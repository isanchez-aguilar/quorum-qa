import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import type { RuntimeReport } from '../../src/runtime/report.js';
import type { Step } from '../../src/runtime/config.js';

const require = createRequire(import.meta.url);
const { run, CHROMIUM_ARGS } = require('../../src/runtime/collector.cjs') as {
  run: (options: { playwright: unknown; plan: unknown; now?: () => number }) => Promise<RuntimeReport>; CHROMIUM_ARGS: string[];
};
type Handler = (...args: any[]) => unknown;
function fake(script: (page: any, index: number, action: string) => unknown = () => {}) {
  const contexts: any[] = [];
  const browser = { close: vi.fn(), newContext: vi.fn(async () => {
    const handlers: Record<string, Handler> = {}; const index = contexts.length;
    const page: any = { on: (event: string, handler: Handler) => { handlers[event] = handler; },
      emit: (event: string, value: unknown) => handlers[event]?.(value), url: () => 'http://localhost:4173/page?secret=yes#hash',
      mainFrame: () => page, evaluate: vi.fn(async () => ({ blank: false, snippets: [] })),
      waitForLoadState: vi.fn(async () => {}), waitForTimeout: vi.fn(async () => {}),
    };
    for (const action of ['goto', 'click', 'fill', 'press', 'waitForURL', 'waitForSelector']) page[action] = vi.fn(async () => script(page, index, action));
    const context = { page, newPage: async () => page, route: vi.fn(async (_pattern: string, handler: Handler) => { context.handler = handler; }), handler: undefined as Handler | undefined, close: vi.fn(async () => {}) };
    contexts.push(context); return context;
  }) };
  return { contexts, browser, chromium: { launch: vi.fn(async () => browser) } };
}
const plan = (steps: Step[] = [{ goto: '/' }]) => ({ readyUrl: 'http://localhost:4173/base', flowTimeoutSeconds: 60, stepTimeoutSeconds: 10, flows: [{ name: 'home', steps }] });
const response = (page: any, type: string, status = 404) => {
  const request = { resourceType: () => type, frame: () => page, isNavigationRequest: () => type === 'document' };
  page.emit('request', request);
  return { status: () => status, url: () => 'http://localhost/missing.js?secret=1', request: () => request };
};
it('imports without running the entry and runs twice in fresh closed contexts', async () => {
  const pw = fake(); const value = await run({ playwright: pw, plan: plan() });
  expect(CHROMIUM_ARGS).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
  expect(pw.chromium.launch).toHaveBeenCalledWith({ args: CHROMIUM_ARGS });
  expect(pw.contexts).toHaveLength(2); for (const context of pw.contexts) expect(context.close).toHaveBeenCalledOnce();
  expect(pw.browser.close).toHaveBeenCalledOnce(); expect(value.runs.map(item => item.completed)).toEqual([true, true]);
  expect(pw.contexts[0].page.goto).toHaveBeenCalledWith('http://localhost:4173/', { timeout: 10000 });
});
it('blocks external requests by host and continues all loopback hosts', async () => {
  const pw = fake(async (_page, index) => {
    for (const host of ['example.test', 'example.test', 'localhost', '127.0.0.1', '[::1]']) {
      const route = { request: () => ({ url: () => `http://${host}/secret?token=hidden` }), fulfill: vi.fn(), continue: vi.fn() };
      await pw.contexts[index].handler(route);
      if (host === 'example.test') expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
      else expect(route.continue).toHaveBeenCalledOnce();
    }
  });
  const value = await run({ playwright: pw, plan: plan() });
  expect(value.runs[0]!.blockedExternal).toEqual({ 'example.test': 2 }); expect(JSON.stringify(value)).not.toContain('token');
});
it('collects exact event fields, expected statuses and DOM snippets', async () => {
  const pw = fake(page => {
    page.emit('console', { type: () => 'log', text: () => 'ignored' });
    page.emit('console', { type: () => 'error', text: () => 'boom' }); page.emit('pageerror', new Error('uncaught'));
    page.emit('response', response(page, 'document')); page.emit('response', response(page, 'script'));
    page.emit('requestfailed', { url: () => 'http://localhost/api?token=x', failure: () => ({ errorText: 'failed' }) });
    page.evaluate.mockResolvedValue({ blank: true, snippets: ['TypeError:'] });
  });
  const value = await run({ playwright: pw, plan: plan([{ goto: '/', expectStatus: [404] }]) });
  expect(value.runs[0]!.observations).toEqual([
    { kind: 'console', step: 0, path: '/page', message: 'boom' }, { kind: 'pageerror', step: 0, path: '/page', message: 'uncaught' },
    { kind: 'http', step: 0, path: '/missing.js', status: 404, resourceType: 'document', expected: true, message: '404 /missing.js' },
    { kind: 'http', step: 0, path: '/missing.js', status: 404, resourceType: 'script', message: '404 /missing.js' },
    { kind: 'requestfailed', step: 0, path: '/api', message: 'failed' }, { kind: 'blank', step: 0, path: '/page', message: 'blank' },
    { kind: 'technicalText', step: 0, path: '/page', message: 'TypeError:' },
  ]);
});
it.each([['TimeoutError', 'timed out', 'timeout'], ['Error', 'selector missing', 'selector'], ['Error', 'net::ERR_FAILED', 'navigation'], ['Error', 'unexpected', 'other']])('classifies %s %s', async (name, message, errorClass) => {
  const pw = fake(() => { throw Object.assign(new Error(message), { name }); });
  const value = await run({ playwright: pw, plan: plan([{ goto: '/' }, { click: 'a' }]) });
  expect(value.runs[0]).toMatchObject({ completed: false, observations: [{ kind: 'flow-failure', step: 0, errorClass, message }] });
  expect(pw.contexts[0].page.click).not.toHaveBeenCalled();
});
it('enforces a flow deadline even when a browser operation never resolves', async () => {
  vi.useFakeTimers();
  try {
    const pw = fake(() => new Promise(() => {})); const pending = run({ playwright: pw, plan: { ...plan(), flowTimeoutSeconds: 1 } });
    await vi.runAllTimersAsync(); const value = await pending;
    expect(value.runs.every(item => !item.completed && item.observations[0]?.errorClass === 'timeout')).toBe(true);
    expect(pw.contexts.every(context => context.close.mock.calls.length === 1)).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('caps observations and messages with notes', async () => {
  const pw = fake(page => { for (let index = 0; index < 205; index++) page.emit('console', { type: () => 'error', text: () => 'x'.repeat(600) }); });
  const value = await run({ playwright: pw, plan: plan() });
  expect(value.runs[0]!.observations).toHaveLength(200); expect(value.runs[0]!.observations[0]!.message).toHaveLength(500);
  expect(value.runs[0]!.notes).toContain('cap: message'); expect(value.runs[0]!.notes).toContain('cap: observations per run');
});
it('caps report observation count and UTF-8 serialized size', async () => {
  for (const message of ['x', '\u0000'.repeat(500)]) {
    const pw = fake(page => { for (let index = 0; index < 200; index++) page.emit('console', { type: () => 'error', text: () => message }); });
    const value = await run({ playwright: pw, plan: { ...plan(), flows: Array.from({ length: 20 }, (_, index) => ({ name: `f${index}`, steps: [{ goto: '/' }] })) } });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(value.runs.reduce((sum, item) => sum + item.observations.length, 0)).toBeLessThanOrEqual(2000);
    expect(value.runs.flatMap(item => item.notes)).toContain(message === 'x' ? 'cap: observations per report' : 'cap: report size');
  }
});
it('executes all declarative actions with per-step timeouts and ignores only idle timeouts', async () => {
  const pw = fake(page => { page.waitForLoadState.mockImplementation(async (state: string) => {
    if (state === 'networkidle') throw Object.assign(new Error('idle'), { name: 'TimeoutError' });
  }); });
  const steps: Step[] = [{ goto: '/' }, { click: 'a', timeoutSeconds: 3 }, { fill: '#email', value: 'synthetic' },
    { press: '#email', key: 'Enter' }, { waitForUrl: '/next' }, { waitForSelector: 'main' }, { wait: 5 }];
  const value = await run({ playwright: pw, plan: plan(steps) }); const page = pw.contexts[0].page;
  expect(value.runs[0]!.completed).toBe(true);
  expect(page.click).toHaveBeenCalledWith('a', { timeout: 3000 });
  expect(page.fill).toHaveBeenCalledWith('#email', 'synthetic', { timeout: 10000 });
  expect(page.press).toHaveBeenCalledWith('#email', 'Enter', { timeout: 10000 });
  expect(page.waitForURL).toHaveBeenCalledWith('http://localhost:4173/next', { timeout: 10000 });
  expect(page.waitForSelector).toHaveBeenCalledWith('main', { timeout: 10000 }); expect(page.waitForTimeout).toHaveBeenCalledWith(5);
  expect(page.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 2000 });
});
it('does not mark a late response from an earlier step expected', async () => {
  let earlier: unknown;
  const pw = fake((page, _index, action) => {
    if (action === 'goto') earlier = response(page, 'fetch');
    else { page.emit('response', earlier); page.emit('response', response(page, 'xhr')); page.emit('response', response(page, 'fetch', 500)); }
  });
  const value = await run({ playwright: pw, plan: plan([{ goto: '/' }, { click: 'a', expectStatus: [404] }]) });
  expect(value.runs[0]!.observations.map(item => item.expected)).toEqual([undefined, true, undefined]);
});
it.each([
  ['at name (/work/' + 'x'.repeat(250) + '.js:12:34)', 'at name (/work/' + 'x'.repeat(250) + '.js:12:34)'],
  ['TypeError:', 'TypeError:'], ['ReferenceError:', 'ReferenceError:'], ['SyntaxError:', 'SyntaxError:'],
  ['undefined', 'undefined'], ['[object Object]', '[object Object]'], ['NaN', 'NaN'],
  ['Internal Server Error', 'Internal Server Error'], ['ECONNREFUSED', 'ECONNREFUSED'],
  ['{"error":"private body"}', '{"error"'], ['{"message":"private body"}', '{"message"'],
])('extracts only the bounded technical snippet %s', async (text, snippet) => {
  const pw = fake(page => page.evaluate.mockImplementation(async (fn: Function) => runInNewContext(`(${fn.toString()})()`, {
    document: { body: { innerText: text + '\nPRIVATE PAGE CONTENT' }, querySelectorAll: () => [] },
  })));
  const value = await run({ playwright: pw, plan: plan() });
  expect(value.runs[0]!.observations).toEqual([{ kind: 'technicalText', step: 0, path: '/page', message: snippet.slice(0, 200) }]);
  expect(JSON.stringify(value)).not.toContain('PRIVATE PAGE CONTENT');
  if (snippet.length > 200) expect(value.runs[0]!.notes).toContain('cap: message');
});
it.each(['img', 'svg', 'canvas', 'video', 'input'])('does not call visible %s blank', async tag => {
  const pw = fake(page => page.evaluate.mockImplementation(async (fn: Function) => runInNewContext(`(${fn.toString()})()`, {
    document: { body: { innerText: ' ' }, querySelectorAll: (selector: string) => selector.includes(tag) ? [{ getBoundingClientRect: () => ({ width: 10, height: 10 }) }] : [] },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  })));
  expect((await run({ playwright: pw, plan: plan() })).runs[0]!.observations).toEqual([]);
});
it.each(['', 'Banana Finance myundefined TypeErrorish'])('inspects blank and benign text: %s', async text => {
  const pw = fake(page => page.evaluate.mockImplementation(async (fn: Function) => runInNewContext(`(${fn.toString()})()`, {
    document: { body: { innerText: text }, querySelectorAll: () => [] },
  })));
  expect((await run({ playwright: pw, plan: plan() })).runs[0]!.observations.map(item => item.kind)).toEqual(text ? [] : ['blank']);
});
it('bounds failure messages, paths and host metadata', async () => {
  const pw = fake(async (page, index) => {
    page.url = () => 'http://localhost/' + 'x'.repeat(600);
    page.emit('console', { type: () => 'error', text: () => 'boom' });
    for (let host = 0; host < 201; host++) await pw.contexts[index].handler({ request: () => ({ url: () => `http://h${host}.test/secret` }), fulfill: async () => {} });
    throw new Error('x'.repeat(400));
  });
  const value = await run({ playwright: pw, plan: plan() });
  expect(value.runs[0]!.observations[0]!.path).toHaveLength(500);
  expect(value.runs[0]!.observations[1]!.message).toHaveLength(300);
  expect(Object.keys(value.runs[0]!.blockedExternal)).toHaveLength(200);
  expect(value.runs[0]!.notes).toEqual(['cap: path', 'cap: external hosts', 'cap: message']);
});
it('uses the injected clock to abort between steps', async () => {
  let time = 0; const pw = fake(() => { time += 61000; });
  const value = await run({ playwright: pw, plan: plan([{ fill: 'input', value: '' }, { click: 'a' }]), now: () => time });
  expect(value.runs[0]!.observations[0]).toMatchObject({ kind: 'flow-failure', step: 1, errorClass: 'timeout' });
});
it('allocates two contexts for each flow and closes the browser on teardown failure', async () => {
  const pw = fake(); const value = await run({ playwright: pw, plan: { ...plan(), flows: [
    { name: 'one', steps: [{ goto: '/' }] }, { name: 'two', steps: [{ goto: '/two' }] },
  ] } });
  expect(pw.contexts).toHaveLength(4); expect(value.runs.map(item => [item.flow, item.run])).toEqual([['one', 1], ['one', 2], ['two', 1], ['two', 2]]);
  const broken = fake((_page, index) => { broken.contexts[index].close.mockRejectedValue(new Error('close failed')); });
  await expect(run({ playwright: broken, plan: plan() })).rejects.toThrow('close failed'); expect(broken.browser.close).toHaveBeenCalledOnce();
});
it('records resource categories and only errors from responses', async () => {
  const types = ['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr', 'media'];
  const pw = fake(page => { for (const type of types) page.emit('response', response(page, type, 500)); page.emit('response', response(page, 'fetch', 200)); });
  const value = await run({ playwright: pw, plan: plan() });
  expect(value.runs[0]!.observations.map(item => item.resourceType)).toEqual([...types.slice(0, -1), 'other']);
});
it('enforces the per-step timeout and suppresses late observations', async () => {
  vi.useFakeTimers();
  try {
    const pw = fake(() => new Promise(() => {}));
    const pending = run({ playwright: pw, plan: plan([{ goto: '/', timeoutSeconds: 1 }]) });
    await vi.runAllTimersAsync(); const value = await pending; const before = JSON.stringify(value);
    pw.contexts[0].page.emit('console', { type: () => 'error', text: () => 'late' });
    expect(JSON.stringify(value)).toBe(before); expect(value.runs[0]!.observations[0]!.errorClass).toBe('timeout');
  } finally { vi.useRealTimers(); }
});
it('records no path for events on about:blank and ignores hostless routed requests', async () => {
  const pw = fake(async (page, index) => {
    page.url = () => 'about:blank';
    page.emit('console', { type: () => 'error', text: () => 'early' });
    const route = { request: () => ({ url: () => 'data:text/plain,x' }), fulfill: vi.fn(), continue: vi.fn() };
    await pw.contexts[index].handler(route);
    expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
  });
  const value = await run({ playwright: pw, plan: plan() });
  const early = value.runs[0]!.observations.find(item => item.message === 'early');
  expect(early?.path).toBe(''); expect(value.runs[0]!.blockedExternal).toEqual({});
});
