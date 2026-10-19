import { AGY_QUOTA_GROUPS, agyQuotaGroup } from '../catalog/agy-groups.js';
import type { ReviewContext } from '../types/index.js';
import { AGY_SCHEMAS, validStructuredOutput } from './schemas.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';
import { ProviderCommands, quotaLanguage, remaining, cleanupPreservingError } from './commands.js';
import { ProviderError, type ProviderAdapter, type Quota, type RawProviderResult, type ReviewOptions } from './types.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function parseAgyQuota(text: string, model: string): Quota {
  try {
    const envelope: unknown = JSON.parse(text);
    if (!record(envelope) || envelope.status !== 'SUCCESS' || !record(envelope.command) || !record(envelope.command.data)) return 'unknown';
    const groups = envelope.command.data.groups;
    const mapping = AGY_QUOTA_GROUPS.find(item => item.group === agyQuotaGroup(model));
    if (!Array.isArray(groups) || !mapping) return 'unknown';
    const group: unknown = groups.find(item => record(item) && typeof item.description === 'string' && mapping.description.test(item.description));
    if (!record(group) || !Array.isArray(group.buckets)) return 'unknown';
    const disabledNames = new Set(typeof envelope.response === 'string' ? envelope.response.split(/\r?\n/).flatMap(line => {
      const [name, bucket, value] = line.split('\t');
      return name === group.name && value?.trim().toLowerCase() === 'disabled' ? [bucket] : [];
    }) : []);
    const active = group.buckets.filter((bucket): bucket is Record<string, unknown> => record(bucket) && bucket.disabled !== true && !disabledNames.has(String(bucket.name)));
    if (!active.length || active.some(bucket => typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction) || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1)) return 'unknown';
    const minimum = Math.min(...active.map(bucket => bucket.remaining_fraction as number));
    const resets = active.filter(bucket => bucket.remaining_fraction === minimum).map(bucket => bucket.reset_time)
      .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { group: mapping.group, remainingPercent: minimum * 100, ...(resets[0] ? { resetTime: resets[0] } : {}) };
  } catch { return 'unknown'; }
}

export class AgyProvider extends ProviderCommands implements ProviderAdapter {
  readonly name = 'agy';
  readonly defaultFamily = 'google';
  async listModels(): Promise<string[]> {
    const result = await this.command('agy', ['models']);
    if (result.exitCode !== 0) throw new ProviderError('unavailable', 'agy models failed');
    return [...new Set(result.stdout.split(/\r?\n/).flatMap(line => {
      const [id, display] = line.split('\t');
      return id?.trim() && display?.trim() ? [id.trim()] : [];
    }))];
  }
  async probe(modelId: string) {
    try { return { available: (await this.listModels()).includes(modelId) }; }
    catch (error) { return { available: false, error: String(error) }; }
  }
  async getQuota(modelId: string): Promise<Quota> {
    try {
      const result = await this.command('agy', ['--output-format', 'json', '--print-timeout', '10s', '--print=/usage']);
      return result.exitCode === 0 ? parseAgyQuota(result.stdout, modelId) : 'unknown';
    } catch { return 'unknown'; }
  }
  async executeReview(context: ReviewContext, modelId: string, prompt: string, options: ReviewOptions): Promise<RawProviderResult> {
    const started = this.now();
    remaining(options, started, this.now);
    const worktree = await createReviewWorktree(context.worktreeRoot, context.headCommit, this.run, options.warn);
    let failure: unknown;
    try {
      const timeoutMs = remaining(options, started, this.now);
      const args = ['--model', modelId, '--sandbox', '--output-format', 'json', '--print-timeout', `${Math.max(1, Math.floor(timeoutMs / 1000))}s`, `--print=${prompt}`];
      const purpose = options.purpose ?? 'review';
      args.push('--json-schema', JSON.stringify(AGY_SCHEMAS[purpose]));
      // Count resolved executable and quoting overhead, without ever shortening the prompt.
      if (this.exceedsWindowsArgv('agy', args, worktree.path)) {
        args.splice(-2);
        (options.warn ?? console.warn)('agy: JSON schema omitted to fit the Windows argv limit; prompt preserved.');
      }
      if (this.exceedsWindowsArgv('agy', args, worktree.path)) {
        throw new ProviderError('unavailable', 'agy argv exceeds the 30,000-character Windows limit');
      }
      const result = await this.command('agy', args, worktree.path, timeoutMs);
      let envelope: unknown;
      try { envelope = JSON.parse(result.stdout); } catch { /* Failure stderr is still diagnostic. */ }
      if (result.exitCode !== 0 || (record(envelope) && envelope.status !== 'SUCCESS')) {
        const diagnostic = result.stderr + '\n' + (record(envelope) ? JSON.stringify([envelope.status, envelope.error]) : '');
        if (quotaLanguage(diagnostic)) throw new ProviderError('quota', 'agy quota exhausted or rate limited');
      }
      if (result.exitCode !== 0) throw new ProviderError('unavailable', `agy exited with ${result.exitCode}`);
      if (!record(envelope) || envelope.status !== 'SUCCESS') throw new ProviderError('unavailable', 'agy did not return a SUCCESS response');
      const rawOutput = validStructuredOutput(envelope.structured_output, purpose)
        ? JSON.stringify(envelope.structured_output) : envelope.response;
      if (typeof rawOutput !== 'string') throw new ProviderError('unavailable', 'agy did not return a SUCCESS response');
      const usage = envelope.usage;
      const tokens = record(usage) && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0 && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0
        ? { prompt: usage.input_tokens, completion: usage.output_tokens } : undefined;
      return { rawOutput, durationMs: this.now() - started, worktreeClean: await isClean(worktree.path, this.run), ...(tokens ? { tokensUsed: tokens } : {}) };
    } catch (error) { failure = error; throw error; }
    finally { await cleanupPreservingError(worktree.cleanup, failure, options.warn); }
  }
}
