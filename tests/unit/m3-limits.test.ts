import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { RunBudget, BUDGET_WARNING } from '../../src/cascade/budget.js';
import { createExecutionPlan } from '../../src/cascade/planner.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { quotaStatus } from '../../src/catalog/groups.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-limits-'));
  await writeFile(path.join(root, 'sample.ts'), source);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const config = () => validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });

it('500 findings use at most 800 origin calls plus eight checkout checks, never the adapter runner', async () => {
  const gitRunner = vi.fn(originRunner(root));
  const providerRunner = vi.fn(originRunner(root));
  const fake = new FakeProvider('agy', 'google', providerRunner, { flash: [JSON.stringify(Array.from({ length: 500 }, () => finding()))] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, gitRunner });
  expect(gitRunner.mock.calls.length).toBeGreaterThan(0);
  expect(gitRunner.mock.calls.length).toBeLessThanOrEqual(808);
  expect(providerRunner).not.toHaveBeenCalled();
  expect(result.ledgerDraft[0]?.verifiedFindingsCount).toBe(100);
  expect(result.ledgerDraft[0]?.rejectionReasons['parse: too many findings']).toBe(400);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'too many findings', count: 400 });
}, 20_000);

it('stops verification at the deadline between findings', async () => {
  const clock = new FakeClock();
  const cfg = config();
  const gitRunner = vi.fn(async (...args: Parameters<ReturnType<typeof originRunner>>) => {
    if (args[1].includes('blame')) clock.time = cfg.budget.maxMinutes * 60_000;
    return originRunner(root)(...args);
  });
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding(), finding()])] });
  const result = await runCascade(context(root), cfg, new Map([['agy', fake]]), { catalog, gitRunner, clock });
  expect(result.ledgerDraft[0]?.verifiedFindingsCount).toBe(1);
  expect(gitRunner.mock.calls.length).toBeLessThanOrEqual(16);
  expect(result.warnings).toContain(BUDGET_WARNING);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'run deadline', file: 'sample.ts', count: 1 });
});

it('caps adjudication at 20 pairs without a confirmation boost', async () => {
  const raw = Array.from({ length: 10 }, (_, index) => finding({
    trigger: `Missing authorization condition${index}`, impact: `Protected records lose property${index}`, confidence: 0.6,
  }));
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(raw)] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [
    ...raw.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })),
    ...Array.from({ length: 30 }, () => '{"same":false}'),
  ] });
  const cfg = config();
  cfg.budget.maxCalls = 100;
  const result = await runCascade(context(root), cfg, new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(result.calls.filter(call => call.purpose === 'adjudicate')).toHaveLength(20);
  expect(result.findings).toHaveLength(10);
  expect(result.warnings).toContain('Adjudication cap reached: 25 pairs left unadjudicated.');
  expect(result.findings.every(item => item.confidence === 0.6)).toBe(true);
});

it('a same-defect merge retains the absorbed trigger and impact', async () => {
  const raw = [finding({ trigger: 'Missing authorization for deleting users', impact: 'Users lose protected records', confidence: 0.6 }),
    finding({ trigger: 'Missing audit for deleting users', impact: 'Users lose protected records', confidence: 0.6 })];
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(raw)] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [
    ...raw.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })), '{"same":true}',
  ] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.verification_note).toContain(raw[1]!.trigger);
  expect(result.findings[0]?.verification_note).toContain(raw[1]!.impact);
  expect(result.findings[0]?.confidence).toBe(0.6);
});

it('marks deadline timeout explicitly even if the clock has not advanced', async () => {
  const clock = new FakeClock();
  let fire: (() => void) | undefined;
  clock.setTimeout = callback => { fire = callback; return 1; };
  const budget = new RunBudget(config().budget, clock);
  const pending = budget.execute(() => new Promise(() => {}));
  const rejection = expect(pending).rejects.toThrow('Run deadline reached');
  fire!();
  await rejection;
  expect(budget.deadlineExceeded).toBe(true);
  expect(clock.now()).toBe(0);
});

