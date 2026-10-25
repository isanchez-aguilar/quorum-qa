import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { isSensitiveChunk } from '../../src/cascade/sensitive.js';
import { checksWorktreePath, pathLengthCheck } from '../../src/worktree/paths.js';
import { cleanupWorktree } from '../../src/worktree/cleanup.js';
import { checkEvidence, summarizeCheckOutput } from '../../src/checks/output.js';
import { cacheKey, type ReviewCache } from '../../src/storage/index.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { generateMarkdownReport, type ReviewResult } from '../../src/reporters/index.js';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { createExecutionPlan, formatDryRun } from '../../src/cascade/planner.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';
import type { CommandRunner } from '../../src/types/index.js';

it.each(['billing', 'payment', 'charge', 'refund', 'price', 'invoice', 'webhook', 'lock', 'getPayment', 'LOCK_ID', 'PaymentService'])('matches money identifier %s', term => {
  expect(isSensitiveChunk(`+ const ${term} = 1;`, [], ['money'])).toBe(true);
});
it.each(['auth', 'token', 'session', 'role', 'permission', 'sessionToken'])('matches auth/permission identifier %s', term => {
  expect(isSensitiveChunk('', [`src/${term}.ts`], ['permissions'])).toBe(true);
});
it.each(['payments', 'refunds', 'webhooks', 'locks', 'invoices', 'charges'])('matches plural money identifier %s', term => {
  expect(isSensitiveChunk(`+ const ${term} = [];`, [], ['money'])).toBe(true);
});
it.each(['tokens', 'roles', 'permissions', 'authorization', 'authorize', 'authenticate', 'isAuthenticated', 'authorisedUser'])('matches auth form %s', term => {
  expect(isSensitiveChunk(`+ ${term}();`, [], ['auth'])).toBe(true);
});
it.each(['author', 'authors', 'authority', 'clock', 'blocked', 'tokenize', 'pricey', 'locksmith'])('rejects substring %s', term => {
  expect(isSensitiveChunk(term, [`src/${term}.ts`], ['money', 'auth', 'permissions'])).toBe(false);
});
it('honors custom and empty focus lists', () => {
  expect(isSensitiveChunk('CACHE_KEY', [], ['cache'])).toBe(true);
  expect(isSensitiveChunk('payment', [], ['auth'])).toBe(false);
  expect(isSensitiveChunk('payment', [], [])).toBe(false);
});

it('chooses Windows paths by length independently of host platform', () => {
  const short = checksWorktreePath('C:\\repo', 'C:\\Users\\tester', 'a'.repeat(36), 'win32');
  expect(short.short).toBe(false);
  const long = checksWorktreePath('C:\\' + 'x'.repeat(150), 'C:\\Users\\tester', 'a'.repeat(36), 'win32');
  expect(long.location).toBe('C:\\Users\\tester\\.quorum\\wt\\aaaaaaaa');
  expect(long.warning).toBeUndefined();
  expect(checksWorktreePath('C:\\' + 'x'.repeat(150), 'C:\\' + 'y'.repeat(150), 'a'.repeat(36), 'win32').warning).toContain('length');
  expect(checksWorktreePath('/' + 'x'.repeat(200), '/home/tester', 'id', 'linux').short).toBe(false);
  expect(pathLengthCheck('C:\\' + 'x'.repeat(150), 'win32', 'false')).toMatchObject({ status: 'WARN', fix: expect.stringContaining('git config core.longpaths true') });
  expect(pathLengthCheck('C:\\' + 'x'.repeat(150), 'win32', 'true\n').status).toBe('PASS');
  const overhead = path.win32.join('C:\\', '.quorum', 'worktrees', 'a'.repeat(36)).length;
  const threshold = 'C:\\' + 'x'.repeat(109 - overhead);
  expect(checksWorktreePath(threshold, 'C:\\Users\\tester', 'a'.repeat(36), 'win32').short).toBe(false);
  expect(checksWorktreePath(threshold + 'x', 'C:\\Users\\tester', 'a'.repeat(36), 'win32').short).toBe(true);
});

