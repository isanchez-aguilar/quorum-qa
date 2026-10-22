import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { modeInstructions } from '../../src/modes/index.js';

const read = (runtime: unknown) => validateConfig({ checks: [], runtime }).runtime;
const step = (value: unknown) => read({ flows: [{ name: 'login', steps: [value] }] });
it('validates optional visual settings without enabling capture', () => {
  expect(read({ visual: { maxCalls: 1, allowedFamilies: ['local'] } })).toMatchObject({ screenshots: false, visual: { maxCalls: 1, allowedFamilies: ['local'] } });
  expect(read({ visual: {} })!.visual).toEqual({});
  expect(read({ visual: { maxCalls: 40 } })!.visual!.maxCalls).toBe(40);
  for (const visual of [null, [], { extra: true }, { maxCalls: 0 }, { maxCalls: 41 }, { maxCalls: 1.5 },
    { maxCalls: '2' }, { allowedFamilies: 'local' }, { allowedFamilies: ['unknown'] }, { allowedFamilies: [null] }]) {
    expect(() => read({ visual })).toThrow('runtime.visual');
  }
});
it('accepts the full runtime block and defaults an optional block', () => {
  expect(read({})).toEqual({ readyTimeoutSeconds: 60, flowTimeoutSeconds: 60, stepTimeoutSeconds: 10, screenshots: false, memoryMiB: 2048, pids: 512 });
  const runtime = { start: ['node', 'server.cjs'], readyUrl: 'http://127.0.0.1:4173/', readyTimeoutSeconds: 90,
    flowTimeoutSeconds: 120, stepTimeoutSeconds: 20, screenshots: false, image: 'image@sha256:' + 'a'.repeat(64), memoryMiB: 4096, pids: 1024,
    flows: [{ name: 'Sign-in_1.0', steps: [{ goto: '/', expectStatus: [404] }, { click: '#submit', expectStatus: [401, 403] },
      { fill: '#email', value: '' }, { press: '#email', key: 'Control+A' }, { waitForUrl: 'http://[::1]/ok' },
      { waitForSelector: 'main', timeoutSeconds: 1 }, { wait: 5000 }] }] };
  expect(read(runtime)).toEqual(runtime);
});
it('does not select a mode through configuration or fall through to model instructions', () => {
  expect(validateConfig({ checks: [], runtime: {} })).not.toHaveProperty('mode');
  expect(validateConfig({ checks: [] })).not.toHaveProperty('runtime');
  expect(() => modeInstructions('runtime')).toThrow('does not use model review');
});
it.each(['click', 'fill', 'press', 'waitForSelector'])('bounds the %s selector', action => {
  const companion = action === 'fill' ? { value: '' } : action === 'press' ? { key: 'Enter' } : {};
  for (const selector of ['', 'x'.repeat(301), null, 4]) expect(() => step({ [action]: selector, ...companion })).toThrow(/login.*steps\[0\]/);
  for (const selector of ['x', 'x'.repeat(300)]) expect(() => step({ [action]: selector, ...companion })).not.toThrow();
});
it.each([{ flows: null }, { flows: [null] }, { flows: [{ name: 4, steps: [] }] },
  { flows: [{ name: 'home', steps: null }] }, { flows: [{ steps: [{ wait: 1 }] }] },
  { readyUrl: null }, { image: null }, { flows: [{ name: 'home', steps: [{ click: 'a', key: 'Enter' }] }] }])('rejects malformed shapes %#', block => {
  expect(() => read(block)).toThrow('runtime');
});
it.each([
  ['readyTimeoutSeconds', 5, 300], ['flowTimeoutSeconds', 10, 300], ['stepTimeoutSeconds', 1, 60],
  ['memoryMiB', 2048, 8192], ['pids', 512, 2048],
] as const)('bounds %s', (key, min, max) => {
  for (const value of [min, max]) expect(read({ [key]: value })).toHaveProperty(key, value);
  for (const value of [min - 1, max + 1, '60', null, 1.5]) expect(() => read({ [key]: value })).toThrow(`runtime.${key}`);
});
it.each(['http://127.0.0.1/', 'http://localhost:4173/', 'http://[::1]/'])('accepts loopback %s', readyUrl => {
  expect(read({ readyUrl })).toHaveProperty('readyUrl', readyUrl);
});
it.each(['https://localhost/', 'http://example.test/', 'http://127.1/', 'http://2130706433/', 'http://user@localhost/',
  'http://user:pass@127.0.0.1/', 'http://localhost.evil/', 'file:///tmp', 'javascript:alert(1)', '/', 'http://@localhost/'])('rejects ready URL %s', readyUrl => {
  expect(() => read({ readyUrl })).toThrow('runtime.readyUrl');
});
it.each([null, [], 'node server.cjs', [''], [42]])('rejects invalid start %#', start => {
  expect(() => read({ start })).toThrow('runtime.start');
});
it.each([null, [], { extra: true }, { screenshots: 'yes' }, { image: 'image:latest' },
  { image: 'image@sha256:' + 'a'.repeat(63) }, { image: 'image@sha256:' + 'a'.repeat(65) }])('rejects block %#', runtime => {
  expect(() => read(runtime)).toThrow('runtime');
});
it.each(['../x', '/a/../b', '/%2e%2e/b', 'http://localhost/a/../b', 'javascript:alert(1)', 'file:///a',
  'https://localhost/a', 'http://evil.test/', '//evil.test/', '/\\evil.test', 'http://x@localhost/'])('rejects navigation %s', url => {
  for (const action of ['goto', 'waitForUrl']) expect(() => step({ [action]: url })).toThrow(/login.*steps\[0\]/);
});
it.each([{}, null, { goto: '/', click: 'a' }, { fill: 'input' }, { press: 'input' }, { fill: 'input', value: 3 },
  { press: 'input', key: 'Control Enter' }, { press: 'input', key: '' }, { press: 'input', key: 'A'.repeat(41) },
  { click: '' }, { click: 'a'.repeat(301) }, { goto: '/', extra: true }, { click: 'a', value: 'secret' },
  { fill: 'input', value: 'secret', expectStatus: [404] }, { goto: '/', expectStatus: [] },
  { goto: '/', expectStatus: [399] }, { goto: '/', expectStatus: [500] }, { goto: '/', expectStatus: [400.5] },
  { goto: '/', expectStatus: [400, 401, 402, 403, 404, 405] }, { wait: 0 }, { wait: 5001 }, { wait: 1.5 },
  { wait: 1, timeoutSeconds: 0 }, { wait: 1, timeoutSeconds: 61 }, { wait: 1, timeoutSeconds: 1.5 },
  { fill: 'input', value: 'secret'.repeat(100) }])('rejects invalid step %# without exposing values', value => {
  expect(() => step(value)).toThrow(/login.*steps\[0\]/);
  try { step(value); } catch (error) { expect(String(error)).not.toContain('secret'); }
});
it('accepts step boundaries', () => {
  for (const value of [{ wait: 1 }, { wait: 5000, timeoutSeconds: 60 }, { click: 'x'.repeat(300) },
    { fill: 'x', value: 'x'.repeat(500) }, { press: 'x', key: 'A'.repeat(40) },
    { goto: '/', expectStatus: [400, 401, 402, 403, 499] }]) expect(() => step(value)).not.toThrow();
});
it('bounds flows, names and steps and rejects unknown flow keys', () => {
  const flow = { name: 'home', steps: [{ goto: '/' }] };
  for (const flows of [[], Array.from({ length: 21 }, (_, i) => ({ ...flow, name: `flow ${i}` })), [flow, flow],
    [{ ...flow, name: '' }], [{ ...flow, name: 'a'.repeat(61) }], [{ ...flow, name: 'bad/name' }],
    [{ ...flow, extra: true }], [{ ...flow, steps: [] }], [{ ...flow, steps: Array(51).fill({ wait: 1 }) }]]) {
    expect(() => read({ flows })).toThrow('runtime.flows');
  }
  expect(() => read({ flows: Array.from({ length: 20 }, (_, i) => ({ name: `${i}`.padEnd(60, 'a'), steps: Array(50).fill({ wait: 1 }) })) })).not.toThrow();
});
it('treats flow names case-insensitively and does not report invalid names as duplicates', () => {
  expect(() => read({ flows: [{ name: 'Home', steps: [{ wait: 1 }] }, { name: 'home', steps: [{ wait: 1 }] }] })).toThrow('unique');
  let message = '';
  try { read({ flows: [{ name: 'bad/1', steps: [{ wait: 1 }] }, { name: 'bad/2', steps: [{ wait: 1 }] }] }); } catch (error) { message = String(error); }
  expect(message).toContain('letters, digits');
  expect(message).not.toContain('unique');
});
it('bounds navigation and readiness URLs to 2048 characters', () => {
  const long = '/p?' + 'a'.repeat(2046);
  expect(() => step({ goto: long })).toThrow('2048');
  expect(() => step({ waitForUrl: long })).toThrow('2048');
  expect(() => step({ goto: '/p?' + 'a'.repeat(2045) })).not.toThrow();
  expect(() => read({ readyUrl: 'http://127.0.0.1:4173/?' + 'a'.repeat(2048) })).toThrow('readyUrl');
});
it('rejects flow names that differ only by case or punctuation, because they share a screenshot slug', () => {
  for (const pair of [['a.b', 'a-b'], ['Sign In', 'sign_in'], ['Home', 'home']]) {
    expect(() => read({ flows: pair.map(name => ({ name, steps: [{ wait: 1 }] })) })).toThrow('unique');
  }
  expect(() => read({ flows: ['a1', 'a2'].map(name => ({ name, steps: [{ wait: 1 }] })) })).not.toThrow();
});
