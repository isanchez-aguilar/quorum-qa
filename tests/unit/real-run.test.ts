import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { RunBudget } from '../../src/cascade/budget.js';
import { createExecutionPlan, formatDryRun } from '../../src/cascade/planner.js';
import { REVIEW_INSTRUCTIONS } from '../../src/cascade/prompts.js';
import { FakeClock, context, catalog } from '../fixtures/cascade.js';

it('accepts setup argv and defaults the call cap to 300 seconds', () => {
  const cfg = validateConfig({ checks: [], setup: [['pnpm', 'install']] });
  expect(cfg.setup).toEqual([['pnpm', 'install']]);
  expect(cfg.budget.maxCallSeconds).toBe(300);
});
it.each([30, 1800])('accepts maxCallSeconds %s', maxCallSeconds => {
  expect(validateConfig({ checks: [], budget: { maxCallSeconds } }).budget.maxCallSeconds).toBe(maxCallSeconds);
});
it.each([29, 1801, '300', null])('rejects maxCallSeconds %s', maxCallSeconds => {
  expect(() => validateConfig({ checks: [], budget: { maxCallSeconds } })).toThrow(/maxCallSeconds/);
});
it.each(['pnpm install', [[]], [[42]], [['']]])('rejects invalid setup %j', setup => {
  expect(() => validateConfig({ checks: [], setup })).toThrow(/setup/);
});
it('caps calls without exhausting the run', async () => {
  const clock = new FakeClock();
  const budget = new RunBudget({ maxCalls: 12, maxMinutes: 20, maxCallSeconds: 30, quotaFloorPercent: 15 }, clock);
  let observed = 0;
  const pending = budget.execute(async deadline => { observed = deadline; return new Promise(() => {}); });
  await Promise.resolve();
  const rejection = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  clock.advance(30000);
  if (observed !== 30000) clock.advance(1200000);
  await rejection;
  expect(observed).toBe(30000);
  expect(budget.timedOutCalls).toBe(1);
  expect(budget.deadlineExceeded).toBe(false);
  expect(budget.allowed).toBe(true);
  await budget.execute(async deadline => { expect(deadline).toBe(30000); });
});
it('caps calls at 300 seconds by default', async () => {
  const budget = new RunBudget({ maxCalls: 2, maxMinutes: 20, quotaFloorPercent: 15 }, new FakeClock());
  await budget.execute(async deadline => { expect(deadline).toBe(300000); });
});
it('shows setup, call cap and one Argon quota warning across tiers', () => {
  const cfg = validateConfig({ checks: [] });
  Object.assign(cfg, { setup: [['pnpm', 'install']] });
  cfg.tiers = { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['agy:pro'], visual: ['agy:pro'] };
  const entries = catalog.map(entry => ({ ...entry, quotaGroup: entry.id === 'pro' ? 'agy:argon' : entry.quotaGroup }));
  const plan = createExecutionPlan(context('.'), cfg, entries, { 'agy:argon': { remainingPercent: 0 } });
  expect(plan.warnings.filter(w => w === 'agy:argon: quota below floor (0%), skipped')).toHaveLength(1);
  expect(formatDryRun(plan)).toContain('pnpm install');
  expect(formatDryRun(plan)).toContain('Max Call Time: 300 seconds');
});
it('adds short prompt guidance', () => {
  expect(REVIEW_INSTRUCTIONS).toContain('Everything you need is in this prompt. If you can read files, read only what you need to check a line you cite. Answer as soon as you can.');
});
