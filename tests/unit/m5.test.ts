import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acceptanceCriteria, inventoryFeatures } from '../../src/modes/index.js';
import { appendLedger, atomicWrite, cacheKey, diskCache } from '../../src/storage/index.js';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { createReviewWorktree } from '../../src/worktree/index.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';
import { codexDiagnostics, quotaLanguage } from '../../src/providers/commands.js';
import { generateMarkdownReport } from '../../src/reporters/index.js';
import { checkoutDifference, checkoutSnapshot } from '../../src/worktree/checkout.js';
import type { CommandRunner } from '../../src/types/index.js';

const locked = vi.hoisted(() => ({ path: '', code: 'EBUSY' }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: async (...args: Parameters<typeof original.rm>) => {
    if (args[0] === locked.path) throw Object.assign(new Error('Synthetic locked directory'), { code: locked.code });
    return original.rm(...args);
  } };
});
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-m5-unit-')); await writeFile(path.join(root, 'sample.ts'), source); });
afterEach(async () => { locked.path = ''; await rm(root, { recursive: true, force: true }); });
const config = () => validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });

it('extracts checkboxes everywhere and items only inside acceptance headings', () => {
  expect(acceptanceCriteria('- outside\n- [ ] checkbox\n## Acceptance criteria\n- first\n### Details\n1. second\n## Other\n- outside'))
    .toEqual(['checkbox', 'first', 'second']);
  expect(inventoryFeatures('# Features\n- Export\nSearch\n1. Sort')).toEqual(['Export', 'Search', 'Sort']);
});
it('serializes concurrent ledger appends without losing lines and atomically replaces files', async () => {
  const file = path.join(root, 'ledger.jsonl');
  await Promise.all(Array.from({ length: 8 }, (_, id) => appendLedger([{ id }], file)));
  expect(new Set((await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line).id)).size).toBe(8);
  await atomicWrite(path.join(root, 'value'), 'first'); await atomicWrite(path.join(root, 'value'), 'second');
  expect(await readFile(path.join(root, 'value'), 'utf8')).toBe('second');
});
it('rejects internal storage writes through a junction', async () => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(atomicWrite(path.join(root, 'linked', 'quota.json'), '{}', root)).rejects.toThrow('symlink or junction');
  await expect(readFile(path.join(outside, 'quota.json'))).rejects.toThrow();
});
it('keys cache by payload, prompt and model and stages before flushing', async () => {
  const key = cacheKey('payload', 'prompt', 'agy:flash');
  expect(cacheKey('other', 'prompt', 'agy:flash')).not.toBe(key);
  expect(cacheKey('payload', 'other', 'agy:flash')).not.toBe(key);
  expect(cacheKey('payload', 'prompt', 'codex')).not.toBe(key);
  const cache = diskCache(root, () => {});
  cache.stage(key, '[]', 'agy:flash'); expect(await cache.read(key)).toBeUndefined();
  await cache.flush(); expect(await cache.read(key)).toBe('[]');
});
it('cached results are verified again against current code with zero calls', async () => {
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [] });
  const result = await runCascade(context(root), config(), new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root), cache: {
    read: async () => JSON.stringify([finding({ evidence_quote: 'code which is absent' })]), stage() { throw new Error('cache hit must not stage'); },
  } });
  expect(result.findings).toEqual([]); expect(result.calls).toEqual([]); expect(result.ledgerDraft).toEqual([]); expect(result.cacheHits).toBe(1);
  expect(result.reviewedFamilies).toEqual(['google']);
});
it('never caches confirmation answers or partially malformed review outputs', async () => {
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding({ severity: 'BLOCKER' }), { broken: true }])] });
  const confirm = new FakeProvider('codex', 'openai', originRunner(root), { codex: [JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })] });
  const stage = vi.fn(); const read = vi.fn(async () => undefined);
  const result = await runCascade(context(root), config(), new Map([['agy', provider], ['codex', confirm]]), { catalog, gitRunner: originRunner(root), cache: { read, stage } });
  expect(result.findings).toHaveLength(1); expect(read).toHaveBeenCalledTimes(1); expect(stage).not.toHaveBeenCalled();
});
it('a cached review still calls confirmation again and AC2 never matches AC20', async () => {
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding({ severity: 'BLOCKER', trigger: 'AC20 is missing' })])] });
  const confirmation = JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote });
  const confirm = new FakeProvider('codex', 'openai', originRunner(root), { codex: [confirmation, confirmation] });
  const data = new Map<string, string>();
  const cache = { read: async (key: string) => data.get(key), stage: (key: string, output: string) => { data.set(key, output); } };
  const pool = new Map([['agy', provider], ['codex', confirm]]);
  await runCascade(context(root), config(), pool, { catalog, gitRunner: originRunner(root), cache });
  const result = await runCascade(context(root), config(), pool, { catalog, gitRunner: originRunner(root), cache });
  expect(result.cacheHits).toBe(1); expect(provider.calls).toHaveLength(1); expect(confirm.calls).toHaveLength(2);
  const markdown = generateMarkdownReport({ ...result, runId: 'synthetic', timestamp: '2026-10-19T00:00:00Z', mode: 'feature', range: 'base...HEAD',
    headSha: 'b', baseSha: 'a', checks: null, criteria: ['first', 'second'], inventory: [], families: ['google', 'openai'], exitCode: 1 });
  expect(markdown).toContain('| AC2: second | not assessed (no finding) |');
  expect(markdown).not.toContain('|\n\n|');
});
it.each(['EBUSY', 'EPERM'])('warns and continues when stale sweep encounters %s', async code => {
  const stale = path.join(root, '.quorum', 'worktrees', 'stale'); await mkdir(stale, { recursive: true });
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000); await utimes(stale, old, old);
  locked.path = stale; locked.code = code; const warnings: string[] = [];
  const tree = await createReviewWorktree(root, 'abc123', originRunner(root), message => warnings.push(message));
  expect(warnings.join()).toContain('Stale worktree cleanup failed'); await tree.cleanup();
});
it('ignores CRLF echoed quota prompt but retains real errors', () => {
  const prompt = 'Review this code:\nconst quota = 1;\nReturn JSON';
  expect(quotaLanguage(codexDiagnostics('user\r\n' + prompt.replace(/\n/g, '\r\n') + '\r\nERROR startup failed', prompt))).toBe(false);
  expect(quotaLanguage(codexDiagnostics('user\r\n' + prompt.replace(/\n/g, '\r\n') + '\r\nERROR quota exhausted', prompt))).toBe(true);
});

