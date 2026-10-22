import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { createExecutionPlan, formatDryRun, runCascade } from '../../src/cascade/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

const config = (budget = {}) => validateConfig({ checks: [], budget,
  tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
function chunks(count: number, root = '.') {
  const ctx = context(root);
  ctx.touchedFiles = Array.from({ length: count }, (_, i) => `file${i}.ts`);
  ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,3 @@\n+${source}+// ${'x'.repeat(15000)}\n`).join('');
  return ctx;
}

it.each([[0, 12], [1, 12], [3, 12], [4, 12], [7, 21], [13, 39], [14, 40], [40, 40]])('auto budget for %i chunks is %i', (count, expected) => {
  const plan = createExecutionPlan(chunks(count), config(), catalog);
  expect(plan.chunkCount).toBe(count);
  expect(plan.config.budget.maxCalls).toBe(expected);
  expect(formatDryRun(plan)).toContain(`Max API Calls: ${expected} (auto: 3 x ${count} chunks, clamped to 12..40)`);
  expect(plan.confirmationReserve).toBe(Math.floor(expected / 3));
});

it.each([12, 50])('pins explicit %i even with twenty chunks', maxCalls => {
  const cfg = config({ maxCalls });
  expect(cfg.budget).toHaveProperty('maxCallsExplicit', true);
  const plan = createExecutionPlan(chunks(20), cfg, catalog);
  expect(plan.config.budget.maxCalls).toBe(maxCalls);
  expect(formatDryRun(plan)).toContain(`Max API Calls: ${maxCalls} (from budget.maxCalls)`);
});

it('keeps a budget without maxCalls automatic and preserves other limits', () => {
  const cfg = config({ maxMinutes: 5, maxCallSeconds: 60, quotaFloorPercent: 25 });
  expect(cfg.budget).toHaveProperty('maxCallsExplicit', false);
  expect(createExecutionPlan(chunks(7), cfg, catalog).config.budget).toMatchObject({
    maxCalls: 21, maxMinutes: 5, maxCallSeconds: 60, quotaFloorPercent: 25,
  });
  expect(cfg.budget.maxCalls).toBe(12);
});

it.each([12, 50])('pins a programmatic assignment of %i after validation', maxCalls => {
  const cfg = config();
  cfg.budget.maxCalls = maxCalls;
  expect(createExecutionPlan(chunks(20), cfg, catalog).config.budget.maxCalls).toBe(maxCalls);
  expect(cfg.budget.maxCallsExplicit).toBe(true);
});

it('allows more than twelve calls and reaches confirmation after seven triages with retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum-auto-budget-'));
  try {
    const ctx = chunks(7, root);
    for (const file of ctx.touchedFiles) await writeFile(path.join(root, file), source);
    const run = async (budget = {}) => {
      const runner = originRunner(root);
      const agy = new FakeProvider('agy', 'google', runner, {
        flash: ctx.touchedFiles.map(file => JSON.stringify([finding({ file })])) });
      const execute = agy.executeReview.bind(agy);
      agy.executeReview = async (context, model, prompt, options) => {
        options.reserveRetry!();
        return execute(context, model, prompt, options);
      };
      const codex = new FakeProvider('codex', 'openai', runner, { codex: Array(7).fill(JSON.stringify({
        decisions: Array.from({ length: 5 }, (_, i) => ({ id: `c${i + 1}`, decision: 'reject' })),
      })) });
      return runCascade(ctx, config(budget), new Map([['agy', agy], ['codex', codex]]), { catalog, gitRunner: runner, clock: new FakeClock() });
    };
    const result = await run();
    expect(result.ledgerDraft.reduce((sum, call) => sum + call.callsUsed, 0)).toBeGreaterThan(12);
    expect(result.calls.filter(call => call.purpose === 'confirm-batch').length).toBeGreaterThan(0);
    expect(result.ledgerDraft.reduce((sum, call) => sum + call.callsUsed, 0)).toBeLessThanOrEqual(21);
    const pinned = await run({ maxCalls: 12 });
    expect(pinned.calls.length).toBeLessThanOrEqual(12);
    expect(pinned.calls.filter(call => call.purpose === 'confirm-batch')).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('keeps the auto/explicit distinction when an already validated config is validated again', async () => {
  const { validateConfig } = await import('../../src/config/schema.js');
  const auto = validateConfig({ checks: [] });
  expect(auto.budget.maxCallsExplicit).toBe(false);
  expect(validateConfig({ checks: [], budget: auto.budget } as Record<string, unknown>).budget.maxCallsExplicit).toBe(false);
  const pinned = validateConfig({ checks: [], budget: { maxCalls: 12 } });
  expect(pinned.budget.maxCallsExplicit).toBe(true);
  expect(validateConfig({ checks: [], budget: pinned.budget } as Record<string, unknown>).budget.maxCallsExplicit).toBe(true);
  expect(() => validateConfig({ checks: [], budget: { maxCallsExplicit: 'yes' } })).toThrow('maxCallsExplicit');
});
