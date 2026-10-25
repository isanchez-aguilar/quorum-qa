import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgyProvider, parseAgyQuota, AGY_NO_TOOLS } from '../../src/providers/agy.js';
import { CodexProvider } from '../../src/providers/codex.js';
import { DEFAULT_CATALOG } from '../../src/catalog/index.js';
import { agyQuotaGroup } from '../../src/catalog/agy-groups.js';
import { extractJson, isRecord, parseFindings, parseReproductionProposal } from '../../src/cascade/parse.js';
import { AGY_SCHEMAS, validStructuredOutput } from '../../src/providers/schemas.js';
import { CommandTimeoutError, CommandOutputLimitError } from '../../src/process/runner.js';
import type { CommandRunner, ReviewContext } from '../../src/types/index.js';

const envelope = await readFile(new URL('../fixtures/providers/agy-print-json.json', import.meta.url), 'utf8');
const usage = await readFile(new URL('../fixtures/providers/agy-usage.json', import.meta.url), 'utf8');
let root: string;
let context: ReviewContext;
let calls: Array<{ command: string; args: string[]; options: Parameters<CommandRunner>[2] }>;
let answer: CommandRunner;
let dirty = false;
const runner: CommandRunner = async (command, args, options) => {
  calls.push({ command, args, options });
  if (/git(?:\.exe)?$/i.test(command)) return { stdout: args.includes('--show-toplevel') ? root : args.includes('status') && dirty ? '?? changed.txt\n' : '', stderr: '', exitCode: 0 };
  return answer(command, args, options);
};
const settings = () => ({ runner, platform: 'linux' as const, env: { PATH: '/synthetic/bin' }, exists: () => true });
const success = (stdout: string, exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-adapter-test-'));
  context = { worktreeRoot: root, baseCommit: 'abc123', headCommit: 'def456', mode: 'feature', diff: '', touchedFiles: [] };
  calls = []; dirty = false; answer = async () => success(envelope);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const providerCalls = () => calls.filter(call => !/git(?:\.exe)?$/i.test(call.command));

describe('structured agy answers', () => {
  const valid = { severity: 'IMPORTANT', origin: 'introduced', file: 'a.ts', line: 1,
    trigger: 'input', impact: 'failure', evidence_quote: 'return a/b', fix: 'guard', confidence: .8 };
  it.each(['review', 'confirm', 'adjudicate', 'reproduce'] as const)('passes an object schema for %s and prefers valid structured output', async purpose => {
    const structured = purpose === 'review' ? { findings: [valid] } : purpose === 'confirm' ? { decision: 'reject' }
      : purpose === 'adjudicate' ? { same: true } : { path: 'a.test.ts', content: 'test', expect: 'failure' };
    answer = async () => success(JSON.stringify({ status: 'SUCCESS', structured_output: structured, response: 'not JSON' }));
    const result = await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000, purpose });
    expect(JSON.parse(result.rawOutput)).toEqual(structured);
    const args = providerCalls()[0]!.args;
    expect(args).toContain('--print=Do not call any tools: no file reads and no commands. Everything you need is in this prompt; answer only with the JSON.\np');
    expect(args).toContain('--json-schema');
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!);
    expect(schema).toEqual(AGY_SCHEMAS[purpose]);
    expect(schema.type).toBe('object');
    expect(schema.required).toContain(Object.keys(structured)[0]);
    if (purpose === 'review') expect(Object.keys(schema.properties.findings.items.properties)).toEqual(Object.keys(valid));
    if (purpose === 'review') expect(parseFindings(result.rawOutput, DEFAULT_CATALOG[0]!).findings).toHaveLength(1);
    if (purpose === 'confirm') expect(extractJson(result.rawOutput, value => isRecord(value) && value.decision === 'reject')).toEqual(structured);
    if (purpose === 'adjudicate') expect(extractJson(result.rawOutput, value => isRecord(value) && typeof value.same === 'boolean')).toEqual(structured);
    if (purpose === 'reproduce') expect(parseReproductionProposal(result.rawOutput)).toMatchObject(structured);
  });
  it('retains the recorded partial probe fixture and falls back without inventing fields', async () => {
    const fixture = await readFile(new URL('../fixtures/providers/agy-print-json-schema.json', import.meta.url), 'utf8');
    const recorded = JSON.parse(fixture);
    expect(recorded.num_turns).toBe(1);
    expect(recorded.duration_seconds).toBeLessThan(7);
    expect(validStructuredOutput(recorded.structured_output, 'review')).toBe(false);
    answer = async () => success(fixture);
    const result = await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 });
    expect(result.rawOutput).toBe(recorded.response);
    expect(parseFindings(result.rawOutput, DEFAULT_CATALOG[0]!).error).toBe('All findings were invalid');
  });
  it('never trusts provider metadata in structured findings', async () => {
    answer = async () => success(JSON.stringify({ status: 'SUCCESS', structured_output: { findings: [{ ...valid, provider: 'spoof', model: 'spoof', family: 'local' }] } }));
    const result = await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 });
    const entry = DEFAULT_CATALOG.find(item => item.provider === 'agy')!;
    expect(parseFindings(result.rawOutput, entry).findings[0]).toMatchObject({ provider: entry.provider, model: entry.id, family: entry.family });
  });
  it.each([
    { purpose: 'confirm', invalid: { decision: 'confirm' }, fallback: { decision: 'reject' } },
    { purpose: 'confirm', invalid: { decision: 'confirm', evidence_quote: ' ' }, fallback: { decision: 'reject' } },
    { purpose: 'confirm', invalid: { decision: 'confirm', evidence_quote: 'code', reproduction: {} }, fallback: { decision: 'reject' } },
    { purpose: 'adjudicate', invalid: { same: 'true' }, fallback: { same: false } },
    { purpose: 'reproduce', invalid: { path: 'test', content: '', expect: 'x' }, fallback: { path: 'test', content: 'test', expect: 'x' } },
  ] as const)('falls back for invalid $purpose payload', async ({ purpose, invalid, fallback }) => {
    answer = async () => success(JSON.stringify({ status: 'SUCCESS', structured_output: invalid, response: JSON.stringify(fallback) }));
    const result = await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000, purpose });
    expect(JSON.parse(result.rawOutput)).toEqual(fallback);
  });
  it.each([null, [], {}, { findings: [{ file: 'missing fields' }] }])('falls back from invalid structured output %j', async structured_output => {
    answer = async () => success(JSON.stringify({ status: 'SUCCESS', structured_output, response: '[]' }));
    expect((await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rawOutput).toBe('[]');
  });
  it('falls back when an extra reproduction field fails the finding parser', async () => {
    answer = async () => success(JSON.stringify({ status: 'SUCCESS', structured_output: { findings: [{ ...valid, reproduction: {} }] }, response: '[]' }));
    expect((await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rawOutput).toBe('[]');
  });
  it.each([0, 1000])('drops only schema when Windows argv with resolved path is too long (%s)', async extra => {
    const warnings: string[] = []; const prompt = 'x'.repeat(29400 - extra);
    await new AgyProvider({ ...settings(), platform: 'win32', env: { PATH: 'C:\\' + 'a'.repeat(extra), PATHEXT: '.EXE' } })
      .executeReview(context, 'model', prompt, { deadlineMs: 5000, warn: message => warnings.push(message) });
    expect(providerCalls()[0]!.args).toContain('--print=' + AGY_NO_TOOLS + '\n' + prompt);
    expect(providerCalls()[0]!.args).not.toContain('--json-schema');
    expect(warnings.join()).toMatch(/schema.*Windows/);
  });
});

