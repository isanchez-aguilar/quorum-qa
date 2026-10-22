import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { RunBudget } from '../../src/cascade/budget.js';
import { completionTiming, formatDuration } from '../../src/cascade/timing.js';
import { validateConfig } from '../../src/config/schema.js';
import { parseArgs } from '../../src/cli/args.js';
import { USAGE } from '../../src/cli/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { ProviderError } from '../../src/providers/types.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';
import { fastest } from '../helpers/timing.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-speed-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const config = (concurrency = 3, maxCalls = 30) => {
  const value = validateConfig({ checks: [], budget: { maxCalls }, escalate: { confirmImportant: false },
    tiers: { triage: ['agy:flash'], review: ['claude:sonnet'], confirm: ['codex'], visual: [] } });
  value.budget.concurrency = concurrency;
  return value;
};
async function chunks(count = 6) {
  const ctx = context(root);
  ctx.touchedFiles = Array.from({ length: count }, (_, i) => `file${i}.ts`);
  ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,3 @@\n+${source}+// ${'x'.repeat(15000)}\n`).join('');
  await Promise.all(ctx.touchedFiles.map(file => writeFile(path.join(root, file), source)));
  return ctx;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scriptedBudgetRun(count: number, maxCalls: number, concurrency: number, script: number[]) {
  const ctx = await chunks(count);
  const cfg = config(concurrency, maxCalls);
  const budget = new RunBudget(cfg.budget, new FakeClock());
  const triage = new FakeProvider('agy', 'google', originRunner(root), {});
  triage.executeReview = async (_ctx, _model, prompt, options) => {
    const index = Number(/file(\d+)\.ts/.exec(prompt)![1]);
    if (script[index]! & 1) options.reserveRetry?.();
    if (script[index]! & 8) throw new ProviderError('unavailable', 'scripted failure');
    if (script[index]! & 16) throw new ProviderError('quota', 'scripted quota');
    return { rawOutput: script[index]! & 2 ? 'invalid' : JSON.stringify([finding({ file: `file${index}.ts` })]), durationMs: 0, worktreeClean: true };
  };
  const reviewer = new FakeProvider('claude', 'anthropic', originRunner(root), {});
  reviewer.executeReview = async (_ctx, _model, prompt, options) => {
    const index = Number(/file(\d+)\.ts/.exec(prompt)![1]);
    if (script[index]! & 4) options.reserveRetry?.();
    return { rawOutput: JSON.stringify([finding({ file: `file${index}.ts` })]), durationMs: 0, worktreeClean: true };
  };
  const result = await runCascade(ctx, cfg, new Map([['agy', triage], ['claude', reviewer]]), { budget, catalog, gitRunner: originRunner(root) });
  return { calls: budget.calls, reviewed: result.coverage.reviewedFiles, findings: result.findings };
}

it('preserves two reviewed files with three chunks, four calls and one retry per chunk', async () => {
  const sequential = await scriptedBudgetRun(3, 4, 1, [1, 1, 1]);
  expect(sequential.calls).toBe(4);
  expect(sequential.reviewed).toHaveLength(2);
  expect(await scriptedBudgetRun(3, 4, 3, [1, 1, 1])).toEqual(sequential);
});

it('matches sequential calls, coverage and findings across seeded small-budget scripts', async () => {
  let seed = 0x51a7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let maxCalls = 3; maxCalls <= 8; maxCalls++) {
    for (let count = 1; count <= 4; count++) {
      for (let sample = 0; sample < 4; sample++) {
        const script = Array.from({ length: count }, () => random() >>> 16 & 31);
        expect(await scriptedBudgetRun(count, maxCalls, 3, script), JSON.stringify({ maxCalls, count, script }))
          .toEqual(await scriptedBudgetRun(count, maxCalls, 1, script));
      }
    }
  }
});

it('keeps retries and review fallbacks when a funded wave becomes sequential', async () => {
  const sequential = await scriptedBudgetRun(3, 12, 1, [7, 7, 7]);
  expect(sequential.calls).toBe(12);
  expect(sequential.reviewed).toHaveLength(3);
  expect(await scriptedBudgetRun(3, 12, 3, [7, 7, 7])).toEqual(sequential);
});