it('old low quota is unknown and does not block planning or execution', async () => {
  const timestamp = new Date(Date.now() - 6 * 60 * 60_000 - 1).toISOString();
  const quotaSnapshot = { 'agy:google': { remainingPercent: 0, timestamp } };
  expect(quotaStatus(catalog[0]!, quotaSnapshot, 15)).toBe('unchecked');
  const plan = createExecutionPlan(context(root), config(), catalog, quotaSnapshot);
  expect(plan.tiers.triage).toHaveLength(1);
  expect(plan.quotas[0]?.remainingPercent).toBe('unknown');
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, quotaSnapshot, gitRunner: originRunner(root) });
  expect(result.calls).toHaveLength(1);
  expect(result.warnings.join(' ')).toContain('floor unchecked');
});


it('skips review payloads with no room for diff content', () => {
  const ctx = { ...context(root), diff: 'x'.repeat(40_000), specContent: 'y'.repeat(40_000) };
  expect(reviewChunks(ctx)).toEqual({ chunks: [], skippedFiles: ['sample.ts'], truncatedHunks: [], binaryFiles: [] });
});

it('caps actual confirm and adjudication prompts, removes reproduction, and truncates the hunk first', async () => {
  const large = 'untrusted '.repeat(5_000);
  const raw = [finding({ trigger: 'Missing authorization for deleting users', impact: 'Users lose protected records', confidence: 0.6, fix: large,
    reproduction: { path: 'sample.test.ts', content: 'NEVER_SEND_THIS', expect: 'failure', status: 'pending' } }),
    finding({ trigger: 'Missing audit for deleting users', impact: 'Users lose protected records', confidence: 0.6, fix: large })];
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify(raw)] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [
    ...raw.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })), '{"same":false}',
  ] });
  const ctx = context(root);
  ctx.diff += '+' + large;
  await runCascade(ctx, config(), new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(codex.calls).toHaveLength(3);
  for (const call of codex.calls) {
    expect(call.prompt.length).toBeLessThanOrEqual(24_000);
    expect(call.prompt).toContain('untrusted data');
    expect(call.prompt).toContain('[... truncated ...]');
    expect(call.prompt).not.toContain('NEVER_SEND_THIS');
    const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1));
    if (payload.hunk) expect(payload.hunk).toBe('[... truncated ...]');
    else expect(payload.hunks).toEqual(['[... truncated ...]', '[... truncated ...]']);
  }
});