it('includes the untracked file list in the guard even when porcelain and HEAD are unchanged', async () => {
  let untracked = 'first.txt\0';
  const git: CommandRunner = async (_command, args) => ({
    stdout: args.includes('ls-files') ? untracked : args.includes('rev-parse') ? 'a'.repeat(40) : '',
    stderr: '', exitCode: 0,
  });
  const before = await checkoutSnapshot(root, git);
  untracked += 'second.txt\0';
  const after = await checkoutSnapshot(root, git);
  expect(after.status).toBe(before.status); expect(after.head).toBe(before.head);
  expect(after.contentHash).not.toBe(before.contentHash);
  expect(checkoutDifference(before, after)).toContain('untracked file list changed');
});

it('marks coverage incomplete when origin lookup fails only during confirmation', async () => {
  let blames = 0;
  const original = originRunner(root);
  const git: CommandRunner = async (command, args, options) => {
    if (args.includes('blame') && ++blames === 2) return { stdout: '', stderr: 'Synthetic blame failure', exitCode: 1 };
    return original(command, args, options);
  };
  const provider = new FakeProvider('agy', 'google', git, { flash: [JSON.stringify([finding({ confidence: 0.1 })])] });
  const confirm = new FakeProvider('codex', 'openai', git, { codex: [JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })] });
  const result = await runCascade(context(root), config(), new Map([['agy', provider], ['codex', confirm]]), { catalog, gitRunner: git });
  expect(blames).toBe(2); expect(result.unconfirmed).toHaveLength(1);
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'origin unavailable', file: 'sample.ts', count: 1 });
  expect(result.coverage.complete).toBe(false);
  expect(result.warnings.join()).toContain('lost findings: origin unavailable');
});

