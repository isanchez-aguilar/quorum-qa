import { checksWorktreePath } from '../../src/worktree/paths.js';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main, type CliDependencies } from '../../src/cli/index.js';
import { CommandTimeoutError, runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CommandRunner } from '../../src/types/index.js';
import type { ReviewResult } from '../../src/reporters/index.js';
import { catalog, finding } from '../fixtures/cascade.js';

let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const runner: CommandRunner = (command, args, options) => {
  if (!/^git(?:\.exe)?$/i.test(path.basename(command))) throw new Error('Only git is allowed by the git runner');
  return runCommand(command, args, { ...options, env });
};
async function git(...args: string[]) {
  const result = await runner('git', args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
}
const source = 'export function value() { return 2; }\n';
const testRunner = `const fs = require('node:fs');
const path = require('node:path');
if (!fs.existsSync('ready')) process.exit(3);
const failed = fs.readFileSync('sample.ts', 'utf8').includes('return 0');
const report = { testResults: [{ name: path.resolve('sample.test.ts'), status: failed ? 'failed' : 'passed',
  assertionResults: [{ ancestorTitles: ['value'], title: 'returns a value', fullName: 'value returns a value',
    status: failed ? 'failed' : 'passed', failureMessages: failed ? ['AssertionError: expected positive value'] : [] }] }] };
const output = process.argv.find(arg => arg.startsWith('--outputFile='));
if (output) fs.writeFileSync(output.slice('--outputFile='.length), JSON.stringify(report));
else process.stdout.write(JSON.stringify(report));
process.exitCode = failed ? 1 : 0;
`;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-refactor-cli-'));
  await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.quorum/\nready\n');
  await writeFile(path.join(root, 'sample.ts'), 'export function value() { return 1; }\n');
  await writeFile(path.join(root, 'sample.test.ts'), "import { value } from './sample.js';\n");
  await writeFile(path.join(root, 'runner.cjs'), testRunner);
  await writeFile(path.join(root, 'setup.cjs'), "require('node:fs').writeFileSync('ready', 'yes');\n");
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify({
    base: 'base', checks: [], setup: [[process.execPath, 'setup.cjs']],
    refactor: { testCommand: [process.execPath, 'runner.cjs'], timeoutSeconds: 30 },
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] },
    escalate: { focus: [], belowConfidence: 0.6, confirmImportant: false },
  }));
  await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
  await writeFile(path.join(root, 'sample.ts'), source);
  await git('add', '.'); await git('commit', '-m', 'head');
}, 20000);
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function review(args: string[] = [], dependencies: CliDependencies = {}) {
  const provider = new FakeProvider('agy', 'google', runner, { flash: ['[]'] });
  const quota = vi.spyOn(provider, 'getQuota');
  let out = ''; let err = '';
  const code = await main(['review', '--mode', 'refactor', ...(args.includes('--diff') ? [] : ['--diff', 'base...HEAD']), '--json', '--no-cache',
    '--out', '.quorum/report.md', ...args], { out: t => { out += t; }, err: t => { err += t; } },
  { repoRoot: root, gitRunner: runner, catalog, providers: new Map([['agy', provider]]),
    appendLedger: async () => {}, appendFindings: async () => {}, ...dependencies });
  return { code, out, err, provider, quota, result: out.startsWith('{') ? JSON.parse(out) as ReviewResult : undefined };
}
it('compares tests and API at a non-HEAD lane using trusted base configuration', async () => {
  const head = await git('rev-parse', 'HEAD');
  await git('branch', 'lane', head);
  await writeFile(path.join(root, 'sample.ts'), source.replace('return 2', 'return 0'));
  await git('add', '.'); await git('commit', '-m', 'later regression outside lane');
  const contextRunner = vi.fn<CommandRunner>(async () => { throw new Error('must not query the checkout index'); });
  const result = await review(['--diff', 'base..lane'], { contextRunner });
  expect(result.code, result.err).toBe(0);
  expect(result.result?.headSha).toBe(head);
  expect(result.result?.refactor?.tests.head).toMatchObject({ failed: 0, passed: 1 });
  expect(result.result?.refactor?.tests.regressions).toEqual([]);
  expect(result.result?.refactor?.verdict).toBe('NO BEHAVIOUR CHANGE FOUND');
  expect(result.provider.calls.length).toBeGreaterThan(0);
  expect(contextRunner).not.toHaveBeenCalled();
});
it.each([
  ['referenced local interface', 'sample.ts', 'interface Props { label: string; } export function Button(props: Props) { return props.label; }', 'interface Props { label: number; } export function Button(props: Props) { return props.label; }'],
  ['class method', 'sample.ts', 'export class S { run(); stop(); }', 'export class S { run(); }'],
  ['enum member', 'sample.ts', 'export enum E { A = 1, B = 2 }', 'export enum E { A = 1 }'],
  ['package type', 'package.json', '{"type":"commonjs"}', '{"type":"module"}'],
  ['next-line union', 'sample.ts', "export type Mode =\n  | 'a'\n  | 'b';", "export type Mode =\n  | 'a';"],
  ['CommonJS brackets', 'sample.ts', "exports['x'] = 1;\nexports['beta'] = 2;", "exports['beta'] = 2;"],
  ['overload', 'sample.ts', 'export function parse(x: string): string;\nexport function parse(x: number): number;\nexport function parse(x: string | number) { return x; }',
    'export function parse(x: number): number;\nexport function parse(x: string | number) { return x; }'],
  ['multiline parameter', 'sample.ts', 'export function calculate(\n  a: number,\n  b: string\n): boolean {',
    'export function calculate(\n  a: number,\n  b: string,\n  c: number\n): boolean {'],
  ['CommonJS rename', 'sample.cjs', 'module.exports = { add, double };', 'module.exports = { sum: add, double };'],
])('detects %s end to end without providers', async (_name, file, before, after) => {
  await writeFile(path.join(root, file), before);
  await git('add', '.'); await git('commit', '-m', 'synthetic API base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(path.join(root, file), after);
  await git('add', '.'); await git('commit', '-m', 'synthetic API head');
  const r = await review(['--deterministic-only', '--diff', `${base}...HEAD`]);
  expect(r.code, r.err).toBe(1);
  expect(r.result?.refactor?.verdict).toBe('NOT EQUIVALENT');
  expect(r.provider.calls).toHaveLength(0); expect(r.quota).not.toHaveBeenCalled();
});
it.each([
  ['default arrow', 'export default (a: number) => { return a + 1; };'],
  ['class method', 'export class S { run(a: number) { return a + 1; } }'],
])('ignores %s body changes end to end with unchanged tests', async (_name, before) => {
  await writeFile(path.join(root, 'sample.ts'), before);
  await git('add', '.'); await git('commit', '-m', 'arrow base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'sample.ts'), before.replace('+ 1', '+ 2'));
  await git('add', '.'); await git('commit', '-m', 'arrow head');
  const r = await review(['--deterministic-only', '--diff', `${base}...HEAD`]);
  expect(r.code, r.err).toBe(0);
  expect(r.result?.refactor?.verdict).toBe('NO BEHAVIOUR CHANGE FOUND');
  expect(r.provider.calls).toHaveLength(0); expect(r.quota).not.toHaveBeenCalled();
});
it.each([
  ['README.md', 'documentation', 'NO BEHAVIOUR CHANGE FOUND'],
  ['sample.py', 'def value(): return 1', 'SUSPECT'],
  ['large.ts', Array.from({ length: 4000 }, (_, i) => `export const x${i} = ${i};`).join('\n'), 'SUSPECT'],
  ['oversized.ts', ' '.repeat(300 * 1024), 'SUSPECT'],
  ['list.ts', 'export { ' + 'a,'.repeat(2500) + 'b };', 'SUSPECT'],
])('handles evidence limits and non-source files end to end: %s', async (file, text, verdict) => {
  await writeFile(path.join(root, file), text);
  await git('add', '.'); await git('commit', '-m', 'synthetic evidence base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(path.join(root, file), text + '\n// changed\n');
  await git('add', '.'); await git('commit', '-m', 'synthetic evidence head');
  const r = await review(['--deterministic-only', '--diff', `${base}...HEAD`]);
  expect(r.code, r.err).toBe(0);
  expect(r.result?.refactor?.verdict).toBe(verdict);
  if (file === 'README.md') {
    expect(r.result?.refactor?.reasons).not.toContain('Touched files have no test dependent.');
    expect(await readFile(path.join(root, '.quorum/report.md'), 'utf8')).toContain('Non-source files changed');
  } else {
    expect(r.result?.refactor?.reasons.join(' ')).toContain(file);
    expect(r.result?.refactor?.available).toBe(true);
  }
});
it('runs real setup and JSON tests in base and head worktrees with no provider activity', async () => {
  const contextProvider = { name: 'codegraph', available: vi.fn(async () => true), enrich: vi.fn() };
  const r = await review(['--deterministic-only'], { contextProvider });
  expect(r.code, r.err).toBe(0);
  expect(r.out).toContain('NO BEHAVIOUR CHANGE FOUND');
  expect(r.result?.coverage.complete).toBe(true);
  expect(r.provider.calls).toHaveLength(0); expect(r.quota).not.toHaveBeenCalled();
  expect(contextProvider.enrich).not.toHaveBeenCalled();
  expect(r.err).toContain('install scripts');
  expect((await git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
  expect(await readdir(checksWorktreePath(root, homedir(), '0'.repeat(36), process.platform).parent)).toEqual([]);
});
it('reports an export rename as NOT EQUIVALENT, or a note when explicitly allowed', async () => {
  await writeFile(path.join(root, 'sample.ts'), source.replace('value', 'renamed'));
  await git('add', '.'); await git('commit', '-m', 'rename');
  const failed = await review(['--deterministic-only']);
  expect(failed.code, failed.err).toBe(1); expect(failed.out).toContain('NOT EQUIVALENT');
  const allowed = await review(['--deterministic-only', '--allow-api-change']);
  expect(allowed.code, allowed.err).toBe(0); expect(allowed.out).toContain('NO BEHAVIOUR CHANGE FOUND');
});
it('reports a passing-base failing-head test as NOT EQUIVALENT and deterministic SARIF', async () => {
  await writeFile(path.join(root, 'sample.ts'), source.replace('return 2', 'return 0'));
  await git('add', '.'); await git('commit', '-m', 'regression');
  const r = await review(['--deterministic-only', '--sarif', '.quorum/report.sarif']);
  expect(r.code, r.err).toBe(1); expect(r.out).toContain('NOT EQUIVALENT');
  const sarif = JSON.parse(await readFile(path.join(root, '.quorum/report.sarif'), 'utf8'));
  expect(sarif.runs[0].results).toContainEqual(expect.objectContaining({
    ruleId: 'quorum-refactor/regression', properties: expect.objectContaining({ deterministic: true }),
  }));
});
it('rejects --no-checks before invoking git or a provider', async () => {
  const forbidden = vi.fn<CommandRunner>(async () => { throw new Error('must not run'); });
  const r = await review(['--no-checks'], { gitRunner: forbidden });
  expect(r.code).toBe(2); expect(r.err).toMatch(/refactor.*cannot.*without.*tests/i);
  expect(forbidden).not.toHaveBeenCalled(); expect(r.provider.calls).toHaveLength(0);
});
it.each([true, false])('dry-run describes both worktrees without execution (deterministic-only: %s)', async deterministicOnly => {
  const checkRunner = vi.fn<CommandRunner>();
  const before = await git('worktree', 'list', '--porcelain');
  const r = await review(['--dry-run', ...(deterministicOnly ? ['--deterministic-only'] : [])], { checkRunner });
  expect(r.code, r.err).toBe(0);
  expect(r.out).toMatch(/merge-base/i); expect(r.out).toMatch(/head/i);
  expect(r.out).toContain('runner.cjs'); expect(r.out).toContain('setup.cjs');
  expect(r.out).toContain(`Model review: ${deterministicOnly ? 'off' : 'on'}`);
  expect(checkRunner).not.toHaveBeenCalled(); expect(r.quota).not.toHaveBeenCalled();
  expect(await git('worktree', 'list', '--porcelain')).toBe(before);
});
it('uses the merge-base for a two-dot range whose requested base has diverged', async () => {
  const original = await git('rev-parse', 'base');
  const divergent = await git('commit-tree', 'HEAD^{tree}', '-p', original, '-m', 'divergent');
  await git('branch', 'divergent', divergent);
  const r = await review(['--deterministic-only', '--diff', 'divergent..HEAD']);
  expect(r.code, r.err).toBe(0);
  expect(r.result?.baseSha).toBe(original);
  expect(r.result?.refactor?.tests.base.total).toBe(1);
});
it('deterministic-only ignores model availability and CodeGraph even when configured', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'quorum.config.json'), 'utf8'));
  config.context = { provider: 'codegraph' };
  config.tiers = { triage: ['missing:unknown'], review: ['missing:unknown'], confirm: [], visual: [] };
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(config));
  await git('add', '.'); await git('commit', '-m', 'configure unavailable providers');
  const contextProvider = { name: 'codegraph', available: vi.fn(async () => true), enrich: vi.fn() };
  const contextRunner = vi.fn<CommandRunner>(async () => { throw new Error('No context calls permitted'); });
  const r = await review(['--deterministic-only', '--trust-head-config'], { contextProvider, contextRunner });
  expect(r.code, r.err).toBe(0);
  expect(contextProvider.available).not.toHaveBeenCalled(); expect(contextProvider.enrich).not.toHaveBeenCalled();
  expect(contextRunner).not.toHaveBeenCalled(); expect(r.quota).not.toHaveBeenCalled();
});
it.each(['base', 'head'].flatMap(side => ['setup', 'missing', 'timeout'].map(failure => [side, failure] as const)))('marks %s %s evidence unavailable as UNKNOWN and exit 2', async (side, failure) => {
  const checkRunner: CommandRunner = async (command, args, options) => {
    const isHead = (await readFile(path.join(options!.cwd!, 'sample.ts'), 'utf8')) === source;
    if (isHead !== (side === 'head')) return runCommand(command, args, options);
    if (failure === 'timeout') throw new CommandTimeoutError('', 'synthetic timeout');
    return { exitCode: failure === 'setup' && args.includes('setup.cjs') ? 1 : 0, stdout: '', stderr: '' };
  };
  const r = await review(['--deterministic-only'], { checkRunner });
  expect(r.code, r.err).toBe(2); expect(r.out).toContain('UNKNOWN');
  expect(r.result?.coverage.complete).toBe(false);
  expect(r.result?.refactor?.reasons.join(' ')).toContain(side + ':');
});
it.each(['IMPORTANT', 'BLOCKER'] as const)('uses FakeProvider and verified %s evidence in the normal cascade', async severity => {
  const item = finding({ severity, evidence_quote: source.trim(), trigger: 'Return value changed', impact: 'Callers observe a different number' });
  const agy = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([item])] });
  const codex = new FakeProvider('codex', 'openai', runner, { codex: [JSON.stringify({ decision: 'confirm', evidence_quote: source.trim() })] });
  const r = await review([], { providers: new Map([['agy', agy], ['codex', codex]]) });
  expect(r.code, r.err).toBe(severity === 'BLOCKER' ? 1 : 0);
  expect(r.out).toContain(severity === 'BLOCKER' ? 'NOT EQUIVALENT' : 'SUSPECT');
  expect(r.result?.findings[0]).toMatchObject({ verified: true, severity });
  expect(agy.calls[0]?.prompt).toContain('UNTRUSTED DETERMINISTIC EVIDENCE');
  expect(agy.calls[0]?.prompt).toContain('observable behaviour');
});

