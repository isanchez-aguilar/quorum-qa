vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { spawn, execFile } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createExecutionPlan, formatDryRun } from '../../src/cascade/planner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { validateConfig } from '../../src/config/schema.js';
import { catalog, context, FakeClock } from '../fixtures/cascade.js';

it('testDryRun_OutputsPlan', () => {
  const runner = vi.fn();
  const fake = new FakeProvider('agy', 'google', runner, { flash: ['[]'] });
  const probe = vi.spyOn(fake, 'probe');
  const quota = vi.spyOn(fake, 'getQuota');
  const config = validateConfig({ checks: [['pnpm', 'test']], author: 'claude',
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
  const plan = createExecutionPlan(context('.'), config, catalog, { 'agy:google': { remainingPercent: 84, timestamp: new Date(0).toISOString() } }, { clock: new FakeClock() });
  const output = formatDryRun(plan);
  for (const text of ['Quorum Review Plan (Dry Run)', 'pnpm test', '84% at',
    'unknown', 'floor unchecked', 'agy:flash', 'codex', 'characters (not tokens)', 'money, auth, permissions',
    'BLOCKER', 'Local-only / parse failure / timeout', 'Max API Calls: 12', '20 minutes', '15%', 'Nothing was called']) {
    expect(output).toContain(text);
  }
  expect(plan.quotas).toHaveLength(2);
  expect(spawn).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(quota).not.toHaveBeenCalled();
  expect(fake.calls).toEqual([]);
});

it('shows quota for canonicalized aliases and skips groups at the floor', () => {
  const config = validateConfig({ checks: [], tiers: { triage: ['claude'], review: ['claude'], confirm: ['codex:codex'], visual: [] } });
  const plan = createExecutionPlan(context('.'), config, catalog);
  expect(plan.quotas.map(item => item.group)).toEqual(['codex:openai', 'claude:anthropic']);
  expect(plan.warnings.filter(item => item.includes('floor unchecked'))).toHaveLength(2);
  const blocked = createExecutionPlan(context('.'), config, catalog, { 'claude:anthropic': { remainingPercent: 15 } });
  expect(blocked.tiers.triage).toEqual([]);
  expect(formatDryRun(blocked)).toContain('[UNAVAILABLE]');
});

it('reports chunk count and whether the initial triage fits the budget', () => {
  const ctx = context('.');
  ctx.touchedFiles = ['first.ts', 'second.ts'];
  ctx.diff = ctx.touchedFiles.map(file => 'diff --git a/' + file + ' b/' + file + '\n--- a/' + file + '\n+++ b/' + file + '\n@@ -1 +1 @@\n+' + 'x'.repeat(15000) + '\n').join('');
  const config = validateConfig({ checks: [], budget: { maxCalls: 1 }, tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
  const plan = createExecutionPlan(ctx, config, catalog, {}, { clock: new FakeClock() });
  expect(plan.chunkCount).toBe(2);
  expect(plan.budgetCoversChunks).toBe(false);
  expect(formatDryRun(plan)).toContain('Review chunks: 2; call budget does not cover');
});