describe('agy adapter', () => {
  it('uses recorded response, tokens, worktree cwd, argument prompt and bounded timeout', async () => {
    const result = await new AgyProvider({ ...settings(), now: () => 100 }).executeReview(context, 'gemini-3.8-flash-medium', 'read only', { deadlineMs: 4200 });
    expect(result).toMatchObject({ rawOutput: '[]\n', worktreeClean: true, tokensUsed: { prompt: 12774, completion: 1 } });
    const call = providerCalls()[0]!;
    expect(call.args).toEqual(['--model', 'gemini-3.8-flash-medium', '--sandbox', '--output-format', 'json', '--print-timeout', '4s', '--print=' + AGY_NO_TOOLS + '\nread only', '--json-schema', expect.any(String)]);
    expect(call.options?.cwd).toContain(path.join('.quorum', 'worktrees'));
    expect(call.options?.stdin).toBeUndefined();
    expect(call.options?.timeoutMs).toBe(4200);
    expect(calls.some(call => call.args.includes('prune'))).toBe(true);
  });
  it('uses at least one timeout second and reports dirty trees', async () => {
    dirty = true;
    expect((await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 900 })).worktreeClean).toBe(false);
    expect(providerCalls()[0]!.args).toContain('1s');
  });
  it.each(['RESOURCE_EXHAUSTED', 'QuOtA', '429', 'RATE LIMIT'])('maps %s to quota errors and cleans up', async text => {
    answer = async () => success('', 1, text);
    await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'quota' });
    expect(calls.some(call => call.args.includes('remove'))).toBe(true);
  });
  it.each([success('{}'), success('not json'), success('{"status":"FAILED","response":"[]"}'), success(envelope, 1)])('rejects unsuccessful envelopes', async response => {
    answer = async () => response;
    await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('refuses oversized Windows argv without inference', async () => {
    await expect(new AgyProvider({ ...settings(), platform: 'win32' }).executeReview(context, 'model', 'x'.repeat(30000), { deadlineMs: 5000 })).rejects.toThrow('30,000');
    expect(providerCalls()).toHaveLength(0);
  });
  it('parses model TSV and gets usage without adding MSYS variables', async () => {
    answer = async (_command, args) => success(args.includes('models') ? 'Fetching available models...\nmodel-a\tModel A\nmodel-b\tModel B\n' : usage);
    const adapter = new AgyProvider(settings());
    expect(await adapter.listModels()).toEqual(['model-a', 'model-b']);
    expect(await adapter.getQuota('gpt-oss-120b-medium')).toMatchObject({ group: 'agy:anthropic', remainingPercent: 0 });
    expect(providerCalls()[1]!.args).toContain('--print=/usage');
    expect(providerCalls()[1]!.options?.env).not.toHaveProperty('MSYS_NO_PATHCONV');
  });
  it('returns unknown quota and failed discovery when commands fail', async () => {
    answer = async () => success('', 1);
    const adapter = new AgyProvider(settings());
    expect(await adapter.getQuota('model')).toBe('unknown');
    await expect(adapter.listModels()).rejects.toThrow();
  });
});