it('defaults to three triages and parallel checks, with strict configuration validation', () => {
  expect(validateConfig({ checks: [] }).budget).toMatchObject({ concurrency: 3, sequentialChecks: false });
  for (const concurrency of [0, 7, 1.5, '3', null]) {
    expect(() => validateConfig({ checks: [], budget: { concurrency } })).toThrow('budget.concurrency');
  }
  for (const concurrency of [1, 6]) expect(config(concurrency).budget.concurrency).toBe(concurrency);
  expect(validateConfig({ checks: [], budget: { sequentialChecks: true } }).budget.sequentialChecks).toBe(true);
  expect(() => validateConfig({ checks: [], budget: { sequentialChecks: 'true' } })).toThrow('sequentialChecks');
  expect(parseArgs(['review', '--sequential-checks']).flags.sequentialChecks).toBe(true);
  expect(USAGE).toContain('--sequential-checks');
  expect(parseArgs(['review', '--verbose']).flags.verbose).toBe(true);
  expect(USAGE).toContain('--verbose');
  expect(USAGE).toContain('budget.concurrency (1–6, default 3');
});

it('merges findings, warnings, calls and ledger in chunk order despite reversed completion', async () => {
  const ctx = await chunks();
  const run = async (concurrency: number) => {
    const provider = new FakeProvider('agy', 'google', originRunner(root), {});
    let active = 0; let peak = 0;
    const finished: number[] = [];
    provider.executeReview = async (_ctx, _model, prompt, options) => {
      const index = Number(/file(\d+)\.ts/.exec(prompt)![1]);
      peak = Math.max(peak, ++active);
      await pause((3 - index % 3) * 5);
      options.warn?.(`chunk ${index}`);
      finished.push(index); active--;
      return { rawOutput: JSON.stringify([finding({ file: `file${index}.ts` })]), durationMs: 10, worktreeClean: true };
    };
    const result = await runCascade(ctx, config(concurrency), new Map([['agy', provider]]), {
      catalog, gitRunner: originRunner(root), clock: new FakeClock(),
    });
    return { result, peak, finished };
  };
  const sequential = await run(1); const parallel = await run(3);
  expect(parallel.peak).toBe(3);
  expect(parallel.finished).not.toEqual(sequential.finished);
  expect(parallel.result).toEqual(sequential.result);
  expect(parallel.result.findings.map(item => item.file)).toEqual(ctx.touchedFiles);
});

it('stops unstarted quota-group calls while observing all in-flight results', async () => {
  const ctx = await chunks();
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  let started = 0; let finished = 0;
  provider.executeReview = async () => {
    const call = ++started;
    await pause(call === 2 ? 1 : 15);
    finished++;
    if (call === 2) throw new ProviderError('quota', 'synthetic quota');
    return { rawOutput: '[]', durationMs: 0, worktreeClean: true };
  };
  const cfg = config(3, 30); const budget = new RunBudget(cfg.budget, new FakeClock());
  const result = await runCascade(ctx, cfg, new Map([['agy', provider]]), { budget, catalog, gitRunner: originRunner(root) });
  expect(started).toBe(3); expect(finished).toBe(3);
  expect(budget.calls).toBe(3);
  expect(result.calls.filter(call => call.status === 'quota')).toHaveLength(1);
  expect(budget.unavailableGroups.has('agy:google')).toBe(true);
});

it('reserves calls and retries atomically even after asynchronous model discovery', async () => {
  const ctx = await chunks();
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  (provider as ProviderAdapter).resolveModel = async model => { await pause(1); return model; };
  let started = 0; let retries = 0;
  provider.executeReview = async (_ctx, _model, _prompt, options) => {
    started++;
    if (options.reserveRetry?.()) retries++;
    await pause(2);
    return { rawOutput: '[]', durationMs: 0, worktreeClean: true };
  };
  const cfg = config(3, 4); const budget = new RunBudget(cfg.budget, new FakeClock());
  const result = await runCascade(ctx, cfg, new Map([['agy', provider]]), { budget, catalog, gitRunner: originRunner(root) });
  expect(budget.calls).toBe(started + retries);
  expect(budget.calls).toBeLessThanOrEqual(4);
  expect(result.ledgerDraft.reduce((sum, ledger) => sum + ledger.callsUsed, 0)).toBe(budget.calls);
});

