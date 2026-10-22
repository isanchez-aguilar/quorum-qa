import { expect, it, vi } from 'vitest';
import { reproduceBlocker } from '../../src/reproduce/index.js';
import { parseTestReport } from '../../src/reproduce/evaluate.js';
import { validateConfig } from '../../src/config/index.js';
import { context, finding } from '../fixtures/cascade.js';

const isolated = vi.hoisted(() => vi.fn());
vi.mock('../../src/reproduce/isolation.js', () => ({ runIsolatedTest: isolated }));
vi.mock('../../src/context/git.js', () => ({ fileExistsAtCommit: async () => true }));
vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: async () => ({ path: '/synthetic', cleanup: async () => {} }) }));
vi.mock('../../src/reproduce/write.js', () => ({ writeProposedTest: async () => ({ relative: 'test.test.ts' }) }));

it.each([['interrupted', 0, true], ['inconsistent exit', 1, false]] as const)('P1 leaves an %s base unproven', async (_name, exitCode, interrupted) => {
  const raw = (status: string, wasInterrupted = false) => parseTestReport({ success: status === 'passed' && !wasInterrupted, wasInterrupted,
    testResults: [{ name: '/work/test.test.ts', assertionResults: [{ fullName: 'synthetic', status,
      failureMessages: status === 'failed' ? ['AssertionError: expected zero'] : [] }] }] });
  isolated.mockReset().mockResolvedValueOnce({ report: raw('failed'), timedOut: false, exitCode: 1 })
    .mockResolvedValueOnce({ report: raw('passed', interrupted), timedOut: false, exitCode });
  const result = await reproduceBlocker(finding(), { path: 'test.test.ts', content: 'synthetic', expect: 'expected zero' },
    context('/synthetic'), validateConfig({ checks: [] }), async () => { throw new Error('no processes allowed'); });
  expect(result).toEqual({ status: 'unproven', reason: 'interrupted or inconsistent base run' });
});