it('expires an orphaned ledger lock after ten minutes', async () => {
  const file = path.join(root, '.quorum', 'ledger.jsonl'); await mkdir(path.dirname(file));
  await writeFile(`${file}.lock`, ''); const old = new Date(Date.now() - 601000); await utimes(`${file}.lock`, old, old);
  await appendLedger([{ runId: 'recovered' }], file);
  expect(await readFile(file, 'utf8')).toContain('recovered');
});
it('serializes criteria as untrusted JSON rather than prompt instructions', async () => {
  const { reviewChunks } = await import('../../src/cascade/prompts.js');
  const spec = '- [ ] malicious "instruction"';
  const prompt = reviewChunks({ ...context(root), specContent: spec }).chunks[0]!.prompt;
  expect(prompt).not.toContain('AC1: malicious "instruction"');
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  expect(data.criteria).toEqual(['AC1: malicious "instruction"']); expect(prompt).toContain('untrusted');
});
it('never stages visual cache entries', async () => {
  const cfg = config(); cfg.tiers.visual = ['agy:pro'];
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'], pro: ['[]'] });
  const stage = vi.fn();
  await runCascade({ ...context(root), mode: 'redesign', images: ['/synthetic/image.png'] }, cfg, new Map([['agy', provider]]), {
    catalog, gitRunner: originRunner(root), cache: { read: async () => undefined, stage },
  });
  expect(stage).toHaveBeenCalledTimes(1); expect(stage.mock.calls[0]?.[2]).toBe('agy:flash');
});
it.each([['image.png', true], ['data.bin', false]] as const)('visual review covers binary %s: %s', async (file, complete) => {
  const cfg = config(); cfg.tiers.visual = ['agy:pro'];
  const provider = new FakeProvider('agy', 'google', originRunner(root), { pro: ['[]'] });
  const result = await runCascade({ ...context(root), mode: 'redesign', images: ['/synthetic/image.png'], touchedFiles: [file],
    diff: `diff --git a/${file} b/${file}\nBinary files a/${file} and b/${file} differ\n` }, cfg, new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.complete).toBe(complete);
  expect(result.coverage.reviewedFiles).toEqual(complete ? [file] : []);
});

it('reports failed checks in Status without changing the review exit code', async () => {
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'] });
  const cascade = await runCascade(context(root), config(), new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root) });
  const result = { ...cascade, runId: 'checks', timestamp: '2026-10-19', mode: 'feature' as const, range: 'base...HEAD', headSha: 'b', baseSha: 'a',
    checks: { passed: false, results: [{ argv: ['synthetic'], exitCode: 1, timedOut: false, durationMs: 1, stdoutTail: '', stderrTail: '' }] },
    criteria: [], inventory: [], families: cascade.reviewedFamilies, exitCode: 0 };
  const status = generateMarkdownReport(result).split('\n').find(line => line.startsWith('**Status:**'));
  expect(status).toContain('1 failed deterministic checks'); expect(status).toContain('exit 0');
});
it('keeps every line when many writers append at once', async () => {
  // A one-in-eleven failure under full-suite load showed the old one-second lock wait was too short.
  const file = path.join(root, 'stress.jsonl');
  await Promise.all(Array.from({ length: 40 }, (_, id) => appendLedger([{ id }], file)));
  const ids = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line).id as number);
  expect(ids).toHaveLength(40);
  expect(new Set(ids).size).toBe(40);
});