it.each([false, true])('awaits in-flight calls after a thrown error (dirty checkout: %s)', async dirty => {
  const ctx = await chunks();
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  let started = 0; let finished = 0; let changed = false;
  provider.executeReview = async () => {
    const call = ++started;
    await pause(call === 2 ? 1 : 15);
    finished++;
    if (call === 2) { changed = dirty; throw new Error('synthetic failure'); }
    return { rawOutput: '[]', durationMs: 0, worktreeClean: true };
  };
  const result = await runCascade(ctx, config(), new Map([['agy', provider]]), { catalog, clock: new FakeClock(),
    gitRunner: async (command, args, options) => args.includes('status') && changed
      ? { stdout: ' M sample.ts\n', stderr: '', exitCode: 0 } : originRunner(root)(command, args, options),
  });
  expect(started).toBe(3); expect(finished).toBe(3);
  if (dirty) {
    expect(result.errors.join(' ')).toContain('sample.ts');
    expect(result.findings).toEqual([]); expect(result.coverage.complete).toBe(false);
  }
});

it('waits for checks before escalation and accounts for phases with the injected clock', async () => {
  await writeFile(path.join(root, 'sample.ts'), source);
  const clock = new FakeClock(); const ctx = context(root);
  ctx.checksContext = 'Deterministic checks: running concurrently; their result is not part of this prompt.';
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  provider.executeReview = async (_ctx, _model, prompt) => {
    expect(prompt).toContain(ctx.checksContext!); expect(prompt).not.toContain('failed test');
    clock.advance(1000);
    return { rawOutput: JSON.stringify([finding({ confidence: 0.2 })]), durationMs: 1000, worktreeClean: true };
  };
  const confirmer = new FakeProvider('codex', 'openai', originRunner(root), {});
  confirmer.executeReview = async (_ctx, _model, prompt) => {
    expect(prompt).toContain('failed test');
    clock.advance(2000);
    return { rawOutput: '{"decision":"reject"}', durationMs: 2000, worktreeClean: true };
  };
  const result = await runCascade(ctx, config(), new Map([['agy', provider], ['codex', confirmer]]), {
    catalog, clock, gitRunner: originRunner(root), beforeConfirmation: async () => {
      clock.advance(3000); ctx.checksContext = 'failed test';
    },
  });
  expect(result.durations).toEqual({ checks: 0, triage: 1000, escalation: 2000, confirmation: 0, total: 6000 });
});

it('formats milliseconds without claiming summed overlapping phases as total', () => {
  expect(formatDuration(72_999)).toBe('1m 12s');
  expect(formatDuration(28_000)).toBe('28s');
  expect(formatDuration(0)).toBe('0s');
  expect(completionTiming({ checks: 120_000, triage: 28_000, escalation: 0, confirmation: 8000, total: 128_000 }, true))
    .toBe('quorum: done in 2m 08s (checks 2m 00s ran in parallel with triage 28s)');
});

it('six 50 ms chunks finish under 60% of sequential time (best of three)', async () => {
  const ctx = await chunks();
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  provider.executeReview = async () => { await pause(50); return { rawOutput: '[]', durationMs: 50, worktreeClean: true }; };
  const run = (concurrency: number) => runCascade(ctx, config(concurrency), new Map([['agy', provider]]), {
    catalog, gitRunner: originRunner(root), clock: new FakeClock(),
  });
  const sequential = await fastest(() => run(1), 3);
  const parallel = await fastest(() => run(3), 3);
  expect(parallel / sequential).toBeLessThan(0.6);
});

it.each(['invalid', 'local'] as const)('keeps %s fallback and verification order identical', async scenario => {
  const ctx = await chunks(3);
  const run = async (concurrency: number) => {
    const triage = new FakeProvider(scenario === 'local' ? 'qwen' : 'agy', scenario === 'local' ? 'local' : 'google', originRunner(root), {});
    let active = 0;
    triage.executeReview = async (_ctx, _model, prompt) => {
      active++;
      const index = Number(/file(\d+)\.ts/.exec(prompt)![1]);
      await pause((3 - index) * 5);
      active--;
      return { rawOutput: scenario === 'invalid' && index !== 1 ? '{broken' : JSON.stringify([finding({ file: `file${index}.ts` })]),
        durationMs: 5, worktreeClean: true };
    };
    const reviewer = new FakeProvider('claude', 'anthropic', originRunner(root), {});
    let reviewActive = false;
    reviewer.executeReview = async () => {
      expect(active).toBe(0); expect(reviewActive).toBe(false); reviewActive = true;
      await pause(1); reviewActive = false;
      return { rawOutput: '[]', durationMs: 5, worktreeClean: true };
    };
    const cfg = config(concurrency);
    if (scenario === 'local') cfg.tiers.triage = ['qwen'];
    return runCascade(ctx, cfg, new Map([[triage.name, triage], ['claude', reviewer]]), {
      catalog, clock: new FakeClock(), gitRunner: originRunner(root),
    });
  };
  expect(await run(3)).toEqual(await run(1));
});

