import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { review } from '../../src/cli/review.js';
import { buildReviewContext } from '../../src/context/index.js';
import { catalog, context, originRunner } from '../fixtures/cascade.js';
import type { CommandRunner } from '../../src/types/index.js';

vi.mock('../../src/context/index.js', () => ({ buildReviewContext: vi.fn() }));
vi.mock('../../src/worktree/index.js', () => ({
  createReviewWorktree: async (root: string) => ({ path: root, cleanup: async () => {} }), isClean: async () => true,
}));
vi.mock('../../src/rules/index.js', () => ({ loadRulesAt: async () => [], runRules: vi.fn() }));
vi.mock('../../src/runtime/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/runtime/run.js')>(),
  runRuntimeEvidence: async () => ({ available: false, reasons: ['synthetic unavailable evidence'], notes: [] }),
}));
vi.mock('../../src/refactor/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/refactor/index.js')>();
  return { ...original, runRefactorEvidence: async () => ({ available: false, reasons: ['synthetic unavailable evidence'],
    tests: original.compareTests({ runner: 'vitest', tests: [], suiteErrors: [] }, { runner: 'vitest', tests: [], suiteErrors: [] }),
    api: { changes: [], packageChanges: [], notes: [], breaking: false },
    blastRadius: { dependents: [], withoutTests: [], notes: [] }, summary: '{}',
  }) };
});
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-auto-cli-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each([
  [7, undefined, false, true, false], [4, undefined, false, false, false], [7, 12, false, false, false],
  [7, 50, false, false, false], [7, undefined, true, false, false], [7, 12, false, false, true],
  [7, 50, true, false, true],
] as const)('discloses resolved budget for chunks=%i explicit=%s dry=%s', async (count, maxCalls, dryRun, announced, trustHeadConfig = false) => {
  const ctx = context(root); ctx.mode = 'redesign';
  ctx.touchedFiles = Array.from({ length: count }, (_, i) => `file${i}.ts`);
  ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+${'x'.repeat(15000)}\n`).join('');
  vi.mocked(buildReviewContext).mockResolvedValue(ctx);
  const reads: string[] = [];
  const gitRunner: CommandRunner = async (file, args, options) => {
    if (args.includes('rev-parse') && !args.includes('--show-toplevel')) return { exitCode: 0, stderr: '', stdout: ctx.headCommit };
    if (args.includes('show') && args.some(arg => arg.endsWith(':quorum.config.json'))) {
      reads.push(args.at(-1)!);
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ checks: [], budget: maxCalls === undefined ? { maxMinutes: 5 } : { maxCalls },
        tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } }) };
    }
    return originRunner(root)(file, args, options);
  };
  let out = ''; let err = '';
  await review({ mode: 'redesign', diff: 'base...HEAD', noChecks: true, noCache: true, json: true, dryRun, trustHeadConfig },
    { out: text => { out += text; }, err: text => { err += text; } },
    { repoRoot: root, gitRunner, providers: new Map(), catalog, appendLedger: async () => {}, appendFindings: async () => {} });
  expect(reads).toEqual([`${trustHeadConfig ? ctx.headCommit : ctx.baseCommit}:quorum.config.json`]);
  const notice = 'quorum: call budget 21 (auto-scaled from 7 chunks; set budget.maxCalls to pin it)\n';
  expect(err.includes(notice)).toBe(announced);
  expect(err.match(/quorum: call budget/g)?.length ?? 0).toBe(announced ? 1 : 0);
  if (!dryRun) {
    const result = JSON.parse(out);
    expect(result.callBudget).toEqual({ maxCalls: maxCalls ?? Math.max(12, 3 * count), auto: maxCalls === undefined });
    expect(await readFile(path.join(root, '.quorum', 'reports', `${result.runId}.md`), 'utf8'))
      .toContain(`**Call budget:** ${result.callBudget.maxCalls} (${maxCalls === undefined ? 'auto' : 'from budget.maxCalls'})`);
  } else expect(out).toContain(maxCalls === undefined ? 'Max API Calls: 21 (auto: 3 x 7 chunks, clamped to 12..40)'
    : `Max API Calls: ${maxCalls} (from budget.maxCalls)`);
});

it.each(['runtime', 'refactor'] as const)('keeps the default at twelve without model chunks in %s', async mode => {
  const ctx = context(root); ctx.mode = mode;
  ctx.touchedFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
  ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+${'x'.repeat(15000)}\n`).join('');
  vi.mocked(buildReviewContext).mockResolvedValue(ctx);
  const gitRunner: CommandRunner = async (file, args, options) => args.includes('show') && args.some(arg => arg.endsWith(':quorum.config.json'))
    ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ checks: [], runtime: {
      start: ['node', 'server.cjs'], readyUrl: 'http://localhost:4173/',
      flows: Array.from({ length: 7 }, (_, i) => ({ name: `flow${i}`, steps: [{ goto: '/' }] })),
    } }) } : originRunner(root)(file, args, options);
  let out = ''; let err = '';
  const forbidden = vi.fn(async () => { throw new Error('must not run'); });
  await review({ mode, diff: 'base...HEAD', json: true, ...(mode === 'refactor' ? { deterministicOnly: true } : {}) },
    { out: text => { out += text; }, err: text => { err += text; } },
    { repoRoot: root, gitRunner, providers: new Map(), checkRunner: forbidden, containerRunner: forbidden,
      appendLedger: async () => {}, appendFindings: async () => {} });
  expect(JSON.parse(out).callBudget).toEqual({ maxCalls: 12, auto: true });
  expect(err).not.toContain('quorum: call budget');
  expect(forbidden).not.toHaveBeenCalled();
});