it.each([true, false])('samples mutants end to end with zero quota (pinned: %s)', async pinned => {
  let calls = 0;
  const checkRunner: CommandRunner = async (_command, args, options) => {
    if (!args.some(arg => arg.startsWith('--outputFile='))) return { exitCode: 0, stdout: '', stderr: '' };
    calls++;
    const text = await readFile(path.join(options!.cwd!, 'sample.ts'), 'utf8');
    const failed = pinned && ![source, source.replace('return 2', 'return 1')].includes(text);
    await writeFile(args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length), JSON.stringify({ testResults: [{
      name: path.join(options!.cwd!, 'sample.test.ts'), assertionResults: [{ title: 'value', status: failed ? 'failed' : 'passed', failureMessages: failed ? ['AssertionError: wrong value'] : [] }],
    }] }));
    return { exitCode: failed ? 1 : 0, stdout: '', stderr: '' };
  };
  const r = await review(['--deterministic-only', '--mutation', '--sarif', '.quorum/mutation.sarif'], { checkRunner });
  expect(r.code, r.err).toBe(0);
  expect(r.result?.refactor?.verdict).toBe(pinned ? 'NO BEHAVIOUR CHANGE FOUND' : 'SUSPECT');
  expect(r.result?.refactor?.mutation).toMatchObject({ attempted: 2, killed: pinned ? 2 : 0, invalid: 0 });
  expect(r.result?.refactor?.mutation?.survived).toHaveLength(pinned ? 0 : 2);
  expect(calls).toBe(4); expect(r.provider.calls).toHaveLength(0); expect(r.quota).not.toHaveBeenCalled();
  expect(await readFile(path.join(root, 'sample.ts'), 'utf8')).toBe(source);
  expect(await readFile(path.join(root, '.quorum/report.md'), 'utf8')).toContain('## Mutation sampling');
  const sarif = JSON.parse(await readFile(path.join(root, '.quorum/mutation.sarif'), 'utf8'));
  expect(sarif.runs[0].results.filter((item: { ruleId: string }) => item.ruleId === 'quorum-refactor/mutant-survived')).toHaveLength(pinned ? 0 : 2);
});
it('dry-run prints mutation limits without running checks', async () => {
  const checkRunner = vi.fn<CommandRunner>();
  const r = await review(['--deterministic-only', '--mutation', '--dry-run'], { checkRunner });
  expect(r.out).toContain('max mutants: 8'); expect(r.out).toContain('budget: 300 seconds');
  expect(checkRunner).not.toHaveBeenCalled(); expect(r.quota).not.toHaveBeenCalled();
});
it('rejects mutation outside refactor mode before executing anything', async () => {
  let err = '';
  const forbidden = vi.fn<CommandRunner>(async () => { throw new Error('must not run'); });
  const code = await main(['review', '--mode', 'bughunt', '--mutation'], { out: () => {}, err: text => { err += text; } }, { gitRunner: forbidden });
  expect(code).toBe(2); expect(err).toContain('--mutation require'); expect(forbidden).not.toHaveBeenCalled();
});

it('mutation configuration alone does not enable sampling', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'quorum.config.json'), 'utf8'));
  config.refactor.mutation = { maxMutants: 1, budgetSeconds: 30 };
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(config));
  await git('add', '.'); await git('commit', '-m', 'configure mutation limits');
  const r = await review(['--deterministic-only', '--trust-head-config']);
  expect(r.code, r.err).toBe(0); expect(r.result?.refactor?.mutation).toBeUndefined();
  expect(r.quota).not.toHaveBeenCalled();
});
