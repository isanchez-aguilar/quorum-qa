import { performance } from 'node:perf_hooks';
import type { CommandRunner, QuorumConfig } from '../types/index.js';
import { cacheReplay, summarizeCheckOutput } from './output.js';
import { CommandOutputLimitError, CommandTimeoutError } from '../process/runner.js';
import { resolveCommand } from './resolver.js';

/**
 * Does a failing check's output mention any file of the change? Cheap and conservative: a full
 * path or a bare file name counts, so output relative to a package directory is still attributed
 * to the change. Only an output that names none of them is reported as pre-existing.
 */
export function namesChangedFile(output: string, changedFiles: readonly string[]): boolean {
  const text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\\/g, '/');
  return changedFiles.some(file => {
    const path = file.replace(/\\/g, '/');
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!name) return false;
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      // A real file name, not the tail of a longer one (`xindex.ts`, `my-index.ts`).
      if (!/[\w.-]/.test(text[at - 1] ?? '')) return true;
    }
    return false;
  });
}

export async function runDeterministicChecks(
  checks: QuorumConfig['checks'], cwd: string, runner: CommandRunner,
  { timeoutMs = 120_000, changedFiles }: { timeoutMs?: number; changedFiles?: readonly string[] } = {},
) {
  const results: Array<{ argv: string[]; exitCode: number; durationMs: number; timedOut: boolean; timeoutMs: number;
    stdoutTail: string; stderrTail: string; cached?: string; preExisting?: boolean }> = [];
  for (const argv of checks) {
    const start = performance.now();
    let exitCode = 1;
    let timedOut = false;
    let completed = false;
    let stdout = '';
    let stderr = '';
    try {
      if (!argv[0]) throw new Error('Check must contain a command');
      const resolved = resolveCommand(argv[0], argv.slice(1), { cwd });
      ({ exitCode, stdout, stderr } = await runner(resolved.file, resolved.args, {
        cwd, timeoutMs, windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      }));
      completed = true;
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
    // Attribute only a command that ran and exited non-zero; a spawn error, timeout or output
    // overflow says nothing about which files it blames. The full output is read, not the kept tail.
    if (changedFiles && completed && exitCode !== 0 && !namesChangedFile(`${stdout}\n${stderr}`, changedFiles)) results.at(-1)!.preExisting = true;
    // Read the full output: the kept tail may no longer hold the runner's cache summary.
    const cached = exitCode === 0 && !timedOut ? cacheReplay(`${stdout}\n${stderr}`) : undefined;
    if (cached) results.at(-1)!.cached = cached;
  }
  return { passed: results.every(result => result.exitCode === 0 && !result.timedOut), results };
}
