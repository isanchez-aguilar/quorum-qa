import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { parseRuntimeReport, type Observation, type RuntimeReport } from '../../src/runtime/report.js';
import * as signatures from '../../src/runtime/signature.js';
import { stableObservations } from '../../src/runtime/stable.js';
import { buildRuntimeReport, runtimeMarkdown, runtimeSarif } from '../../src/reporters/runtime.js';
import { runtimePayload, runtimeText } from '../../src/runtime/run.js';

const require = createRequire(import.meta.url);
const { run: collect } = require('../../src/runtime/collector.cjs');
const { run: runApp } = require('../../src/runtime/runner.cjs');
const config = validateConfig({ checks: [], runtime: { flows: [{ name: 'home', steps: [{ goto: '/' }] }] } }).runtime!;
function side(observation: Observation, notes: string[] = []) {
  const report: RuntimeReport = { version: 1, runs: ([1, 2] as const).map(run => ({ flow: 'home', run,
    completed: observation.kind !== 'flow-failure', observations: [observation], notes, blockedExternal: {} })) };
  return { report, stable: stableObservations(report), durationMs: 0 };
}
function published(base: ReturnType<typeof side>, head = base) {
  return buildRuntimeReport({ available: true, reasons: [], notes: [], base, head }, config, { strictFlows: true });
}
it('infrastructure is unknown on both sides and accepted by the parser', () => {
  const broken = side({ kind: 'flow-failure', step: 0, errorClass: 'infrastructure' as Observation['errorClass'], message: 'browser context unavailable' });
  expect(parseRuntimeReport(JSON.stringify(broken.report), config)).not.toHaveProperty('error');
  const value = published(broken);
  expect(value).toMatchObject({ verdict: 'UNKNOWN', exitCode: 2 });
  expect(value.comparison).toMatchObject({ preExisting: [], flowBroke: [], fixed: [] });
  const selector = side({ kind: 'flow-failure', step: 0, errorClass: 'selector', message: 'selector missing' });
  expect(published(selector)).toMatchObject({ verdict: 'NO NEW RUNTIME PROBLEMS FOUND', exitCode: 0 });
});
it('keeps differences beyond 1000 characters and makes every truncation visible and unknown', () => {
  const prefix = 'ordinary error '.repeat(80);
  const parsed = (message: string) => {
    const value = parseRuntimeReport(JSON.stringify(side({ kind: 'console', message }).report), config);
    if ('error' in value) throw new Error(value.error);
    return { report: value, stable: stableObservations(value), durationMs: 0 };
  };
  expect(published(parsed(prefix + 'alpha'), parsed(prefix + 'beta')).comparison?.newAtHead).toHaveLength(1);
  const capped = parsed('word '.repeat(500));
  const value = published(capped);
  expect(value.verdict).toBe('UNKNOWN');
  expect(value.comparison).toHaveProperty('notes', [{ flow: 'home', text: 'cap: message' }]);
  expect(runtimeMarkdown(value).join('\n')).toContain('cap: message');
  expect(JSON.stringify(value)).toContain('cap: message');
  expect(published(side({ kind: 'console', message: 'error' }, ['cap: path'])).verdict).toBe('UNKNOWN');
});
it('retains run notes even when the other side is unavailable', () => {
  const base = side({ kind: 'console', message: 'error' }, ['cap: message']);
  const value = buildRuntimeReport({ available: false, reasons: ['head unavailable'], notes: [], base }, config, { strictFlows: false });
  expect(value.notes).toEqual(['home: cap: message']);
  expect(runtimeMarkdown(value).join('\n')).toContain('home: cap: message');
});
it.each([
  ['failed http://localhost:4173/api?token=SYNTHETIC_SECRET at C:/synthetic/build/app.js:1:2', 'failed http://localhost:4173/api at app.js'],
  ['https://user:pass@example.test/a?q=x#fragment', 'https://example.test/a'],
  ['http://localhost/a#secret', 'http://localhost/a'],
  ['at /synthetic/build/app.js:1:2 and C:\\synthetic\\build\\other.js', 'at app.js and other.js'],
  ['token 0123456789abcdef01234567', 'token [token]'],
  ['token QWxhZGRpbjpvcGVuIHNlc2FtZQ==', 'token [token]'],
  ['token abcd/efgh/ijkl/mnop/qrst/uvwx', 'token [token]'],
  ['file=C:/synthetic/build/app.js:1:2', 'file=app.js'],
])('scrubs display text exactly: %s', (input, output) => {
  expect((signatures as unknown as { scrubForDisplay: (text: string) => string }).scrubForDisplay(input)).toBe(output);
});
it('scrubs pathological 500 KB in under 50 ms', () => {
  const scrub = (signatures as unknown as { scrubForDisplay: (text: string) => string }).scrubForDisplay;
  scrub('warmup');
  const input = '9'.repeat(125000) + ':'.repeat(125000) + '/'.repeat(125000) + 'a'.repeat(137000);
  const start = performance.now(); scrub(input);
  expect(performance.now() - start).toBeLessThan(50);
});
it('scrubs all published forms, including notes, summaries and host-supplied evidence', () => {
  const message = 'failed http://localhost:4173/api?token=SYNTHETIC_SECRET at C:/synthetic/build/app.js:1:2';
  const value = published(side({ kind: 'console', message: 'old' }), side({ kind: 'console', message }, [message]));
  for (const output of [JSON.stringify(value), runtimeMarkdown(value).join('\n'), JSON.stringify(runtimeSarif(value)), value.summary]) {
    expect(output).not.toMatch(/SYNTHETIC_SECRET|synthetic\/build|:1:2/);
  }
  expect(value.comparison?.newAtHead[0]?.message).toBe('failed http://localhost:4173/api at app.js');
});
it('rejects screenshots true with the reserved-feature explanation', () => {
  expect(() => validateConfig({ checks: [], runtime: { screenshots: true } })).toThrow('runtime.screenshots: true is not implemented yet (planned with the model layer); remove it or set false');
});
it('keeps resource routes valid when a short fill value occurs in the internal URL prefix', () => {
  const runtime = structuredClone(config); runtime.flows![0]!.steps = [{ fill: 'input', value: 'e' }];
  const data = side({ kind: 'console', message: 'error', path: '/home' }).report;
  const parsed = runtimePayload('FRESH:' + JSON.stringify(data), 'FRESH:', runtime);
  expect('runs' in parsed && parsed.runs[0]!.observations[0]!.path).toBe('/hom[redacted]');
  const once = runtimeText('error', runtime);
  expect(runtimeText(once, runtime)).toBe(once);
});
it('classifies a context creation exception as infrastructure', async () => {
  const report = await collect({ plan: config, playwright: { chromium: { launch: async () => ({
    newContext: async () => { throw new Error('browser context unavailable'); }, close: async () => {},
  }) } } });
  expect(report.runs.every((run: { observations: Observation[] }) => run.observations[0]?.errorClass === 'infrastructure')).toBe(true);
});
it('redacts a fill value crossing the stderr raw-tail boundary before limiting output', async () => {
  vi.useFakeTimers();
  try {
    const value = 'SYNTHETIC_PASSWORD_1234567890!';
    const app = Object.assign(new EventEmitter(), { pid: 1, stderr: new EventEmitter() });
    const pending = runApp({ start: ['node'], plan: { readyUrl: 'http://localhost/', readyTimeoutSeconds: 1,
      flows: [{ name: 'home', steps: [{ fill: 'input', value }] }] }, childProcess: { spawn: () => app },
      http: { get: () => Object.assign(new EventEmitter(), { destroy() {} }) },
      kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
    app.stderr.emit('data', 'padding ' + value + '\u0000'.repeat(3990));
    app.emit('exit', 1); await vi.runAllTimersAsync();
    const result = await pending;
    for (let i = 0; i <= value.length - 4; i++) expect(result.stderrTail).not.toContain(value.slice(i, i + 4));
  } finally { vi.useRealTimers(); }
});
