import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { parseFindings } from '../../src/cascade/parse.js';
import { validateConfig } from '../../src/config/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { rawOutputWriter } from '../../src/storage/raw.js';
import { validateSuppressionReport } from '../../src/suppressions/commands.js';
import { generateMarkdownReport, generateSarifReport, type ReviewResult } from '../../src/reporters/index.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-dropped-'));
  await writeFile(path.join(root, 'sample.ts'), source);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const malformed = () => ({ ...finding(), severity: 'unknown', trigger: '<script>[run](https://invalid)\n**BLOCKER**', impact: 'x'.repeat(400) });
async function review(raw: string, save = rawOutputWriter(root, 'synthetic')) {
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [raw], pro: ['[]'] });
  const stage = vi.fn();
  const result = await runCascade(context(root), validateConfig({ checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] }, escalate: { focus: [], confirmImportant: false },
  }), new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root), saveDroppedOutput: save,
    cache: { read: async () => undefined, stage } });
  return { result, stage, provider };
}

it('bounds scalar excerpts, omits objects and retains every rejection count', () => {
  const parsed = parseFindings(JSON.stringify({ findings: Array.from({ length: 25 }, () => ({
    file: 42, line: 'bad\r\nline', severity: {}, trigger: '\n' + 'z'.repeat(400), impact: null,
  })) }), catalog[0]!);
  expect(parsed.dropped).toHaveLength(25);
  expect(parsed.dropped[0]?.excerpt).toEqual({ file: '42', line: 'bad line', trigger: ' ' + 'z'.repeat(299) });
  expect(parsed.dropped[20]?.excerpt).toBeUndefined();
});

it('preserves mixed drops, keeps coverage incomplete and never stages that response', async () => {
  const raw = JSON.stringify([finding(), ...Array.from({ length: 25 }, malformed)]);
  const { result, stage } = await review(raw);
  expect(result.dropped).toHaveLength(20);
  expect(result.dropped?.[0]).toMatchObject({ provider: 'agy', model: 'flash', tier: 'triage', purpose: 'review', chunkIndex: 0,
    reason: 'invalid severity: "unknown"', entryIndex: 1, rawFile: '.quorum/raw/synthetic/1.txt' });
  expect(result.dropped?.[0]?.excerpt?.impact).toHaveLength(300);
  expect(result.findings).toHaveLength(1);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'malformed finding', count: 25 });
  expect(stage).not.toHaveBeenCalled();
  expect(await readFile(path.join(root, result.dropped![0]!.rawFile!), 'utf8')).toBe(raw);
  expect(await readdir(path.join(root, '.quorum/raw/synthetic'))).toEqual(['1.txt']);
});

it('retains unparseable output even when fallback succeeds without findings', async () => {
  const raw = 'unparseable <script>\n'.repeat(100);
  const { result, provider } = await review(raw);
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped?.[0]?.rawExcerpt).toBe(raw.slice(0, 1000));
  expect(result.findings).toEqual([]);
  expect(result.coverage.complete).toBe(true);
  expect(provider.calls.map(call => call.model)).toEqual(['flash', 'pro']);
});

