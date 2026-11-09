import { ProviderError } from '../../src/providers/types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { BUDGET_WARNING, RunBudget } from '../../src/cascade/budget.js';
import { SKIP_REASONS, skipReasonCounts, skipRemedy } from '../../src/cascade/coverage.js';
import { generateMarkdownReport, generateSarifReport, type ReviewResult } from '../../src/reporters/index.js';
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

  it.each(['budget-exhausted', 'run-deadline-reached', 'no-provider-available', 'no-usable-response'] as const)(
    'records and reports the actual skipped-file cause: %s', async reason => {
      const clock = new FakeClock();
      const cfg = config({ budget: { maxCalls: 3, maxMinutes: 1 } });
      const budget = new RunBudget(cfg.budget, clock);
      if (reason === 'budget-exhausted') budget.calls = 3;
      if (reason === 'run-deadline-reached') clock.advance(60000);
      const pool = reason === 'no-provider-available' ? new Map() : providers({ agy: { flash: ['invalid'], pro: ['invalid'] } });
      const cascade = await runCascade(context(root), cfg, pool, { catalog, budget, gitRunner: originRunner(root) });
      expect(cascade.coverage.skippedFiles).toEqual(['sample.ts']);
      expect(cascade.coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason }]);
      expect(cascade.coverage.complete).toBe(false);
      expect(cascade.warnings).toContain(`sample.ts: skipped review; ${SKIP_REASONS[reason]}.${skipRemedy(reason)}`);
      const result: ReviewResult = { ...cascade, runId: 'synthetic', timestamp: '', mode: 'general', range: 'base...lane',
        headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), checks: null, criteria: [], inventory: [], families: [], exitCode: 2 };
      const markdown = generateMarkdownReport(result);
      expect(markdown).toContain(`sample.ts: skipped review; ${SKIP_REASONS[reason]}.`);
      expect(markdown).toContain(`Skipped summary: ${SKIP_REASONS[reason]}: 1 file(s).`);
      if (reason === 'budget-exhausted') expect(markdown).toContain('Raise budget.maxCalls or review per lane with a narrower --diff.');
      if (reason === 'run-deadline-reached') expect(markdown).toContain('Raise budget.maxMinutes or review per lane with a narrower --diff.');
      const coverage = JSON.parse(generateSarifReport([], result)).runs[0].properties.coverage;
      expect(coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason }]);
      expect(coverage.skipReasonCounts).toEqual({ [reason]: 1 });
    });

  it('keeps no usable response when the last invalid call also exhausts the budget', async () => {
    const result = await runCascade(context(root), config({ budget: { maxCalls: 2 } }),
      providers({ agy: { flash: ['invalid'], pro: ['invalid'] } }), { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason: 'no-usable-response' }]);
  });

  it('records budget exhaustion when it prevents the fallback after an invalid response', async () => {
    const result = await runCascade(context(root), config({ budget: { maxCalls: 1 } }),
      providers({ agy: { flash: ['invalid'], pro: ['[]'] } }), { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason: 'budget-exhausted' }]);
  });

  it('counts each file once per cause, including files skipped across multiple chunks', () => {
    expect(skipReasonCounts([
      { file: 'a.ts', reason: 'budget-exhausted' }, { file: 'a.ts', reason: 'budget-exhausted' },
      { file: 'b.ts', reason: 'budget-exhausted' }, { file: 'a.ts', reason: 'run-deadline-reached' },
    ])).toEqual({ 'budget-exhausted': 2, 'run-deadline-reached': 1 });
  });

  it('preserves earlier causes when later chunks exhaust the call budget', async () => {
    const ctx = context(root);
    ctx.touchedFiles = ['first.ts', 'second.ts', 'third.ts'];
    ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+${'x'.repeat(15000)}\n`).join('');
    const result = await runCascade(ctx, config({ budget: { maxCalls: 3, concurrency: 1 } }),
      providers({ agy: { flash: ['invalid', '[]'], pro: ['invalid'] } }), { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage.reviewedFiles).toEqual(['second.ts']);
    expect(result.coverage.skippedFileReasons).toEqual([
      { file: 'first.ts', reason: 'no-usable-response' }, { file: 'third.ts', reason: 'budget-exhausted' },
    ]);
  });

  it.each(['unavailable', 'quota'] as const)('records no provider available after %s errors', async error => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [{ error }], pro: [{ error }] } }),
      { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason: 'no-provider-available' }]);
  });

  it('retains a fake provider finding quoted with a diff marker', async () => {
    const evidence_quote = '+' + finding().evidence_quote;
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ evidence_quote })])] } }),
      { catalog, gitRunner: originRunner(root), clock: new FakeClock() });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ verified: true, evidence_quote: finding().evidence_quote,
      verification_note: expect.stringContaining('stripped diff markers from the quote') });
  });

  it('warns once for an exhausted quota group and never retries its sibling model', async () => {
    const pool = providers({ agy: { flash: [{ error: 'quota' }], pro: ['[]'] }, codex: { codex: ['[]'] } });
    const cfg = config({ tiers: { triage: ['agy:flash', 'agy:pro', 'codex'], review: ['agy:pro', 'codex'], confirm: ['codex'], visual: [] } });
    const result = await runCascade(context(root), cfg, pool, { catalog, gitRunner: originRunner(root), clock: new FakeClock() });
    expect(pool.get('agy')!.calls.map(call => call.model)).toEqual(['flash']);
    expect(result.warnings.filter(message => message === 'agy:google: quota exhausted earlier in this run, skipped')).toHaveLength(1);
  });
  it('warns once across denied agy models, keeps their group available, and resets per run', async () => {
    for (let run = 0; run < 2; run++) {
      const pool = providers({ agy: { flash: [], pro: [] }, codex: { codex: ['[]'] } });
      const called: string[] = [];
      pool.get('agy')!.executeReview = async (_context, model) => {
        called.push(model);
        throw new ProviderError('unavailable', 'agy tried to run a command in headless mode and returned nothing');
      };
      const cfg = config({ tiers: { triage: ['agy:flash', 'agy:pro', 'codex'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
      const result = await runCascade(context(root), cfg, pool, { catalog, gitRunner: originRunner(root), clock: new FakeClock() });
      expect(called).toEqual(['flash', 'pro']);
      expect(result.calls.map(call => call.status)).toEqual(['unavailable', 'unavailable', 'ok']);
      expect(result.warnings.filter(message => message.includes('agy tried to run a command'))).toEqual(['agy tried to run a command in headless mode and returned nothing']);
    }
  });
  it('deduplicates response_format warnings across calls within each run', async () => {
    const pool = providers({ agy: { flash: [] } });
    pool.get('agy')!.executeReview = async (_context, _model, _prompt, options) => {
      options.warn?.('qwen server does not support response_format');
      options.warn?.('qwen server does not support response_format');
      return { rawOutput: '[]', durationMs: 0, worktreeClean: true };
    };
    const result = await runCascade(context(root), config(), pool, { catalog, gitRunner: originRunner(root), clock: new FakeClock() });
    expect(result.warnings.filter(message => message.includes('response_format'))).toEqual(['qwen server does not support response_format']);
  });
  it('reports below-floor Argon even when triage completes without escalation', async () => {
    const entries = catalog.map(entry => ({ ...entry, quotaGroup: entry.id === 'pro' ? 'agy:argon' : entry.quotaGroup }));
    const result = await runCascade(context(root), config(), providers({ agy: { flash: ['[]'], pro: ['[]'] } }), {
      catalog: entries, gitRunner: originRunner(root), quotaSnapshot: { 'agy:argon': { remainingPercent: 0 } }, clock: new FakeClock(),
    });
    expect(result.calls.map(call => call.model)).toEqual(['flash']);
    expect(result.warnings.filter(message => message === 'agy:argon: quota below floor (0%), skipped')).toHaveLength(1);
  });

  it.each(['status', 'HEAD', 'error'])('aborts the run on checkout %s changes', async mode => {
    let changed = false;
    const pool = providers({ agy: { flash: ['[]'], pro: ['[]'] }, codex: { codex: ['[]'] } });
    pool.get('agy')!.executeReview = async () => { changed = true; if (mode === 'error') throw new Error('failed'); return { rawOutput: '[]', durationMs: 0, worktreeClean: true }; };
    const result = await runCascade(context(root), config(), pool, { catalog, clock: new FakeClock(), gitRunner: async (command, args, options) => {
      if (args.includes('status')) return { stdout: changed && mode !== 'HEAD' ? ' M sample.ts\n?? new.txt\n' : '', stderr: '', exitCode: 0 };
      if (changed && mode === 'HEAD' && args.includes('rev-parse')) return { stdout: 'c'.repeat(40), stderr: '', exitCode: 0 };
      return originRunner(root)(command, args, options);
    } });
    expect(result).toMatchObject({ errors: [expect.stringContaining(mode === 'HEAD' ? 'HEAD' : 'sample.ts')] });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.status).toBe('error');
    expect(result.coverage.complete).toBe(false);
  });
  it('testCascade_EscalatesMoney', async () => {
    const pool = providers({ agy: { flash: [JSON.stringify([finding({ trigger: 'currency rounding error' })])] }, codex: { codex: [yes()] } });
    const cfg = config({ escalate: { focus: ['currency'], belowConfidence: 0.7 } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.tier)).toEqual(['triage', 'confirm']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ verified: true, origin: 'pre-existing' });
    expect(pool.get('codex')!.calls[0]!.prompt).toContain('@@ -1 +1,2 @@');
    expect(pool.get('codex')!.calls[0]!.prompt).toContain('currency rounding error');
  });

  it('testCascade_BelowConfidenceEscalation', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ confidence: 0.5 })])] },
      codex: { codex: ['See [1]. ' + yes({ fix: 'Use the confirming fix' })] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.findings[0]).toMatchObject({ confidence: 0.5, fix: 'Use the confirming fix' });
    expect(result.calls.map(call => call.purpose)).toEqual(['review', 'confirm']);
  });

  it('escalates BLOCKER even without a focus match and keeps confirmed evidence', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])] },
      codex: { codex: [yes({ evidence_quote: 'export const other = load(input);', line: 2, confidence: 0.5 })] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.findings[0]).toMatchObject({ severity: 'BLOCKER', line: 2, evidence_quote: 'export const other = load(input);' });
  });

  it('does not escalate confidence equal to threshold and counts verifier rejections', async () => {
    const raw = [finding({ confidence: 0.7 }), finding({ file: 'hallucinated.ts' }), finding({ evidence_quote: 'deleteEverything(secret);' })];
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify(raw)] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.ledgerDraft[0]).toMatchObject({ rawFindingsCount: 3, verifiedFindingsCount: 1, rejectedFindingsCount: 2 });
    expect(Object.keys(result.ledgerDraft[0]!.rejectionReasons).join(' ')).toContain('file not found');
  });

  it('drops a rejected confirmation and cannot trust invented confirmation evidence', async () => {
    const raw = JSON.stringify([finding({ confidence: 0.5 })]);
    const rejected = await runCascade(context(root), config(), providers({ agy: { flash: [raw] }, codex: { codex: ['{"decision":"reject"}'] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(rejected.findings).toEqual([]);
    expect(rejected.unconfirmed).toEqual([]);
    expect(rejected.ledgerDraft[1]!.rejectionReasons['confirm rejected finding']).toBe(1);
    expect(rejected.ledgerDraft[1]).toMatchObject({ rawFindingsCount: 1, verifiedFindingsCount: 0, rejectedFindingsCount: 1 });
    const invented = await runCascade(context(root), config(), providers({ agy: { flash: [raw] }, codex: { codex: [yes({ evidence_quote: 'inventedCall(secret);' })] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(invented.findings).toEqual([]);
    expect(invented.unconfirmed).toHaveLength(1);
    expect(invented.ledgerDraft[1]!.rejectedFindingsCount).toBe(1);
  });

  it.each(['not JSON', { error: 'timeout' } as FakeResponse])('escalates malformed JSON or an early triage timeout to review: %j', response => {
    return runCascade(context(root), config(), providers({ agy: { flash: [response], pro: [JSON.stringify([finding()])] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() }).then(result => {
      expect(result.calls.map(call => call.tier)).toEqual(['triage', 'review']);
      expect(result.findings).toHaveLength(1);
    });
  });

  it('testCascade_QwenOnlyNeverFinal', async () => {
    const cfg = config({ tiers: { triage: ['qwen'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
    const only = await runCascade(context(root), cfg, providers({ qwen: { qwen: [JSON.stringify([finding()])] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(only.findings).toEqual([]);
    expect(only.unconfirmed).toHaveLength(1);
    expect(only.warnings.join(' ')).toContain('local model only');
    const confirmed = await runCascade(context(root), cfg, providers({ qwen: { qwen: [JSON.stringify([finding()])] }, agy: { pro: ['[]', yes()] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(confirmed.calls.map(call => call.tier)).toEqual(['triage', 'review', 'review']);
    expect(confirmed.findings).toHaveLength(1);
    expect(confirmed.unconfirmed).toEqual([]);
  });

  it('tries the next review model after an early review timeout', async () => {
    const cfg = config({ tiers: { triage: ['agy:flash'], review: ['agy:pro', 'claude:sonnet'], confirm: [], visual: [] } });
    const pool = providers({ agy: { flash: ['not JSON'], pro: [{ error: 'timeout' }] }, claude: { sonnet: [JSON.stringify([finding()])] } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['flash', 'pro', 'sonnet']);
    expect(result.findings).toHaveLength(1);
  });

  it('verifies findings even when the call cap is exhausted', async () => {
    const result = await runCascade(context(root), config({ budget: { maxCalls: 1 } }), providers({ agy: { flash: [JSON.stringify([
      finding({ confidence: 0.5 }), finding({ line: 2, trigger: 'Loading uses a stale cache', impact: 'Old data is displayed', evidence_quote: 'export const other = load(input);' }),
    ])] }, codex: { codex: [yes()] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.unconfirmed).toHaveLength(1);
    expect(result.ledgerDraft[0]?.verifiedFindingsCount).toBe(2);
    expect(result.warnings).toContain(BUDGET_WARNING);
  });

  it('returns and records a hanging call at the run deadline', async () => {
    const clock = new FakeClock();
    const pool = providers({ agy: { flash: [{ neverReturns: true }], pro: ['[]'] } });
    const pending = runCascade(context(root), config({ budget: { maxMinutes: 1 } }), pool, { gitRunner: originRunner(root), catalog, clock });
    for (let i = 0; i < 20 && !pool.get('agy')!.calls.length; i++) await Promise.resolve();
    expect(pool.get('agy')!.calls).toHaveLength(1);
    clock.advance(60_000);
    const result = await pending;
    expect(result.calls).toHaveLength(1);
    expect(result.ledgerDraft[0]).toMatchObject({ timedOutCalls: 1, durationMs: 60_000 });
    expect(pool.get('agy')!.calls[0]!.aborted).toBe(true);
    expect(result.warnings).toContain(BUDGET_WARNING);
    expect(result.coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason: 'run-deadline-reached' }]);
    expect(clock.pending).toBe(0);
  });

  it('falls back after an early confirmation timeout within the same budget', async () => {
    const cfg = config({ tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex', 'agy:opus'], visual: [] } });
    const pool = providers({ agy: { flash: [JSON.stringify([finding({ confidence: 0.5 })])], opus: [yes()] }, codex: { codex: [{ error: 'timeout' }] } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['flash', 'codex', 'opus']);
    expect(result.findings).toHaveLength(1);
  });

  it('filters the author family in triage and confirm and warns when it is unavoidable', async () => {
    const cfg = config({ author: 'claude', tiers: { triage: ['agy:sonnet', 'agy:flash'], review: ['agy:pro'], confirm: ['agy:opus', 'codex'], visual: [] } });
    const pool = providers({ agy: { sonnet: ['[]'], flash: [JSON.stringify([finding({ confidence: 0.5 })])], opus: ['[]'] }, codex: { codex: [yes()] } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['flash', 'codex']);
    cfg.tiers.triage = ['agy:sonnet'];
    const fallback = await runCascade(context(root), cfg, providers({ agy: { sonnet: ['[]'] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(fallback.warnings.join(' ')).toContain('Independence rule cannot be met');
  });

  it('a 429 disables the whole group, including models in another tier', async () => {
    const cfg = config({ tiers: { triage: ['agy:sonnet', 'agy:opus', 'agy:flash'], review: ['agy:pro'], confirm: ['agy:opus', 'codex'], visual: [] } });
    const pool = providers({ agy: { sonnet: [{ error: 'quota' }], opus: ['[]'], flash: [JSON.stringify([finding({ confidence: 0.5 })])] }, codex: { codex: [yes()] } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.model)).toEqual(['sonnet', 'flash', 'codex']);
    expect(result.calls[0]?.status).toBe('quota');
    expect(result.warnings.join(' ')).toContain('floor unchecked');
  });

  it('skips both models sharing a quota reading at the floor', async () => {
    const cfg = config({ tiers: { triage: ['agy:sonnet', 'agy:opus', 'agy:flash'], review: ['agy:pro'], confirm: [], visual: [] } });
    const result = await runCascade(context(root), cfg, providers({ agy: { sonnet: ['[]'], opus: ['[]'], flash: ['[]'] } }),
      { gitRunner: originRunner(root), catalog, clock: new FakeClock(), quotaSnapshot: { 'agy:anthropic': { remainingPercent: 15, timestamp: '2026-10-12T09:40:00Z' } } });
    expect(result.calls.map(call => call.model)).toEqual(['flash']);
  });

  it('discards every dirty-worktree finding and records a reason', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [{ rawOutput: JSON.stringify([finding()]), worktreeClean: false }], pro: ['[]'] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.findings).toEqual([]);
    expect(result.ledgerDraft[0]!.rejectionReasons['provider changed worktree']).toBe(1);
  });

  it('ignores model origin except OPTIONAL improvement, including a corrected line', async () => {
    const result = await runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([
      finding({ origin: 'improvement', line: 25 }),
      finding({ severity: 'OPTIONAL', origin: 'improvement', line: 2, evidence_quote: 'export const other = load(input);', trigger: 'Naming is unclear', impact: 'Harder to read' }),
    ])] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.findings.map(item => [item.line, item.origin])).toEqual([[1, 'pre-existing'], [2, 'improvement']]);
  });

  it.each([true, false, 'no budget'] as const)('adjudicates related cross-family sources: %s', async verdict => {
    const raw = [finding({ trigger: 'Missing authorization when deleting users', impact: 'Users can delete protected records', confidence: 0.7 }),
      finding({ line: 2, trigger: 'Missing audit when deleting users', impact: 'Users can delete protected records', confidence: 0.7, evidence_quote: 'export const other = load(input);' })];
    const cfg = config({ escalate: { focus: ['authorization'], belowConfidence: 0.7 }, budget: { maxCalls: verdict === 'no budget' ? 2 : 3 } });
    const pool = providers({ agy: { flash: [JSON.stringify(raw)] }, codex: { codex: [yes(), 'See [1]. ' + JSON.stringify({ same: verdict })] } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    if (verdict === true) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.confidence).toBe(0.7);
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
    const execute = () => runCascade(context(root), config(), providers({ agy: { flash: [JSON.stringify([finding({ confidence: 0.5 })])] }, codex: { codex: [yes()] } }), { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(await execute()).toEqual(await execute());
  });

  it('does not compound confidence boosts in an adjudication prompt after strong dedupe', async () => {
    const raw = [finding({ trigger: 'Missing authorization when deleting users', impact: 'Users can delete protected records', confidence: 0.6 }),
      finding({ trigger: 'Missing authorization when deleting users', impact: 'Users can delete protected records', confidence: 0.5 }),
      finding({ line: 2, trigger: 'Missing audit when deleting users', impact: 'Users can delete protected records', confidence: 0.9, evidence_quote: 'export const other = load(input);' })];
    const cfg = config({ escalate: { focus: ['authorization'], belowConfidence: 0.7 } });
    const pool = providers({ agy: { flash: [JSON.stringify(raw)] }, codex: { codex: [yes({ confidence: 0.4 }), yes({ confidence: 0.7 }), '{"same":false}'] } });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    const prompt = pool.get('codex')!.calls[2]!.prompt;
    const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { first: { confidence: number } };
    expect(payload.first.confidence).toBe(0.7);
    expect(result.findings[0]?.confidence).toBe(0.7);
    expect(result.findings).toHaveLength(2);
  });
  it.each([true, false])('local money BLOCKER requires both tiers: %s', async available => {
    const cfg = config({ tiers: { triage: ['qwen'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
    const pool = providers({ qwen: { qwen: [JSON.stringify([finding({ severity: 'BLOCKER', trigger: 'money rounding' })])] }, agy: { pro: ['[]', yes()] }, ...(available ? { codex: { codex: [yes()] } } : {}) });
    const result = await runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.calls.map(call => call.tier)).toEqual(available ? ['triage', 'review', 'review', 'confirm'] : ['triage', 'review', 'review']);
    expect(result.findings).toHaveLength(available ? 1 : 0);
    expect(result.unconfirmed).toHaveLength(available ? 0 : 1);
    if (available) expect(result.findings[0]?.confidence).toBe(0.9);
  });
  it.each(['triage', 'review', 'confirm', 'visual', 'author'])('validates %s before calls', async tier => {
    const cfg = config();
    if (tier === 'author') cfg.author = 'invalid-author';
    else cfg.tiers[tier as keyof typeof cfg.tiers].push('agy:fable-9');
    const pool = providers({ agy: { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])] }, codex: { codex: [yes()] } });
    await expect(runCascade(context(root), cfg, pool, { gitRunner: originRunner(root), catalog })).rejects.toThrow();
    expect([...pool.values()].flatMap(provider => provider.calls)).toHaveLength(0);
  });
  it('does not warn after a normal last permitted call', async () => {
    const result = await runCascade(context(root), config({ budget: { maxCalls: 1 } }), providers({ agy: { flash: ['[]'] } }), { gitRunner: originRunner(root), catalog });
    expect(result.warnings).not.toContain(BUDGET_WARNING);
  });
  it('rejects a confirmation moved to distant real code', async () => {
    await writeFile(path.join(root, 'far.ts'), source + '\n'.repeat(30) + 'export const distant = unrelated();\n');
    const pool = providers({ agy: { flash: [JSON.stringify([finding({ file: 'far.ts', severity: 'BLOCKER' })])] }, codex: { codex: [yes({ line: 33, evidence_quote: 'export const distant = unrelated();' })] } });
    const result = await runCascade(context(root), config(), pool, { gitRunner: originRunner(root), catalog, clock: new FakeClock() });
    expect(result.findings).toHaveLength(0);
    expect(result.unconfirmed).toHaveLength(1);
    for (const ledger of result.ledgerDraft) expect(ledger.rawFindingsCount).toBe(ledger.verifiedFindingsCount + ledger.rejectedFindingsCount);
  });


  it.each([10, 1, 3000])('reports chunk coverage for %s files/calls', async size => {
    const count = size === 3000 ? 3000 : 10;
    const ctx = context(root);
    ctx.touchedFiles = Array.from({ length: count }, (_, i) => 'file' + i + '.ts');
    ctx.diff = ctx.touchedFiles.map(file => 'diff --git a/' + file + ' b/' + file + '\n--- a/' + file + '\n+++ b/' + file + '\n@@ -1 +1 @@\n+' + 'x'.repeat(count === 3000 ? 10 : 10000) + '\n').join('');
    const pool = providers({ agy: { flash: Array(100).fill('[]') } });
    const result = await runCascade(ctx, config({ budget: { maxCalls: size === 1 ? 1 : 100 } }), pool, { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage.complete).toBe(size !== 1);
    expect(result.coverage.skippedFiles.length).toBe(size === 1 ? 8 : 0);
    expect(result.calls.length).toBeGreaterThan(size === 1 ? 0 : 1);
    const payloads = pool.get('agy')!.calls.map(call => {
      expect(call.prompt.length).toBeLessThanOrEqual(24000);
      return JSON.parse(call.prompt.slice(call.prompt.indexOf('{'))) as { diff: string };
    });
    expect(payloads.every(payload => payload.diff?.includes('@@'))).toBe(true);
    if (size !== 1) expect(payloads.map(payload => payload.diff).join('')).toBe(ctx.diff);
    else for (const file of result.coverage.skippedFiles) expect(result.warnings.join(' ')).toContain(file);
  });
  it('records a cut oversized hunk', async () => {
    const ctx = context(root);
    ctx.diff += '+' + 'x'.repeat(100000);
    const result = await runCascade(ctx, config(), providers({ agy: { flash: ['[]'] } }), { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.truncatedHunks).toEqual([{ file: 'sample.ts', hunk: 1 }]);
    expect(result.warnings.join(' ')).toContain('sample.ts');
  });
  it('skips files when no diff content fits', async () => {
    const ctx = { ...context(root), specContent: 'x'.repeat(30000) };
    const result = await runCascade(ctx, config(), providers({ agy: { flash: ['[]'] } }), { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.calls).toHaveLength(0);
    expect(result.coverage).toMatchObject({ complete: false, skippedFiles: ['sample.ts'] });
    expect(result.coverage.skippedFileReasons).toEqual([{ file: 'sample.ts', reason: 'no-diff-content' }]);
  });
  it('counts findings left at the verification deadline', async () => {
    const clock = new FakeClock();
    const runner: ReturnType<typeof originRunner> = async (...args) => {
      if (args[1].includes('blame')) clock.advance(60000);
      return originRunner(root)(...args);
    };
    const result = await runCascade(context(root), config({ budget: { maxMinutes: 1 } }), providers({ agy: { flash: [JSON.stringify([finding(), finding()])] } }), { catalog, clock, gitRunner: runner });
    expect(result.ledgerDraft[0]!.rejectionReasons['run deadline']).toBe(1);
    expect(result.warnings).toContain(BUDGET_WARNING);
  });

  it.each([1, 10])('splits large files at hunk boundaries with %s calls', async maxCalls => {
    const ctx = context(root);
    const header = ctx.diff.slice(0, ctx.diff.indexOf('@@'));
    const hunks = [1, 2, 3].map(line => '@@ -' + line + ' +' + line + ' @@\n+' + ('hunk' + line).repeat(3000) + '\n');
    ctx.diff = header + hunks.join('');
    const pool = providers({ agy: { flash: Array(10).fill('[]') } });
    const result = await runCascade(ctx, config({ budget: { maxCalls } }), pool, { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.calls).toHaveLength(maxCalls === 1 ? 1 : 3);
    expect(result.coverage.truncatedHunks).toEqual([]);
    expect(result.coverage.complete).toBe(maxCalls !== 1);
    expect(result.coverage.skippedFiles).toEqual(maxCalls === 1 ? ['sample.ts'] : []);
    pool.get('agy')!.calls.forEach((call, index) => {
      const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf('{')));
      expect(payload.diff).toBe(header + hunks[index]);
    });
  });
  it('reports missing diff files and unsuccessful review responses', async () => {
    const ctx = context(root);
    ctx.touchedFiles.push('missing.ts');
    const result = await runCascade(ctx, config(), providers({ agy: { flash: ['invalid'], pro: ['invalid'] } }), { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.coverage).toMatchObject({ complete: false, reviewedFiles: [], skippedFiles: ['missing.ts', 'sample.ts'] });
    for (const file of ctx.touchedFiles) expect(result.warnings.join(' ')).toContain(file);
  });
});
