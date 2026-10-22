import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { compareRuntime, summarizeRuntimeComparison } from '../../src/runtime/compare.js';
import { evaluateRuntimeVerdict } from '../../src/cli/runtime.js';
import { parseRuntimeReport, type Observation, type RuntimeRun } from '../../src/runtime/report.js';
import { stableObservations } from '../../src/runtime/stable.js';
import type { SideResult } from '../../src/runtime/run.js';

export const config = validateConfig({ checks: [], runtime: { flows: ['home', 'login'].map(name => ({ name,
  steps: [{ goto: '/' }, { fill: 'input', value: 'PRIVATE_VALUE' }] })) } }).runtime!;
export function side(observations: Observation[] = [], overrides: Partial<RuntimeRun> = {}): SideResult {
  const report = { version: 1 as const, runs: config.flows!.flatMap(({ name }) => ([1, 2] as const).map(run => ({
    flow: name, run, completed: true, observations: name === 'home' ? [...observations] : [], blockedExternal: {}, notes: [], ...overrides,
  }))) };
  return { report, stable: stableObservations(report), durationMs: 1 };
}
const error = (message: string, step = 0): Observation => ({ kind: 'console', message, step, path: '/' });
const failure: Observation = { kind: 'flow-failure', message: 'selector missing', errorClass: 'selector', step: 1 };
function verdict(base = side(), head = side(), strictFlows = false) {
  return evaluateRuntimeVerdict({ available: true, reasons: [], notes: [], base, head }, compareRuntime(base, head, config), { strictFlows });
}
it('compares stable sets per flow, retaining display evidence and both run counts', () => {
  const result = compareRuntime(side([error('old'), error('shared')]), side([error('new'), error('shared', 1)]), config);
  expect(result.newAtHead).toMatchObject([{ kind: 'console', flow: 'home', message: 'new', path: '/', counts: { base: [0, 0], head: [1, 1] } }]);
  expect(result.newAtHead[0]).not.toHaveProperty('step');
  expect(result.fixed.map(item => item.message)).toEqual(['old']);
  expect(result.preExisting.map(item => item.message)).toEqual(['shared']);
  expect(result.flows.home!.newAtHead).toEqual(result.newAtHead);
  expect(result.flows.login!.newAtHead).toEqual([]);
});
it('separates flow broke from new problems and pre-existing failures', () => {
  const broken = side([failure], { completed: false });
  // Only home failed; login still completes.
  broken.report.runs.filter(run => run.flow === 'login').forEach(run => { run.completed = true; });
  broken.stable = stableObservations(broken.report);
  const result = compareRuntime(side(), broken, config);
  expect(result.newAtHead).toEqual([]);
  expect(result.flowBroke).toMatchObject([{ flow: 'home', step: 1, errorClass: 'selector' }]);
  expect(result.coveredFlows).toEqual(['home', 'login']);
  expect(compareRuntime(broken, broken, config)).toMatchObject({ flowBroke: [], preExisting: [expect.objectContaining({ kind: 'flow-failure' })] });
});
it('matches stable failing steps even when their error messages differ', () => {
  const head = side([failure]);
  head.report.runs.filter(run => run.flow === 'home').forEach(run => { run.completed = false; run.observations = [{ ...failure, message: `failure ${run.run}` }]; });
  head.stable = stableObservations(head.report);
  expect(compareRuntime(side(), head, config).flowBroke).toHaveLength(1);
});
it.each(['base', 'head'] as const)('retains flaky and incomplete coverage from %s', which => {
  const changed = side(); changed.report.runs[0]!.completed = false;
  changed.report.runs[0]!.notes.push('cap: observations'); changed.stable = stableObservations(changed.report);
  const result = compareRuntime(which === 'base' ? changed : side(), which === 'head' ? changed : side(), config);
  expect(result.flaky).toContainEqual({ flow: 'home', side: which });
  expect(result.incomplete).toContainEqual({ flow: 'home', side: which });
});
it('tracks absent flows, including parser-inserted missing runs', () => {
  const head = side(); head.report.runs = head.report.runs.filter(run => run.flow !== 'login');
  head.stable = stableObservations(head.report);
  expect(compareRuntime(side(), head, config).uncoveredFlows).toEqual(['login']);
  const parsed = parseRuntimeReport(JSON.stringify(head.report), config);
  if ('error' in parsed) throw new Error(parsed.error);
  expect(compareRuntime(side(), { report: parsed, stable: stableObservations(parsed), durationMs: 0 }, config).uncoveredFlows).toEqual(['login']);
});
it('counts blocked hosts on each side without making them problems', () => {
  const result = compareRuntime(side([], { blockedExternal: { 'example.test': 2 } }), side([], { blockedExternal: { 'example.test': 3 } }), config);
  expect(result.blockedExternal).toEqual({ base: { 'example.test': 8 }, head: { 'example.test': 12 } });
  expect(result.newAtHead).toEqual([]);
});
it('makes unavailable or missing evidence unknown', () => {
  expect(evaluateRuntimeVerdict({ available: false, reasons: ['not ready'], notes: [] }, undefined, { strictFlows: false })).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2, reasons: expect.arrayContaining(['not ready']) });
  expect(evaluateRuntimeVerdict({ available: true, reasons: [], notes: [], base: side() }, undefined, { strictFlows: false }).verdict).toBe('UNKNOWN');
});
it('never passes incomplete coverage, but preserves confirmed new problems and both reasons', () => {
  const head = side([], { notes: ['cap: observations'] });
  expect(verdict(side(), head)).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2 });
  const problem = side([error('new')], { notes: ['cap: observations'] });
  const result = verdict(side(), problem);
  expect(result).toMatchObject({ verdict: 'NEW RUNTIME PROBLEMS', exitCode: 1 });
  expect(result.reasons.join(' ')).toMatch(/incomplete/i); expect(result.reasons.join(' ')).toMatch(/new problem/i);
});
it('treats two crashes outside a step as unknown and missing configured flows as unknown', () => {
  expect(verdict(side(), side([], { completed: false })).verdict).toBe('UNKNOWN');
  const head = side(); head.report.runs = []; head.stable = stableObservations(head.report);
  expect(verdict(side(), head).verdict).toBe('UNKNOWN');
});
it('classifies broken flows, strict flows and flaky runs', () => {
  const head = side([failure]); head.report.runs.filter(run => run.flow === 'home').forEach(run => { run.completed = false; }); head.stable = stableObservations(head.report);
  expect(verdict(side(), head)).toMatchObject({ verdict: 'SUSPECT', exitCode: 0 });
  expect(verdict(side(), head, true)).toMatchObject({ verdict: 'NEW RUNTIME PROBLEMS', exitCode: 1 });
  head.report.runs[1]!.completed = true; head.report.runs[1]!.observations = []; head.stable = stableObservations(head.report);
  expect(verdict(side(), head)).toMatchObject({ verdict: 'SUSPECT', exitCode: 0 });
});
it('names clean coverage and ignores expected document 4xx but counts static 404', () => {
  expect(verdict()).toEqual({ verdict: 'NO NEW RUNTIME PROBLEMS FOUND', exitCode: 0, reasons: ['no new problems found in flows: home, login'] });
  const http: Observation = { kind: 'http', message: '404', status: 404, resourceType: 'document', expected: true, path: '/' };
  expect(verdict(side(), side([http])).exitCode).toBe(0);
  expect(verdict(side(), side([{ ...http, resourceType: 'script' }])).exitCode).toBe(1);
});
it.each(['console', 'pageerror', 'requestfailed', 'blank', 'technicalText'] as const)('fails on a new stable %s', kind => {
  expect(verdict(side(), side([{ kind, step: 0, message: 'new error' }]))).toMatchObject({ verdict: 'NEW RUNTIME PROBLEMS', exitCode: 1 });
});
it('does not promote a one-run observation to a confirmed problem, and retains duplicate counts', () => {
  const head = side([error('new')]); head.report.runs[0]!.observations.push(error('new'));
  head.stable = stableObservations(head.report);
  expect(compareRuntime(side(), head, config).newAtHead[0]!.counts.head).toEqual([2, 1]);
  head.report.runs[1]!.observations = []; head.stable = stableObservations(head.report);
  expect(compareRuntime(side(), head, config).newAtHead).toEqual([]);
});
it('unknown coverage takes precedence over strict-flow failure and flaky evidence', () => {
  const head = side([failure], { notes: ['cap: observations'] });
  expect(verdict(side(), head, true)).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2 });
});
it('redacts display evidence and signatures, and bounds valid model JSON in bytes', () => {
  const result = compareRuntime(side(), side([error('PRIVATE_VALUE')]), config);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
  const many = { ...result, newAtHead: Array.from({ length: 2000 }, () => ({ ...result.newAtHead[0]!, message: '😀'.repeat(300) })),
    coveredFlows: Array.from({ length: 20 }, (_, index) => `${index}${'long-flow-'.repeat(5)}`),
    uncoveredFlows: Array.from({ length: 20 }, (_, index) => `${index}${'missing-flow-'.repeat(4)}`) };
  const summary = summarizeRuntimeComparison(many);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(4096);
  expect(JSON.parse(summary).totals.newAtHead).toBe(2000);
});