it('caps entries across chunks while saving each affected response only once', async () => {
  const ctx = context(root);
  ctx.touchedFiles = ['first.ts', 'second.ts'];
  ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${'x'.repeat(15000)}\n`).join('');
  const raw = JSON.stringify(Array.from({ length: 15 }, malformed));
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [raw, raw], pro: ['[]', '[]'] });
  const result = await runCascade(ctx, validateConfig({ checks: [], budget: { maxCalls: 12 },
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] }, escalate: { focus: [] },
  }), new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root), saveDroppedOutput: rawOutputWriter(root, 'synthetic') });
  expect(result.dropped).toHaveLength(20);
  expect(result.dropped?.map(item => item.chunkIndex)).toEqual([...Array<number>(15).fill(0), ...Array<number>(5).fill(1)]);
  expect(result.dropped?.[15]?.rawFile).toBe('.quorum/raw/synthetic/2.txt');
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'malformed finding', count: 30 });
  expect(await readdir(path.join(root, '.quorum/raw/synthetic'))).toEqual(['1.txt', '2.txt']);
});

it('reports escaped diagnostics after unconfirmed, excludes them from SARIF and counts', async () => {
  const { result } = await review(JSON.stringify([malformed()]));
  const report: ReviewResult = { ...result, runId: 'synthetic', timestamp: '2026-10-24T00:00:00Z', mode: 'general', range: 'base...HEAD',
    headSha: 'b', baseSha: 'a', checks: null, criteria: [], inventory: [], families: [], exitCode: 2 };
  const markdown = generateMarkdownReport(report);
  expect(markdown.indexOf('## Dropped model output (1)')).toBeGreaterThan(markdown.indexOf('## Unconfirmed (other reviewers)'));
  expect(markdown).toContain('NOT verified');
  expect(markdown).toContain('&lt;script>\\[run\\](https://invalid)');
  expect(markdown).toContain('\\*\\*BLOCKER\\*\\*');
  expect(markdown).toContain('.quorum/raw/synthetic/1.txt');
  expect(markdown).toContain('0 Blockers Found');
  const sarif = generateSarifReport([], report);
  expect(sarif).not.toContain('unknown');
  expect(sarif).not.toContain('rawFile');
  expect(JSON.parse(sarif).runs[0].results).toEqual([]);
  expect(JSON.parse(JSON.stringify(report)).dropped).toHaveLength(1);
  expect(validateSuppressionReport(report)).toEqual({ findings: [], unconfirmed: [], suppressed: [] });
});

it('retains confirmation parser drops with the original raw response and chunk', async () => {
  const raw = JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote, line: 'invalid' });
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])] });
  const confirmer = new FakeProvider('codex', 'openai', originRunner(root), { codex: [raw] });
  const result = await runCascade(context(root), validateConfig({ checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] },
  }), new Map([['agy', provider], ['codex', confirmer]]), { catalog, gitRunner: originRunner(root), saveDroppedOutput: rawOutputWriter(root, 'synthetic') });
  expect(result.dropped?.[0]).toMatchObject({ provider: 'codex', purpose: 'confirm', tier: 'confirm', chunkIndex: 0,
    reason: 'line must be a positive integer', excerpt: { line: 'invalid' } });
  expect(await readFile(path.join(root, result.dropped![0]!.rawFile!), 'utf8')).toBe(raw);
});

it('keeps diagnostics and existing coverage when the raw writer fails', async () => {
  const { result } = await review(JSON.stringify([malformed()]), async () => { throw new Error('synthetic disk failure'); });
  expect(result.dropped).toHaveLength(1);
  expect(result.dropped?.[0]?.rawFile).toBeUndefined();
  expect(result.errors).toEqual([]);
  expect(result.warnings.join()).toContain('Raw output write failed');
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'malformed finding', count: 1 });
});

it('preserves a discarded cache response without changing cache miss behavior', async () => {
  const raw = JSON.stringify([malformed()]);
  const provider = new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'] });
  const stage = vi.fn();
  const result = await runCascade(context(root), validateConfig({ checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] },
  }), new Map([['agy', provider]]), { catalog, gitRunner: originRunner(root), saveDroppedOutput: rawOutputWriter(root, 'synthetic'),
    cache: { read: async () => raw, stage } });
  expect(result.dropped?.[0]).toMatchObject({ chunkIndex: 0, reason: 'invalid severity: "unknown"' });
  expect(result.cacheHits).toBe(0);
  expect(provider.calls).toHaveLength(1);
  expect(stage.mock.calls[0]?.[1]).toBe('[]');
  expect(result.coverage.complete).toBe(true);
  expect(await readFile(path.join(root, result.dropped![0]!.rawFile!), 'utf8')).toBe(raw);
});

it('caps raw files at 20 and 256 KiB without splitting UTF-8 characters', async () => {
  const save = rawOutputWriter(root, 'synthetic');
  const raw = 'a'.repeat(256 * 1024 - 1) + '😀'.repeat(100);
  for (let i = 0; i < 20; i++) expect(await save(raw)).toBe(`.quorum/raw/synthetic/${i + 1}.txt`);
  expect(await save('extra')).toBeUndefined();
  const bytes = await readFile(path.join(root, '.quorum/raw/synthetic/1.txt'));
  expect(bytes.length).toBe(256 * 1024 - 1);
  expect(bytes.toString()).not.toContain('�');
  expect(await readdir(path.join(root, '.quorum/raw/synthetic'))).toHaveLength(20);
});

it.each(['../escape', '/outside', 'a/b', 'a\\b', '..', ''])('refuses unsafe run ID %s', runId => {
  expect(() => rawOutputWriter(root, runId)).toThrow('Invalid raw output run ID');
});

it.each(['.quorum', '.quorum/raw', '.quorum/raw/synthetic'])('refuses a symlink or junction at %s', async part => {
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await mkdir(path.dirname(path.join(root, part)), { recursive: true });
  await symlink(outside, path.join(root, part), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(rawOutputWriter(root, 'synthetic')('untrusted')).rejects.toThrow('symlink or junction');
  expect(await readdir(outside)).toEqual([]);
});
