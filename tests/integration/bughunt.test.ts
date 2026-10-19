import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CommandRunner } from '../../src/types/index.js';
import type { ReviewResult } from '../../src/reporters/index.js';
import { catalog, finding } from '../fixtures/cascade.js';

let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const runner: CommandRunner = (command, args, options) => runCommand(command, args, { ...options, env });
async function git(...args: string[]) {
  const result = await runner('git', args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
}
const lines = Array.from({ length: 25 }, (_, i) => `export const value${i + 1} = ${i + 1};`);
lines[4] = 'for (let i = 0; i <= values.length; i++) consume(values[i]);';
const bug = () => finding({ severity: 'BLOCKER', line: 5, evidence_quote: lines[4], trigger: 'A nonempty array reaches the loop', impact: 'An undefined element is consumed', fix: 'Use i < values.length' });
const changed = () => finding({ severity: 'BLOCKER', line: 15, evidence_quote: 'export const value15 = 150;', trigger: 'The changed constant is used', impact: 'The new value is wrong' });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-cli-'));
  await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
  await writeFile(path.join(root, 'sample.ts'), lines.join('\n') + '\n');
  await writeFile(path.join(root, 'spec.md'), '# Acceptance\n- [ ] A criterion\n');
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify({ base: 'base', checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] }, escalate: { focus: [], belowConfidence: 0.6 } }));
  await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
  const headLines = [...lines]; headLines[14] = 'export const value15 = 150;';
  await writeFile(path.join(root, 'sample.ts'), headLines.join('\n') + '\n');
  await git('add', '.'); await git('commit', '-m', 'head');
}, 20000);
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function review(raw = '[]', confirmations: string[] = [], args: string[] = []) {
  const agy = new FakeProvider('agy', 'google', runner, { flash: [raw] });
  const codex = new FakeProvider('codex', 'openai', runner, { codex: confirmations });
  let out = ''; let err = '';
  const code = await main(['review', '--mode', 'bughunt', '--diff', 'base...HEAD', '--no-checks', '--out', '.quorum/report.md', '--json', ...args],
    { out: text => { out += text; }, err: text => { err += text; } }, { repoRoot: root, gitRunner: runner, catalog, providers: new Map([['agy', agy], ['codex', codex]]) });
  return { code, out, err, agy, codex, result: out.startsWith('{') ? JSON.parse(out) as ReviewResult : undefined };
}
const confirm = (line: number, quote: string) => JSON.stringify({ decision: 'confirm', line, evidence_quote: quote });

