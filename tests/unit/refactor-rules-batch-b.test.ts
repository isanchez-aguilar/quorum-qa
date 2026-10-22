import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import { context } from '../fixtures/cascade.js';
import { compareTests, runRefactorEvidence } from '../../src/refactor/index.js';
import { runCascade } from '../../src/cascade/index.js';
import { buildReviewContext } from '../../src/context/index.js';
import { loadRulesAt } from '../../src/rules/index.js';
import type { CommandRunner } from '../../src/types/index.js';

vi.mock('../../src/refactor/index.js', async original => ({ ...await original<object>(), runRefactorEvidence: vi.fn() }));
vi.mock('../../src/context/index.js', async original => ({ ...await original<object>(), buildReviewContext: vi.fn() }));
vi.mock('../../src/rules/index.js', async original => ({ ...await original<object>(), loadRulesAt: vi.fn() }));
vi.mock('../../src/cascade/index.js', async original => ({ ...await original<object>(), runCascade: vi.fn() }));
vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: async (root: string) => ({ path: root, cleanup: async () => {} }), isClean: async () => true }));
vi.mock('../../src/worktree/checkout.js', () => ({ checkoutSnapshot: async () => ({ status: '' }), checkoutDifference: () => undefined }));
vi.mock('../../src/storage/index.js', async original => ({ ...await original<object>(), atomicWrite: async () => {}, readQuota: async () => ({}) }));

it.each([false, true])('M1: rule evidence controls refactor CLI, deterministic-only=%s', async deterministicOnly => {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum-m1-'));
  const report = { runner: 'vitest' as const, tests: [{ file: 'sample.test.ts', name: 'value', status: 'passed' as const }], suiteErrors: [] };
  const evidence = { available: true, reasons: [], summary: '', tests: compareTests(report, report),
    api: { changes: [], packageChanges: [], breaking: false, notes: [] }, blastRadius: { dependents: [], withoutTests: [], notes: [] } };
  const cascade = { reviewedFamilies: [], cacheHits: 0, findings: [], unconfirmed: [], related: [], warnings: [], errors: [], calls: [], ledgerDraft: [],
    coverage: { reviewedFiles: ['sample.ts'], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: true } };
  vi.mocked(runRefactorEvidence).mockResolvedValue(evidence);
  vi.mocked(runCascade).mockResolvedValue(cascade);
  vi.mocked(buildReviewContext).mockResolvedValue({ ...context(root), mode: 'refactor' });
  const gitRunner: CommandRunner = async (_command, args) => ({ exitCode: 0, stderr: '',
    stdout: args.includes('ls-tree') || args.includes('diff') ? '' : args.includes('show') ? JSON.stringify({ checks: [] }) : 'a'.repeat(40) });
  try {
    for (const [severity, pattern, verdict, exitCode] of [
      ['error', 'load', 'NOT EQUIVALENT', 1], ['warning', 'load', 'SUSPECT', 0], ['error', 'absent', 'NO BEHAVIOUR CHANGE FOUND', 0],
    ] as const) {
      vi.mocked(loadRulesAt).mockResolvedValue([{ id: 'unsafe-call', severity, pattern, message: 'Validate first' }]);
      let out = ''; let err = '';
      const code = await main(['review', '--mode', 'refactor', '--diff', 'base...HEAD', '--json', '--no-cache',
        ...(deterministicOnly ? ['--deterministic-only'] : [])], { out: t => { out += t; }, err: t => { err += t; } },
      { repoRoot: root, gitRunner, providers: new Map(), appendLedger: async () => {}, appendFindings: async () => {} });
      expect(code, err).toBe(exitCode);
      const result = JSON.parse(out);
      expect(result.refactor.verdict).toBe(verdict);
      if (pattern === 'load') {
        expect(result.refactor.reasons.join(' ')).toContain('unsafe-call');
        expect(result.refactor.reasons.join(' ')).toContain('sample.ts:2');
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
