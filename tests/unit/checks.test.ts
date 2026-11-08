import { expect, it, vi } from 'vitest';
import { runDeterministicChecks } from '../../src/checks/index.js';
import { CommandOutputLimitError, CommandTimeoutError } from '../../src/process/runner.js';
import type { CommandRunner } from '../../src/types/index.js';

it('records pass, failure and timeout and continues', async () => {
  const runner = vi.fn<CommandRunner>()
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 124, stdout: '', stderr: 'failed' })
    .mockRejectedValueOnce(new CommandTimeoutError('partial', 'deadline'));
  const checks = [[process.execPath, 'a'], [process.execPath, 'b'], [process.execPath, 'c']];
  const result = await runDeterministicChecks(checks, process.cwd(), runner, { timeoutMs: 50 });
  expect(result.passed).toBe(false);
  expect(result.results.map(item => [item.exitCode, item.timedOut])).toEqual([[0, false], [124, false], [1, true]]);
  expect(result.results[2]?.stdoutTail).toBe('partial');
  expect(result.results.every(item => 'timeoutMs' in item && item.timeoutMs === 50)).toBe(true);
  expect(result.results.map(item => item.argv)).toEqual(checks);
  expect(result.results.every(item => item.durationMs >= 0)).toBe(true);
  expect(runner).toHaveBeenCalledWith(process.execPath, ['a'], {
    cwd: process.cwd(), timeoutMs: 50, windowsVerbatimArguments: undefined,
  });
});

it('caps both tails at 4 KiB including UTF-8', async () => {
  const runner: CommandRunner = async () => ({ exitCode: 0, stdout: 'x'.repeat(5000) + 'END', stderr: '😀'.repeat(2000) + 'END' });
  const result = await runDeterministicChecks([[process.execPath]], process.cwd(), runner);
  expect(result.passed).toBe(true);
  for (const tail of [result.results[0]!.stdoutTail, result.results[0]!.stderrTail]) {
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(tail.endsWith('END')).toBe(true);
    expect(tail).not.toContain('\ufffd');
  }
});

it('accepts no checks and reports resolution failures', async () => {
  const runner = vi.fn<CommandRunner>();
  expect(await runDeterministicChecks([], process.cwd(), runner)).toEqual({ passed: true, results: [] });
  const result = await runDeterministicChecks([['quorum-synthetic-missing-program']], process.cwd(), runner);
  expect(result.passed).toBe(false);
  expect(result.results[0]?.stderrTail).toContain('Command not found');
  expect(runner).not.toHaveBeenCalled();
});

it('uses the exit code and tails when capture overflowed', async () => {
  const runner: CommandRunner = async () => {
    throw new CommandOutputLimitError('prefix', '', 'x'.repeat(5000) + 'END', 'last error', 7);
  };
  const result = await runDeterministicChecks([[process.execPath]], process.cwd(), runner);
  expect(result.passed).toBe(false);
  expect(result.results[0]).toMatchObject({ exitCode: 7, timedOut: false, stderrTail: 'last error' });
  expect(result.results[0]!.stdoutTail).toHaveLength(4096);
  expect(result.results[0]!.stdoutTail.endsWith('END')).toBe(true);
});

