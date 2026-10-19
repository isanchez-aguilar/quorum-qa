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
