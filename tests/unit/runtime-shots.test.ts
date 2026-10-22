import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import * as host from '../../src/runtime/run.js';
import { stableObservations } from '../../src/runtime/stable.js';
import { buildRuntimeReport, runtimeMarkdown, runtimeSarif } from '../../src/reporters/runtime.js';
import { runtimeReview } from '../../src/cli/runtime.js';

const require = createRequire(import.meta.url);
const collector = require('../../src/runtime/collector.cjs');
const jpeg = Buffer.from([255, 216, 255, 1]);
const config = () => validateConfig({ checks: [], runtime: { start: ['node', 'app.cjs'], readyUrl: 'http://localhost:4173/',
  flows: [{ name: 'Home Page', steps: Array.from({ length: 12 }, () => ({ goto: '/' })) }] } }).runtime!;
const shot = (step = 0, data = jpeg) => ({ flow: 'Home Page', step, mime: 'image/jpeg', bytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') });
const line = (value: unknown) => 'FRESH:IMG ' + JSON.stringify(value) + '\n';
function fake(capture: () => Promise<Buffer> = async () => jpeg) {
  const pages: any[] = [];
  const browser = { close: vi.fn(), newContext: vi.fn(async () => {
    const page = { on: vi.fn(), url: () => 'http://localhost/', goto: vi.fn(), click: vi.fn(), press: vi.fn(), fill: vi.fn(),
      waitForURL: vi.fn(), waitForSelector: vi.fn(), waitForTimeout: vi.fn(), waitForLoadState: vi.fn(),
      evaluate: vi.fn(async () => ({ blank: false, snippets: [] })), screenshot: vi.fn(capture) };
    pages.push(page); return { route: vi.fn(), newPage: async () => page, close: vi.fn() };
  }) };
  return { pages, browser, chromium: { launch: async () => browser } };
}
it('accepts capture-only config and describes local storage in dry-run', () => {
  expect(validateConfig({ checks: [], runtime: { screenshots: true } }).runtime!.screenshots).toBe(true);
  expect(() => validateConfig({ checks: [], runtime: { screenshots: 'true' } })).toThrow('boolean');
  const out = vi.fn(); runtimeReview({ ...config(), screenshots: true }, true, { out, err: vi.fn() });
  expect(out.mock.calls.join()).toContain('Screenshots: on (stored under .quorum/runtime-shots/, up to 10 per flow, 300 KB each)');
});
it.each([false, true])('fixes every viewport and captures only inspected steps on both runs: %s', async screenshots => {
  const pw = fake(); const plan = { ...config(), screenshots, flows: [{ name: 'Home Page', steps: [
    { goto: '/' }, { fill: 'input', value: '' }, { click: 'a' }, { press: 'input', key: 'Enter' },
    { waitForUrl: '/' }, { waitForSelector: 'body' }, { wait: 1 },
  ] }] };
  const report = await collector.run({ playwright: pw, plan });
  expect(collector.VIEWPORT).toEqual({ width: 1280, height: 800 }); expect(Object.isFrozen(collector.VIEWPORT)).toBe(true);
  expect(pw.browser.newContext.mock.calls).toEqual(Array(2).fill([{ serviceWorkers: 'block', viewport: collector.VIEWPORT }]));
  for (const page of pw.pages) {
    expect(page.screenshot).toHaveBeenCalledTimes(screenshots ? 5 : 0);
    if (screenshots) expect(page.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 70, fullPage: false, animations: 'disabled', caret: 'hide', timeout: 5000 });
  }
  expect(report.shots.map((s: any) => s.step)).toEqual(screenshots ? [0, 2, 3, 4, 5] : []);
  expect(JSON.stringify(report)).not.toMatch(/shots|base64|sha256/);
  expect(report.shots[0]).toEqual(screenshots ? shot() : undefined);
});
it.each(['size', 'budget', 'count', 'failed'])('bounds screenshot %s without losing deterministic coverage', async reason => {
  let captures = 0;
  const pw = fake(async () => { if (reason === 'failed') throw new Error('page closed'); return Buffer.alloc(reason === 'size' ? 307201 : reason === 'budget' && ++captures % 3 !== 0 ? 307200 : 4); });
  const plan = { ...config(), screenshots: true };
  if (reason === 'budget') plan.flows = Array.from({ length: 20 }, (_, i) => ({ name: 'f' + i, steps: Array(3).fill({ goto: '/' }) }));
  const report = await collector.run({ playwright: pw, plan });
  expect(report.shots).toHaveLength(reason === 'size' || reason === 'failed' ? 0 : reason === 'budget' ? 20 : 10);
  expect(report.runs[0].notes).toContain('cap: screenshot ' + reason);
  expect(report.runs.every((r: any) => r.completed && !r.observations.length)).toBe(true);
  expect(stableObservations(report).incomplete).toEqual([]);
  expect(pw.pages[0].screenshot).toHaveBeenCalledTimes(plan.flows![0]!.steps.length);
});
it('excludes capture time from the flow and step deadlines, bounded at five seconds', async () => {
  vi.useFakeTimers();
  try {
    const pw = fake(() => new Promise(resolve => setTimeout(() => resolve(jpeg), 4500)));
    const pending = collector.run({ playwright: pw, plan: { ...config(), screenshots: true, flowTimeoutSeconds: 1, stepTimeoutSeconds: 1 } });
    await vi.runAllTimersAsync(); const report = await pending;
    expect(report.runs.every((r: any) => r.completed)).toBe(true);
    const hanging = fake(() => new Promise(() => {}));
    const waiting = collector.run({ playwright: hanging, plan: { ...config(), screenshots: true, flowTimeoutSeconds: 1 } });
    await vi.runAllTimersAsync(); const timed = await waiting;
    expect(timed.runs.every((r: any) => r.completed && r.notes.includes('cap: screenshot failed'))).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('accepts verified JPEGs and leaves the last-marker report readable after six MiB of images', () => {
  const runtime = config(); const s = shot();
  expect(host.runtimeShots(line(s), 'FRESH:', runtime)).toEqual({ shots: [s], notes: [] });
  const report = { version: 1, runs: [1, 2].map(run => ({ flow: 'Home Page', run, completed: true, observations: [], blockedExternal: {}, notes: [] })) };
  const big = line(shot(0, Buffer.concat([jpeg, Buffer.alloc(300 * 1024 - jpeg.length)])));
  expect(host.runtimePayload(big.repeat(21) + 'FRESH:' + JSON.stringify(report), 'FRESH:', runtime)).toEqual(report);
});
it.each([
  ['mime', { mime: 'image/png' }], ['bytes', { bytes: 3 }], ['hash', { sha256: '0'.repeat(64) }],
  ['flow', { flow: 'unknown' }], ['step', { step: 12 }], ['negative', { step: -1 }], ['fraction', { step: 0.5 }],
  ['size', { bytes: 307201 }], ['base64', { data: '/9j/AQ==!' }], ['missing', { data: undefined }],
  ['prototype', { prototype: {} }], ['constructor', { constructor: {} }], ['magic', shot(0, Buffer.from('nope'))],
])('drops invalid screenshot %s', (_name, patch) => {
  expect(host.runtimeShots(line({ ...shot(), ...patch }), 'FRESH:', config())).toEqual({ shots: [], notes: ['dropped 1 invalid screenshots'] });
});
it('rejects prototype JSON, oversized lines, duplicates and the eleventh image; ignores forged markers', () => {
  const runtime = config();
  for (const raw of ['FRESH:IMG {"__proto__":{}}\n', 'FRESH:IMG ' + ' '.repeat(450 * 1024) + '\n', 'FRESH:IMG null\n', 'FRESH:IMG {bad}\n'])
    expect(host.runtimeShots(raw, 'FRESH:', runtime)).toEqual({ shots: [], notes: ['dropped 1 invalid screenshots'] });
  expect(host.runtimeShots(line(shot()) + line(shot()), 'FRESH:', runtime).notes).toEqual(['dropped 1 invalid screenshots']);
  const capped = host.runtimeShots(Array.from({ length: 11 }, (_, i) => line(shot(i))).join(''), 'FRESH:', runtime);
  expect(capped.shots).toHaveLength(10); expect(capped.notes).toEqual(['dropped 1 invalid screenshots']);
  expect(host.runtimeShots('OLD:IMG {}\nx' + line(shot()), 'FRESH:', runtime)).toEqual({ shots: [], notes: [] });
});
it('reports stored paths and pairing without images in JSON, Markdown, SARIF or the model summary', () => {
  const report = { version: 1 as const, runs: ([1, 2] as const).map(run => ({ flow: 'Home Page', run, completed: true, observations: [], blockedExternal: {}, notes: [] })) };
  const stored = (step: number, side: string) => ({ ...shot(step), path: `.quorum/runtime-shots/qrm-test/${side}/01-home-page-${step}.jpg` });
  const side = (shots: any[]) => ({ report, stable: stableObservations(report), durationMs: 0, shots });
  const result = buildRuntimeReport({ available: true, reasons: [], notes: [], base: side([stored(0, 'base')]), head: side([stored(0, 'head'), stored(1, 'head')]) }, config(), { strictFlows: false });
  expect(result.shots.map(s => s.paired)).toEqual([true, true, false]);
  expect(runtimeMarkdown(result).join('\n')).toContain('### Screenshots');
  expect(runtimeMarkdown(result).join('\n')).toContain('unpaired');
  expect(JSON.stringify(result)).toContain('.quorum/runtime-shots/');
  for (const text of [JSON.stringify(result), runtimeMarkdown(result).join('\n'), JSON.stringify(runtimeSarif(result)), result.summary]) expect(text).not.toContain(shot().data);
  expect(result.summary).not.toContain('shots'); expect(runtimeSarif(result)).toEqual([]);
});

it('keeps screenshot notes informational after host redaction with a one-letter fill value', async () => {
  const runtime = config(); runtime.flows![0]!.steps.push({ fill: 'input', value: 's' });
  const pw = fake(async () => { throw new Error('closed'); });
  const raw = await collector.run({ playwright: pw, plan: { ...runtime, screenshots: true } });
  const parsed = host.runtimePayload('FRESH:' + JSON.stringify(raw), 'FRESH:', runtime);
  expect(parsed).not.toHaveProperty('error');
  if ('runs' in parsed) expect(stableObservations(parsed).incomplete).toEqual([]);
});

it('keeps only first-run bytes and excludes a multi-MiB image payload from report parsing', async () => {
  let capture = 0;
  const pw = fake(async () => Buffer.concat([jpeg, Buffer.alloc(300 * 1024 - jpeg.length, ++capture)]));
  const runtime = { ...config(), screenshots: true, flows: Array.from({ length: 3 }, (_, index) => ({ name: 'f' + index, steps: Array(6).fill({ goto: '/' }) })) };
  const report = await collector.run({ playwright: pw, plan: runtime });
  expect(report.shots).toHaveLength(18);
  expect(report.shots.reduce((bytes: number, shot: any) => bytes + shot.bytes, 0)).toBe(18 * 300 * 1024);
  expect(report.shots.map((shot: any) => Buffer.from(shot.data, 'base64')[4])).toEqual([1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18, 25, 26, 27, 28, 29, 30]);
  expect(host.runtimePayload('FRESH:' + JSON.stringify(report), 'FRESH:', runtime)).toEqual(report);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(2 * 1024 * 1024);
  for (const page of pw.pages) expect(page.screenshot.mock.invocationCallOrder[0]).toBeGreaterThan(page.evaluate.mock.invocationCallOrder[0]);
});
it('never credits more than five seconds of capture against the flow deadline', async () => {
  let clock = 0;
  const pw = fake(async () => { clock += 9000; return jpeg; });
  const report = await collector.run({ playwright: pw, now: () => clock, plan: { ...config(), screenshots: true, flowTimeoutSeconds: 1 } });
  expect(report.runs.every((run: any) => !run.completed && run.observations[0]?.errorClass === 'timeout')).toBe(true);
});
it('enforces the fair host budget even for otherwise valid images', () => {
  const runtime = { ...config(), flows: Array.from({ length: 20 }, (_, i) => ({ name: 'f' + i, steps: [{ goto: '/' }, { goto: '/' }] })) };
  const value = { ...shot(0, Buffer.concat([jpeg, Buffer.alloc(300 * 1024 - jpeg.length)])), flow: 'f0' };
  expect(host.runtimeShots(line(value) + line({ ...value, step: 1 }), 'FRESH:', runtime)).toEqual({ shots: [value], notes: ['dropped 1 invalid screenshots'] });
});
it.each(['flow', 'step', 'mime', 'bytes', 'sha256', 'data'])('requires the own %s field', key => {
  const value: Record<string, unknown> = shot(); delete value[key];
  expect(host.runtimeShots(line(value), 'FRESH:', config())).toEqual({ shots: [], notes: ['dropped 1 invalid screenshots'] });
});
