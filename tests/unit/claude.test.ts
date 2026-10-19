import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { CommandTimeoutError } from '../../src/process/runner.js';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { ProviderAdapter } from '../../src/providers/types.js';
import type { CommandRunner } from '../../src/types/index.js';
import { context, originRunner } from '../fixtures/cascade.js';

let root: string;
let dirty: boolean;
let answer: ReturnType<typeof vi.fn<CommandRunner>>;
let runner: ReturnType<typeof vi.fn<CommandRunner>>;
const ok = (result = '[]') => ({ stdout: JSON.stringify({ subtype: 'success', result, usage: { input_tokens: 12, output_tokens: 3 } }), stderr: '', exitCode: 0 });
const settings = () => ({ runner, platform: 'linux' as const, env: { PATH: '/synthetic/bin' }, exists: () => true });
const review = (options = { deadlineMs: 10000 }) => new ClaudeProvider(settings()).executeReview(context(root), 'sonnet', 'untrusted\nprompt "quota"', options);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-claude-'));
  dirty = false;
  answer = vi.fn(async () => ok());
  runner = vi.fn(async (file, args, options) => /git(?:\.exe)?$/i.test(file)
    ? { stdout: args.includes('--show-toplevel') ? root : args.includes('status') && dirty ? '?? changed.txt' : '', stderr: '', exitCode: 0 }
    : answer(file, args, options));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('uses the exact restricted argv, stdin, worktree cwd, tokens and unknown quota', async () => {
  expect(await review()).toMatchObject({ rawOutput: '[]', worktreeClean: true, tokensUsed: { prompt: 12, completion: 3 } });
  const [, argv, options] = answer.mock.calls[0]!;
  expect(argv).toEqual(['-p', '--output-format', 'json', '--model', 'sonnet', '--no-session-persistence', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk']);
  expect(argv).not.toContain('--bare'); expect(argv).not.toContain('bypassPermissions');
  expect(options?.stdin).toBe('untrusted\nprompt "quota"');
  expect(options?.cwd).toContain(path.join('.quorum', 'worktrees')); expect(options?.cwd).not.toBe(root);
  expect(options?.timeoutMs).toBeGreaterThan(0); expect(options?.timeoutMs).toBeLessThanOrEqual(10000);
  expect(runner.mock.calls.some(([, args]) => args.includes('remove'))).toBe(true);
  expect(await new ClaudeProvider(settings()).getQuota('sonnet')).toBe('unknown');
});
it.each([true, false])('probes the version, available=%s', async available => {
  answer.mockResolvedValue({ ...ok(), exitCode: available ? 0 : 1 });
  expect(await new ClaudeProvider(settings()).probe('opus')).toEqual({ available });
  expect(answer.mock.calls[0]![1]).toEqual(['--version']);
});
it.each(['{}', 'null', '[]', 'not JSON', '{"result":[]}', '{"subtype":"success","result":{}}'])('returns an unparseable sentinel for unknown JSON %s', async stdout => {
  answer.mockResolvedValue({ ...ok(), stdout });
  expect((await review()).rawOutput).toBe('Invalid Claude result envelope');
  expect(answer).toHaveBeenCalledOnce();
});
it.each([{ subtype: 'error', result: 'quota 429' }])('fails error envelopes without scanning answer text', async envelope => {
  answer.mockResolvedValue({ ...ok(), stdout: JSON.stringify(envelope) });
  await expect(review()).rejects.toMatchObject({ kind: 'unavailable' });
});
it.each(['stderr', 'error', 'errors', 'subtype'])('detects quota only in failure diagnostics: %s', async field => {
  const envelope = { subtype: 'error', result: '[]', [field]: 'RESOURCE_EXHAUSTED' };
  answer.mockResolvedValue({ stdout: JSON.stringify(envelope), stderr: field === 'stderr' ? 'quota' : '', exitCode: 1 });
  await expect(review()).rejects.toMatchObject({ kind: 'quota' });
});
it('never detects quota from successful stderr, error fields or answer text', async () => {
  answer.mockResolvedValue({ ...ok('quota 429'), stderr: 'quota', stdout: JSON.stringify({ subtype: 'success', result: 'quota 429', error: 'quota' }) });
  expect((await review()).rawOutput).toBe('quota 429');
});
it('retries empty failed stdout once, reserves budget, checks checkout each time and reduces timeout', async () => {
  let time = 0;
  answer.mockImplementationOnce(async () => { time = 100; return { stdout: '', stderr: '', exitCode: 1 }; });
  const reserveRetry = vi.fn(() => true); const guard = vi.fn(async () => {});
  await new ClaudeProvider({ ...settings(), now: () => time }).executeReview(context(root), 'opus', 'p', { deadlineMs: 1000, reserveRetry, assertCheckoutUnchanged: guard });
  expect(answer).toHaveBeenCalledTimes(2); expect(reserveRetry).toHaveBeenCalledOnce(); expect(guard).toHaveBeenCalledTimes(2);
  expect(answer.mock.calls.map(([, , options]) => options?.timeoutMs)).toEqual([1000, 900]);
});
it('does not exceed one retry or retry when budget denies it', async () => {
  answer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
  await expect(review()).rejects.toMatchObject({ kind: 'unavailable' }); expect(answer).toHaveBeenCalledTimes(2);
  answer.mockClear();
  await expect(new ClaudeProvider(settings()).executeReview(context(root), 'sonnet', 'p', { deadlineMs: 1000, reserveRetry: () => false })).rejects.toThrow('budget');
  expect(answer).toHaveBeenCalledOnce();
});
it('does not retry failed nonempty stdout', async () => {
  answer.mockResolvedValue({ ...ok(), exitCode: 1 });
  await expect(review()).rejects.toMatchObject({ kind: 'unavailable' }); expect(answer).toHaveBeenCalledOnce();
});
it('enforces deadline before setup and before retry', async () => {
  await expect(review({ deadlineMs: 0 })).rejects.toMatchObject({ kind: 'timeout' }); expect(runner).not.toHaveBeenCalled();
  let time = 0;
  answer.mockImplementation(async () => { time = 100; return { stdout: '', stderr: '', exitCode: 1 }; });
  await expect(new ClaudeProvider({ ...settings(), now: () => time }).executeReview(context(root), 'sonnet', 'p', { deadlineMs: 100 })).rejects.toMatchObject({ kind: 'timeout' });
  expect(answer).toHaveBeenCalledOnce();
});
it('preserves runner timeout and invokes the checkout guard on failure', async () => {
  answer.mockRejectedValue(new CommandTimeoutError('', ''));
  const guard = vi.fn(async () => {});
  await expect(new ClaudeProvider(settings()).executeReview(context(root), 'sonnet', 'p', { deadlineMs: 1000, assertCheckoutUnchanged: guard })).rejects.toMatchObject({ kind: 'timeout' });
  expect(guard).toHaveBeenCalledOnce();
});
it('stops before retry if checkout guard fails, and always cleans up', async () => {
  answer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
  await expect(new ClaudeProvider(settings()).executeReview(context(root), 'sonnet', 'p', { deadlineMs: 1000, assertCheckoutUnchanged: async () => { throw new Error('checkout changed'); } })).rejects.toThrow('checkout changed');
  expect(answer).toHaveBeenCalledOnce(); expect(runner.mock.calls.some(([, args]) => args.includes('remove'))).toBe(true);
});
it('marks dirty worktrees for discard without retry', async () => {
  dirty = true; answer.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
  expect((await review()).worktreeClean).toBe(false); expect(answer).toHaveBeenCalledOnce();
});
it('escalates an unknown envelope under rule 4 instead of accepting nested findings', async () => {
  answer.mockResolvedValue({ ...ok(), stdout: '{"unknown":{"findings":[]}}' });
  const cfg = validateConfig({ checks: [], tiers: { triage: ['claude:sonnet'], review: ['agy:gemini-4-argon-high'], confirm: [], visual: [] } });
  const agy = new FakeProvider('agy', 'google', runner, { 'gemini-4-argon-high': ['[]'] });
  const result = await runCascade(context(root), cfg, new Map<string, ProviderAdapter>([['claude', new ClaudeProvider(settings())], ['agy', agy]]), { gitRunner: originRunner(root) });
  expect(result.calls.map(call => call.status)).toEqual(['invalid', 'ok']);
  expect(result.coverage.complete).toBe(true);
});

it('recognizes the recorded expired-login envelope (ASSUMPTION 10)', async () => {
  const { claudeAuthFailure, claudeEnvelope, CLAUDE_LOGIN_HINT } = await import('../../src/providers/claude.js');
  // Shape recorded from claude 2.1.285 on 2026-10-19, trimmed.
  const recorded = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', num_turns: 1,
    result: 'Failed to authenticate: OAuth session expired and could not be refreshed', usage: { input_tokens: 0, output_tokens: 0 } });
  expect(claudeAuthFailure(claudeEnvelope(recorded))).toBe(true);
  expect(claudeAuthFailure(claudeEnvelope(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '[]' })))).toBe(false);
  // A review that merely mentions OAuth is an answer, not an auth failure.
  expect(claudeAuthFailure(claudeEnvelope(JSON.stringify({ subtype: 'success', is_error: false, result: 'The OAuth refresh path lacks a check' })))).toBe(false);
  answer.mockResolvedValue({ stdout: recorded, stderr: '', exitCode: 1 });
  await expect(review()).rejects.toMatchObject({ kind: 'unavailable', message: CLAUDE_LOGIN_HINT });
});

