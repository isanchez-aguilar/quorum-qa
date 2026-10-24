import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import { buildReviewContext } from '../../src/context/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';
import type { CommandRunner } from '../../src/types/index.js';
import { runDoctor } from '../../src/doctor/index.js';
import { proposeRules } from '../../src/rules/mining.js';
import * as cascadeModule from '../../src/cascade/index.js';

vi.mock('../../src/context/index.js', () => ({ buildReviewContext: vi.fn() }));
vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: async (root: string) => ({ path: root, cleanup: async () => {} }), isClean: async () => true }));
let root: string;
let baseFile: string | undefined;
let headFile: string | undefined;
const today = () => Date.parse('2026-10-22T12:00:00Z');
const runner: CommandRunner = async (command, args, options) => {
  const output = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  if (args.includes('ls-tree')) {
    const commit = args[args.indexOf('-z') + 1];
    const text = commit === 'b'.repeat(40) ? headFile : baseFile;
    return output(args.at(-1) === 'quorum.suppress.json' && text !== undefined ? '100644 blob abc\tquorum.suppress.json\0' : '');
  }
  if (args.includes('show')) {
    if (args.at(-1)?.endsWith(':quorum.config.json')) return output(JSON.stringify({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] }, escalate: { focus: [], belowConfidence: 0.1, confirmImportant: false } }));
    if (args.at(-1)?.endsWith(':quorum.suppress.json')) return output(args.at(-1)!.startsWith('b'.repeat(40)) ? headFile : baseFile);
  }
  if (args.includes('diff') && args.at(-1) === 'quorum.suppress.json') return output(baseFile === headFile ? '' : 'quorum.suppress.json\n');
  if (args.includes('rev-parse') && !args.includes('--show-toplevel')) return output('b'.repeat(40));
  if (args.includes('merge-base')) return output('a'.repeat(40));
  return originRunner(root)(command, args, options);
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-suppress-cli-'));
  baseFile = undefined; headFile = undefined;
  await writeFile(path.join(root, 'sample.ts'), source);
  vi.mocked(buildReviewContext).mockResolvedValue(context(root));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-suppress-cli-'))) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});

it('keeps a reproduced two-family BLOCKER active through main and reports the ignored suppression', async () => {
  const first = JSON.parse((await review()).out);
  const blocker = finding({ severity: 'BLOCKER', family: 'google', verified: true, confirmationFamilies: ['google', 'openai'],
    reproduction: { path: 'proof.test.ts', content: 'assert(false)', expect: 'false', status: 'reproduced' } });
  vi.spyOn(cascadeModule, 'runCascade').mockResolvedValueOnce({ ...first, findings: [blocker], unconfirmed: [] });
  baseFile = headFile = JSON.stringify({ suppressions: [entry] });
  const r = await review(); expect(r.code, r.err).toBe(1);
  expect(JSON.parse(r.out).findings).toHaveLength(1); expect(JSON.parse(r.out).suppressed).toEqual([]);
  expect(JSON.parse(r.out).warnings).toContain('suppression s1 ignored: reproduced BLOCKER');
});

it('expired and changed quotes return as active findings with warnings for expiration', async () => {
  for (const replacement of [{ ...entry, expires: '2026-10-21' }, { ...entry, quote: 'entirelyDifferentCode();' }]) {
    baseFile = headFile = JSON.stringify({ suppressions: [replacement] });
    const r = await review(); expect(r.code, r.err).toBe(1); expect(JSON.parse(r.out).suppressed).toEqual([]);
    if ('expires' in replacement) expect(JSON.parse(r.out).warnings.join()).toContain('s1 expired');
  }
});

it('rejects invalid trusted configuration but only notes invalid untrusted HEAD changes', async () => {
  headFile = '{';
  const untrusted = await review(); expect(untrusted.code, untrusted.err).toBe(1);
  expect(JSON.parse(untrusted.out).warnings.join()).toContain('added entries unavailable');
  const trusted = await review(['--trust-head-config']); expect(trusted.code).toBe(2); expect(trusted.err).toContain('JSON');
});
async function invoke(args: string[]) {
  let out = ''; let err = '';
  const provider = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])], pro: ['[]'] });
  const code = await main(args, { out: t => { out += t; }, err: t => { err += t; } }, {
    repoRoot: root, gitRunner: runner, providers: new Map([['agy', provider]]), catalog, now: today,
  });
  return { code, out, err };
}
const review = (extra: string[] = []) => invoke(['review', '--mode', 'redesign', '--diff', 'base...HEAD', '--no-checks', '--no-cache', '--json', ...extra]);
const entry = { id: 's1', file: 'sample.ts', quote: 'export const value = compute(input);', reason: 'Reviewed and intentional.' };

