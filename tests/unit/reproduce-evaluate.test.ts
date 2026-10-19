import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { evaluateReproduction, infrastructureFailure, infrastructureReason, parseTestReport, passedAtBase } from '../../src/reproduce/evaluate.js';
import type { TestReport } from '../../src/types/index.js';

const testFile = 'tests/reproduction.test.ts';
async function fixture(runner: 'vitest' | 'jest') {
  return JSON.parse(await readFile(new URL(`../fixtures/reproduce/${runner}.json`, import.meta.url), 'utf8'));
}
function report(tests: TestReport['tests'] = []): TestReport {
  return { runner: 'vitest', suiteErrors: [], tests };
}
function test(overrides: Partial<TestReport['tests'][number]> = {}): TestReport['tests'][number] {
  return { file: testFile, name: 'synthetic test', status: 'failed', failureKind: 'assertion', message: 'AssertionError: expected 1 to be +0', ...overrides };
}

describe('vitest and Jest JSON reporters', () => {
  it.each(['vitest', 'jest'] as const)('parses synthetic recorded %s JSON and matching assertion', async runner => {
    const parsed = parseTestReport(JSON.stringify(await fixture(runner)))!;
    expect(parsed.runner).toBe(runner);
    expect(parsed.suiteErrors).toEqual([]);
    expect(parsed.tests).toHaveLength(1);
    expect(parsed.tests[0]).toMatchObject({ file: testFile, status: 'failed', failureKind: 'assertion' });
    expect(evaluateReproduction(parsed, testFile, runner === 'vitest' ? 'expected 1' : 'expect(received).toBe(expected)')).toBe('assertion-failure-matching');
    expect(passedAtBase(parsed, testFile)).toBe(false);
  });
  it.each(['vitest', 'jest'] as const)('parses a passing %s report at base independently of expect', async runner => {
    const raw = await fixture(runner);
    raw.testResults[0].message = '';
    raw.testResults[0].status = 'passed';
    raw.testResults[0].assertionResults[0].status = 'passed';
    raw.testResults[0].assertionResults[0].failureMessages = [];
    const parsed = parseTestReport(raw)!;
    expect(evaluateReproduction(parsed, testFile, 'not present')).toBe('passed');
    expect(passedAtBase(parsed, testFile)).toBe(true);
  });
  it.each([
    ['SyntaxError: Unexpected token', 'syntax'],
    ['Error: Cannot find module synthetic-missing', 'import'],
    ['Error: Failed to resolve import synthetic-missing', 'import'],
    ['TransformError: transform failed', 'syntax'],
    ['Error: Test timed out in 5000ms', 'timeout'],
    ['Error: ordinary thrown error', 'error'],
  ])('classifies %s as a non-assertion %s', async (message, kind) => {
    const raw = await fixture('vitest');
    raw.testResults[0].assertionResults[0].failureMessages = [message];
    const parsed = parseTestReport(raw)!;
    expect(parsed.tests[0]?.failureKind).toBe(kind);
    expect(evaluateReproduction(parsed, testFile, message)).toBe('non-assertion-failure');
    expect(infrastructureFailure(parsed)).toBeUndefined();
  });
  it.each(['vitest', 'jest'] as const)('does not mistake a %s suite import error for an assertion', async runner => {
    const raw = await fixture(runner);
    raw.testResults[0].assertionResults = [];
    raw.testResults[0].message = 'Cannot find module synthetic-missing';
    if (runner === 'jest') raw.testResults[0].testExecError = { message: 'Cannot find module synthetic-missing' };
    const parsed = parseTestReport(raw)!;
    expect(evaluateReproduction(parsed, testFile, 'Cannot find module')).toBe('non-assertion-failure');
    expect(passedAtBase(parsed, testFile)).toBe(false);
  });
  it('normalizes host reporter Windows absolute paths', async () => {
    const raw = await fixture('vitest');
    raw.testResults[0].name = 'C:\\temp\\worktree\\tests\\reproduction.test.ts';
    expect(parseTestReport(raw, 'C:\\temp\\worktree')?.tests[0]?.file).toBe(testFile);
  });
  it('compares the worktree prefix case-insensitively on win32', async () => {
    const raw = await fixture('vitest');
    raw.testResults[0].name = 'c:/TEMP/WORKTREE/tests/reproduction.test.ts';
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try { expect(parseTestReport(raw, 'C:/temp/worktree')?.tests[0]?.file).toBe(testFile); }
    finally { platform.mockRestore(); }
  });
  it('keeps a different root absolute so it cannot impersonate the target', async () => {
    const raw = await fixture('vitest');
    raw.testResults[0].name = '/work-other/tests/reproduction.test.ts';
    expect(evaluateReproduction(parseTestReport(raw)!, testFile, 'expected 1')).toBe('unproven');
  });
  it.each([null, '', 'not json', {}, { testResults: [null] }, { testResults: [{ name: 'x', assertionResults: [{}] }] }])('refuses malformed reports %j', raw => {
    expect(parseTestReport(raw)).toBeNull();
  });
  it('uses the first failure line and strips terminal color escapes', async () => {
    const raw = await fixture('vitest');
    raw.testResults[0].assertionResults[0].failureMessages = ['\u001b[31mAssertionError: expected zero\u001b[0m\nstack and detail'];
    const parsed = parseTestReport(raw)!;
    expect(parsed.tests[0]?.message).toBe('AssertionError: expected zero');
    expect(evaluateReproduction(parsed, testFile, 'stack and detail')).toBe('assertion-failure-other-message');
  });
  it('does not let one assertion hide a second runtime error', async () => {
    const raw = await fixture('vitest');
    raw.testResults[0].assertionResults[0].failureMessages.push('Error: cleanup failed');
    expect(evaluateReproduction(parseTestReport(raw)!, testFile, 'expected 1')).toBe('non-assertion-failure');
  });
});

