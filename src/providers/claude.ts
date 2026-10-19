import type { ReviewContext } from '../types/index.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';
import { isRecord } from '../cascade/parse.js';
import { ProviderCommands, quotaLanguage, remaining, cleanupPreservingError } from './commands.js';
import { ProviderError, type ProviderAdapter, type Quota, type RawProviderResult, type ReviewOptions } from './types.js';

export const claudeArgs = (model: string): string[] => ['-p', '--output-format', 'json', '--model', model,
  '--no-session-persistence', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk'];

// ASSUMPTION 10: never salvage nested findings from an unknown envelope.
export function claudeEnvelope(stdout: string): Record<string, unknown> | undefined {
  try { const value: unknown = JSON.parse(stdout); return isRecord(value) ? value : undefined; }
  catch { return undefined; }
}
// Recorded on 2026-10-19: an expired login answers exit 1 with {"is_error": true, "subtype": "success",
// "terminal_reason": "api_error", "result": "Failed to authenticate: OAuth session expired ..."}.
export const CLAUDE_LOGIN_HINT = 'claude login expired or missing: run `claude` and sign in';
export function claudeAuthFailure(envelope: Record<string, unknown> | undefined): boolean {
  return envelope?.is_error === true && typeof envelope.result === 'string'
    && /failed to authenticate|oauth|not logged in|please (?:log|sign) in/i.test(envelope.result.slice(0, 300));
}
export function claudeAnswer(envelope: Record<string, unknown> | undefined): string | undefined {
  return envelope?.subtype === 'success' && (envelope.is_error === undefined || envelope.is_error === false)
    && typeof envelope.result === 'string' ? envelope.result : undefined;
}

export class ClaudeProvider extends ProviderCommands implements ProviderAdapter {
  readonly name = 'claude';
  readonly defaultFamily = 'anthropic';
  async probe(_modelId: string) {
    try { return { available: (await this.command('claude', ['--version'])).exitCode === 0 }; }
    catch (error) { return { available: false, error: String(error) }; }
  }
  async getQuota(_modelId: string): Promise<Quota> { return 'unknown'; }
  async executeReview(context: ReviewContext, modelId: string, prompt: string, options: ReviewOptions): Promise<RawProviderResult> {
    const started = this.now();
    remaining(options, started, this.now);
    const worktree = await createReviewWorktree(context.worktreeRoot, context.headCommit, this.run, options.warn);
    let failure: unknown;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await this.command('claude', claudeArgs(modelId), worktree.path, remaining(options, started, this.now), prompt)
          .finally(() => options.assertCheckoutUnchanged?.());
        const envelope = claudeEnvelope(result.stdout);
        const failed = result.exitCode !== 0 || envelope?.is_error === true
          || (typeof envelope?.subtype === 'string' && envelope.subtype !== 'success');
        // Only explicit error envelopes put diagnostics rather than answer text in `result`.
        const errorResult = envelope?.is_error === true && typeof envelope.result === 'string' ? envelope.result.slice(0, 300) : '';
        if (failed && claudeAuthFailure(envelope)) throw new ProviderError('unavailable', CLAUDE_LOGIN_HINT);
        if (failed && quotaLanguage(result.stderr + '\n' + JSON.stringify([envelope?.subtype, envelope?.error, envelope?.errors]) + '\n' + errorResult)) {
          throw new ProviderError('quota', 'claude quota exhausted or rate limited');
        }
        const rawOutput = claudeAnswer(envelope) ?? 'Invalid Claude result envelope';
        const clean = await isClean(worktree.path, this.run);
        if (!clean) return { rawOutput, durationMs: this.now() - started, worktreeClean: false };
        if (attempt === 0 && result.exitCode !== 0 && !result.stdout.trim()) {
          remaining(options, started, this.now);
          if (options.reserveRetry && !options.reserveRetry()) throw new ProviderError('unavailable', 'Claude retry denied: review budget ceiling reached');
          continue;
        }
        if (failed) throw new ProviderError('unavailable', 'claude call failed');
        const usage = envelope?.usage;
        const tokens = isRecord(usage) && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
          && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0 && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0
          ? { prompt: usage.input_tokens, completion: usage.output_tokens } : undefined;
        return { rawOutput, durationMs: this.now() - started, worktreeClean: true, ...(tokens ? { tokensUsed: tokens } : {}) };
      }
      throw new ProviderError('unavailable', 'claude retry exhausted');
    } catch (error) { failure = error; throw error; }
    finally { await cleanupPreservingError(worktree.cleanup, failure, options.warn); }
  }
}