it.each(['general', 'redesign'])('runs %s main with fake providers, adds from its JSON, trusts only base, and reports suppressions without verdict, SARIF or count contributions', async mode => {
  const review = (extra: string[] = []) => invoke(['review', '--mode', mode, '--diff', 'base...HEAD', '--no-checks', '--no-cache', '--json', ...extra]);
  const first = await review(); expect(first.code, first.err).toBe(1);
  await writeFile(path.join(root, 'report.json'), first.out);
  const add = await invoke(['suppress', 'add', '--from', 'report.json', '--finding', '1', '--reason', entry.reason]);
  expect(add.code, add.err).toBe(0);
  headFile = await readFile(path.join(root, 'quorum.suppress.json'), 'utf8');
  const untrusted = await review(); expect(untrusted.code, untrusted.err).toBe(1);
  expect(JSON.parse(untrusted.out).warnings.join()).toContain('1 added entries');
  const trusted = await review(['--trust-head-config']); expect(trusted.code, trusted.err).toBe(0);
  baseFile = headFile;
  const second = await review(['--sarif', 'result.sarif']); expect(second.code, second.err).toBe(0);
  const report = JSON.parse(second.out);
  expect(report.findings).toEqual([]); expect(report.unconfirmed).toEqual([]); expect(report.suppressed).toHaveLength(1);
  expect(report.suppressed[0]).toMatchObject({ file: 'sample.ts', provider: 'agy', suppression: { reason: entry.reason } });
  const md = await readFile(path.join(root, `.quorum/reports/${report.runId}.md`), 'utf8');
  expect(md).toContain('## Suppressed (1)'); expect(md).toContain('0 Blockers Found'); expect(md).toContain(entry.reason);
  expect(JSON.parse(await readFile(path.join(root, 'result.sarif'), 'utf8')).runs[0].results).toEqual([]);
  const history = (await readFile(path.join(root, '.quorum/findings.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(history.at(-1).suppressed).toBe(true);
  expect(report.cacheHits).toBe(0);
  expect((await readdir(root)).some(file => file.endsWith('.tmp'))).toBe(false);
  expect((await invoke(['suppress', 'add', '--from', 'report.json', '--finding', '1', '--reason', entry.reason])).code).toBe(2);
  expect(await readFile(path.join(root, 'quorum.suppress.json'), 'utf8')).toBe(headFile);
  expect(headFile).toBe(JSON.stringify(JSON.parse(headFile), null, 2) + '\n');
  const id = JSON.parse(headFile).suppressions[0].id;
  expect((await invoke(['suppress', 'list'])).out).toContain(`${id} active`);
  expect((await invoke(['suppress', 'remove', id])).code).toBe(0);
  expect(await readFile(path.join(root, 'quorum.suppress.json'), 'utf8')).toBe('{\n  "suppressions": []\n}\n');
});
it('lists expired and unused entries and doctor warns when code no longer contains the quote', async () => {
  await writeFile(path.join(root, 'quorum.suppress.json'), JSON.stringify({ suppressions: [entry, { ...entry, id: 'old', quote: 'removedDistinctiveCode();', expires: '2020-01-01' }] }));
  const r = await review(); const report = JSON.parse(r.out); report.findings = []; report.unconfirmed = [];
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report));
  expect((await invoke(['suppress', 'list', '--from', 'report.json'])).out).toContain('s1 unused');
  expect((await invoke(['suppress', 'list'])).out).toContain('old expired');
  await writeFile(path.join(root, 'sample.ts'), 'changed();');
  const checks = await runDoctor(undefined, { repoRoot: root, homedir: root, env: { PATH: '' }, runner: async () => ({ stdout: '', stderr: '', exitCode: 1 }) });
  expect(checks).toContainEqual(expect.objectContaining({ status: 'WARN', message: expect.stringContaining('unused suppression s1') }));
});
it.each(['0', '-1', '1.5', '999', 'NaN'])('rejects invalid finding index %s', async index => {
  const report = await review(); await writeFile(path.join(root, 'report.json'), report.out);
  const result = await invoke(['suppress', 'add', '--from', 'report.json', `--finding=${index}`, '--reason', entry.reason]);
  expect(result.code).toBe(2); expect(result.err.toLowerCase()).toContain('finding'); expect(result.err).not.toContain('Unknown option');
});

it('refuses oversized input and linked input/output paths without writing', async () => {
  await writeFile(path.join(root, 'large.json'), ' '.repeat(8 * 1024 * 1024 + 1));
  const large = await invoke(['suppress', 'add', '--from', 'large.json', '--finding', '1', '--reason', entry.reason]);
  expect(large.code).toBe(2); expect(large.err).toContain('8 MiB');
  await mkdir(path.join(root, 'actual'));
  await symlink(path.join(root, 'actual'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, 'actual', 'report.json'), (await review()).out);
  const linked = await invoke(['suppress', 'add', '--from', 'link/report.json', '--finding', '1', '--reason', entry.reason]);
  expect(linked.code).toBe(2); expect(linked.err).toContain('symlink');
  await symlink(path.join(root, 'actual'), path.join(root, 'quorum.suppress.json'), process.platform === 'win32' ? 'junction' : 'dir');
  const list = await invoke(['suppress', 'list']); expect(list.code).toBe(2); expect(list.err).toContain('symlink');
  expect(await readdir(path.join(root, 'actual'))).toEqual(['report.json']);
});

it('selects unconfirmed after findings, records date and expiry, trims/caps evidence, and keeps deterministic bytes', async () => {
  const r = await review(); const report = JSON.parse(r.out);
  report.findings = [finding({ file: 'first.ts' })];
  report.unconfirmed = [finding({ file: 'second.ts', evidence_quote: '  ' + 'a'.repeat(401) + '  ' })];
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report));
  const added = await invoke(['suppress', 'add', '--from', 'report.json', '--finding', '2', '--reason', entry.reason, '--expires', '2027-01-01']);
  expect(added.code, added.err).toBe(0);
  const text = await readFile(path.join(root, 'quorum.suppress.json'), 'utf8');
  const s = JSON.parse(text).suppressions[0];
  expect(s).toMatchObject({ file: 'second.ts', quote: 'a'.repeat(400), reason: entry.reason, created: '2026-10-22', expires: '2027-01-01' });
  expect(Object.keys(s)).toEqual(['id', 'file', 'quote', 'reason', 'created', 'expires']);
  expect((await invoke(['suppress', 'remove', 'missing'])).code).toBe(2);
  expect(await readFile(path.join(root, 'quorum.suppress.json'), 'utf8')).toBe(text);
});

