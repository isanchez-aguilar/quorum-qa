import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QwenProvider, QWEN_REVIEW_PREFIX, MAX_QWEN_BYTES } from '../../src/providers/qwen.js';
import { checkQwen } from '../../src/doctor/checks.js';
import { DEFAULT_CATALOG, parseModelRef, withQwenModel } from '../../src/catalog/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { runCascade } from '../../src/cascade/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import { context, finding, originRunner, source } from '../fixtures/cascade.js';

const models = () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder-next' }, { id: 'second-model' }] }));
const completion = (content = '[]') => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const fetcher = () => vi.fn<typeof fetch>(async (_url, init) => init?.method === 'GET' ? models() : completion());
const deadline = { deadlineMs: 1000 };
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-qwen-')); await writeFile(path.join(root, 'sample.ts'), source); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

it.each(['https://example.com', 'http://127.0.0.2', 'file:///tmp/models', 'http://user:pass@localhost', 'http://localhost.example.com', 'http://[::ffff:127.0.0.1]', 'not a url'])('shares doctor refusal of unsafe endpoint %s', async endpoint => {
  const fetch = fetcher();
  expect((await checkQwen(endpoint, fetch)).status).toBe('FAIL');
  await expect(new QwenProvider({ endpoint, model: 'configured', fetch }).executeReview(context(root), 'qwen', 'p', deadline)).rejects.toMatchObject({ kind: 'unavailable' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://localhost:8080/v1/'])('shares doctor loopback acceptance and refuses redirects: %s', async endpoint => {
  const fetch = fetcher();
  expect((await checkQwen(endpoint, fetch)).status).toBe('PASS');
  await new QwenProvider({ endpoint, fetch }).executeReview(context(root), 'qwen', 'p', deadline);
  expect(fetch.mock.calls.map(([url]) => (url as URL).pathname)).toEqual(['/v1/models', '/v1/models', '/v1/chat/completions']);
  expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'error' && init.signal instanceof AbortSignal)).toBe(true);
});
it('sends the stable system prefix and diff-only warning, discovers once and never runs commands', async () => {
  const fetch = fetcher(); const runner = vi.fn();
  const provider = new QwenProvider({ fetch, runner });
  expect(await provider.getQuota('qwen')).toBe('unknown');
  for (let i = 0; i < 2; i++) expect((await provider.executeReview(context(root), 'qwen', 'synthetic diff', deadline)).rawOutput).toBe('[]');
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ model: 'qwen3-coder-next', messages: [
    { role: 'system', content: QWEN_REVIEW_PREFIX }, { role: 'user', content: 'synthetic diff' },
  ], temperature: 0, max_tokens: 4096, stream: false });
  expect(QWEN_REVIEW_PREFIX).toContain('diff is all the code you have'); expect(QWEN_REVIEW_PREFIX).toContain('no file access');
  expect(runner).not.toHaveBeenCalled();
});
it('uses a config override without discovery and resolves the bare catalog alias', async () => {
  const config = validateConfig({ checks: [], qwen: { model: 'configured-model' } });
  const fetch = fetcher();
  await new QwenProvider({ ...config.qwen, fetch }).executeReview(context(root), 'qwen', 'p', deadline);
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).model).toBe('configured-model');
  expect(parseModelRef('qwen', withQwenModel(DEFAULT_CATALOG, config.qwen?.model))).toEqual({ provider: 'qwen', model: 'configured-model', family: 'local' });
  expect(parseModelRef('claude:sonnet').family).toBe('anthropic'); expect(parseModelRef('claude:opus').family).toBe('anthropic');
});
it.each(['', ' ', 42, null, [], {}])('rejects invalid qwen.model %j', model => {
  expect(() => validateConfig({ checks: [], qwen: { model } })).toThrow('qwen.model');
});
it.each([['429', 429, 'quota'], ['resource QUOTA reached', 503, 'quota'], ['service down', 500, 'unavailable'], ['rate limit', 200, 'invalid']])('classifies HTTP %s (%s)', async (body, status, kind) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status: status as number }));
  const call = new QwenProvider({ model: 'local', fetch }).executeReview(context(root), 'qwen', 'p', deadline);
  if (kind === 'invalid') expect((await call).rawOutput).toBe('Invalid Qwen result envelope');
  else await expect(call).rejects.toMatchObject({ kind });
});
it('classifies connection refused as unavailable without exposing diagnostics', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('ECONNREFUSED private diagnostic'));
  await expect(new QwenProvider({ fetch }).executeReview(context(root), 'qwen', 'p', deadline)).rejects.toMatchObject({ kind: 'unavailable', message: 'Qwen endpoint unavailable or refused' });
});
it.each(['{}', 'not json', '{"choices":[{"message":{"content":null}}]}'])('rejects malformed completion %s as parse failure', async body => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
  expect((await new QwenProvider({ model: 'local', fetch }).executeReview(context(root), 'qwen', 'p', deadline)).rawOutput).toBe('Invalid Qwen result envelope');
});
it.each(['{}', '{"data":[]}', '{"data":[{}]}', 'not json'])('fails discovery safely for %s', async body => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
  expect(await new QwenProvider({ fetch }).probe('qwen')).toMatchObject({ available: false });
});
it.each(['headers', 'bytes', 'multibyte', 'chunks', 'models'])('caps response bodies at 1 MiB: %s', async mode => {
  const cancel = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (mode === 'headers') return new Response('x', { headers: { 'content-length': String(MAX_QWEN_BYTES + 1) } });
    if (mode === 'chunks') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_QWEN_BYTES)); controller.enqueue(new Uint8Array(1));
    }, cancel }));
    return new Response((mode === 'multibyte' ? 'é' : 'x').repeat(MAX_QWEN_BYTES + 1));
  });
  const provider = new QwenProvider({ fetch, ...(mode === 'models' ? {} : { model: 'local' }) });
  await expect(provider.executeReview(context(root), 'qwen', 'p', deadline)).rejects.toThrow('1 MiB');
  if (mode === 'chunks') expect(cancel).toHaveBeenCalledOnce();
});
it.each(['fetch', 'body'])('aborts at deadline during %s', async stage => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (stage === 'body') return new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } }));
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const promise = new QwenProvider({ model: 'local', fetch }).executeReview(context(root), 'qwen', 'p', { deadlineMs: 100 });
  const assertion = expect(promise).rejects.toMatchObject({ kind: 'timeout' });
  await vi.advanceTimersByTimeAsync(100); await assertion;
  expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('honors external cancellation and expired deadlines without HTTP', async () => {
  const fetch = fetcher(); const controller = new AbortController(); controller.abort();
  await expect(new QwenProvider({ fetch }).executeReview(context(root), 'qwen', 'p', { deadlineMs: 100, signal: controller.signal })).rejects.toMatchObject({ kind: 'timeout' });
  await expect(new QwenProvider({ fetch }).executeReview(context(root), 'qwen', 'p', { deadlineMs: 0 })).rejects.toMatchObject({ kind: 'timeout' });
  expect(fetch).not.toHaveBeenCalled();
});
it('propagates external cancellation after the request starts and clears its timer', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('abort')), { once: true });
  }));
  const pending = new QwenProvider({ model: 'local', fetch }).executeReview(context(root), 'qwen', 'p', { deadlineMs: 1000, signal: controller.signal });
  const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledOnce(); controller.abort(); await assertion;
  expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('accepts a complete response at exactly the 1 MiB byte boundary', async () => {
  const empty = JSON.stringify({ choices: [{ message: { content: '' } }] });
  const text = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(MAX_QWEN_BYTES - Buffer.byteLength(empty)) } }] });
  expect(Buffer.byteLength(text)).toBe(MAX_QWEN_BYTES);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(text));
  expect((await new QwenProvider({ model: 'local', fetch }).executeReview(context(root), 'qwen', 'p', deadline)).rawOutput.length).toBe(MAX_QWEN_BYTES - empty.length);
});
it('budgets discovery and completion together and does not POST after discovery exhausts time', async () => {
  let time = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { time = 100; return models(); });
  await expect(new QwenProvider({ fetch, now: () => time }).executeReview(context(root), 'qwen', 'p', { deadlineMs: 100 })).rejects.toMatchObject({ kind: 'timeout' });
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]?.method).toBe('GET');
});