describe('quota mapping', () => {
  it('uses binding buckets and shared Claude/GPT description mapping', () => {
    expect(parseAgyQuota(usage, 'gemini-3.8-flash-medium')).toMatchObject({ remainingPercent: 99.96805191040039, resetTime: '2026-10-19T15:42:40Z' });
    for (const model of ['claude-sonnet-5-5-high', 'claude-opus-5-5-low', 'gpt-oss-120b-medium']) {
      expect(parseAgyQuota(usage, model)).toEqual({ group: 'agy:anthropic', remainingPercent: 0, resetTime: '2026-10-22T02:43:58Z' });
    }
    expect(new Set(DEFAULT_CATALOG.filter(item => item.provider === 'agy' && /claude|gpt-oss/.test(item.id)).map(item => item.quotaGroup)).size).toBe(1);
  });
  it('ignores text-disabled buckets and chooses earliest tied reset regardless of ids', () => {
    const data = JSON.parse(usage);
    const group = data.command.data.groups[1];
    group.buckets = [{ id: 'new-id', name: 'Weekly Limit Remaining', remaining_fraction: .2, reset_time: '2026-11-01' },
      { name: 'Other', remaining_fraction: .2, reset_time: '2026-10-25' },
      { name: 'Five Hour Limit Remaining', remaining_fraction: 0 }];
    expect(parseAgyQuota(JSON.stringify(data), 'gpt-oss-120b-medium')).toEqual({ group: 'agy:anthropic', remainingPercent: 20, resetTime: '2026-10-25' });
  });
  it.each(['{}', 'invalid', '{"status":"FAILED"}'])('fails closed to unknown for %s', text => expect(parseAgyQuota(text, 'gpt-oss-120b-medium')).toBe('unknown'));
});