it.each([
  ['a full relative path', 'src/app/sample.ts(3,1): error TS2304', true],
  ['a bare file name from a package-relative run', 'FAIL  sample.ts > loads', true],
  ['a Windows absolute path', String.raw`C:\work\tree\src\app\sample.ts` + '\n  1:1  error  no-require-imports', true],
  ['a Windows path whose case differs', String.raw`C:\Work\Tree\SRC\APP\Sample.TS(3,1): error`, true],
  ['colored output', '\x1b[31mFAIL\x1b[0m \x1b[1msample.ts\x1b[0m', true],
  ['a name at the end of a sentence', 'could not parse sample.ts.', true],
  ['no file of the change', '/work/OfflineBanner.test.tsx\n  4:9  error  no-require-imports', false],
  ['the tail of a longer file name', 'my-sample.ts 1:1 error', false],
  ['the head of a longer file name', 'src/app/sample.tsx(3,1): error', false],
  ['the head of a longer extension chain', 'wrote sample.ts.map', false],
  ['empty output', '', false],
])('notes whether the output names a changed file from %s', async (_label, output, named) => {
  const runner: CommandRunner = async () => ({ exitCode: 1, stdout: '', stderr: output });
  const result = await runDeterministicChecks([['pnpm', 'run', 'lint']], process.cwd(), runner, { changedFiles: ['src/app/sample.ts'] });
  expect(result.passed).toBe(false);
  expect(result.results[0]).toMatchObject({ exitCode: 1, timedOut: false });
  expect(result.results[0]?.namesNoChangedFile).toBe(named ? undefined : true);
});

it('keeps the failure and only flags the unknown origin when an unchanged consumer reports the error', async () => {
  // The change removed an export from src/api.ts; TypeScript reports the break in src/consumer.ts.
  const runner: CommandRunner = async () => ({ exitCode: 2, stdout: "src/consumer.ts(4,10): error TS2305: Module './api' has no exported member 'gone'.", stderr: '' });
  const result = await runDeterministicChecks([['pnpm', 'typecheck']], process.cwd(), runner, { changedFiles: ['src/api.ts'] });
  expect(result.passed).toBe(false);
  expect(result.results[0]).toMatchObject({ exitCode: 2, namesNoChangedFile: true });
  expect(result.results[0]).not.toHaveProperty('preExisting');
});

it('judges the output on the full text, not on the kept tail', async () => {
  const runner: CommandRunner = async () => ({ exitCode: 1, stdout: 'sample.ts failed\n' + 'noise\n'.repeat(5000), stderr: '' });
  const result = await runDeterministicChecks([['pnpm', 'test']], process.cwd(), runner, { changedFiles: ['sample.ts'] });
  expect(result.results[0]?.stdoutTail).not.toContain('sample.ts');
  expect(result.results[0]?.namesNoChangedFile).toBeUndefined();
});

it('never flags passes, timeouts, spawn errors or runs without a changed-file list', async () => {
  const changedFiles = ['sample.ts'];
  const passed = await runDeterministicChecks([['a']], process.cwd(), async () => ({ exitCode: 0, stdout: '', stderr: '' }), { changedFiles });
  expect(passed.results[0]?.namesNoChangedFile).toBeUndefined();
  const timed = await runDeterministicChecks([['a']], process.cwd(), async () => { throw new CommandTimeoutError('', 'deadline'); }, { changedFiles });
  expect(timed.results[0]?.namesNoChangedFile).toBeUndefined();
  const spawnError = await runDeterministicChecks([['a']], process.cwd(), async () => { throw new Error('spawn ENOENT'); }, { changedFiles });
  expect(spawnError.results[0]).toMatchObject({ exitCode: 1 });
  expect(spawnError.results[0]?.namesNoChangedFile).toBeUndefined();
  const unlisted = await runDeterministicChecks([['a']], process.cwd(), async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }));
  expect(unlisted.results[0]?.namesNoChangedFile).toBeUndefined();
  expect(unlisted.passed).toBe(false);
});

it('gives the models a neutral note, never a pre-existing claim', async () => {
  const { checkEvidence } = await import('../../src/checks/output.js');
  const base = { argv: ['pnpm', 'run', 'lint'], exitCode: 1, timedOut: false, timeoutMs: 1000, stdoutTail: 'x', stderrTail: 'y' };
  const flagged = checkEvidence([{ ...base, namesNoChangedFile: true }]);
  expect(JSON.parse(flagged)[0]).toMatchObject({ note: 'no changed file named in its output; origin unknown' });
  expect(flagged).not.toContain('pre-existing');
  expect(JSON.parse(checkEvidence([base]))[0]).not.toHaveProperty('note');
});