it('preserves the confirmation reserve when first-pass findings need escalation', async () => {
  const ctx = await chunks(6);
  const run = async (concurrency: number) => {
    const triage = new FakeProvider('agy', 'google', originRunner(root), {});
    triage.executeReview = async (_ctx, _model, prompt) => ({ rawOutput: JSON.stringify([
      finding({ file: /file\d+\.ts/.exec(prompt)![0], confidence: 0.2 }),
    ]), durationMs: 0, worktreeClean: true });
    const confirmer = new FakeProvider('codex', 'openai', originRunner(root), { codex: ['{"decision":"reject"}'] });
    return runCascade(ctx, config(concurrency, 4), new Map([['agy', triage], ['codex', confirmer]]), {
      catalog, clock: new FakeClock(), gitRunner: originRunner(root),
    });
  };
  const result = await run(3);
  expect(result.calls.map(call => call.tier)).toEqual(['triage', 'triage', 'triage', 'confirm']);
  expect(result).toEqual(await run(1));
});

it('passes the run deadline and abort signal to every concurrent call', async () => {
  const ctx = await chunks(3); const clock = new FakeClock();
  const signals: AbortSignal[] = []; const deadlines: number[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  provider.executeReview = async (_ctx, _model, _prompt, options) => {
    deadlines.push(options.deadlineMs); signals.push(options.signal!);
    if (signals.length === 3) ready();
    return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const cfg = config(); cfg.budget.maxMinutes = 0.5;
  const pending = runCascade(ctx, cfg, new Map([['agy', provider]]), { catalog, clock, gitRunner: originRunner(root) });
  await started;
  clock.advance(30_000);
  const result = await pending;
  expect(deadlines).toEqual([30_000, 30_000, 30_000]);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(result.calls.map(call => call.status)).toEqual(['timeout', 'timeout', 'timeout']);
  expect(clock.pending).toBe(0);
});

it('settles in-flight workers before propagating an unexpected chunk error', async () => {
  const ctx = await chunks();
  const provider = new FakeProvider('agy', 'google', originRunner(root), {});
  let read = 0; let finished = 0;
  provider.executeReview = async () => {
    await pause(15); finished++;
    return { rawOutput: '[]', durationMs: 0, worktreeClean: true };
  };
  await expect(runCascade(ctx, config(), new Map([['agy', provider]]), {
    catalog, clock: new FakeClock(), gitRunner: originRunner(root), cache: {
      read: async () => { const index = ++read; if (index === 2) { await pause(1); throw new Error('synthetic cache failure'); } return undefined; },
      stage: () => {},
    },
  })).rejects.toThrow('synthetic cache failure');
  expect(read).toBe(3); expect(finished).toBe(2);
});

it('includes check evidence in batch confirmation and measures its own phase', async () => {
  await writeFile(path.join(root, 'sample.ts'), source);
  const ctx = context(root); const clock = new FakeClock(); const cfg = config();
  cfg.escalate.confirmImportant = true;
  const triage = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding()])] });
  const confirmer = new FakeProvider('codex', 'openai', originRunner(root), {});
  let called = false;
  confirmer.executeReview = async (_ctx, _model, prompt, options) => {
    called = true;
    expect(options.purpose).toBe('confirm-batch');
    expect(prompt).toContain('failed batch check');
    clock.advance(4000);
    return { rawOutput: '{"decisions":[{"id":"c1","decision":"reject"}]}', durationMs: 4000, worktreeClean: true };
  };
  const result = await runCascade(ctx, cfg, new Map([['agy', triage], ['codex', confirmer]]), {
    catalog, clock, gitRunner: originRunner(root), beforeConfirmation: async () => { ctx.checksContext = 'failed batch check'; },
  });
  expect(called).toBe(true);
  expect(result.durations).toEqual({ checks: 0, triage: 0, escalation: 0, confirmation: 4000, total: 4000 });
  expect(result.findings).toEqual([]);
});
