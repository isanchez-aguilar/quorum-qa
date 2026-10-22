import type { RefactorEvidence } from '../refactor/index.js';

export interface RefactorReport extends RefactorEvidence {
  verdict: 'NOT EQUIVALENT' | 'SUSPECT' | 'NO BEHAVIOUR CHANGE FOUND' | 'UNKNOWN';
  allowApiChange: boolean;
  modelReview: boolean;
}
export const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/</g, '&lt;');
const list = (rows: string[], cap = 50): string => rows.slice(0, cap).map(row => `- ${cell(row)}`).join('\n')
  + (rows.length > cap ? `\n\n+${rows.length - cap} more` : '') || 'None.';
const json = (value: unknown) => JSON.stringify(value) ?? '(absent)';

export function refactorMarkdown(report: RefactorReport): string[] {
  const { tests, api, blastRadius } = report;
  const testList = (rows: Array<{ file: string; name: string }>) => list(rows.map(test => `${test.file}: ${test.name}`));
  return [
    '## Test results at base and head',
    '| Revision | Passed | Failed | Skipped | Total |', '|---|---:|---:|---:|---:|',
    ...(['base', 'head'] as const).map(side => {
      const count = tests[side];
      return `| ${side} | ${count.passed} | ${count.failed} | ${count.skipped} | ${count.total} |`;
    }),
    report.available ? 'Test evidence available. Passing tests do not prove equivalence.' : 'Deterministic evidence unavailable; counts from an unavailable side are not a successful empty suite.',
    '### Regressions', testList(tests.regressions), '### Fixed tests', testList(tests.fixed),
    'Fixed tests do not establish behaviour equivalence.',
    '### Removed tests', testList(tests.removed), '### Added tests', testList(tests.added),
    '### Failing at both', testList(tests.failingBoth),
    '### Skipped changes', list(tests.skippedChanges.map(test => `${test.file}: ${test.name} (${test.before} → ${test.after})`)),
    '### Edited test files', list(tests.editedFiles),
    '## Public API changes',
    'signature changes are reported conservatively; review whether compatible (including compatible widening or an added optional parameter).',
    ...(api.changes.length ? [list(api.changes.map(change => `${change.kind}: ${change.file}:${change.line} — ${change.previousName ? change.previousName + ' → ' : ''}${change.name}`
      + `${change.breaking ? report.allowApiChange ? ' (allowed API change)' : ' (breaking)' : ''}`
      + `${change.overloads ? `; overloads: ${change.overloads.before} before, ${change.overloads.after} after` : ''}`
      + `${change.detail ? `; ${change.detail}` : ''}`
      + `; before: ${change.before ?? '(absent)'}; after: ${change.after ?? '(absent)'}`))] : ['No export changes.']),
    '### Package fields', list(api.packageChanges.map(change => `${change.field}: ${json(change.before)} → ${json(change.after)}${report.allowApiChange ? ' (allowed API change)' : ' (breaking)'}`)),
    ...api.notes.map(cell),
    '## Blast radius',
    list(blastRadius.dependents.map(item => `${item.touchedFile} ← ${item.file} (hop ${item.hop}${item.isTest ? ', test' : ''}; ${item.source}${item.source === 'codegraph' ? ', untrusted and may be stale' : ''})`), 200),
    '### Touched files without tests', list(blastRadius.withoutTests, 200),
    '### Touched files: tests unknown (search truncated)', list(blastRadius.testsUnknown ?? [], 200),
    `Non-source files changed: ${(blastRadius.nonSource ?? []).map(cell).join(', ') || 'None.'}`,
    ...blastRadius.notes.map(cell),
    '### Verdict reasons', list(report.reasons),
    `Model review: ${report.modelReview ? 'on' : 'off (--deterministic-only)'}.`,
    '## Mutation sampling',
    ...(report.mutation ? [
      `Candidates: ${report.mutation.candidates}; sampled ${report.mutation.attempted} of ${report.mutation.candidates} candidates (max ${report.mutation.maxMutants}); killed: ${report.mutation.killed}; invalid: ${report.mutation.invalid}; survived: ${report.mutation.survived.length}.`,
      `Budget exhausted: ${report.mutation.budgetExhausted ? 'yes' : 'no'}.`,
      ...(report.mutation.attempted ? [] : ['No mutants ran.']),
      ...((report.mutation.skipped ?? []).map(cell)),
      '### Survivors', list(report.mutation.survived.map(item => `${item.file}:${item.line} ${item.operator}: ${item.before} → ${item.after}`)),
    ] : ['Mutation sampling: off (use --mutation)']),
  ];
}

export function refactorSarif(report?: RefactorReport) {
  if (!report) return [];
  const location = (file: string, line = 1) => [{ physicalLocation: {
    artifactLocation: { uri: file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' },
    region: { startLine: Math.max(1, line) },
  } }];
  return [
    ...(report.mutation?.survived ?? []).map(item => ({
      ruleId: 'quorum-refactor/mutant-survived', level: 'note',
      message: { text: `${item.operator}: ${item.before} → ${item.after}; the tests do not pin this code` },
      locations: location(item.file, item.line), properties: { deterministic: true },
    })),
    ...report.tests.regressions.map(test => ({
      ruleId: 'quorum-refactor/regression', level: 'error',
      message: { text: `Passed at base, failed at head: ${test.name}` }, locations: location(test.file),
      properties: { deterministic: true },
    })),
    ...report.api.changes.map(change => ({
      ruleId: `quorum-refactor/${change.kind}`, level: !change.breaking || report.allowApiChange ? 'note' : 'error',
      message: { text: `${change.kind} export ${change.previousName ? change.previousName + ' → ' : ''}${change.name}: ${change.before ?? '(absent)'} → ${change.after ?? '(absent)'}${change.detail ? `; ${change.detail}` : ''}` },
      locations: location(change.file, change.line), properties: { deterministic: true, allowedApiChange: report.allowApiChange },
    })),
    ...report.api.packageChanges.map(change => ({
      ruleId: 'quorum-refactor/package-field', level: report.allowApiChange ? 'note' : 'error',
      message: { text: `package.json ${change.field}: ${json(change.before)} → ${json(change.after)}` },
      locations: location('package.json'), properties: { deterministic: true, allowedApiChange: report.allowApiChange },
    })),
  ];
}
