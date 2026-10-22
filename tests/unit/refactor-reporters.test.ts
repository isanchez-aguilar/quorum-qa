import { expect, it } from 'vitest';
import { generateMarkdownReport, generateSarifReport, type ReviewResult } from '../../src/reporters/index.js';
import { finding } from '../fixtures/cascade.js';

function result(): ReviewResult {
  const counts = { passed: 1, failed: 0, skipped: 0, total: 1 };
  return {
    mode: 'refactor', runId: 'synthetic', timestamp: '2026-10-19', range: 'base...HEAD',
    headSha: 'b', baseSha: 'a', checks: null, criteria: [], inventory: [], families: ['google'],
    reviewedFamilies: ['google'], cacheHits: 0, findings: [finding({ verified: true })],
    unconfirmed: [], related: [], warnings: [], errors: [], calls: [], ledgerDraft: [], exitCode: 1,
    coverage: { reviewedFiles: ['sample.ts'], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: true },
    refactor: {
      verdict: 'NOT EQUIVALENT', available: true, reasons: ['regression'], allowApiChange: false, modelReview: true, summary: '{}',
      tests: { base: counts, head: { ...counts, passed: 0, failed: 1 },
        regressions: [{ file: 'sample.test.ts', name: 'suite works', status: 'failed' }],
        fixed: [], removed: [{ file: 'old.test.ts', name: 'old case', status: 'passed' }],
        added: [{ file: 'new.test.ts', name: 'new case', status: 'passed' }],
        failingBoth: [], skippedChanges: [], editedFiles: ['sample.test.ts'] },
      api: { breaking: true, notes: [], changes: [
        { file: 'sample.ts', name: 'value', kind: 'renamed', previousName: 'oldValue', before: 'const oldValue', after: 'const value', line: 1, breaking: true },
      ], packageChanges: [{ field: 'version', before: '1.0.0', after: '2.0.0' }] },
      blastRadius: { dependents: [{ file: 'sample.test.ts', touchedFile: 'sample.ts', hop: 1, isTest: true, source: 'imports' }], withoutTests: ['other.ts'], notes: ['cap note'] },
    },
  } as ReviewResult;
}

it.each(['![remote](https://example.invalid/pixel)', '[link](https://example.invalid)', '[x][y]', '<https://example.invalid>'])('K3 escapes refactor notes and evidence: %s', text => {
  const report = result();
  report.refactor!.reasons = [text];
  report.refactor!.api.notes = [text];
  report.refactor!.api.changes[0]!.name = text;
  report.refactor!.tests.regressions[0]!.name = text;
  report.refactor!.blastRadius.notes = [text];
  expect(generateMarkdownReport(report)).not.toContain(text);
});

it('reports refactor verdict, counts, evidence and behaviour findings without origin', () => {
  const markdown = generateMarkdownReport(result());
  for (const text of ['**Verdict:** NOT EQUIVALENT', 'Test results at base and head', 'Regressions', 'Removed tests',
    'Edited test files', 'Added tests', 'Public API changes', 'renamed', 'oldValue', 'version',
    'Blast radius', 'other.ts', 'cap note', 'suspected behaviour change']) expect(markdown).toContain(text);
  expect(markdown).not.toContain('(introduced)');
  expect(markdown).not.toContain('| Introduced |');
  expect(markdown).not.toContain('Pre-existing bugs');
  expect(markdown).not.toContain('Skipped (--no-checks)');
});
it('emits SARIF deterministic regression and breaking API results plus structured evidence', () => {
  const report = JSON.parse(generateSarifReport(result().findings, result()));
  const run = report.runs[0];
  expect(run.properties.refactor.verdict).toBe('NOT EQUIVALENT');
  expect(run.properties.refactor.tests.removed).toHaveLength(1);
  expect(run.properties.refactor.blastRadius.withoutTests).toEqual(['other.ts']);
  const deterministic = run.results.filter((row: { properties: { deterministic?: boolean } }) => row.properties.deterministic);
  expect(deterministic.map((row: { ruleId: string }) => row.ruleId)).toEqual([
    'quorum-refactor/regression', 'quorum-refactor/renamed', 'quorum-refactor/package-field',
  ]);
  expect(run.results[0].properties.origin).toBeUndefined();
  expect(run.results[0].message.text).toContain('suspected behaviour change');
});
it('caps human evidence lists and lists explicitly allowed API changes as notes', () => {
  const report = result();
  report.refactor!.allowApiChange = true;
  report.refactor!.tests.regressions = Array.from({ length: 55 }, (_, n) => ({ file: 'a.test.ts', name: `case-${n}`, status: 'failed' }));
  expect(generateMarkdownReport(report)).toContain('+5 more');
  expect(generateMarkdownReport(report)).not.toContain('case-54');
  const sarif = JSON.parse(generateSarifReport([], report));
  expect(sarif.runs[0].results.find((row: { ruleId: string }) => row.ruleId === 'quorum-refactor/renamed').level).toBe('note');
});
it('explains changed local types in Markdown and SARIF', () => {
  const report = result();
  report.refactor!.api.changes = [{ file: 'sample.ts', name: 'Button', kind: 'changed', line: 1, breaking: true,
    before: 'function Button(props: Props)', after: 'function Button(props: Props)', detail: 'uses Props, which changed' }];
  expect(generateMarkdownReport(report)).toContain('uses Props, which changed');
  const sarif = JSON.parse(generateSarifReport([], report));
  expect(sarif.runs[0].results.find((row: { ruleId: string }) => row.ruleId === 'quorum-refactor/changed').message.text)
    .toContain('uses Props, which changed');
});

it('reports mutation warnings, notes, locations and JSON without losing summary bounds', async () => {
  const { summarizeEvidence } = await import('../../src/refactor/index.js');
  const report = result();
  report.refactor!.mutation = { requested: true, candidates: 25, attempted: 25, killed: 0, invalid: 0, budgetExhausted: true, maxMutants: 25,
    survived: Array.from({ length: 25 }, () => ({ file: 'é'.repeat(2000) + '.ts', line: 4, operator: 'boolean', before: 'true', after: 'false' })), skipped: ['sample note'] };
  const markdown = generateMarkdownReport(report);
  expect(markdown).toContain('sampled 25 of 25'); expect(markdown).toContain('Budget exhausted: yes'); expect(markdown).toContain('sample note');
  const sarif = JSON.parse(generateSarifReport([], report));
  expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'quorum-refactor/mutant-survived', level: 'note',
    locations: [{ physicalLocation: { region: { startLine: 4 } } }] });
  expect(JSON.parse(JSON.stringify(report)).refactor.mutation.survived).toHaveLength(25);
  const summary = summarizeEvidence(report.refactor!);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(4096);
  expect(JSON.parse(summary).mutation.survived).toBe(25);
  expect(JSON.parse(summary).mutationSurvivors.length).toBeLessThanOrEqual(5);
  delete report.refactor!.mutation;
  expect(generateMarkdownReport(report)).toContain('Mutation sampling: off (use --mutation)');
});
