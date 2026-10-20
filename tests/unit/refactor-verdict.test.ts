import { expect, it } from 'vitest';
import { evaluateRefactorVerdict } from '../../src/cli/refactor.js';
import type { RefactorEvidence } from '../../src/refactor/index.js';
import type { CascadeResult } from '../../src/cascade/index.js';
import { finding } from '../fixtures/cascade.js';

const evidence = (): RefactorEvidence => ({
  available: true, reasons: [], summary: '',
  tests: { base: { passed: 1, failed: 0, skipped: 0, total: 1 }, head: { passed: 1, failed: 0, skipped: 0, total: 1 },
    regressions: [], fixed: [], removed: [], added: [], failingBoth: [], skippedChanges: [], editedFiles: [] },
  api: { changes: [], packageChanges: [], breaking: false, notes: [] },
  blastRadius: { dependents: [], withoutTests: [], notes: [] },
});
const cascade = (): Pick<CascadeResult, 'findings' | 'unconfirmed' | 'errors' | 'coverage'> => ({
  findings: [], unconfirmed: [], errors: [],
  coverage: { reviewedFiles: ['sample.ts'], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: true },
});
it('does not claim equivalence when no change is found', () => {
  expect(evaluateRefactorVerdict(evidence(), cascade())).toMatchObject({ verdict: 'NO BEHAVIOUR CHANGE FOUND', exitCode: 0 });
});
it.each(['regression', 'api', 'blocker'])('fails %s as NOT EQUIVALENT', kind => {
  const e = evidence(); const c = cascade();
  if (kind === 'regression') e.tests.regressions.push({ file: 'sample.test.ts', name: 'value', status: 'failed' });
  if (kind === 'api') e.api.breaking = true;
  if (kind === 'blocker') c.findings.push(finding({ severity: 'BLOCKER', verified: true }));
  expect(evaluateRefactorVerdict(e, c)).toMatchObject({ verdict: 'NOT EQUIVALENT', exitCode: 1 });
});
it('allows breaking API changes without waiving BLOCKERs', () => {
  const e = evidence(); e.api.breaking = true;
  expect(evaluateRefactorVerdict(e, cascade(), true)).toMatchObject({ verdict: 'NO BEHAVIOUR CHANGE FOUND', exitCode: 0 });
  const c = cascade(); c.findings.push(finding({ severity: 'BLOCKER', verified: true }));
  expect(evaluateRefactorVerdict(e, c, true).exitCode).toBe(1);
});
it.each(['edited', 'removed', 'withoutTests', 'important', 'singleSource', 'optionalSingleSource'])('reports %s as SUSPECT with exit 0', kind => {
  const e = evidence(); const c = cascade();
  if (kind === 'edited') e.tests.editedFiles.push('sample.test.ts');
  if (kind === 'removed') e.tests.removed.push({ file: 'sample.test.ts', name: 'value', status: 'passed' });
  if (kind === 'withoutTests') e.blastRadius.withoutTests.push('sample.ts');
  if (kind === 'important') c.findings.push(finding({ severity: 'IMPORTANT', verified: true }));
  if (kind === 'singleSource') c.unconfirmed.push(finding({ severity: 'OPTIONAL', verified: true }));
  if (kind === 'optionalSingleSource') c.findings.push(finding({ severity: 'OPTIONAL', verified: true }));
  expect(evaluateRefactorVerdict(e, c)).toMatchObject({ verdict: 'SUSPECT', exitCode: 0 });
});
it('unavailable evidence overrides API breakage, except for verified BLOCKERs', () => {
  const e = evidence(); e.available = false; e.reasons.push('head: no JSON report'); e.api.breaking = true;
  const c = cascade();
  expect(evaluateRefactorVerdict(e, c)).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2 });
  c.findings.push(finding({ severity: 'BLOCKER', verified: true }));
  expect(evaluateRefactorVerdict(e, c)).toMatchObject({ verdict: 'NOT EQUIVALENT', exitCode: 1 });
});
it('tool failures and incomplete model coverage exit 2', () => {
  const c = cascade(); c.errors.push('tool failed');
  expect(evaluateRefactorVerdict(evidence(), c)).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2 });
  c.errors = []; c.coverage.complete = false;
  expect(evaluateRefactorVerdict(evidence(), c).exitCode).toBe(2);
});
