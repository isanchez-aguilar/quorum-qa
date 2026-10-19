import { expect, it, vi } from 'vitest';
import { FakeProvider } from '../../src/providers/fake.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { QwenProvider } from '../../src/providers/qwen.js';
import { NotImplementedError, ProviderError } from '../../src/providers/types.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { context, FakeClock, originRunner } from '../fixtures/cascade.js';

it.each([ClaudeProvider, QwenProvider])('%s is an unavailable stub without calling a process or endpoint', async Provider => {
  const runner = vi.fn();
  const adapter = new Provider({ runner });
  expect(await adapter.probe('synthetic')).toEqual({ available: false, error: 'not implemented in v1' });
  expect(await adapter.getQuota('synthetic')).toBe('unknown');
  const result = adapter.executeReview(context('.'), 'synthetic', 'review', { deadlineMs: 1000 });
  await expect(result).rejects.toBeInstanceOf(NotImplementedError);
  await expect(result).rejects.toBeInstanceOf(ProviderError);
  await expect(result).rejects.toMatchObject({ kind: 'unavailable', message: 'not implemented in v1', provider: adapter.name });
  expect(runner).not.toHaveBeenCalled();
});

it('falls back from the Claude stub to the next configured review model', async () => {
  const runner = originRunner(process.cwd());
  const agy = new FakeProvider('agy', 'google', runner, {
    'gemini-3.8-flash-medium': ['invalid JSON'],
    'gemini-4-argon-high': ['[]'],
  });
  const claude = new ClaudeProvider({ runner });
  const config = validateConfig({ checks: [], tiers: {
    triage: ['agy:gemini-3.8-flash-medium'], review: ['claude:sonnet', 'agy:gemini-4-argon-high'], confirm: [], visual: [],
  } });
  const result = await runCascade(context(process.cwd()), config,
    new Map<string, ProviderAdapter>([['claude', claude], ['agy', agy]]), { gitRunner: runner, clock: new FakeClock() });
  expect(agy.calls.map(call => call.model)).toEqual(['gemini-3.8-flash-medium', 'gemini-4-argon-high']);
  expect(result.errors).toEqual([]);
  expect(result.calls.some(call => call.model === 'gemini-4-argon-high' && call.status === 'ok')).toBe(true);
});

it('scripts raw outputs by model without running the injected runner', async () => {
  const runner = vi.fn();
  const fake = new FakeProvider('agy', 'google', runner, {
    flash: ['[]', 'Before [{"synthetic":true}] after', '```json\n[]\n```', 'not JSON'],
    pro: [{ rawOutput: '[]', worktreeClean: false }, { error: 'quota' }, { error: 'timeout' }],
  }, { flash: { group: 'agy:google', remainingPercent: 42 } });
  expect(await fake.probe('flash')).toEqual({ available: true });
  expect(await fake.probe('missing')).toEqual({ available: false });
  expect(await fake.getQuota('flash')).toEqual({ group: 'agy:google', remainingPercent: 42 });
  expect(await fake.getQuota('pro')).toBe('unknown');
  for (const raw of ['[]', 'Before [{"synthetic":true}] after', '```json\n[]\n```', 'not JSON']) {
    expect((await fake.executeReview(context('.'), 'flash', 'same prompt', { deadlineMs: 20 })).rawOutput).toBe(raw);
  }
  expect((await fake.executeReview(context('.'), 'pro', 'dirty', { deadlineMs: 15 })).worktreeClean).toBe(false);
  await expect(fake.executeReview(context('.'), 'pro', 'quota', { deadlineMs: 10 })).rejects.toMatchObject({ kind: 'quota' });
  await expect(fake.executeReview(context('.'), 'pro', 'timeout', { deadlineMs: 5 })).rejects.toMatchObject({ kind: 'timeout' });
  expect(fake.calls).toHaveLength(7);
  expect(new Set(fake.calls.slice(0, 4).map(call => call.promptHash)).size).toBe(1);
  expect(fake.calls[0]).toMatchObject({ model: 'flash', deadlineMs: 20, aborted: false });
  expect(runner).not.toHaveBeenCalled();
});