it('prioritizes early failures, collapses progress and preserves UTF-8 within the cap', () => {
  const output = 'not ok 9 - payment fails\nFAIL suite\n✗ test\n× another\nError: broken\nerror TS1234: invalid\nERR_TEST\n'
    + Array.from({ length: 500 }, (_, i) => `Progress: resolved ${i}\nordinary ${i} 😀`).join('\n') + '\nEND';
  const summary = summarizeCheckOutput(output, true);
  expect(summary.startsWith('not ok 9 - payment fails')).toBe(true);
  for (const marker of ['FAIL suite', '✗ test', '× another', 'Error: broken', 'error TS1234', 'ERR_TEST']) expect(summary).toContain(marker);
  expect(summary.match(/Progress:/g)).toHaveLength(1);
  expect(summary.endsWith('END')).toBe(true);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(4096);
  expect(summary).not.toContain('\ufffd');
  expect(summarizeCheckOutput('old\rnew\rfinal\npassed', false)).toBe('final\npassed');
  expect(summarizeCheckOutput('old\rnew\rfinal\r', false)).toBe('final');
  expect(summarizeCheckOutput('line\n'.repeat(300), false).split('\n')).toHaveLength(8);
});

let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-trial-')); await writeFile(path.join(root, 'sample.ts'), source); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['slow', 'failed', 'timeout'] as const)('prunes even after a %s filesystem remover', async kind => {
  const parent = path.join(root, kind); await mkdir(parent);
  const location = path.join(parent, 'tree'); await mkdir(location);
  const commands: string[][] = [];
  const runner: CommandRunner = async (_file, args) => {
    commands.push(args);
    if (args.includes('remove')) throw new Error('synthetic git removal failure');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const remove: typeof rm = async (file, options) => {
    expect(options).toMatchObject({ recursive: true, force: true, maxRetries: 10 });
    if (kind === 'failed') throw new Error('busy');
    await new Promise(resolve => setTimeout(resolve, 30));
    await rm(file, options);
  };
  const cleaning = cleanupWorktree(root, parent, location, runner, { remove, timeoutMs: kind === 'timeout' ? 1 : 1000 });
  if (kind === 'slow') await cleaning;
  else await expect(cleaning).rejects.toThrow();
  expect(commands.some(args => args.includes('prune') && args.includes('now'))).toBe(true);
  if (kind === 'timeout') {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(commands.filter(args => args.includes('prune')).length).toBe(2);
  }
});
it('refuses cleanup outside its root before touching filesystem or Git', async () => {
  const runner = vi.fn<CommandRunner>(); const remove = vi.fn<typeof rm>();
  await expect(cleanupWorktree(root, path.join(root, 'wt'), path.join(root, 'outside'), runner, { remove })).rejects.toThrow('inside its root');
  expect(remove).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
});

function config(extra = {}) { return validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['claude:sonnet', 'agy:pro'], confirm: ['codex'], visual: [] }, ...extra }); }
function sensitiveContext() { const ctx = context(root); ctx.diff += '+// payment\n'; return ctx; }
function pool(first = '[]', second = '[]') {
  return new Map([
    ['agy', new FakeProvider('agy', 'google', originRunner(root), { flash: [first], pro: ['[]'] })],
    ['claude', new FakeProvider('claude', 'anthropic', originRunner(root), { sonnet: [second] })],
  ]);
}
it('reviews empty sensitive triage independently and reports coverage and families', async () => {
  const providers = pool();
  const result = await runCascade(sensitiveContext(), config(), providers, { catalog, gitRunner: originRunner(root) });
  expect(result.calls.map(call => [call.tier, call.model])).toEqual([['triage', 'flash'], ['review', 'sonnet']]);
  expect(result.coverage).toMatchObject({ sensitiveChunks: 1, sensitiveSecondPasses: 1, complete: true });
  expect(result.reviewedFamilies).toEqual(['google', 'anthropic']);
});
it('borrows a confirm-tier model from another family when review offers only the triage family', async () => {
  const providers = new Map([
    ['agy', new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'], pro: ['[]'] })],
    ['codex', new FakeProvider('codex', 'openai', originRunner(root), { codex: ['[]'] })],
  ]);
  const cfg = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
  const result = await runCascade(sensitiveContext(), cfg, providers, { catalog, gitRunner: originRunner(root) });
  expect(result.calls.map(call => [call.tier, call.model])).toEqual([['triage', 'flash'], ['confirm', 'codex']]);
  expect(result.coverage).toMatchObject({ sensitiveChunks: 1, sensitiveSecondPasses: 1 });
  expect(result.reviewedFamilies).toEqual(['google', 'openai']);
  expect(result.warnings.join('\n')).not.toContain('Independence rule cannot be met');
});
it('falls back to the same family, with a warning, when no other family is configured', async () => {
  const providers = new Map([['agy', new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'], pro: ['[]'] })]]);
  const cfg = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] } });
  const result = await runCascade(sensitiveContext(), cfg, providers, { catalog, gitRunner: originRunner(root) });
  expect(result.calls.map(call => [call.tier, call.model])).toEqual([['triage', 'flash'], ['review', 'pro']]);
  expect(result.warnings.join('\n')).toContain('Independence rule cannot be met');
});
it('uses verifier survivors, validates second-pass findings and dedupes them', async () => {
  const providers = pool(JSON.stringify([finding({ evidence_quote: 'invented' })]), JSON.stringify([finding(), finding()]));
  const result = await runCascade(sensitiveContext(), config(), providers, { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.sensitiveSecondPasses).toBe(1);
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.verified).toBe(true);
});
it('does not buy a second pass for surviving triage findings', async () => {
  const result = await runCascade(sensitiveContext(), config({ escalate: { confirmImportant: false } }), pool(JSON.stringify([finding()])), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.sensitiveSecondPasses).toBe(0);
  expect(result.calls).toHaveLength(1);
});
it('honors disabling and preserves reserve without making coverage incomplete', async () => {
  for (const extra of [{ escalate: { sensitiveSecondPass: false } }, { budget: { maxCalls: 2 } }]) {
    const result = await runCascade(sensitiveContext(), config(extra), pool(), { catalog, gitRunner: originRunner(root) });
    expect(result.calls).toHaveLength(1);
    expect(result.coverage).toMatchObject({ complete: true, sensitiveSecondPasses: 0 });
    if ('budget' in extra) expect(result.warnings).toContain('1 sensitive chunks got no second review: budget');
  }
  expect(config().escalate.sensitiveSecondPass).toBe(true);
  expect(() => config({ escalate: { sensitiveSecondPass: 'yes' } })).toThrow('must be a boolean');
});
it('dry-run lists only supplied payloads and shows the sensitive option', () => {
  const ctx = context(root); ctx.mode = 'general';
  let plan = formatDryRun(createExecutionPlan(ctx, config(), catalog));
  expect(plan).toContain('Payload: surgical diff (');
  expect(plan).not.toContain('+ supplied');
  expect(plan).toContain('sensitiveSecondPass: true');
  ctx.mode = 'feature'; ctx.specContent = '- [ ] Synthetic acceptance';
  plan = formatDryRun(createExecutionPlan(ctx, config(), catalog));
  expect(plan).toContain('Payload: surgical diff + supplied spec (');
  expect(plan).not.toContain('supplied inventory');
});