describe('evaluation', () => {
  it('matches an assertion message literally and rejects the wrong message', () => {
    expect(evaluateReproduction(report([test()]), testFile, 'expected 1')).toBe('assertion-failure-matching');
    expect(evaluateReproduction(report([test()]), testFile, 'expected 2')).toBe('assertion-failure-other-message');
    expect(evaluateReproduction(report([test()]), testFile, '.*')).toBe('assertion-failure-other-message');
    expect(evaluateReproduction(report([test()]), testFile, '')).toBe('assertion-failure-other-message');
  });
  it('ignores another test failure for reproduction and base passing', () => {
    const parsed = report([test({ status: 'passed' }), test({ file: 'tests/other.test.ts' })]);
    expect(evaluateReproduction(parsed, testFile, 'expected 1')).toBe('other-test-failed');
    expect(passedAtBase(parsed, testFile)).toBe(false);
  });
  it('requires a target test to run and pass at base', () => {
    expect(passedAtBase(report([]), testFile)).toBe(false);
    expect(passedAtBase(report([test({ status: 'skipped' })]), testFile)).toBe(false);
    expect(passedAtBase(report([test({ status: 'passed', file: 'other.test.ts' })]), testFile)).toBe(false);
    expect(passedAtBase(report([test({ status: 'passed' }), test()]), testFile)).toBe(false);
    expect(passedAtBase(report([test({ status: 'passed' })]), testFile)).toBe(true);
  });
  it('does not allow a suite error to coexist with reproduced or passed', () => {
    const parsed = { ...report([test()]), suiteErrors: ['SyntaxError: bad fixture'] };
    expect(evaluateReproduction(parsed, testFile, 'expected 1')).toBe('non-assertion-failure');
    expect(passedAtBase(parsed, testFile)).toBe(false);
  });
});

describe('infrastructure classification', () => {
  it.each(['signature accepted for tampered payload', 'user was signed out', 'expected signal to abort', 'process was killed', 'Process exited with signal SIGKILL', 'out of memory'])
  ('does not classify assertion text as infrastructure: %s', async text => {
    const raw = await fixture('vitest');
    const message = `AssertionError: ${text}`;
    raw.testResults[0].assertionResults[0].failureMessages = [message];
    const parsed = parseTestReport(raw)!;
    expect(infrastructureFailure(parsed)).toBeUndefined();
    expect(evaluateReproduction(parsed, testFile, text)).toBe('assertion-failure-matching');
    expect(infrastructureFailure(report([test({ message })]))).toBeUndefined();
  });
  it.each(['signature accepted for tampered payload', 'user was signed out', 'expected signal to abort', 'killed', 'sigkill', 'SIGKILLING'])
  ('does not infer infrastructure from ordinary suite text: %s', message => {
    expect(infrastructureFailure({ ...report(), suiteErrors: [message] })).toBeUndefined();
  });
  it.each(['Worker terminated due to reaching memory limit: JS heap out of memory', 'Process exited with signal SIGKILL', 'process was killed', 'terminated by signal', 'SIGSEGV', 'SIGTERM', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGFPE'])
  ('recognizes suite infrastructure: %s', message => {
    expect(infrastructureFailure({ ...report(), suiteErrors: [message] })).toBe('test infrastructure failure');
  });
  it('keeps missing or skipped targets unproven even alongside unrelated suite errors', () => {
    const missing = parseTestReport({ testResults: [{ name: '/work/other.test.ts', message: 'SyntaxError: invalid', assertionResults: [] }] })!;
    expect(infrastructureFailure(missing, '', testFile)).toBe('target test missing from report');
    expect(evaluateReproduction(missing, testFile, 'invalid')).toBe('unproven');
    const skipped = { ...report([test({ status: 'skipped' })]), suiteErrors: ['SyntaxError: other suite'] };
    expect(infrastructureFailure(skipped, '', testFile)).toBe('target test only skipped');
  });
  it.each([
    ['EROFS: read-only file system, mkdir /work/node_modules/.vite', 'cache is not writable'],
    ['EACCES: permission denied, open /work/node_modules/.cache/file', 'cache is not writable'],
    ['cache setup: EACCES', 'cache is not writable'],
    ['pnpm: command not found', 'command not found'],
    ['executable file not found in PATH', 'command not found'],
    ['Error: spawn pnpm ENOENT', 'command not found'],
  ])('recognizes %s as %s', (message, expected) => {
    expect(infrastructureReason(message)).toBe(expected);
    expect(infrastructureFailure(report(), message)).toBe(expected);
    expect(infrastructureFailure({ ...report(), suiteErrors: [message] })).toBe(expected);
  });
  it('missing report is infrastructure, not a failed assertion', () => {
    expect(infrastructureFailure(null)).toBe('missing test report');
  });
  it('does not label arbitrary file access or import failures infrastructure', () => {
    expect(infrastructureReason('EACCES: open /outside/protected')).toBeUndefined();
    expect(infrastructureReason('Error: Cannot find module missing')).toBeUndefined();
  });
  it('retains infrastructure errors beyond the first failure message line', async () => {
    const raw = await fixture('vitest');
    raw.testResults[0].assertionResults[0].failureMessages = ['Error: worker failed\nEROFS: open /work/node_modules/.vite/cache'];
    expect(infrastructureFailure(parseTestReport(raw))).toBe('cache is not writable');
  });
});
