import type { CommandRunner, Family, ReviewContext } from '../types/index.js';

export type Quota = 'unknown' | { group: string; remainingPercent: number; resetTime?: string };

export interface RawProviderResult {
  rawOutput: string;
  durationMs: number;
  worktreeClean: boolean;
  tokensUsed?: { prompt: number; completion: number };
  error?: string;
}

export interface ReviewOptions {
  deadlineMs: number;
  // Reserves an additional inference slot before an adapter retries a call.
  reserveRetry?: () => boolean;
  // Cancellation supplements the runner deadline, including adapters with no child process.
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly defaultFamily: Family;
  readonly run: CommandRunner;
  probe(modelId: string): Promise<{ available: boolean; error?: string }>;
  getQuota(modelId: string): Promise<Quota>;
  executeReview(context: ReviewContext, modelId: string, prompt: string, options: ReviewOptions): Promise<RawProviderResult>;
}

export class ProviderError extends Error {
  constructor(readonly kind: 'quota' | 'timeout' | 'unavailable', message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