it.each(['[Quorum: diff truncated at 512 KiB]', '[Quorum: command output truncated]'])('tracks upstream truncation: %s', async marker => {
  const ctx = context(root); ctx.diff += marker + '\n';
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: ['[]'] });
  const result = await runCascade(ctx, config(), new Map([['agy', fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.truncatedHunks).toContainEqual({ file: 'sample.ts', hunk: 1 });
  expect(fake.calls[0]?.prompt).not.toContain(marker);
});
it('records exhausted invalid responses', async () => {
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: ['bad'], pro: ['bad'] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'invalid response', count: 2 });
  expect(result.coverage.complete).toBe(false);
});
it('reserves four calls with 3000 files', async () => {
  const ctx = context(root);
  ctx.touchedFiles = Array.from({length: 3000}, (_, i) => 'file' + i + '.ts');
  ctx.diff = ctx.touchedFiles.map(f => 'diff --git a/'+f+' b/'+f+'\n--- a/'+f+'\n+++ b/'+f+'\n@@ -0,0 +1 @@\n+value\n').join('');
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: Array.from({length:12}, () => JSON.stringify([finding({confidence:0.6})])) });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), {codex:Array.from({length:4}, () => JSON.stringify({decision:'confirm', evidence_quote:finding().evidence_quote}))});
  const cfg = config(); cfg.budget.maxCalls = 12;
  const result = await runCascade(ctx, cfg, new Map([['agy', fake], ['codex', codex]]), { catalog, gitRunner: originRunner(root) });
  expect(result.calls.filter(c => c.tier === 'triage')).toHaveLength(8);
  expect(result.calls.filter(c => c.purpose === 'confirm')).toHaveLength(4);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.skippedFiles.length).toBeGreaterThan(0);
  expect(createExecutionPlan(ctx, cfg, catalog).confirmationReserve).toBe(4);
});
it('separates binary files', async () => {
  const ctx = {...context(root), touchedFiles:['image.png'], diff:'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n'};
  const result = await runCascade(ctx, config(), new Map(), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.binaryFiles).toEqual(['image.png']);
  expect(result.coverage.reviewedFiles).toEqual([]);
  expect(result.coverage.complete).toBe(true);
});
it('decodes quoted UTF-8 paths', () => {
  const ctx = {...context(root), touchedFiles:['other.ts', 'café.txt'], diff: String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"
--- "a/caf\303\251.txt"
+++ "b/caf\303\251.txt"
@@ -0,0 +1 @@
+value
`};
  expect(reviewChunks(ctx).chunks[0]?.files).toEqual(['café.txt']);
});

it.each(['dir x/my file.ts', 'café.txt', 'tab\tline\n"\\.ts'])('parses quoted paths and control escapes: %s', async file => {
  const encoded = file === 'café.txt' ? 'caf\\303\\251.txt' : file.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
  const ctx = context(root);
  ctx.touchedFiles = [file];
  ctx.diff = 'diff --git "a/' + encoded + '" "b/' + encoded + '"\n--- "a/' + encoded + '"\n+++ "b/' + encoded + '"\n@@ -1 +1,2 @@\n ' + finding().evidence_quote + '\n+HUNK_SENTINEL\n';
  expect(reviewChunks(ctx).chunks[0]?.files).toEqual([file]);
});

it('releases the reserve when there are no findings to escalate', async () => {
  const ctx = context(root);
  ctx.touchedFiles = Array.from({length:3000}, (_, i) => 'file' + i + '.ts');
  ctx.diff = ctx.touchedFiles.map(f => 'diff --git a/'+f+' b/'+f+'\n--- a/'+f+'\n+++ b/'+f+'\n@@ -0,0 +1 @@\n+value\n').join('');
  const fake = new FakeProvider('agy', 'google', originRunner(root), {flash:Array.from({length:12}, () => '[]')});
  const cfg = config(); cfg.budget.maxCalls = 12;
  const result = await runCascade(ctx, cfg, new Map([['agy',fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.calls.filter(call => call.tier === 'triage')).toHaveLength(12);
});

it('honors the explicit upstream flag even without a marker', async () => {
  const fake = new FakeProvider('agy', 'google', originRunner(root), {flash:['[]']});
  const result = await runCascade({...context(root), diffTruncated:true}, config(), new Map([['agy',fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.truncatedHunks).toContainEqual({file:'sample.ts', hunk:1});
});

it('sends the actual hunk when a finding path has spaces', async () => {
  await writeFile(path.join(root, 'my file.ts'), source);
  const ctx = context(root);
  ctx.diff = ctx.diff.replaceAll('sample.ts', 'my file.ts').replace('+++ b/my file.ts\n', '+++ b/my file.ts\t\n');
  ctx.touchedFiles = ['my file.ts'];
  const raw = finding({file:'my file.ts', confidence:0.6});
  const fake = new FakeProvider('agy', 'google', originRunner(root), {flash:[JSON.stringify([raw])]});
  const codex = new FakeProvider('codex', 'openai', originRunner(root), {codex:[JSON.stringify({decision:'confirm', evidence_quote:raw.evidence_quote})]});
  await runCascade(ctx, config(), new Map([['agy',fake], ['codex',codex]]), {catalog, gitRunner:originRunner(root)});
  expect(codex.calls[0]?.prompt).toContain('@@ -1 +1,2 @@');
});

it('records a finding lost because git cannot tell its origin', async () => {
  const gitRunner = vi.fn(async (...args: Parameters<ReturnType<typeof originRunner>>) => args[1].includes('blame') ? { stdout: '', stderr: 'fatal: shallow clone', exitCode: 128 } : originRunner(root)(...args));
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding()])] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, gitRunner });
  expect(result.findings).toEqual([]);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'origin unavailable', file: 'sample.ts', count: 1 });
  expect(result.warnings.some(warning => warning.includes('could not tell its origin'))).toBe(true);
});

it('records malformed findings as lost', async () => {
  const { fix: _fix, ...withoutFix } = finding();
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: [JSON.stringify([finding(), withoutFix])] });
  const result = await runCascade(context(root), config(), new Map([['agy', fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.lostFindings).toContainEqual({ reason: 'malformed finding', count: 1 });
});
