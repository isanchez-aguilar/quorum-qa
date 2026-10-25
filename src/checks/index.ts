import { performance } from 'node:perf_hooks';
import type { CommandRunner, QuorumConfig } from '../types/index.js';
import { summarizeCheckOutput } from './output.js';
import { CommandOutputLimitError, CommandTimeoutError } from '../process/runner.js';
import { resolveCommand } from './resolver.js';

export async function runDeterministicChecks(
  checks: QuorumConfig['checks'], cwd: string, runner: CommandRunner,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
) {
  const results = [];
  for (const argv of checks) {
    const start = performance.now();
    let exitCode = 1;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    try {
      if (!argv[0]) throw new Error('Check must contain a command');
      const resolved = resolveCommand(argv[0], argv.slice(1), { cwd });
      ({ exitCode, stdout, stderr } = await runner(resolved.file, resolved.args, {
        cwd, timeoutMs, windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      }));
    } catch (error) {
      timedOut = error instanceof CommandTimeoutError;
      stdout = error instanceof CommandTimeoutError ? error.stdout : '';
      stderr = error instanceof CommandTimeoutError ? error.stderr : String(error);
      if (error instanceof CommandOutputLimitError) {
        exitCode = error.exitCode;
        stdout = [error.stdout, error.stdoutTail].filter(Boolean).join('\n');
        stderr = [error.stderr, error.stderrTail].filter(Boolean).join('\n');
      }
    }
    results.push({ argv: [...argv], exitCode, durationMs: performance.now() - start, timedOut, timeoutMs,
      stdoutTail: summarizeCheckOutput(stdout, exitCode !== 0 || timedOut), stderrTail: summarizeCheckOutput(stderr, exitCode !== 0 || timedOut) });
  }
  return { passed: results.every(result => result.exitCode === 0 && !result.timedOut), results };
}