it('reports a planted pre-existing blocker through main, Markdown and SARIF', async () => {
  const run = await review(JSON.stringify([bug(), changed()]), [confirm(5, lines[4]!)], ['--sarif', '.quorum/report.sarif']);
  expect(run.code, run.err).toBe(1);
  expect(run.result?.findings).toMatchObject([{ origin: 'pre-existing', line: 5, confirmationFamilies: ['google', 'openai'] }]);
  expect(run.result?.pointsAtChange).toMatchObject([{ origin: 'introduced', line: 15 }]);
  const markdown = await readFile(path.join(root, '.quorum/report.md'), 'utf8');
  expect(markdown).toContain('Points at the change (use feature mode)');
  expect(markdown).toContain('sample.ts:1-11');
  expect(markdown).toContain('1 Blockers Found');
  const sarif = JSON.parse(await readFile(path.join(root, '.quorum/report.sarif'), 'utf8'));
  expect(sarif.runs[0].results).toHaveLength(1);
  expect(sarif.runs[0].results[0].properties).toMatchObject({ mode: 'bughunt', origin: 'pre-existing' });
});
it('only points at the change exits zero and spends no confirmation calls', async () => {
  const run = await review(JSON.stringify([changed()]));
  expect(run.code, run.err).toBe(0); expect(run.result?.findings).toEqual([]); expect(run.codex.calls).toHaveLength(0);
});
it('unconfirmed pre-existing blockers do not fail a complete bughunt', async () => {
  const run = await review(JSON.stringify([bug()]));
  expect(run.code, run.err).toBe(0); expect(run.result?.unconfirmed).toHaveLength(1);
});
it('confirmation moved onto the change cannot confirm a bughunt blocker', async () => {
  const item = bug(); item.line = 11; item.evidence_quote = lines[10]!;
  const run = await review(JSON.stringify([item]), [confirm(15, changed().evidence_quote)]);
  expect(run.code, run.err).toBe(0);
  expect(run.result?.findings).toEqual([]);
  expect(run.result?.pointsAtChange).toMatchObject([{ line: 15, origin: 'introduced' }]);
});
it('blames OPTIONAL model improvements in bughunt', async () => {
  const run = await review(JSON.stringify([{ ...bug(), severity: 'OPTIONAL', origin: 'improvement' }]));
  expect(run.code, run.err).toBe(0); expect(run.result?.findings[0]?.origin).toBe('pre-existing');
});
it('accepts an equivalent relative path spelling inside a selected window', async () => {
  const run = await review(JSON.stringify([{ ...bug(), file: './sample.ts' }]), [confirm(5, lines[4]!)]);
  expect(run.code, run.err).toBe(1);
  expect(run.result?.findings).toMatchObject([{ file: './sample.ts', origin: 'pre-existing' }]);
  expect(run.codex.calls[0]?.prompt).toContain('UNCHANGED HEAD lines');
});
it('unavailable providers leave window coverage incomplete', async () => {
  const run = await review('invalid');
  expect(run.code).toBe(2); expect(run.result?.coverage.complete).toBe(false);
  expect(run.result?.coverage.reviewedWindows).toEqual([]);
});
it('rejects pre-existing findings outside the selected radius after verification correction', async () => {
  const run = await review(JSON.stringify([{ ...bug(), line: 11 }]), [], ['--radius', '1']);
  expect(run.code, run.err).toBe(0);
  expect(run.result?.findings).toEqual([]); expect(run.result?.unconfirmed).toEqual([]);
  expect(run.result?.ledgerDraft[0]?.rejectionReasons['outside bughunt windows']).toBe(1);
  expect(run.codex.calls).toEqual([]);
});
it('rejects a confirmation moved outside the selected windows', async () => {
  const run = await review(JSON.stringify([{ ...bug(), line: 11, evidence_quote: lines[10] }]), [confirm(5, lines[4]!)], ['--radius', '1']);
  expect(run.code, run.err).toBe(0);
  expect(run.result?.findings).toEqual([]);
  expect(run.result?.unconfirmed).toMatchObject([{ line: 11, confirmationFamilies: ['google'] }]);
});
it('does not merge nearby pre-existing and changed findings with identical descriptions', async () => {
  const old = { ...bug(), line: 11, evidence_quote: lines[10]!, severity: 'IMPORTANT' as const };
  const fresh = { ...old, line: 15, evidence_quote: changed().evidence_quote };
  const run = await review(JSON.stringify([old, fresh]));
  expect(run.code, run.err).toBe(0);
  expect(run.result?.findings).toMatchObject([{ line: 11, origin: 'pre-existing' }]);
  expect(run.result?.pointsAtChange).toMatchObject([{ line: 15, origin: 'introduced' }]);
});
it('dry-run uses committed HEAD windows, and radius zero has empty complete coverage', async () => {
  await writeFile(path.join(root, 'sample.ts'), 'DIRTY CHECKOUT ONLY\n');
  const dry = await review('[]', [], ['--dry-run']);
  expect(dry.code, dry.err).toBe(0); expect(dry.out).toContain('Windows: 2 (18 total lines)'); expect(dry.out).toContain('Review chunks: 1');
  expect(dry.agy.calls).toEqual([]);
  const zero = await review('[]', [], ['--radius', '0']);
  expect(zero.code, zero.err).toBe(0); expect(zero.agy.calls).toEqual([]);
});
it.each(['--spec', '--inventory'])('rejects %s in bughunt', async flag => {
  const run = await review('[]', [], [flag, 'spec.md']);
  expect(run.code).toBe(2); expect(run.err).toContain('bughunt'); expect(run.agy.calls).toEqual([]);
});
it('isolates cache by mode and radius even when windows are identical', async () => {
  let out = '';
  const fake = new FakeProvider('agy', 'google', runner, { flash: ['[]'] });
  expect(await main(['review', '--mode', 'feature', '--spec', 'spec.md', '--diff', 'base...HEAD', '--no-checks', '--out', '.quorum/report.md'],
    { out: text => { out += text; }, err: () => {} }, { repoRoot: root, gitRunner: runner, catalog, providers: new Map([['agy', fake]]) })).toBe(0);
  const first = await review('[]', [], ['--radius', '40']);
  const second = await review('[]', [], ['--radius', '41']);
  const cached = await review('[]', [], ['--radius', '40']);
  expect(first.agy.calls).toHaveLength(1); expect(second.agy.calls).toHaveLength(1); expect(cached.agy.calls).toHaveLength(0);
  expect(cached.result?.cacheHits).toBe(1);
});
