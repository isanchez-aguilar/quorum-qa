import { resolveCommand, type ResolveOptions } from '../checks/resolver.js';
import { runCommand, CommandTimeoutError, CommandOutputLimitError } from '../process/runner.js';
import type { CommandRunner } from '../types/index.js';
import { ProviderError, type ReviewOptions } from './types.js';

export interface AdapterOptions extends Pick<ResolveOptions, 'env' | 'platform' | 'exists'> {
  runner?: CommandRunner;
  now?: () => number;
}
export const quotaLanguage = (text: string): boolean => /RESOURCE_EXHAUSTED|quota|429|rate limit/i.test(text);
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
      if ((error instanceof CommandTimeoutError || error instanceof CommandOutputLimitError)
        && quotaLanguage(error.stdout + '\n' + error.stderr)) throw new ProviderError('quota', name + ' quota exhausted or rate limited');
      if (error instanceof CommandTimeoutError) throw new ProviderError('timeout', `${name} timed out`);
      throw new ProviderError('unavailable', `${name} call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

