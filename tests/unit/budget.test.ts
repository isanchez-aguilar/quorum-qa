import { expect, it } from 'vitest';
import { RunBudget, BUDGET_WARNING } from '../../src/cascade/budget.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { FakeClock, context, originRunner } from '../fixtures/cascade.js';

it('testBudget_CallCapExceeded', async () => {
  const budget = new RunBudget({ maxCalls: 1, maxMinutes: 1, quotaFloorPercent: 15 }, new FakeClock());
  const fake = new FakeProvider('qwen', 'local', originRunner('.'), { qwen: ['[]'] });
  await budget.execute((deadlineMs, signal) => fake.executeReview(context('.'), 'qwen', 'review', { deadlineMs, signal }));
  await expect(budget.execute(async () => undefined)).rejects.toThrow(BUDGET_WARNING);
  expect(fake.calls).toHaveLength(1);
});

it('testBudget_DeadlineKillsInFlight', async () => {
  const clock = new FakeClock();
  const budget = new RunBudget({ maxCalls: 12, maxMinutes: 1, quotaFloorPercent: 15 }, clock);
  const fake = new FakeProvider('qwen', 'local', originRunner('.'), { qwen: [{ neverReturns: true }] });
  const pending = budget.execute((deadlineMs, signal) => fake.executeReview(context('.'), 'qwen', 'review', { deadlineMs, signal }));
  await Promise.resolve();
  const rejection = expect(pending).rejects.toThrow('Run deadline reached');
  clock.advance(60_000);
  await rejection;
  expect(fake.calls[0]).toMatchObject({ deadlineMs: 60_000, aborted: true });
  expect(budget.timedOutCalls).toBe(1);
  expect(budget.allowed).toBe(false);
  expect(clock.pending).toBe(0);
});

it('retries share time and call ceilings and clear successful timers', async () => {
  const clock = new FakeClock();
  const budget = new RunBudget({ maxCalls: 2, maxMinutes: 1, quotaFloorPercent: 15 }, clock);
  const fake = new FakeProvider('qwen', 'local', originRunner('.'), { qwen: [{ error: 'quota' }, '[]'] });
  const call = () => budget.execute((deadlineMs, signal) => fake.executeReview(context('.'), 'qwen', 'review', { deadlineMs, signal }));
  await expect(call()).rejects.toThrow('429');
  clock.advance(20_000);
  await call();
  expect(fake.calls.map(item => item.deadlineMs)).toEqual([60_000, 40_000]);
  expect(clock.pending).toBe(0);
  expect(budget.calls).toBe(2);
});
