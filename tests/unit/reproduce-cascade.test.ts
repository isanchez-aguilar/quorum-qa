import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCascade, type ReproduceFinding } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider, type FakeResponse } from '../../src/providers/fake.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import type { Finding } from '../../src/types/index.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

describe('opt-in reproduction cascade', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-reproduce-cascade-'));
    for (const file of ['sample.ts', 'second.ts', 'third.ts', 'fourth.ts']) await writeFile(path.join(root, file), source);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const proposal = JSON.stringify({ path: 'proof.test.ts', content: 'test source', expect: 'expected assertion',
    status: 'reproduced', failureReason: 'untrusted status' });
  const yes = () => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote });
  const blocker = (overrides: Partial<Finding> = {}) => finding({ severity: 'BLOCKER', confidence: 0.7, ...overrides });
  const config = (overrides: Record<string, unknown> = {}) => validateConfig({ checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] }, ...overrides });
  function pool(findings: Finding[], responses: FakeResponse[] = [yes(), proposal]) {
    const agy = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(findings)] });
    const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: responses });
    return { agy, codex, providers: new Map<string, ProviderAdapter>([['agy', agy], ['codex', codex]]) };
  }
  const reproduce = () => vi.fn<ReproduceFinding>(async () => ({ status: 'reproduced', reason: 'synthetic proof' }));

  it('runs at most three BLOCKERs in confidence order and marks the rest unproven', async () => {
    const findings = [blocker({ confidence: 0.6 }), blocker({ file: 'second.ts', confidence: 0.9 }),
      blocker({ file: 'third.ts', confidence: 0.8 }), blocker({ file: 'fourth.ts', confidence: 0.7 })];
    const models = pool(findings, [yes(), yes(), yes(), yes(), proposal, proposal, proposal]);
    const run = reproduce();
    const result = await runCascade(context(root), config(), models.providers,
      { catalog, gitRunner: originRunner(root), clock: new FakeClock(), reproduce: run });
    expect(run.mock.calls.map(([item]) => item.file)).toEqual(['second.ts', 'third.ts', 'fourth.ts']);
    expect(result.findings.find(item => item.file === 'sample.ts')).toMatchObject({ severity: 'BLOCKER',
      reproduction: { status: 'unproven', failureReason: 'reproduction cap' } });
    expect(result.calls.filter(call => call.purpose === 'reproduce')).toHaveLength(3);
  });

  it('uses the review call budget for proposals and does not execute after it is exhausted', async () => {
    const models = pool([blocker()]); const run = reproduce();
    const result = await runCascade(context(root), config({ budget: { maxCalls: 2 } }), models.providers,
      { catalog, gitRunner: originRunner(root), clock: new FakeClock(), reproduce: run });
    expect(result.calls.map(call => call.purpose)).toEqual(['review', 'confirm']);
    expect(run).not.toHaveBeenCalled();
    expect(result.findings[0]?.reproduction).toMatchObject({ status: 'unproven', failureReason: 'reproduction budget exhausted' });
  });

  it('shares the deadline with the proposal call and never executes an expired proposal', async () => {
    const models = pool([blocker()]); const run = reproduce(); const clock = new FakeClock();
    const original = models.codex.executeReview.bind(models.codex);
    models.codex.executeReview = async (...args) => {
      if (args[2].includes('TASK: PROPOSE REPRODUCTION')) clock.advance(60_000);
      return original(...args);
    };
    const result = await runCascade(context(root), config({ budget: { maxMinutes: 1 } }), models.providers,
      { catalog, gitRunner: originRunner(root), clock, reproduce: run });
    expect(run).not.toHaveBeenCalled();
    expect(result.findings[0]?.reproduction?.status).toBe('unproven');
    expect(result.calls.at(-1)).toMatchObject({ purpose: 'reproduce', status: 'timeout' });
    expect(clock.pending).toBe(0);
  });

  it('filters unrelated JSON and resets model-supplied reproduction status before executing', async () => {
    const models = pool([blocker()], [yes(), '{"status":"reproduced"} {"path":4,"content":"invalid"}\n```json\n' + proposal + '\n```']);
    const run = vi.fn<ReproduceFinding>(async (_finding, supplied) => {
      expect(supplied).toEqual({ path: 'proof.test.ts', content: 'test source', expect: 'expected assertion', status: 'pending' });
      return { status: 'not-reproduced', reason: 'passed' };
    });
    const result = await runCascade(context(root), config(), models.providers,
      { catalog, gitRunner: originRunner(root), clock: new FakeClock(), reproduce: run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.findings[0]).toMatchObject({ severity: 'IMPORTANT', reproduction: { status: 'not-reproduced', failureReason: 'passed' } });
    expect(models.codex.calls.at(-1)?.prompt).toContain('untrusted data');
  });

  it('marks an invalid-only proposal unproven without running it', async () => {
    const models = pool([blocker()], [yes(), '{"path":"proof.test.ts","content":"","expect":"x","status":"reproduced"}']);
    const run = reproduce();
    const result = await runCascade(context(root), config(), models.providers,
      { catalog, gitRunner: originRunner(root), clock: new FakeClock(), reproduce: run });
    expect(run).not.toHaveBeenCalled();
    expect(result.calls.at(-1)?.status).toBe('invalid');
    expect(result.findings[0]?.reproduction).toMatchObject({ status: 'unproven', failureReason: 'no valid reproduction proposal' });
  });

  it('does not reproduce a same-family confirmation', async () => {
    const agy = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([blocker()])], pro: [yes(), proposal] });
    const run = reproduce();
    const result = await runCascade(context(root), config({ tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['agy:pro'], visual: [] } }),
      new Map([['agy', agy]]), { catalog, gitRunner: originRunner(root), clock: new FakeClock(), reproduce: run });
    expect(run).not.toHaveBeenCalled();
    expect(agy.calls).toHaveLength(2);
    expect(result.findings[0]?.reproduction).toMatchObject({ status: 'unproven', failureReason: 'no cross-family confirmation' });
  });

  it('quarantines a local-only BLOCKER without requesting reproduction', async () => {
    const qwen = new FakeProvider('qwen', 'local', originRunner(root), { qwen: [JSON.stringify([blocker()])] });
    const run = reproduce();
    const result = await runCascade(context(root), config({ tiers: { triage: ['qwen'], review: ['agy:pro'], confirm: [], visual: [] } }),
      new Map([['qwen', qwen]]), { catalog, gitRunner: originRunner(root), clock: new FakeClock(), reproduce: run });
    expect(run).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
    expect(result.unconfirmed[0]?.reproduction?.status).toBe('unproven');
    expect(result.calls).toHaveLength(1);
  });

  it('does not request proposals when reproduction is not opted into', async () => {
    const models = pool([blocker()]);
    const result = await runCascade(context(root), config(), models.providers,
      { catalog, gitRunner: originRunner(root), clock: new FakeClock() });
    expect(result.calls.map(call => call.purpose)).toEqual(['review', 'confirm']);
    expect(result.findings[0]?.reproduction).toBeUndefined();
    expect(models.codex.calls).toHaveLength(1);
  });
});
