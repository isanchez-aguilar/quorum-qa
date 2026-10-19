import { expect, it, vi } from 'vitest';
import { FakeProvider } from '../../src/providers/fake.js';
import { context } from '../fixtures/cascade.js';

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
