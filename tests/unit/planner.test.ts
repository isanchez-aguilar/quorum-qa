import { expect, it, vi } from 'vitest';
import { createExecutionPlan, formatDryRun } from '../../src/cascade/planner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { validateConfig } from '../../src/config/schema.js';
import { catalog, context } from '../fixtures/cascade.js';

it('testDryRun_OutputsPlan', () => {
  const runner = vi.fn();
  const fake = new FakeProvider('agy', 'google', runner, { flash: ['[]'] });
  const probe = vi.spyOn(fake, 'probe');
  const quota = vi.spyOn(fake, 'getQuota');
  const config = validateConfig({ checks: [['pnpm', 'test']], author: 'claude',
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
  const plan = createExecutionPlan(context('.'), config, catalog, { 'agy:google': { remainingPercent: 84, timestamp: new Date().toISOString() } });
  const output = formatDryRun(plan);
  for (const text of ['Quorum Review Plan (Dry Run)', 'pnpm test', '84% at',
    'unknown', 'floor unchecked', 'agy:flash', 'codex', 'characters (not tokens)', 'money, auth, permissions',
    'BLOCKER', 'Local-only / parse failure / timeout', 'Max API Calls: 12', '20 minutes', '15%', 'Nothing was called']) {
    expect(output).toContain(text);
  }
  expect(plan.quotas).toHaveLength(2);
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