describe('codex adapter', () => {
  it('sends stdin in read-only worktree, reads final file, deletes temp files', async () => {
    let outfile = '';
    answer = async (_command, args) => { outfile = args[args.indexOf('-o') + 1]!; await writeFile(outfile, '[]'); return success('events'); };
    expect(await new CodexProvider(settings()).executeReview(context, 'codex', 'prompt', { deadlineMs: 5000 })).toMatchObject({ rawOutput: '[]', worktreeClean: true });
    const call = providerCalls()[0]!;
    expect(call.args).toEqual(['exec', '-C', call.options!.cwd!, '-s', 'read-only', '-o', outfile, '-']);
    expect(call.options!.stdin).toBe('prompt');
    expect(path.relative(tmpdir(), outfile)).not.toMatch(/^\.\./);
    await expect(access(outfile)).rejects.toThrow();
  });
  it.each([false, true])('retries missing/empty output once, charging budget (empty=%s)', async empty => {
    let attempts = 0; let charges = 0;
    answer = async (_command, args) => {
      const outfile = args[args.indexOf('-o') + 1]!;
      if (++attempts === 1) { if (empty) await writeFile(outfile, ''); return success('', 1); }
      await writeFile(outfile, '[]'); return success('');
    };
    await new CodexProvider(settings()).executeReview(context, 'codex', 'p', { deadlineMs: 5000, reserveRetry: () => { charges++; return true; } });
    expect(attempts).toBe(2); expect(charges).toBe(1);
  });
  it('never retries twice and cleans temp directory on failure', async () => {
    let outfile = '';
    answer = async (_command, args) => { outfile = args[args.indexOf('-o') + 1]!; return success('', 1); };
    await expect(new CodexProvider(settings()).executeReview(context, 'codex', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(providerCalls()).toHaveLength(2);
    await expect(access(path.dirname(outfile))).rejects.toThrow();
  });
  it('does not retry after exhausted budget', async () => {
    answer = async () => success('', 1);
    await expect(new CodexProvider(settings()).executeReview(context, 'codex', 'p', { deadlineMs: 5000, reserveRetry: () => false })).rejects.toThrow('budget');
    expect(providerCalls()).toHaveLength(1);
  });
  it.each([success('', 1, '429'), success('', 1, 'quota exhausted')])('maps quota without retry', async response => {
    answer = async () => response;
    await expect(new CodexProvider(settings()).executeReview(context, 'codex', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'quota' });
    expect(providerCalls()).toHaveLength(1);
  });
  it('does not retry nonempty failing output or successful empty output', async () => {
    answer = async (_command, args) => { await writeFile(args[args.indexOf('-o') + 1]!, 'partial'); return success('', 1); };
    await expect(new CodexProvider(settings()).executeReview(context, 'codex', 'p', { deadlineMs: 5000 })).rejects.toThrow();
    expect(providerCalls()).toHaveLength(1);
  });
  it('reports dirty output and unknown quota', async () => {
    dirty = true; answer = async () => success('', 1);
    const adapter = new CodexProvider(settings());
    expect((await adapter.executeReview(context, 'codex', 'p', { deadlineMs: 5000 })).worktreeClean).toBe(false);
    expect(providerCalls()).toHaveLength(1);
    expect(await adapter.getQuota('codex')).toBe('unknown');
  });
});

it('includes resolved executable path in Windows argv limit', async () => {
  const adapter = new AgyProvider({ ...settings(), platform: 'win32', env: { PATH: 'C:\\' + 'a'.repeat(1500), PATHEXT: '.EXE' } });
  await expect(adapter.executeReview(context, 'model', 'x'.repeat(29000), { deadlineMs: 5000 })).rejects.toThrow('30,000');
  expect(providerCalls()).toHaveLength(0);
});

it('subtracts worktree preparation time from agy deadline', async () => {
  let clock = 0;
  const delayedRunner: CommandRunner = async (command, args, options) => {
    if (args.includes('add')) clock += 1500;
    return runner(command, args, options);
  };
  await new AgyProvider({ ...settings(), runner: delayedRunner, now: () => clock }).executeReview(context, 'model', 'p', { deadlineMs: 5000 });
  expect(providerCalls()[0]!.args).toContain('3s');
  expect(providerCalls()[0]!.options?.timeoutMs).toBe(3500);
});

it('does not retry codex after the deadline expires', async () => {
  let clock = 0;
  answer = async () => { clock = 5001; return success('', 1); };
  await expect(new CodexProvider({ ...settings(), now: () => clock }).executeReview(context, 'codex', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'timeout' });
  expect(providerCalls()).toHaveLength(1);
});

it('rejects an already aborted review without creating a worktree', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000, signal: controller.signal })).rejects.toMatchObject({ kind: 'timeout' });
  expect(calls).toHaveLength(0);
});

