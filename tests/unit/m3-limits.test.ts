import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { RunBudget, BUDGET_WARNING } from '../../src/cascade/budget.js';
import { createExecutionPlan } from '../../src/cascade/planner.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { quotaStatus } from '../../src/catalog/groups.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-limits-'));
  await writeFile(path.join(root, 'sample.ts'), source);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const config = () => validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });

it('500 findings use at most 800 git calls, never the adapter runner', async () => {
  const gitRunner = vi.fn(originRunner(root));
  const providerRunner = vi.fn(originRunner(root));
  const fake = new FakeProvider('agy', 'google', providerRunner, { flash: [JSON.stringify(Array.from({ length: 500 }, () => finding()))] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, gitRunner });
  expect(gitRunner.mock.calls.length).toBeGreaterThan(0);
  expect(gitRunner.mock.calls.length).toBeLessThanOrEqual(800);
  expect(providerRunner).not.toHaveBeenCalled();
  expect(result.ledgerDraft[0]?.verifiedFindingsCount).toBe(100);
  expect(result.ledgerDraft[0]?.rejectionReasons['parse: too many findings']).toBe(400);
}, 20_000);

it('stops verification at the deadline between findings', async () => {
  const clock = new FakeClock();
  const cfg = config();
  const gitRunner = vi.fn(async (...args: Parameters<ReturnType<typeof originRunner>>) => {
    clock.time = cfg.budget.maxMinutes * 60_000;
    return originRunner(root)(...args);
  });
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding(), finding()])] });
  const result = await runCascade(context(root), cfg, new Map([['agy', fake]]), { catalog, gitRunner, clock });
  expect(result.ledgerDraft[0]?.verifiedFindingsCount).toBe(1);
  expect(gitRunner.mock.calls.length).toBeLessThanOrEqual(8);
  expect(result.warnings).toContain(BUDGET_WARNING);
});

it('caps adjudication at 20 pairs without a confirmation boost', async () => {
  const raw = Array.from({ length: 10 }, (_, index) => finding({
    trigger: `Missing authorization condition${index}`, impact: `Protected records lose property${index}`, confidence: 0.6,
  }));
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(raw)] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [
    ...raw.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })),
    ...Array.from({ length: 30 }, () => '{"same":false}'),
  ] });
  const cfg = config();
  cfg.budget.maxCalls = 100;
  const result = await runCascade(context(root), cfg, new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(result.calls.filter(call => call.purpose === 'adjudicate')).toHaveLength(20);
  expect(result.findings).toHaveLength(10);
  expect(result.warnings).toContain('Adjudication cap reached: 25 pairs left unadjudicated.');
  expect(result.findings.every(item => item.confidence === 0.6)).toBe(true);
});

it('a same-defect merge retains the absorbed trigger and impact', async () => {
  const raw = [finding({ trigger: 'Missing authorization for deleting users', impact: 'Users lose protected records', confidence: 0.6 }),
    finding({ trigger: 'Missing audit for deleting users', impact: 'Users lose protected records', confidence: 0.6 })];
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(raw)] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [
    ...raw.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })), '{"same":true}',
  ] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.verification_note).toContain(raw[1]!.trigger);
  expect(result.findings[0]?.verification_note).toContain(raw[1]!.impact);
  expect(result.findings[0]?.confidence).toBe(0.6);
});

it('marks deadline timeout explicitly even if the clock has not advanced', async () => {
  const clock = new FakeClock();
  let fire: (() => void) | undefined;
  clock.setTimeout = callback => { fire = callback; return 1; };
  const budget = new RunBudget(config().budget, clock);
  const pending = budget.execute(() => new Promise(() => {}));
  const rejection = expect(pending).rejects.toThrow('Run deadline reached');
  fire!();
  await rejection;
  expect(budget.deadlineExceeded).toBe(true);
  expect(clock.now()).toBe(0);
});

it('old low quota is unknown and does not block planning or execution', async () => {
  const timestamp = new Date(Date.now() - 6 * 60 * 60_000 - 1).toISOString();
  const quotaSnapshot = { 'agy:google': { remainingPercent: 0, timestamp } };
  expect(quotaStatus(catalog[0]!, quotaSnapshot, 15)).toBe('unchecked');
  const plan = createExecutionPlan(context(root), config(), catalog, quotaSnapshot);
  expect(plan.tiers.triage).toHaveLength(1);
  expect(plan.quotas[0]?.remainingPercent).toBe('unknown');
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, quotaSnapshot });
  expect(result.calls).toHaveLength(1);
  expect(result.warnings.join(' ')).toContain('floor unchecked');
});


it('skips review payloads with no room for diff content', () => {
  const ctx = { ...context(root), diff: 'x'.repeat(40_000), specContent: 'y'.repeat(40_000) };
  expect(reviewChunks(ctx)).toEqual({ chunks: [], skippedFiles: ['sample.ts'], truncatedHunks: [] });
});

it('caps actual confirm and adjudication prompts, removes reproduction, and truncates the hunk first', async () => {
  const large = 'untrusted '.repeat(5_000);
  const raw = [finding({ trigger: 'Missing authorization for deleting users', impact: 'Users lose protected records', confidence: 0.6, fix: large,
    reproduction: { path: 'sample.test.ts', content: 'NEVER_SEND_THIS', expect: 'failure', status: 'pending' } }),
    finding({ trigger: 'Missing audit for deleting users', impact: 'Users lose protected records', confidence: 0.6, fix: large })];
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(raw)] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [
    ...raw.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })), '{"same":false}',
  ] });
  const ctx = context(root);
  ctx.diff += '+' + large;
  await runCascade(ctx, config(), new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(codex.calls).toHaveLength(3);
  for (const call of codex.calls) {
    expect(call.prompt.length).toBeLessThanOrEqual(24_000);
    expect(call.prompt).toContain('untrusted data');
    expect(call.prompt).toContain('[... truncated ...]');
    expect(call.prompt).not.toContain('NEVER_SEND_THIS');
    const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1));
    if (payload.hunk) expect(payload.hunk).toBe('[... truncated ...]');
    else expect(payload.hunks).toEqual(['[... truncated ...]', '[... truncated ...]']);
  }
});