const config = () => validateConfig({ checks: [], tiers: { triage: ['qwen', 'agy:gemini-3.8-flash-medium'], review: ['agy:gemini-4-argon-high'], confirm: [], visual: [] } });
it.each([false, true])('uses Qwen first and quarantines findings until review confirms: %s', async confirmed => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => init?.method === 'GET' ? models() : completion(JSON.stringify([finding()])));
  const qwen = new QwenProvider({ fetch });
  const agy = new FakeProvider('agy', 'google', originRunner(root), {
    'gemini-3.8-flash-medium': ['[]'],
    ...(confirmed ? { 'gemini-4-argon-high': ['[]', JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })] } : {}),
  });
  const result = await runCascade(context(root), config(), new Map<string, ProviderAdapter>([['qwen', qwen], ['agy', agy]]), { gitRunner: originRunner(root) });
  expect(result.calls[0]).toMatchObject({ provider: 'qwen', model: 'qwen3-coder-next' });
  expect(result.ledgerDraft[0]).toMatchObject({ model: 'qwen3-coder-next', family: 'local' });
  expect(agy.calls.some(call => call.model === 'gemini-3.8-flash-medium')).toBe(false);
  expect(result.findings).toHaveLength(confirmed ? 1 : 0); expect(result.unconfirmed).toHaveLength(confirmed ? 0 : 1);
});
it.each(['connection', 'nonjson', 'quota'])('falls back or escalates Qwen %s', async failure => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === 'GET') return models();
    if (failure === 'connection') throw new Error('ECONNREFUSED');
    return failure === 'quota' ? new Response('', { status: 429 }) : new Response('not json');
  });
  const agy = new FakeProvider('agy', 'google', originRunner(root), { 'gemini-3.8-flash-medium': ['[]'], 'gemini-4-argon-high': ['[]'] });
  const result = await runCascade(context(root), config(), new Map<string, ProviderAdapter>([['qwen', new QwenProvider({ fetch })], ['agy', agy]]), { gitRunner: originRunner(root) });
  expect(result.calls[0]?.status).toBe(failure === 'nonjson' ? 'invalid' : failure === 'quota' ? 'quota' : 'unavailable');
  expect(agy.calls[0]?.model).toBe(failure === 'nonjson' ? 'gemini-4-argon-high' : 'gemini-3.8-flash-medium');
  expect(result.coverage.complete).toBe(true);
});
it('uses the resolved model in cache keys and invalidates cache when discovery changes', async () => {
  const keys: string[] = []; const cache = { read: vi.fn(async (key: string) => { keys.push(key); return undefined; }), stage: vi.fn<(key: string, rawOutput: string, model: string) => void>() };
  for (const model of ['first', 'second']) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => init?.method === 'GET'
      ? new Response(JSON.stringify({ data: [{ id: model }] })) : completion());
    const result = await runCascade(context(root), config(), new Map([['qwen', new QwenProvider({ fetch })]]), { gitRunner: originRunner(root), cache });
    expect(result.calls[0]?.model).toBe(model);
    expect(cache.stage.mock.calls.at(-1)?.[2]).toBe(`qwen:${model}`);
  }
  expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
});