describe('M4 regressions', () => {
  it.each(['exit', 'timeout', 'overflow'].flatMap(kind => ['\n', '\r\n'].map(newline => ({ kind, newline }))))('ignores Codex echoed prompt quota text on $kind failure ($newline)', async ({ kind, newline }) => {
    const prompt = 'Review quota exhaustion\nERROR quota is a test fixture\nReturn JSON';
    answer = async () => {
      const stderr = `user\n${prompt}\nERROR: executable unavailable`.replace(/\n/g, newline);
      if (kind === 'timeout') throw new CommandTimeoutError('', stderr);
      if (kind === 'overflow') throw new CommandOutputLimitError('', stderr, '', stderr, 1);
      return success('', 1, stderr);
    };
    await expect(new CodexProvider(settings()).executeReview(context, 'model', prompt, { deadlineMs: 5000 })).rejects.toMatchObject({ kind: kind === 'timeout' ? 'timeout' : 'unavailable' });
  });
  it('recognizes genuine Codex quota after the prompt echo', async () => {
    answer = async () => success('', 1, 'user\nReview quota fixtures\nERROR: quota exceeded');
    await expect(new CodexProvider(settings()).executeReview(context, 'model', 'Review quota fixtures', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'quota' });
  });
  it.each(['agy', 'codex'])('warns without failing a successful %s call when cleanup fails', async provider => {
    const warnings: string[] = [];
    let removing = false;
    const locked: CommandRunner = async (command, args, options) => {
      if (args.includes('remove')) removing = true;
      return removing && (args.includes('remove') || args.includes('prune')) ? success('', 1, 'locked') : runner(command, args, options);
    };
    answer = async (_command, args) => {
      if (provider === 'codex') await writeFile(args[args.indexOf('-o') + 1]!, '[]');
      return success(envelope);
    };
    const adapter = provider === 'agy' ? new AgyProvider({ ...settings(), runner: locked }) : new CodexProvider({ ...settings(), runner: locked });
    expect((await adapter.executeReview(context, 'model', 'p', { deadlineMs: 5000, warn: message => warnings.push(message) })).worktreeClean).toBe(true);
    expect(warnings.join()).toContain('locked');
  });
  it.each(['quota', 'HTTP 429 looks fine', '[]'])('accepts SUCCESS %s and token count 14290', async response => {
    answer = async () => success(JSON.stringify({ status: 'SUCCESS', response, usage: { input_tokens: 14290, output_tokens: 1 } }));
    expect((await new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rawOutput).toBe(response);
  });
  it('accepts Codex success with quota in prompt echo and output', async () => {
    answer = async (_command, args) => { await writeFile(args[args.indexOf('-o') + 1]!, 'quota 429'); return success('14290', 0, 'prompt: quota'); };
    expect((await new CodexProvider(settings()).executeReview(context, 'codex', 'p', { deadlineMs: 5000 })).rawOutput).toBe('quota 429');
  });
  it.each(['agy', 'codex'])('ignores quota in %s failed model output', async provider => {
    answer = async (_command, args) => {
      if (provider === 'codex') await writeFile(args[args.indexOf('-o') + 1]!, 'quota 429');
      return success(JSON.stringify({ status: 'FAILED', response: 'quota 429' }), 1);
    };
    const adapter = provider === 'agy' ? new AgyProvider(settings()) : new CodexProvider(settings());
    await expect(adapter.executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('recognizes failed envelope error fields', async () => {
    answer = async () => success(JSON.stringify({ status: 'FAILED', error: { message: 'RESOURCE_EXHAUSTED' } }));
    await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'quota' });
  });
  it('requires word boundaries in failed stderr', async () => {
    answer = async () => success('', 1, '14290 quotaStatus abc429def');
    await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it.each(['agy', 'codex'])('preserves %s error with cleanup warning', async provider => {
    answer = async () => { throw new CommandTimeoutError('', ''); };
    let removing = false;
    const locked: CommandRunner = async (command, args, options) => {
      if (args.includes('remove')) removing = true;
      return removing && (args.includes('remove') || args.includes('prune')) ? success('', 1, 'locked') : runner(command, args, options);
    };
    const adapter = provider === 'agy' ? new AgyProvider({ ...settings(), runner: locked }) : new CodexProvider({ ...settings(), runner: locked });
    await expect(adapter.executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'timeout', warnings: [expect.stringContaining('locked')] });
  });
  it('uses stderr only on timeout', async () => {
    answer = async () => { throw new CommandTimeoutError('quota 429', ''); };
    await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('does not classify a successful output-limit error as quota', async () => {
    answer = async () => { throw new CommandOutputLimitError('', 'prompt: quota', '', '', 0); };
    await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 })).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('matches argon before generic Gemini', () => {
    expect(agyQuotaGroup('gemini-3.8-pro-argon-high')).toBe('agy:argon');
  });
});

it.each(['required the "command" permission', 'auto-denied'])('detects empty headless agy answers: %s', async diagnostic => {
  answer = async () => success(JSON.stringify({ status: 'SUCCESS', response: '' }), 0,
    'no output produced — a tool ' + diagnostic + ' that headless mode cannot prompt for');
  await expect(new AgyProvider(settings()).executeReview(context, 'model', 'p', { deadlineMs: 5000 }))
    .rejects.toMatchObject({ kind: 'unavailable', message: 'agy tried to run a command in headless mode and returned nothing' });
});
