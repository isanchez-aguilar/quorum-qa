import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

describe('local chunk escalation boundaries', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-routing-qa-'));
    await writeFile(path.join(root, 'sample.ts'), source);
  });
  afterAll(async () => {
    expect(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-routing-qa-'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  function config(maxCalls: number) {
    return validateConfig({ checks: [], budget: { maxCalls },
      tiers: { triage: ['qwen'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
  }

  it.each([3, 4])('tracks separate chunks of one file with %i available calls', async maxCalls => {
    const reviewContext = context(root);
    reviewContext.diff = 'diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n'
      + '@@ -1 +1 @@\n-' + 'a'.repeat(7_000) + '\n+' + 'b'.repeat(7_000) + '\n'
      + '@@ -10 +10 @@\n-' + 'c'.repeat(7_000) + '\n+' + 'd'.repeat(7_000) + '\n';
    const chunks = reviewChunks(reviewContext);
    expect(chunks.chunks).toHaveLength(2);
    expect(chunks.truncatedHunks).toEqual([]);
    const qwen = new FakeProvider('qwen', 'local', originRunner(root), { qwen: ['[]', '[]'] });
    const agy = new FakeProvider('agy', 'google', originRunner(root), { pro: ['[]', '[]'] });
    const result = await runCascade(reviewContext, config(maxCalls), new Map([['qwen', qwen], ['agy', agy]]),
      { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(result.calls).toHaveLength(maxCalls);
    expect(result.coverage.reviewedFiles).toEqual(['sample.ts']);
    expect(result.coverage.complete).toBe(maxCalls === 4);
    expect(result.findings).toEqual([]);
    expect(result.unconfirmed).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('reviewed only by a local model: sample.ts'))).toBe(maxCalls === 3);
    expect(agy.calls.map(call => call.prompt)).toEqual(qwen.calls.slice(0, maxCalls - 2).map(call => call.prompt));
  });

  it.each([3, 4])('charges chunk-review retries while preserving rule 3b with %i calls', async maxCalls => {
    const qwen = new FakeProvider('qwen', 'local', originRunner(root), { qwen: [JSON.stringify([finding()])] });
    const agy = new FakeProvider('agy', 'google', originRunner(root), {});
    const retryReservations: boolean[] = [];
    agy.executeReview = async (_context, _model, prompt, options) => {
      const confirmation = prompt.includes('Return JSON {"decision"');
      if (!confirmation) retryReservations.push(options.reserveRetry?.() ?? false);
      return { rawOutput: confirmation ? JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote }) : '[]',
        worktreeClean: true, durationMs: 0 };
    };
    const result = await runCascade(context(root), config(maxCalls), new Map([['qwen', qwen], ['agy', agy]]),
      { catalog, clock: new FakeClock(), gitRunner: originRunner(root) });
    expect(retryReservations).toEqual([maxCalls === 4]);
    expect(result.calls.map(call => call.purpose)).toEqual(['review', 'review', 'confirm']);
    expect(result.ledgerDraft.reduce((sum, call) => sum + call.callsUsed, 0)).toBe(maxCalls);
    expect(result.coverage.complete).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.confirmationFamilies).toEqual(expect.arrayContaining(['local', 'google']));
    expect(result.unconfirmed).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