it('reuses exact prompt/model cache without spending the confirmation reserve', async () => {
  const ctx = sensitiveContext(); const prompt = reviewChunks(ctx).chunks[0]!.prompt;
  const key = cacheKey(prompt, prompt, 'claude:sonnet');
  const cache: ReviewCache = { read: async value => value === key ? '[]' : undefined, stage: () => {} };
  const result = await runCascade(ctx, config({ budget: { maxCalls: 2 } }), pool(), { catalog, gitRunner: originRunner(root), cache });
  expect(result.calls).toHaveLength(1);
  expect(result.cacheHits).toBe(1);
  expect(result.coverage.sensitiveSecondPasses).toBe(1);
  const changed = { ...ctx, diff: ctx.diff + '+// different input\n' };
  const miss = await runCascade(changed, config({ budget: { maxCalls: 2 } }), pool(), { catalog, gitRunner: originRunner(root), cache });
  expect(miss.cacheHits).toBe(0);
  expect(miss.coverage.sensitiveSecondPasses).toBe(0);
});

it('falls back through the review route and keeps the author family rule', async () => {
  const providers = pool();
  providers.set('claude', new FakeProvider('claude', 'anthropic', originRunner(root), { sonnet: [{ error: 'unavailable' }] }));
  // Registered so that only the author rule, not a missing provider, keeps codex out.
  providers.set('codex', new FakeProvider('codex', 'openai', originRunner(root), { codex: ['[]'] }));
  const ctx = sensitiveContext(); ctx.authorFamily = 'openai';
  const result = await runCascade(ctx, config(), providers, { catalog, gitRunner: originRunner(root) });
  expect(result.calls.map(call => call.model)).toEqual(['flash', 'sonnet', 'pro']);
  expect(result.coverage.sensitiveSecondPasses).toBe(1);
  expect(result.reviewedFamilies).toEqual(['google']);
  expect(result.warnings.some(warning => warning.includes('Independence'))).toBe(true);
});

