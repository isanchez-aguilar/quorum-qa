import { resolveCommand, type ResolveOptions } from '../checks/resolver.js';
import { runCommand, CommandTimeoutError, CommandOutputLimitError } from '../process/runner.js';
import type { CommandRunner } from '../types/index.js';
import { ProviderError, type ReviewOptions } from './types.js';

export interface AdapterOptions extends Pick<ResolveOptions, 'env' | 'platform' | 'exists'> {
  runner?: CommandRunner;
  now?: () => number;
}
export const quotaLanguage = (text: string): boolean => /RESOURCE_EXHAUSTED|\bquota\b|\b429\b|rate.?limit|\busage limit\b/i.test(text);

export function codexDiagnostics(stderr: string, prompt = ''): string {
  stderr = stderr.replace(/\r\n/g, '\n');
  prompt = prompt.replace(/\r\n/g, '\n');
  const echo = prompt ? stderr.lastIndexOf(prompt) : -1;
  const withoutEcho = echo < 0 ? stderr : stderr.slice(0, echo) + stderr.slice(echo + prompt.length);
  const tail = echo < 0 ? stderr : stderr.slice(echo + prompt.length);
  return [...withoutEcho.split(/\r?\n/).filter(line => /^(ERROR|error:)/.test(line)), ...tail.split(/\r?\n/).slice(-20)].join('\n');
}

export async function cleanupPreservingError(cleanup: () => Promise<void>, original: unknown, warn: (message: string) => void = console.warn): Promise<void> {
  try { await cleanup(); }
  catch (error) {
    const message = `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    if (original instanceof ProviderError) original.warnings.push(message);
    else warn(message);
  }
}
export function remaining(options: ReviewOptions, started: number, now: () => number): number {
  const value = options.deadlineMs - (now() - started);
  if (options.signal?.aborted || !Number.isFinite(value) || value <= 0) throw new ProviderError('timeout', 'Provider deadline reached');
  return value;
}
export class ProviderCommands {
  readonly run: CommandRunner;
  readonly now: () => number;
  constructor(readonly options: AdapterOptions = {}) {
    this.run = options.runner ?? runCommand;
    this.now = options.now ?? Date.now;
  }
  exceedsWindowsArgv(name: string, args: string[], cwd?: string): boolean {
    if ((this.options.platform ?? process.platform) !== 'win32') return false;
    const resolved = resolveCommand(name, args, { ...this.options, cwd });
    return [resolved.file, ...resolved.args].reduce((size, arg) => size + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0) >= 30_000;
  }
  async command(name: string, args: string[], cwd?: string, timeoutMs = 10_000, stdin?: string) {
    try {
      const resolved = resolveCommand(name, args, { ...this.options, cwd });
      if (name === 'agy' && (this.options.platform ?? process.platform) === 'win32'
        && [resolved.file, ...resolved.args].reduce((size, arg) => size + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0) >= 30_000) {
        throw new ProviderError('unavailable', 'agy argv exceeds the 30,000-character Windows limit');
      }
      return await this.run(resolved.file, resolved.args, { cwd, timeoutMs, stdin,
        env: this.options.env, windowsVerbatimArguments: resolved.windowsVerbatimArguments });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if ((error instanceof CommandTimeoutError || (error instanceof CommandOutputLimitError && error.exitCode !== 0))
        && quotaLanguage(name === 'codex' ? codexDiagnostics(error.stderr, stdin) : error.stderr)) throw new ProviderError('quota', name + ' quota exhausted or rate limited');
      if (error instanceof CommandTimeoutError) throw new ProviderError('timeout', `${name} timed out`);
      throw new ProviderError('unavailable', `${name} call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
