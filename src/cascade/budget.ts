import type { QuorumConfig } from '../types/index.js';
import { ProviderError } from '../providers/types.js';

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export const BUDGET_WARNING = 'Run terminated early: review budget ceiling reached.';

export function checkBudget(budget: QuorumConfig['budget'], currentCalls: number, startTimeMs: number, nowMs = Date.now()): { allowed: boolean; reason?: string } {
  return currentCalls >= budget.maxCalls || nowMs - startTimeMs >= budget.maxMinutes * 60_000
    ? { allowed: false, reason: BUDGET_WARNING } : { allowed: true };
}

export class RunBudget {
  readonly startTimeMs: number;
  calls = 0;
  timedOutCalls = 0;
  readonly unavailableGroups = new Set<string>();

  constructor(readonly limits: QuorumConfig['budget'], readonly clock: Clock = systemClock) {
    this.startTimeMs = clock.now();
  }

  get remainingMs(): number {
    return Math.max(0, this.limits.maxMinutes * 60_000 - (this.clock.now() - this.startTimeMs));
  }

  get allowed(): boolean {
    return checkBudget(this.limits, this.calls, this.startTimeMs, this.clock.now()).allowed;
  }

  async execute<T>(call: (deadlineMs: number, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.allowed) throw new Error(BUDGET_WARNING);
    this.calls++;
    const deadlineMs = this.remainingMs;
    const controller = new AbortController();
    let timer: unknown;
    const deadline = new Promise<never>((_, reject) => {
      timer = this.clock.setTimeout(() => {
        // Reject first so a synchronous abort listener cannot mask the timeout classification.
        reject(new ProviderError('timeout', 'Run deadline reached'));
        controller.abort();
      }, deadlineMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => call(deadlineMs, controller.signal)), deadline]);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'timeout') this.timedOutCalls++;
      throw error;
    } finally {
      this.clock.clearTimeout(timer);
    }
  }
}
