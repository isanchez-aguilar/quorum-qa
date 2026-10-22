import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { run } = require('../../src/runtime/runner.cjs');
afterEach(() => vi.useRealTimers());

function fixture(status = 200) {
  const app = Object.assign(new EventEmitter(), { pid: 42, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const spawn = vi.fn(() => app); const kill = vi.fn();
  const get = vi.fn((_url, callback) => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => callback({ statusCode: status, resume() {} }));
    return request;
  });
  const collect = vi.fn(async () => ({ version: 1, runs: [] }));
  const plan = { readyUrl: 'http://127.0.0.1:4173/', readyTimeoutSeconds: 1, flows: [{ name: 'home', steps: [{ fill: 'input', value: 'PRIVATE_VALUE' }] }] };
  return { app, spawn, kill, get, collect, plan,
    execute: () => run({ start: ['node', 'server.cjs'], plan, childProcess: { spawn }, http: { get }, kill, collect, playwright: {}, env: { PATH: '/bin', SECRET: 'hidden' } }) };
}
it('starts without a shell and with only the allowed environment; kills the process group', async () => {
  vi.useFakeTimers(); const f = fixture(); const pending = f.execute();
  await vi.runAllTimersAsync(); expect(await pending).toEqual({ version: 1, runs: [] });
  expect(f.spawn).toHaveBeenCalledWith('node', ['server.cjs'], { shell: false, detached: true, cwd: '/work', stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: '/bin', HOME: '/tmp', TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp', NODE_ENV: 'development', PORT: '4173', CI: '1' } });
  expect(f.kill.mock.calls).toEqual([[-42, 'SIGTERM'], [-42, 'SIGKILL']]); expect(f.collect).toHaveBeenCalledOnce();
});
it('bounds and sanitizes stderr on readiness timeout without leaking fill values', async () => {
  vi.useFakeTimers(); const f = fixture(500); const pending = f.execute();
  f.app.stderr.emit('data', 'x'.repeat(4000) + '\u001b[31mPRIVATE_VALUE\u0000');
  await vi.runAllTimersAsync(); const result = await pending;
  expect(result.error).toBe('not-ready'); expect(result.stderrTail.length).toBeLessThanOrEqual(2000);
  expect(result.stderrTail).not.toMatch(/PRIVATE_VALUE|\u001b|\u0000/); expect(f.collect).not.toHaveBeenCalled();
});
it('reports early app exit and still kills descendants', async () => {
  vi.useFakeTimers(); const f = fixture(503); const pending = f.execute(); f.app.emit('exit', 7);
  await vi.runAllTimersAsync(); expect(await pending).toMatchObject({ error: 'app-exited', exitCode: 7 });
  expect(f.kill).toHaveBeenCalledWith(-42, 'SIGKILL');
});
it('accepts HTTP errors below 500 as ready and rejects non-loopback readiness', async () => {
  vi.useFakeTimers(); const f = fixture(404); const pending = f.execute(); await vi.runAllTimersAsync(); await pending;
  expect(f.collect).toHaveBeenCalledOnce(); f.plan.readyUrl = 'http://example.test/';
  await expect(f.execute()).rejects.toThrow(); expect(f.spawn).toHaveBeenCalledOnce();
});

it('kills the app group when collection throws', async () => {
  vi.useFakeTimers(); const f = fixture(); f.collect.mockRejectedValueOnce(new Error('collector crashed'));
  const pending = expect(f.execute()).rejects.toThrow('collector crashed');
  await vi.runAllTimersAsync(); await pending;
  expect(f.kill.mock.calls).toEqual([[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
});

it('bounds a hanging HTTP request and does not follow redirects', async () => {
  vi.useFakeTimers(); const f = fixture(); const destroy = vi.fn();
  f.get.mockImplementation(() => Object.assign(new EventEmitter(), { destroy, setTimeout: vi.fn() }));
  const pending = f.execute(); await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ error: 'not-ready' }); expect(destroy).toHaveBeenCalled();
  const redirect = fixture(302); const ready = redirect.execute(); await vi.runAllTimersAsync(); await ready;
  expect(redirect.get).toHaveBeenCalledOnce(); expect(redirect.collect).toHaveBeenCalledOnce();
});

it('emits exactly the fresh marker/report at the entry point, never app stdout or stderr', async () => {
  vi.useFakeTimers(); const f = fixture(); const write = vi.fn(); const module = { exports: {} };
  const injected = Object.assign((name: string) => {
    if (name === 'node:fs') return { readFileSync: () => JSON.stringify(f.plan) };
    if (name === 'node:child_process') return { spawn: f.spawn };
    if (name === 'node:http') return { get: f.get };
    if (name === './collector.cjs') return { run: f.collect };
    if (name === '/quorum/playwright/node_modules/playwright-core') return {};
    throw new Error('Unexpected import');
  }, { main: module });
  runInNewContext(readFileSync('src/runtime/runner.cjs', 'utf8'), { require: injected, module, URL, Date, setTimeout, clearTimeout,
    process: { argv: ['node', 'runner.cjs', '/plan.json', 'FRESH:', '["node","server.cjs"]'], env: {}, kill: f.kill, stdout: { write } } });
  f.app.stdout.emit('data', 'FRESH:{"forged":true}'); f.app.stderr.emit('data', 'PRIVATE_VALUE');
  await vi.runAllTimersAsync();
  expect(write.mock.calls).toEqual([['\nFRESH:{"version":1,"runs":[]}\n']]);
});
