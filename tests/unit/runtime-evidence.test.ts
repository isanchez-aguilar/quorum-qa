import { expect, it } from 'vitest';
import { parseRuntimeReport, type RuntimeReport } from '../../src/runtime/report.js';
import { normalizeMessage, signature } from '../../src/runtime/signature.js';
import { stableObservations } from '../../src/runtime/stable.js';

const plan = { flows: [{ name: 'home', steps: [{ goto: '/' }] }] };
const report = (): RuntimeReport => ({ version: 1, runs: [1, 2].map(run => ({ flow: 'home', run: run as 1 | 2,
  completed: true, observations: [{ kind: 'console', message: 'boom' }], blockedExternal: {}, notes: [] })) });
it('round trips valid reports', () => { expect(parseRuntimeReport(JSON.stringify(report()), plan)).toEqual(report()); });
it.each([
  ['positions', 'at fn app.js:12:34', 'at fn app.js'], ['hashes', 'chunk abcdef123', 'chunk'],
  ['UUID', 'id 123e4567-e89b-12d3-a456-426614174000', 'id'], ['numbers', 'id 12345', 'id'],
  ['ISO', 'at 2026-10-21T12:34:56.123Z', 'at'], ['date', 'at 2026-10-21 12:34:56', 'at'],
  ['ports', 'http://localhost:4173/x', 'http://localhost/x'], ['Windows', 'C:\\work\\src\\app.js', 'app.js'],
  ['POSIX', '/work/src/app.js', 'app.js'], ['query', 'app.js?secret=1#x', 'app.js'], ['space', ' A\n  B ', 'A B'],
])('normalizes %s', (_rule, input, output) => { expect(normalizeMessage(input)).toBe(output); });
it('keeps async identity across steps and step-bound identity separate', () => {
  expect(signature({ kind: 'console', message: 'boom', step: 0 }, 'home')).toBe('console|home|boom');
  expect(signature({ kind: 'console', message: 'boom', step: 1 }, 'home')).toBe('console|home|boom');
  expect(signature({ kind: 'blank', message: 'blank', step: 0 }, 'home')).toBe('blank|home|0|blank');
  expect(signature({ kind: 'console', message: 'TypeError: missing' }, 'home')).not.toBe(signature({ kind: 'console', message: 'ReferenceError: missing' }, 'home'));
});
it('drops expected 4xx except static resources and retains 5xx', () => {
  for (const resourceType of ['document', 'fetch', 'xhr']) expect(signature({ kind: 'http', status: 404, path: '/missing.js', resourceType, expected: true, message: '' }, 'home')).toBeUndefined();
  for (const resourceType of ['script', 'stylesheet', 'image', 'font']) expect(signature({ kind: 'http', status: 404, path: '/missing.js', resourceType, expected: true, message: '' }, 'home')).toBe('http|home|404 /missing.js');
  expect(signature({ kind: 'http', status: 500, path: '/', expected: true, message: '' }, 'home')).toBe('http|home|500 /');
});
it('intersects signatures and counts each run', () => {
  const value = report(); value.runs[0]!.observations.push({ kind: 'console', message: 'once' }, { kind: 'console', message: 'boom' });
  const result = stableObservations(value);
  expect([...result.flows.home!]).toEqual(['console|home|boom']);
  expect(result.counts['console|home|boom']).toEqual([2, 1]);
  expect(result.flaky).toEqual([]); expect(result.incomplete).toEqual([]);
});
it('distinguishes flaky, stable failure and incomplete coverage', () => {
  const value = report(); value.runs[0]!.completed = false;
  expect(stableObservations(value).flaky).toEqual(['home']);
  const failure = { kind: 'flow-failure' as const, step: 0, message: 'timeout', errorClass: 'timeout' as const };
  value.runs[0]!.observations.push(failure); value.runs[1]!.completed = false;
  expect(stableObservations(value)).toMatchObject({ flaky: ['home'], incomplete: ['home'] });
  value.runs[1]!.observations.push(failure);
  expect(stableObservations(value)).toMatchObject({ flaky: [], incomplete: [] });
  value.runs[0]!.notes.push('cap: observations per run');
  expect(stableObservations(value).incomplete).toEqual(['home']);
});
it.each(['kind', 'flow', 'run', 'duplicate', 'version', 'types', '__proto__', 'constructor', 'deep', 'oversize'])('rejects %s', test => {
  const value = report(); let raw: string;
  if (test === 'kind') (value.runs[0]!.observations[0] as unknown as { kind: string }).kind = 'unknown';
  if (test === 'flow') value.runs[0]!.flow = 'unknown';
  if (test === 'run') (value.runs[0] as unknown as { run: number }).run = 3;
  if (test === 'duplicate') value.runs.push(value.runs[0]!);
  if (test === 'version') (value as { version: number }).version = 2;
  if (test === 'types') (value.runs[0] as unknown as { completed: string }).completed = 'yes';
  raw = JSON.stringify(value);
  if (test === '__proto__' || test === 'constructor') raw = raw.replace('"blockedExternal":{}', `"blockedExternal":{"${test}":1}`);
  if (test === 'deep') raw = '['.repeat(20000) + '0' + ']'.repeat(20000);
  if (test === 'oversize') raw = ' '.repeat(2 * 1024 * 1024 + 1);
  expect(parseRuntimeReport(raw, plan)).toHaveProperty('error');
});
it('truncates messages again', () => {
  const value = report(); value.runs[0]!.observations[0]!.message = 'x'.repeat(900);
  const parsed = parseRuntimeReport(JSON.stringify(value), plan);
  expect('runs' in parsed && parsed.runs[0]!.observations[0]!.message.length).toBe(500);
});
it('normalizes pathological 500 KB in under 50 ms', () => {
  const input = ('9'.repeat(125000) + ':'.repeat(125000) + '/'.repeat(125000) + 'a'.repeat(137000)).slice(0, 512000);
  normalizeMessage('warmup'); const start = performance.now(); normalizeMessage(input);
  expect(performance.now() - start).toBeLessThan(50);
});
it('parses a 2 MiB input with 2000 observations in under 300 ms', () => {
  const flows = Array.from({ length: 5 }, (_, index) => ({ name: `flow${index}`, steps: [{ goto: '/' }] }));
  const value = { version: 1, runs: flows.flatMap(flow => [1, 2].map(run => ({ flow: flow.name, run, completed: true,
    observations: Array.from({ length: 200 }, () => ({ kind: 'console', message: 'x'.repeat(500) })), blockedExternal: {}, notes: [] }))) };
  const raw = JSON.stringify(value).padEnd(2 * 1024 * 1024, ' '); const start = performance.now();
  expect(parseRuntimeReport(raw, { flows })).not.toHaveProperty('error'); expect(performance.now() - start).toBeLessThan(300);
});
it.each([
  { message: 2 }, { step: -1 }, { step: 1 }, { step: 0.5 }, { path: '/?secret=1' }, { path: 3 },
  { status: 404 }, { resourceType: 'script' }, { expected: true }, { errorClass: 'timeout' }, { extra: 'unknown' },
  { kind: 'http', status: 399, resourceType: 'fetch', path: '/' },
  { kind: 'http', status: 600, resourceType: 'fetch', path: '/' },
  { kind: 'http', status: 404, resourceType: 'unknown', path: '/' },
  { kind: 'http', status: 404, resourceType: 'fetch', path: '/', expected: 'true' },
  { kind: 'blank' }, { kind: 'flow-failure', step: 0 }, { kind: 'flow-failure', step: 0, errorClass: 'unknown' },
])('rejects malformed observation %#', patch => {
  const value = report(); Object.assign(value.runs[0]!.observations[0]!, patch);
  expect(parseRuntimeReport(JSON.stringify(value), plan)).toHaveProperty('error');
});
it.each([null, [], { version: 1, runs: null }, { version: 1, runs: [null] }])('rejects malformed root/run %#', value => {
  expect(parseRuntimeReport(JSON.stringify(value), plan)).toHaveProperty('error');
});
it.each([
  { notes: [2] }, { notes: Array(21).fill('cap') }, { blockedExternal: { 'example.test': -1 } },
  { blockedExternal: { 'http://example.test/secret': 1 } }, { blockedExternal: [] }, { observations: {} },
  { observations: Array(201).fill({ kind: 'console', message: 'boom' }) },
])('rejects malformed run metadata %#', patch => {
  const value = report(); Object.assign(value.runs[0]!, patch);
  expect(parseRuntimeReport(JSON.stringify(value), plan)).toHaveProperty('error');
});
it('marks missing runs incomplete and handles prototype-like configured names safely', () => {
  const parsed = parseRuntimeReport('{"version":1,"runs":[]}', { flows: [{ name: '__proto__', steps: [{ goto: '/' }] }] });
  expect(parsed).not.toHaveProperty('error');
  if ('runs' in parsed) expect(stableObservations(parsed).incomplete).toEqual(['__proto__']);
});
it('rejects deeply nested observation values without recursion', () => {
  const raw = JSON.stringify(report()).replace('"message":"boom"', '"message":' + '['.repeat(20000) + '0' + ']'.repeat(20000));
  expect(parseRuntimeReport(raw, plan)).toHaveProperty('error');
});
it('bounds technical text and failure messages independently', () => {
  const value = report(); value.runs[0]!.observations = [
    { kind: 'technicalText', step: 0, message: 'x'.repeat(900) },
    { kind: 'flow-failure', step: 0, errorClass: 'other', message: 'x'.repeat(900) },
  ];
  const parsed = parseRuntimeReport(JSON.stringify(value), plan);
  expect('runs' in parsed && parsed.runs[0]!.observations.map(item => item.message.length)).toEqual([200, 300]);
});
it.each(['console', 'pageerror', 'requestfailed'] as const)('omits steps for %s signatures', kind => {
  expect(signature({ kind, step: 0, message: 'boom' }, 'home')).toBe(`${kind}|home|boom`);
  expect(signature({ kind, step: 1, message: 'boom' }, 'home')).toBe(`${kind}|home|boom`);
});
it.each(['blank', 'technicalText', 'flow-failure'] as const)('includes steps for %s signatures', kind => {
  expect(signature({ kind, step: 0, message: 'boom' }, 'home')).toBe(`${kind}|home|0|boom`);
  expect(signature({ kind, step: 1, message: 'boom' }, 'home')).toBe(`${kind}|home|1|boom`);
});
it('keeps distinct resources and error descriptions distinct', () => {
  const messages = ['TypeError: missing account', 'TypeError: missing invoice', 'ReferenceError: missing account'];
  expect(new Set(messages.map(message => signature({ kind: 'console', message }, 'home'))).size).toBe(3);
  const paths = ['/a/missing.js', '/b/missing.js'];
  expect(new Set(paths.map(path => signature({ kind: 'http', status: 404, path, message: '' }, 'home'))).size).toBe(2);
});
it('strips ports from parenthesised V8 stack-frame URLs', () => {
  expect(normalizeMessage('at f (http://127.0.0.1:4173/assets/app.js:12:34)')).toBe('at f (http://127.0.0.1/assets/app.js)');
  expect(normalizeMessage('at f (http://localhost:80/app.js:1:2)')).toBe(normalizeMessage('at f (http://localhost:5173/app.js:9:9)'));
});
it('matches a stable failure by step even when its message varies, and keeps truncation-only notes complete', () => {
  const value = report();
  for (const [index, message] of ['net::ERR_A', 'net::ERR_B'].entries()) {
    value.runs[index]!.completed = false;
    value.runs[index]!.observations.push({ kind: 'flow-failure', step: 0, message, errorClass: 'navigation' });
  }
  value.runs[0]!.notes.push('cap: message');
  expect(stableObservations(value)).toMatchObject({ flaky: [], incomplete: [] });
  value.runs[1]!.observations[1]!.step = undefined as never;
  value.runs[1]!.observations.push({ kind: 'flow-failure', step: 0, message: 'x', errorClass: 'other' });
  expect(stableObservations(value).incomplete).toEqual([]);
});
it('accepts reports whose observations carry no path (about:blank)', () => {
  const value = report(); value.runs[0]!.observations[0]!.path = '';
  expect('runs' in (parseRuntimeReport(JSON.stringify(value), plan) as object)).toBe(true);
});