it.each(['', 'short', ' '.repeat(20), 'x'.repeat(501), 'reason\u0000invalid'])('refuses invalid reason %#', async reason => {
  await writeFile(path.join(root, 'report.json'), (await review()).out);
  const r = await invoke(['suppress', 'add', '--from', 'report.json', '--finding', '1', `--reason=${reason}`]);
  expect(r.code).toBe(2); expect(r.err).toContain('reason');
  expect(await readdir(root)).not.toContain('quorum.suppress.json');
});

it('doctor reports count, invalid data, expiration, branch additions and valid moved code', async () => {
  const { checkSuppressions } = await import('../../src/suppressions/doctor.js');
  expect(await checkSuppressions(root, runner)).toEqual([]);
  await writeFile(path.join(root, 'quorum.suppress.json'), '{');
  expect(await checkSuppressions(root, runner)).toContainEqual(expect.objectContaining({ id: 'suppressions', status: 'WARN' }));
  await writeFile(path.join(root, 'quorum.suppress.json'), JSON.stringify({ suppressions: [entry, { ...entry, id: 'old', quote: 'oldStatement();', expires: '2020-01-01' }] }));
  const checks = await checkSuppressions(root, runner, 'base', '2026-10-22');
  expect(checks).toContainEqual(expect.objectContaining({ id: 'suppressions', status: 'PASS', message: expect.stringContaining('2 suppressions') }));
  expect(checks).toContainEqual(expect.objectContaining({ status: 'WARN', message: expect.stringContaining('old expired') }));
  expect(checks).toContainEqual(expect.objectContaining({ id: 'suppressions.branch', message: expect.stringContaining('2 entries added') }));
  expect(checks.some(c => c.message.includes('unused suppression s1'))).toBe(false);
});

it('rule mining ignores suppressed rows even when they would form a recurring cluster', async () => {
  await mkdir(path.join(root, '.quorum'));
  await writeFile(path.join(root, '.quorum/findings.jsonl'), Array.from({ length: 3 }, (_, i) => JSON.stringify({ ...finding(), file: `file${i}.ts`, runId: `run${i}`, timestamp: new Date(today()).toISOString(), suppressed: true })).join('\n'));
  const report = await proposeRules(root, { runner, now: new Date(today()) });
  expect(report.findingsSeen).toBe(0); expect(report.clusters).toEqual([]);
});

it('rejects malformed nested finding metadata and unknown report keys', async () => {
  const original = JSON.parse((await review()).out);
  for (const change of [{ unknown: true }, { findings: [finding({ line: 0 })] }, { findings: [finding({ confidence: 2 })] },
    { findings: [{ ...finding(), extra: true }] }, { unconfirmed: [{ ...finding(), reproduction: { status: 'reproduced' } }] }, { coverage: [] },
    { findings: [{ ...finding(), severity: ['BLOCKER'] }] }, { findings: [{ ...finding(), family: ['google'] }] }, { mode: ['feature'] }]) {
    await writeFile(path.join(root, 'report.json'), JSON.stringify({ ...original, ...change }));
    const r = await invoke(['suppress', 'add', '--from', 'report.json', '--finding', '1', '--reason', entry.reason]);
    expect(r.code).toBe(2); expect(r.err).toContain('Invalid Quorum report');
  }
});
it.each([{}, { findings: [finding()], unconfirmed: [] }, { extra: true }, { findings: [{}] }])('rejects malformed report %#', async raw => {
  await writeFile(path.join(root, 'report.json'), JSON.stringify(raw));
  const result = await invoke(['suppress', 'add', '--from', 'report.json', '--finding', '1', '--reason', entry.reason]);
  expect(result.code).toBe(2); expect(result.err).toContain('report');
});
