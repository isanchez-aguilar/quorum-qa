import { expect, it } from 'vitest';

const modulePath = '../../bench/score.mjs';
const { scoreCase, summarize } = await import(modulePath);
const truth = { file: 'src/item.ts', lines: [10, 12], class: 'example', minSeverity: 'IMPORTANT' };
const testCase = { truth: [truth] };
const finding = (line: number, extra = {}) => ({ file: './src\\item.ts', line, severity: 'IMPORTANT', family: 'google', ...extra });

it.each([[6, 0], [7, 1], [10, 1], [12, 1], [15, 1], [16, 0]])('scores inclusive tolerance at %s', (line, TP) => {
  const result = scoreCase(testCase, { findings: [finding(line)] });
  expect(result.all.TP).toBe(TP);
  expect(result.all.FN).toBe(1 - TP);
  expect(result.all.FP).toBe(1 - TP);
});

it('counts truth once, keeps best severity, and separates confirmation', () => {
  const result = scoreCase(testCase, { findings: [finding(10, { severity: 'OPTIONAL' })],
    unconfirmed: [finding(11, { severity: 'BLOCKER', confirmationFamilies: ['google', 'openai'] }), finding(12)] });
  expect(result.all).toMatchObject({ TP: 1, FN: 0, FP: 0, severityAccuracy: 1 });
  expect(result.all.matches[0].bestSeverity).toBe('BLOCKER');
  expect(result.confirmed).toMatchObject({ TP: 1, reported: 1 });
});

it('does not infer confirmation from the findings array or repeated families', () => {
  const result = scoreCase(testCase, { findings: [finding(10, { confirmationFamilies: ['google', 'google'] })] });
  expect(result.confirmed.TP).toBe(0);
  expect(scoreCase(testCase, { findings: [finding(10, { confirmed: true })] }).confirmed.TP).toBe(1);
});

it('counts control noise and rejects unrelated paths and unsupported severities', () => {
  expect(scoreCase({ truth: [] }, { findings: [finding(10), finding(10, { confirmed: true })] })).toMatchObject({
    all: { FP: 2, TP: 0, recall: null, precision: 0 }, confirmed: { FP: 1 },
  });
  expect(scoreCase(testCase, { findings: [finding(10, { file: 'other.ts' }), finding(10, { severity: 'INFO' })] }).all).toMatchObject({ TP: 0, FP: 1 });
});

it('counts rejected findings separately without granting recall', () => {
  const result = scoreCase(testCase, { rejectedOnConfirmation: [{ finding: finding(10) }, { finding: finding(11) }, { finding: finding(99) }] });
  expect(result).toMatchObject({ all: { TP: 0, FN: 1 }, rejectedWouldBeTP: 2, rejectedTruthItems: 1 });
});

it('scores distinct truth items independently', () => {
  const second = { ...truth, lines: [30, 31] };
  const result = scoreCase({ truth: [truth, second] }, { findings: [finding(10), finding(11), finding(99)] });
  expect(result.all).toMatchObject({ TP: 1, FN: 1, FP: 1, recall: 0.5, precision: 0.5 });
});

it('records severity misses and undefined denominators', () => {
  expect(scoreCase(testCase, { findings: [finding(10, { severity: 'OPTIONAL' })] }).all).toMatchObject({ TP: 1, severityAccuracy: 0 });
  expect(scoreCase(testCase, {}).all).toMatchObject({ precision: null, severityAccuracy: null });
  const row = { kind: 'control', score: scoreCase({ truth: [] }, {}), calls: null, wallMs: 5, status: 'timeout', exitCode: null };
  expect(summarize([row])).toMatchObject({ unknownCallRuns: 1, failedRuns: 1, wallMs: 5, exitCodes: { null: 1 } });
});
it('never counts a finding with a non-positive line as a hit', async () => {
  // scoreCase is imported at the top of this file (the path is a variable so tsc does not need .d.ts).
  const truth = [{ file: 'index.mjs', lines: [2, 2], class: 'x', minSeverity: 'IMPORTANT' }];
  for (const line of [0, -1]) {
    const report = { findings: [{ file: 'index.mjs', line, severity: 'IMPORTANT', confirmed: true }], unconfirmed: [], rejectedOnConfirmation: [] };
    expect((scoreCase as (c: unknown, r: unknown) => { all: { TP: number } })({ kind: "seeded", truth }, report).all.TP).toBe(0);
  }
});