it('never borrows a confirm-tier model from the author family', async () => {
  const providers = new Map([
    ['agy', new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'], pro: ['[]'] })],
    ['codex', new FakeProvider('codex', 'openai', originRunner(root), { codex: ['[]'] })],
  ]);
  const cfg = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
  const ctx = sensitiveContext(); ctx.authorFamily = 'openai';
  const result = await runCascade(ctx, cfg, providers, { catalog, gitRunner: originRunner(root) });
  expect(result.calls.map(call => call.model)).toEqual(['flash', 'pro']);
});

it('leaves no independence warning when the confirm route meets the rule', async () => {
  const providers = new Map([
    ['agy', new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'] })],
    ['claude', new FakeProvider('claude', 'anthropic', originRunner(root), { sonnet: ['[]'] })],
    ['codex', new FakeProvider('codex', 'openai', originRunner(root), { codex: ['[]'] })],
  ]);
  const cfg = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['claude:sonnet'], confirm: ['codex'], visual: [] } });
  const ctx = sensitiveContext(); ctx.authorFamily = 'anthropic';
  const result = await runCascade(ctx, cfg, providers, { catalog, gitRunner: originRunner(root) });
  expect(result.calls.map(call => call.model)).toEqual(['flash', 'codex']);
  expect(result.warnings.join('\n')).not.toContain('Independence rule cannot be met');
});

it('treats a singular permission focus like permissions', () => {
  expect(isSensitiveChunk('+ authorize(user);', [], ['permission'])).toBe(true);
});

it('retains all check statuses in valid bounded model evidence and Markdown', async () => {
  const checks = Array.from({ length: 3 }, (_, index) => ({ argv: ['synthetic', String(index)], exitCode: index + 1,
    timedOut: index === 2, timeoutMs: 1000, durationMs: 1,
    stdoutTail: 'not ok 1 - synthetic\n' + 'x'.repeat(4000), stderrTail: 'Error: synthetic\n' + 'y'.repeat(4000) }));
  const evidence = checkEvidence(checks);
  expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(8192);
  expect(JSON.parse(evidence).map((row: { exitCode: number }) => row.exitCode)).toEqual([1, 2, 3]);
  expect(evidence).toContain('TIMED OUT');
  const cascade = await runCascade(sensitiveContext(), config(), pool(), { catalog, gitRunner: originRunner(root) });
  const result: ReviewResult = { ...cascade, checks: { passed: false, results: checks }, ruleChecks: null,
    criteria: [], inventory: [], families: cascade.reviewedFamilies, runId: 'synthetic', timestamp: new Date(0).toISOString(), mode: 'general', range: 'a...b', headSha: 'b', baseSha: 'a', exitCode: 0 };
  const report = generateMarkdownReport(result);
  expect(report).toContain('Sensitive chunks: 1; second passes: 1');
  expect(report).toContain('TIMED OUT after 1s (exit 3)');
  expect(report).toContain('anthropic');
  expect(JSON.parse(JSON.stringify(result)).coverage.sensitiveSecondPasses).toBe(1);
});

it('counts a successful mandatory local review once and does not retry failed local review optionally', async () => {
  for (const output of ['[]', 'not JSON']) {
    const providers = new Map([
      ['qwen', new FakeProvider('qwen', 'local', originRunner(root), { qwen: ['[]'] })],
      ['claude', new FakeProvider('claude', 'anthropic', originRunner(root), { sonnet: [output, '[]'] })],
    ]);
    const result = await runCascade(sensitiveContext(), config({ tiers: { triage: ['qwen'], review: ['claude:sonnet'], confirm: [], visual: [] } }),
      providers, { catalog, gitRunner: originRunner(root) });
    expect(providers.get('claude')!.calls).toHaveLength(1);
    expect(result.coverage.sensitiveSecondPasses).toBe(output === '[]' ? 1 : 0);
    expect(result.coverage.complete).toBe(output === '[]');
  }
});

it('defers late prune through the creation lock hook', async () => {
  const parent = path.join(root, 'late-lock'); await mkdir(parent);
  const location = path.join(parent, 'tree'); await mkdir(location);
  let finishRemoval!: () => void; let releaseCreation!: () => void;
  const removal = new Promise<void>(resolve => { finishRemoval = resolve; });
  const creation = new Promise<void>(resolve => { releaseCreation = resolve; });
  let prunes = 0;
  const runner: CommandRunner = async (_file, args) => {
    if (args.includes('prune')) prunes++;
    return { exitCode: args.includes('remove') ? 1 : 0, stdout: '', stderr: 'synthetic' };
  };
  const latePrune = vi.fn(async (action: () => Promise<void>) => { await creation; await action(); });
  await expect(cleanupWorktree(root, parent, location, runner, {
    timeoutMs: 1, remove: async (file, options) => { await removal; await rm(file, options); }, latePrune,
  })).rejects.toThrow('timed out');
  expect(prunes).toBe(1);
  finishRemoval();
  await vi.waitFor(() => expect(latePrune).toHaveBeenCalledOnce());
  expect(prunes).toBe(1);
  releaseCreation();
  await vi.waitFor(() => expect(prunes).toBe(2));
});
