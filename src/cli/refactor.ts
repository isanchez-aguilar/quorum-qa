import type { CascadeResult } from '../cascade/index.js';
import type { RefactorEvidence } from '../refactor/index.js';

export type RefactorVerdict = 'NOT EQUIVALENT' | 'SUSPECT' | 'NO BEHAVIOUR CHANGE FOUND' | 'UNKNOWN';

export function evaluateRefactorVerdict(
  evidence: RefactorEvidence,
  cascade: Pick<CascadeResult, 'findings' | 'unconfirmed' | 'errors' | 'coverage'>,
  allowApiChange = false,
): { verdict: RefactorVerdict; exitCode: number; reasons: string[] } {
  const reasons = [...evidence.reasons];
  if (evidence.mutation?.survived.length) reasons.push(`${evidence.mutation.survived.length} of ${evidence.mutation.attempted} sampled mutants of the changed lines survived the test suite: the tests do not pin this code (${evidence.mutation.survived.slice(0, 3).map(item => `${item.file}:${item.line} ${item.operator}`).join(', ')})`);
  if (evidence.api.incomplete || evidence.api.unscanned?.length) {
    reasons.push(...(evidence.api.notes.length ? evidence.api.notes : ['Public API scan is incomplete.']));
  }
  if (evidence.blastRadius.incomplete) reasons.push('blast radius incomplete', ...evidence.blastRadius.notes);
  // A local-only report is not a verified model verdict.
  const verified = [...cascade.findings, ...cascade.unconfirmed.filter(finding => finding.family !== 'local')];
  const blocker = verified.some(finding => finding.verified && finding.severity === 'BLOCKER');
  if (blocker) reasons.push('A verified BLOCKER is a suspected behaviour change.');
  if (!evidence.available) return { verdict: blocker ? 'NOT EQUIVALENT' : 'UNKNOWN', exitCode: blocker ? 1 : 2, reasons };
  if (evidence.tests.regressions.length) reasons.push(`${evidence.tests.regressions.length} tests passed at base and failed at head.`);
  if (evidence.api.breaking && !allowApiChange) reasons.push('The public API has breaking changes.');
  if (blocker || evidence.tests.regressions.length || evidence.api.breaking && !allowApiChange) {
    return { verdict: 'NOT EQUIVALENT', exitCode: 1, reasons };
  }
  if (cascade.errors.length || !cascade.coverage.complete) {
    reasons.push(...cascade.errors, 'Review coverage is incomplete.');
    return { verdict: 'UNKNOWN', exitCode: 2, reasons };
  }
  if (evidence.tests.editedFiles.length) reasons.push('Edited test files weaken the behaviour evidence.');
  if (evidence.tests.removed.length) reasons.push('Tests present at base are absent at head.');
  if (evidence.blastRadius.withoutTests.length) reasons.push('Touched files have no test dependent.');
  if (verified.some(finding => finding.verified && finding.severity === 'IMPORTANT')) reasons.push('Verified IMPORTANT findings are suspected behaviour changes.');
  if (cascade.unconfirmed.length || cascade.findings.some(finding => finding.singleSource
    || !finding.confirmed && (finding.confirmationFamilies?.length ?? 1) < 2)) reasons.push('Single-source findings remain unconfirmed.');
  const suspect = reasons.length > evidence.reasons.length;
  return { verdict: suspect ? 'SUSPECT' : 'NO BEHAVIOUR CHANGE FOUND', exitCode: 0, reasons };
}
