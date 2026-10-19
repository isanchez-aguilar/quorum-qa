import { createHash } from 'node:crypto';
import type { CommandRunner, Family, ReviewContext } from '../types/index.js';
import { ProviderError, type ProviderAdapter, type Quota, type RawProviderResult, type ReviewOptions } from './types.js';

export type FakeResponse = string | {
  rawOutput?: string;
  error?: 'quota' | 'timeout' | 'unavailable';
  neverReturns?: boolean;
  worktreeClean?: boolean;
  durationMs?: number;
};

export class FakeProvider implements ProviderAdapter {
  readonly calls: Array<{ model: string; prompt: string; promptHash: string; deadlineMs: number; aborted: boolean }> = [];
  private readonly positions = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly defaultFamily: Family,
    readonly run: CommandRunner,
    private readonly scripts: Readonly<Record<string, readonly FakeResponse[]>>,
    private readonly quotas: Readonly<Record<string, Quota>> = {},
  ) {}

  async probe(modelId: string) {
    return { available: Object.hasOwn(this.scripts, modelId) };
  }

  async getQuota(modelId: string): Promise<Quota> {
    return this.quotas[modelId] ?? 'unknown';
  }

  async executeReview(_context: ReviewContext, modelId: string, prompt: string, options: ReviewOptions): Promise<RawProviderResult> {
    const call = { model: modelId, prompt, promptHash: createHash('sha256').update(prompt).digest('hex'),
      deadlineMs: options.deadlineMs, aborted: false };
    this.calls.push(call);
    const index = this.positions.get(modelId) ?? 0;
    this.positions.set(modelId, index + 1);
    const response = this.scripts[modelId]?.[index];
    if (response === undefined) throw new ProviderError('unavailable', `No scripted response for ${modelId}`);
    const item = typeof response === 'string' ? { rawOutput: response } : response;
    if (item.neverReturns) {
      return new Promise((_, reject) => {
        const abort = () => { call.aborted = true; reject(new ProviderError('timeout', 'Fake call aborted at deadline')); };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (item.error) throw new ProviderError(item.error, item.error === 'quota' ? '429 quota exhausted' : item.error);
    return { rawOutput: item.rawOutput ?? '[]', worktreeClean: item.worktreeClean ?? true, durationMs: item.durationMs ?? 0 };
  }
}
