import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { BUDGET_WARNING } from '../../src/cascade/budget.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider, type FakeResponse } from '../../src/providers/fake.js';
import type { QuorumConfig } from '../../src/types/index.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

describe('fake provider cascade', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-cascade-'));
    await writeFile(path.join(root, 'sample.ts'), source);
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  function config(overrides: Record<string, unknown> = {}): QuorumConfig {
    return validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] }, ...overrides });
  }
  function providers(scripts: Record<string, Record<string, readonly FakeResponse[]>>) {
    return new Map(Object.entries(scripts).map(([name, responses]) => [name,
      new FakeProvider(name, name === 'qwen' ? 'local' : name === 'codex' ? 'openai' : 'google', originRunner(root), responses)]));
  }
  const yes = (fields = {}) => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote, ...fields });

  it('testCascade_EscalatesMoney', async () => {
    const pool = providers({ agy: { flash: [JSON.stringify([finding({ trigger: 'currency rounding error' })])] }, codex: { codex: [yes()] } });
    const cfg = config({ escalate: { focus: ['currency'], belowConfidence: 0.7 } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.tier)).toEqual(['triage', 'confirm']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ verified: true, origin: 'pre-existing' });
    expect(pool.get('codex')!.calls[0]!.prompt).toContain('@@ -1 +1,2 @@');
    expect(pool.get('codex')!.calls[0]!.prompt).toContain('currency rounding error');
  });

  it('testCascade_BelowConfidenceEscalation', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ confidence: 0.5 })])] },
      codex: { codex: [yes({ fix: 'Use the confirming fix' })] } }), { catalog, clock: new FakeClock() });
    expect(result.findings[0]).toMatchObject({ confidence: 0.75, fix: 'Use the confirming fix' });
    expect(result.calls.map(call => call.purpose)).toEqual(['review', 'confirm']);
  });

  it('escalates BLOCKER even without a focus match and keeps confirmed evidence', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])] },
      codex: { codex: [yes({ evidence_quote: 'export const other = load(input);', line: 2, confidence: 0.5 })] } }), { catalog, clock: new FakeClock() });
    expect(result.findings[0]).toMatchObject({ severity: 'BLOCKER', line: 2, evidence_quote: 'export const other = load(input);' });
  });

  it('does not escalate confidence equal to threshold and counts verifier rejections', async () => {
    const raw = [finding({ confidence: 0.7 }), finding({ file: 'hallucinated.ts' }), finding({ evidence_quote: 'deleteEverything(secret);' })];
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify(raw)] } }), { catalog, clock: new FakeClock() });
    expect(result.calls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.ledgerDraft[0]).toMatchObject({ rawFindingsCount: 3, verifiedFindingsCount: 1, rejectedFindingsCount: 2 });
    expect(Object.keys(result.ledgerDraft[0]!.rejectionReasons).join(' ')).toContain('file not found');
  });

  it('drops a rejected confirmation and cannot trust invented confirmation evidence', async () => {
    const raw = JSON.stringify([finding({ confidence: 0.5 })]);
    const rejected = await runCascade(context(root), config(), providers({ agy: { flash: [raw] }, codex: { codex: ['{"decision":"reject"}'] } }), { catalog, clock: new FakeClock() });
    expect(rejected.findings).toEqual([]);
    expect(rejected.unconfirmed).toEqual([]);
    expect(rejected.ledgerDraft[1]!.rejectionReasons['confirm rejected finding']).toBe(1);
    expect(rejected.ledgerDraft[1]).toMatchObject({ rawFindingsCount: 1, verifiedFindingsCount: 0, rejectedFindingsCount: 1 });
    const invented = await runCascade(context(root), config(), providers({ agy: { flash: [raw] }, codex: { codex: [yes({ evidence_quote: 'inventedCall(secret);' })] } }), { catalog, clock: new FakeClock() });
    expect(invented.findings).toEqual([]);
    expect(invented.unconfirmed).toHaveLength(1);
    expect(invented.ledgerDraft[1]!.rejectedFindingsCount).toBe(1);
  });

  it.each(['not JSON', { error: 'timeout' } as FakeResponse])('escalates malformed JSON or an early triage timeout to review: %j', response => {
    return runCascade(context(root), config(), providers({ agy: { flash: [response], pro: [JSON.stringify([finding()])] } }), { catalog, clock: new FakeClock() }).then(result => {
      expect(result.calls.map(call => call.tier)).toEqual(['triage', 'review']);
      expect(result.findings).toHaveLength(1);
    });
  });

  it('testCascade_QwenOnlyNeverFinal', async () => {
    const cfg = config({ tiers: { triage: ['qwen'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
    const only = await runCascade(context(root), cfg, providers({ qwen: { qwen: [JSON.stringify([finding()])] } }), { catalog, clock: new FakeClock() });
    expect(only.findings).toEqual([]);
    expect(only.unconfirmed).toHaveLength(1);
    expect(only.warnings.join(' ')).toContain('local model only');
    const confirmed = await runCascade(context(root), cfg, providers({ qwen: { qwen: [JSON.stringify([finding()])] }, agy: { pro: [yes()] } }), { catalog, clock: new FakeClock() });
    expect(confirmed.calls.map(call => call.tier)).toEqual(['triage', 'review']);
    expect(confirmed.findings).toHaveLength(1);
    expect(confirmed.unconfirmed).toEqual([]);
  });

  it('tries the next review model after an early review timeout', async () => {
    const cfg = config({ tiers: { triage: ['agy:flash'], review: ['agy:pro', 'claude:sonnet'], confirm: [], visual: [] } });
    const pool = providers({ agy: { flash: ['not JSON'], pro: [{ error: 'timeout' }] }, claude: { sonnet: [JSON.stringify([finding()])] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['flash', 'pro', 'sonnet']);
    expect(result.findings).toHaveLength(1);
  });

  it('retains gathered findings when the call cap stops escalation', async () => {
    const result = await runCascade(context(root), config({ budget: { maxCalls: 1 } }), providers({ agy: { flash: [JSON.stringify([
      finding({ confidence: 0.5 }), finding({ line: 2, trigger: 'Loading uses a stale cache', impact: 'Old data is displayed', evidence_quote: 'export const other = load(input);' }),
    ])] }, codex: { codex: [yes()] } }), { catalog, clock: new FakeClock() });
    expect(result.calls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.unconfirmed).toHaveLength(1);
    expect(result.warnings).toContain(BUDGET_WARNING);
  });

  it('returns and records a hanging call at the run deadline', async () => {
    const clock = new FakeClock();
    const pool = providers({ agy: { flash: [{ neverReturns: true }], pro: ['[]'] } });
    const pending = runCascade(context(root), config({ budget: { maxMinutes: 1 } }), pool, { catalog, clock });
    await Promise.resolve();
    clock.advance(60_000);
    const result = await pending;
    expect(result.calls).toHaveLength(1);
    expect(result.ledgerDraft[0]).toMatchObject({ timedOutCalls: 1, durationMs: 60_000 });
    expect(pool.get('agy')!.calls[0]!.aborted).toBe(true);
    expect(result.warnings).toContain(BUDGET_WARNING);
    expect(clock.pending).toBe(0);
  });

  it('falls back after an early confirmation timeout within the same budget', async () => {
    const cfg = config({ tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex', 'agy:opus'], visual: [] } });
    const pool = providers({ agy: { flash: [JSON.stringify([finding({ confidence: 0.5 })])], opus: [yes()] }, codex: { codex: [{ error: 'timeout' }] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['flash', 'codex', 'opus']);
    expect(result.findings).toHaveLength(1);
  });

  it('filters the author family in triage and confirm and warns when it is unavoidable', async () => {
    const cfg = config({ author: 'claude', tiers: { triage: ['agy:sonnet', 'agy:flash'], review: ['agy:pro'], confirm: ['agy:opus', 'codex'], visual: [] } });
    const pool = providers({ agy: { sonnet: ['[]'], flash: [JSON.stringify([finding({ confidence: 0.5 })])], opus: ['[]'] }, codex: { codex: [yes()] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['flash', 'codex']);
    cfg.tiers.triage = ['agy:sonnet'];
    const fallback = await runCascade(context(root), cfg, providers({ agy: { sonnet: ['[]'] } }), { catalog, clock: new FakeClock() });
    expect(fallback.warnings.join(' ')).toContain('Independence rule cannot be met');
  });

  it('a 429 disables the whole group, including models in another tier', async () => {
    const cfg = config({ tiers: { triage: ['agy:sonnet', 'agy:opus', 'agy:flash'], review: ['agy:pro'], confirm: ['agy:opus', 'codex'], visual: [] } });
    const pool = providers({ agy: { sonnet: [{ error: 'quota' }], opus: ['[]'], flash: [JSON.stringify([finding({ confidence: 0.5 })])] }, codex: { codex: [yes()] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['sonnet', 'flash', 'codex']);
    expect(result.calls[0]?.status).toBe('quota');
    expect(result.warnings.join(' ')).toContain('floor unchecked');
  });

  it('skips both models sharing a quota reading at the floor', async () => {
    const cfg = config({ tiers: { triage: ['agy:sonnet', 'agy:opus', 'agy:flash'], review: ['agy:pro'], confirm: [], visual: [] } });
    const result = await runCascade(context(root), cfg, providers({ agy: { sonnet: ['[]'], opus: ['[]'], flash: ['[]'] } }),
      { catalog, clock: new FakeClock(), quotaSnapshot: { 'agy:anthropic': { remainingPercent: 15, timestamp: '2026-10-12T09:40:00Z' } } });
    expect(result.calls.map(call => call.model)).toEqual(['flash']);
  });

  it('discards every dirty-worktree finding and records a reason', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [{ rawOutput: JSON.stringify([finding()]), worktreeClean: false }], pro: ['[]'] } }), { catalog, clock: new FakeClock() });
    expect(result.findings).toEqual([]);
    expect(result.ledgerDraft[0]!.rejectionReasons['provider changed worktree']).toBe(1);
  });

  it('ignores model origin except OPTIONAL improvement, including a corrected line', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([
      finding({ origin: 'improvement', line: 25 }),
      finding({ severity: 'OPTIONAL', origin: 'improvement', line: 2, evidence_quote: 'export const other = load(input);', trigger: 'Naming is unclear', impact: 'Harder to read' }),
    ])] } }), { catalog, clock: new FakeClock() });
    expect(result.findings.map(item => [item.line, item.origin])).toEqual([[1, 'pre-existing'], [2, 'improvement']]);
  });

  it.each([true, false, 'no budget'] as const)('adjudicates related cross-family sources: %s', async verdict => {
    const raw = [finding({ trigger: 'Missing authorization when deleting users', impact: 'Users can delete protected records', confidence: 0.7 }),
      finding({ line: 2, trigger: 'Missing audit when deleting users', impact: 'Users can delete protected records', confidence: 0.7, evidence_quote: 'export const other = load(input);' })];
    const cfg = config({ escalate: { focus: ['authorization'], belowConfidence: 0.7 }, budget: { maxCalls: verdict === 'no budget' ? 2 : 3 } });
    const pool = providers({ agy: { flash: [JSON.stringify(raw)] }, codex: { codex: [yes(), JSON.stringify({ same: verdict })] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    if (verdict === true) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.confidence).toBe(0.95);
      expect(result.related).toEqual([]);
    } else {
      expect(result.findings).toHaveLength(2);
      expect(result.findings[1]?.confidence).toBe(0.7);
      expect(result.related).toHaveLength(1);
      expect(result.findings.every(item => item.possibly_related?.length)).toBe(true);
    }
    expect(result.calls.filter(call => call.purpose === 'adjudicate')).toHaveLength(verdict === 'no budget' ? 0 : 1);
  });

  it('is deterministic with the same inputs and clock', async () => {
    const execute = () => runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ confidence: 0.5 })])] }, codex: { codex: [yes()] } }), { catalog, clock: new FakeClock() });
    expect(await execute()).toEqual(await execute());
  });

  it('does not compound confidence boosts in an adjudication prompt after strong dedupe', async () => {
    const raw = [finding({ trigger: 'Missing authorization when deleting users', impact: 'Users can delete protected records', confidence: 0.6 }),
      finding({ trigger: 'Missing authorization when deleting users', impact: 'Users can delete protected records', confidence: 0.5 }),
      finding({ line: 2, trigger: 'Missing audit when deleting users', impact: 'Users can delete protected records', confidence: 0.9, evidence_quote: 'export const other = load(input);' })];
    const cfg = config({ escalate: { focus: ['authorization'], belowConfidence: 0.7 } });
    const pool = providers({ agy: { flash: [JSON.stringify(raw)] }, codex: { codex: [yes({ confidence: 0.4 }), yes({ confidence: 0.7 }), '{"same":false}'] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, clock: new FakeClock() });
    const prompt = pool.get('codex')!.calls[2]!.prompt;
    const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { first: { confidence: number } };
    expect(payload.first.confidence).toBe(0.95);
    expect(result.findings[0]?.confidence).toBe(0.95);
    expect(result.findings).toHaveLength(2);
  });
});
