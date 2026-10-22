import { expect, it, vi } from 'vitest';
import { evaluateRefactorVerdict } from '../../src/cli/refactor.js';
import { main } from '../../src/cli/index.js';
import { compareTests, summarizeEvidence, type RefactorEvidence } from '../../src/refactor/index.js';
import { compareApi } from '../../src/refactor/api.js';
import type { TestReport } from '../../src/types/index.js';
import type { RuleRun } from '../../src/rules/index.js';
import { validateConfig } from '../../src/config/index.js';

const report = (tests: TestReport['tests']): TestReport => ({ runner: 'vitest', tests, suiteErrors: [] });
const test = (name: string, status: 'passed' | 'failed' | 'skipped') => ({ file: `${name}.test.ts`, name, status });
const clean = { findings: [], unconfirmed: [], errors: [], coverage: {
  reviewedFiles: [], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: true,
} };
function evidence(base: TestReport['tests'], head: TestReport['tests']): RefactorEvidence {
  return { available: true, reasons: [], summary: '', tests: compareTests(report(base), report(head)),
    api: { changes: [], packageChanges: [], breaking: false, notes: [] }, blastRadius: { dependents: [], withoutTests: [], notes: [] } };
}
it.each(['timeout', 'long-line', 'unavailable', 'coverage'])('M1: partial %s evidence never becomes clean through warning rules', partial => {
  const e = evidence([test('old', 'passed')], [test('old', 'passed')]);
  const c = { ...clean, coverage: { ...clean.coverage, complete: partial !== 'coverage' } };
  e.available = partial !== 'unavailable';
  const rules: RuleRun = { passed: true, notes: [], results: [{
    rule: { id: 'guard', severity: 'warning', pattern: 'unsafe', message: 'Guard' },
    totalMatches: 1, matches: [{ file: 'a.ts', line: 2, text: 'unsafe' }],
    timedOut: partial === 'timeout', skippedLongLines: partial === 'long-line' ? 1 : 0,
  }] };
  expect(evaluateRefactorVerdict(e, c, false, rules)).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2 });
  rules.passed = false; rules.results[0]!.rule.severity = 'error';
  expect(evaluateRefactorVerdict(e, c, false, rules)).toMatchObject({ verdict: 'NOT EQUIVALENT', exitCode: 1 });
});
it.each(['added', 'skipped', 'passed'])('M2: %s test failing at head is a new failure', before => {
  const e = evidence([test('old', 'passed'), ...(before === 'added' ? [] : [test('new', before as 'passed' | 'skipped')])],
    [test('old', 'passed'), test('new', 'failed')]);
  const result = evaluateRefactorVerdict(e, clean);
  expect(result).toMatchObject({ verdict: 'NOT EQUIVALENT', exitCode: 1 });
  expect(result.reasons.join(' ')).toContain('1 tests fail at head that did not fail at base');
  expect(result.reasons.join(' ')).toContain('new');
});
it('M2: passed to skipped without an edited file is suspect', () => {
  const result = evaluateRefactorVerdict(evidence([test('old', 'passed')], [test('old', 'skipped')]), clean);
  expect(result).toMatchObject({ verdict: 'SUSPECT', exitCode: 0 });
  expect(result.reasons.join(' ')).toContain('1 tests were passing and are now skipped');
});
it('M2: failing at both revisions is suspect, not a new failure', () => {
  const e = evidence([test('old', 'failed')], [test('old', 'failed')]);
  expect(e.tests.failingBoth).toHaveLength(1);
  expect(e.tests.regressions).toEqual([]);
  expect(evaluateRefactorVerdict(e, clean)).toMatchObject({ verdict: 'SUSPECT', exitCode: 0 });
});
it('M2: clean and newly passing tests retain the clean verdict', () => {
  expect(evaluateRefactorVerdict(evidence([test('old', 'passed')], [test('old', 'passed'), test('new', 'passed')]), clean))
    .toMatchObject({ verdict: 'NO BEHAVIOUR CHANGE FOUND', exitCode: 0 });
});
it('M2: preserves passed-to-failed reporting while summarizing every new failure', () => {
  const e = evidence([test('old', 'passed'), test('skip', 'skipped')],
    [test('old', 'failed'), test('skip', 'failed'), test('new', 'failed')]);
  expect(e.tests.regressions.map(item => item.name)).toEqual(['old']);
  expect(JSON.parse(summarizeEvidence(e)).newFailures.map((item: { name: string }) => item.name)).toEqual(['old', 'skip', 'new']);
});
it.each(['exports', 'imports', 'typesVersions'])('M3: %s key order is significant at every depth', field => {
  for (const wrap of [(v: unknown) => v, (v: unknown) => ({ nested: v }), (v: unknown) => [{ nested: v }]]) {
    const result = compareApi(new Map(), new Map(), { [field]: wrap({ node: './node.js', default: './fallback.js' }) },
      { [field]: wrap({ default: './fallback.js', node: './node.js' }) });
    expect(result.breaking).toBe(true);
    expect(result.packageChanges.map(change => change.field)).toEqual([field]);
  }
});
it('M3: engines and peerDependencies remain order insensitive', () => {
  for (const field of ['engines', 'peerDependencies']) expect(compareApi(new Map(), new Map(),
    { [field]: { node: '22', pnpm: '9' } }, { [field]: { pnpm: '9', node: '22' } }).packageChanges).toEqual([]);
});
it.each(['enum', 'const enum', 'declare enum'])('M4: implicit values in %s track reorder, insertion and removal', kind => {
  const compare = (before: string, after: string) => compareApi(new Map([['a.ts', `export ${kind} State { ${before} }`]]),
    new Map([['a.ts', `export ${kind} State { ${after} }`]]));
  for (const [before, after] of [['Ready, Done', 'Done, Ready'], ['Ready, Done', 'New, Ready, Done'],
    ['Ready, Done', 'Done'], ['Ready = 4, Done', 'Done, Ready = 4']]) {
    const result = compare(before!, after!);
    expect(result.breaking).toBe(true);
    expect(result.changes.some(change => change.kind === 'changed' && change.breaking)).toBe(true);
  }
  expect(compare('Ready = 4, Done = 8', 'Done = 8, Ready = 4')).toMatchObject({ changes: [], breaking: false, incomplete: false });
});
it.each([['doctor', '--probe'], ['doctor'], ['rules', 'propose'], ['help'], ['version'], ['--help'], ['--version'],
  ['review', '--help'], ['review', '--version']])('K4: rejects ignored dry-run for %j', async (...args) => {
  const runDoctor = vi.fn(async () => []);
  const loadConfig = vi.fn(async () => validateConfig({ checks: [] }));
  let err = '';
  const code = await main([...args, '--dry-run'], { out: () => {}, err: text => { err += text; } }, { runDoctor, loadConfig });
  expect(code).toBe(2);
  expect(err).toContain(args.includes('--probe') ? '--dry-run cannot be combined with --probe: a dry run never calls a provider' : '--dry-run is only supported by review');
  expect(runDoctor).not.toHaveBeenCalled(); expect(loadConfig).not.toHaveBeenCalled();
});