it.each(["You've hit your usage limit", 'API Error: 429 rate_limit_error'])('exhausts the Claude quota group from error result: %s', async result => {
  answer.mockResolvedValue({ stdout: JSON.stringify({ subtype: 'success', is_error: true, result }), stderr: '', exitCode: 1 });
  await expect(review()).rejects.toMatchObject({ kind: 'quota' });
  answer.mockClear();
  const cfg = validateConfig({ checks: [], tiers: { triage: ['claude:sonnet', 'claude:opus'], review: ['agy:gemini-4-argon-high'], confirm: [], visual: [] } });
  const agy = new FakeProvider('agy', 'google', runner, { 'gemini-4-argon-high': ['[]'] });
  const cascade = await runCascade(context(root), cfg, new Map<string, ProviderAdapter>([['claude', new ClaudeProvider(settings())], ['agy', agy]]), { gitRunner: originRunner(root) });
  expect(cascade.calls.map(call => call.status)).toEqual(['quota', 'ok']);
  expect(answer.mock.calls.filter(([, args]) => args.includes('-p'))).toHaveLength(1);
});

it('does not scan error result beyond the first 300 characters', async () => {
  answer.mockResolvedValue({ stdout: JSON.stringify({ subtype: 'success', is_error: true, result: 'x'.repeat(300) + '429' }), stderr: '', exitCode: 1 });
  await expect(review()).rejects.toMatchObject({ kind: 'unavailable' });
});
