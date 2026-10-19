import { expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { context, FakeClock, originRunner } from '../fixtures/cascade.js';

it.each([1, 2])('reserves adapter retries within maxCalls=%i and records them', async maxCalls => {
  let retried = false;
  const adapter: ProviderAdapter = {
    name: 'codex', defaultFamily: 'openai', run: originRunner('.'),
    probe: async () => ({ available: true }), getQuota: async () => 'unknown',
    executeReview: async (_context, _model, _prompt, options) => {
      retried = options.reserveRetry!();
      expect(options.reserveRetry!()).toBe(false);
      return { rawOutput: '[]', durationMs: 1, worktreeClean: true };
    },
  };
  const config = validateConfig({ checks: [], tiers: { triage: ['codex'], review: ['codex'], confirm: [], visual: [] },
    budget: { maxCalls, maxMinutes: 1, quotaFloorPercent: 15 } });
  const result = await runCascade(context('.'), config, new Map([['codex', adapter]]), { clock: new FakeClock(), gitRunner: originRunner('.') });
  expect(retried).toBe(maxCalls === 2);
  expect(result.ledgerDraft[0]!.callsUsed).toBe(maxCalls);
});

it('a GPT-OSS 429 disables agy Claude models sharing its quota group', async () => {
  const provider = new FakeProvider('agy', 'openai', originRunner('.'), {
    'gpt-oss-120b-medium': [{ error: 'quota' }], 'claude-sonnet-5-5-medium': ['[]'],
  });
  const config = validateConfig({ checks: [], tiers: { triage: ['agy:gpt-oss-120b-medium'],
    review: ['agy:claude-sonnet-5-5-medium'], confirm: [], visual: [] } });
  const result = await runCascade(context('.'), config, new Map([['agy', provider]]), { clock: new FakeClock(), gitRunner: originRunner('.') });
  expect(provider.calls).toHaveLength(1);
  expect(result.calls[0]!.status).toBe('quota');
  expect(result.coverage.complete).toBe(false);
});
