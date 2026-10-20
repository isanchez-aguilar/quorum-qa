import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { main, type CliDependencies } from '../../src/cli/index.js';
import { runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CommandRunner } from '../../src/types/index.js';
import { catalog, finding } from '../fixtures/cascade.js';

let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const runner: CommandRunner = (command, args, options) => {
  if (!/^git(?:\.exe)?$/i.test(path.basename(command))) throw new Error('Only synthetic Git operations allowed');
  return runCommand(command, args, { ...options, env });
};
async function git(...args: string[]) {
  const result = await runner('git', args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
}
const rule = { id: 'unsafe-call', pattern: 'unsafe\\(', severity: 'error', message: 'Validate before calling' };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-rules-cli-'));
  await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
  await writeFile(path.join(root, 'sample.ts'), 'const old = unsafe(oldInput);\n');
  await writeFile(path.join(root, 'spec.md'), '# Acceptance\n- [ ] Validate input\n');
  await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ rules: [rule] }));
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify({ base: 'base', checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] },
    escalate: { focus: [], belowConfidence: 0.6, confirmImportant: false } }));
  await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
  await writeFile(path.join(root, 'sample.ts'), 'const old = unsafe(oldInput);\nconst value = unsafe(input);\n');
  await git('add', '.'); await git('commit', '-m', 'head');
}, 20000);
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function invoke(args: string[], deps: CliDependencies = {}) {
  let out = ''; let err = '';
  const code = await main(args, { out: t => { out += t; }, err: t => { err += t; } },
    { repoRoot: root, gitRunner: runner, catalog, ...deps });
  return { code, out, err };
}
async function review(args: string[] = [], deps: CliDependencies = {}) {
  const provider = new FakeProvider('agy', 'google', runner, { flash: ['[]'], pro: ['[]'] });
  const r = await invoke(['review', '--spec', 'spec.md', '--diff', 'base...HEAD', '--no-cache', '--json', ...args],
    { providers: new Map([['agy', provider]]), ...deps });
  return { ...r, provider, result: r.out.startsWith('{') ? JSON.parse(r.out) : undefined };
}
it('runs base rules even when HEAD deletes them, reports only added lines and emits SARIF', async () => {
  await rm(path.join(root, 'quorum.rules.json')); await git('add', '.'); await git('commit', '-m', 'delete rules');
  const r = await review(['--sarif', '.quorum/result.sarif']);
  expect(r.code, r.err).toBe(1);
  expect(r.result.ruleChecks.results[0].matches).toEqual([{ file: 'sample.ts', line: 2, text: 'const value = unsafe(input);' }]);
  const md = await readFile(path.join(root, `.quorum/reports/${r.result.runId}.md`), 'utf8');
  expect(md.indexOf('## Rule matches')).toBeGreaterThan(md.indexOf('## Deterministic checks'));
  expect(md).toContain('unsafe-call'); expect(md).toContain('sample.ts:2');
  const sarif = JSON.parse(await readFile(path.join(root, '.quorum/result.sarif'), 'utf8'));
  expect(sarif.runs[0].results).toContainEqual(expect.objectContaining({ ruleId: 'quorum-rule/unsafe-call', properties: { deterministic: true } }));
  // The deleted rules file is itself part of the reviewed diff; matching results are not.
  expect(r.provider.calls.every(call => !call.prompt.includes('"ruleChecks"') && !call.prompt.includes('## Rule matches'))).toBe(true);
});
it('trust-head-config uses committed HEAD rules and no-checks skips matching', async () => {
  await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ rules: [{ ...rule, severity: 'warning' }] }));
  await git('add', '.'); await git('commit', '-m', 'warning');
  const r = await review(['--trust-head-config']);
  expect(r.code, r.err).toBe(0); expect(r.result.ruleChecks.results[0].rule.severity).toBe('warning');
  const skipped = await review(['--no-checks']);
  expect(skipped.code).toBe(0); expect(skipped.result.ruleChecks).toBeNull();
});
it('dry-run lists rule count and trusted commit without inference', async () => {
  const r = await review(['--dry-run']);
  expect(r.code).toBe(0); expect(r.out).toContain('Deterministic rules: 1'); expect(r.out).toContain(await git('rev-parse', 'base'));
  expect(r.provider.calls).toEqual([]);
});
it('error rules win over incomplete coverage without a model call', async () => {
  const r = await review([], { providers: new Map() });
  expect(r.code, r.err).toBe(1); expect(r.result.coverage.complete).toBe(false);
  expect(r.result.ruleChecks.results[0].matches).toHaveLength(1); expect(r.result.calls).toEqual([]);
});
it('warning rules keep incomplete coverage at exit 2', async () => {
  await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ rules: [{ ...rule, severity: 'warning' }] }));
  await git('add', '.'); await git('commit', '-m', 'warning');
  const r = await review(['--trust-head-config'], { providers: new Map() });
  expect(r.code, r.err).toBe(2); expect(r.result.ruleChecks.results[0].matches).toHaveLength(1);
});
it('timeout warns and preserves complete-review exit zero', async () => {
  await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ rules: [{ ...rule, pattern: '(a+)+$' }] }));
  await writeFile(path.join(root, 'sample.ts'), 'a'.repeat(1500) + '!\n');
  await git('add', '.'); await git('commit', '-m', 'adversarial');
  const r = await review(['--trust-head-config']);
  expect(r.code, r.err).toBe(0); expect(r.result.warnings.join()).toContain('rule unsafe-call timed out; skipped');
});
it('history failure warns without changing review outcome', async () => {
  const provider = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([finding({ line: 2, evidence_quote: 'const value = unsafe(input);' })])] });
  const r = await review(['--no-checks'], { providers: new Map([['agy', provider]]), appendFindings: async () => { throw new Error('synthetic failure'); } } as CliDependencies);
  expect(r.code, r.err).toBe(0); expect(r.result.warnings.join()).toContain('Findings history write failed');
});
it('records final verified findings but not confirmation rejections', async () => {
  const provider = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([finding({ line: 2, evidence_quote: 'const value = unsafe(input);' })])] });
  const r = await review(['--no-checks'], { providers: new Map([['agy', provider]]) });
  expect(r.code, r.err).toBe(0);
  const history = (await readFile(path.join(root, '.quorum/findings.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ runId: r.result.runId, evidence_quote: 'const value = unsafe(input);', confirmed: false });
  const cfg = JSON.parse(await readFile(path.join(root, 'quorum.config.json'), 'utf8'));
  cfg.escalate.confirmImportant = true;
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(cfg)); await git('add', '.'); await git('commit', '-m', 'confirm');
  const rejecting = new FakeProvider('codex', 'openai', runner, { codex: [JSON.stringify({ decisions: [{ id: 'c1', decision: 'reject' }] })] });
  const again = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([finding({ line: 2, evidence_quote: 'const value = unsafe(input);' })])] });
  const rejected = await review(['--no-checks', '--trust-head-config'], { providers: new Map([['agy', again], ['codex', rejecting]]) });
  expect(rejected.result.rejectedOnConfirmation).toHaveLength(1);
  expect((await readFile(path.join(root, '.quorum/findings.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
});
it('mines three FakeProvider reviews then enforces the accepted base rule without inference', async () => {
  for (let i = 0; i < 3; i++) {
    const file = `file${i}.ts`; const quote = `const value${i} = unsafe(input${i});`;
    await writeFile(path.join(root, file), quote + '\n'); await git('add', '.'); await git('commit', '-m', `sample ${i}`);
    const provider = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([finding({ file, line: 1, evidence_quote: quote })])] });
    const r = await review(['--no-checks'], { providers: new Map([['agy', provider]]) });
    expect(r.code, r.err).toBe(0);
  }
  const proposed = await invoke(['rules', 'propose', '--json']);
  expect(proposed.code, proposed.err).toBe(0);
  const proposals = JSON.parse(proposed.out);
  expect(proposals.clusters).toHaveLength(1);
  const entry = proposals.clusters[0].rule;
  expect(entry.pattern).toBeTypeOf('string');
  await writeFile(path.join(root, 'quorum.rules.json'), JSON.stringify({ rules: [entry] }));
  await git('add', '.'); await git('commit', '-m', 'accepted rule'); await git('branch', '-f', 'base', 'HEAD');
  await writeFile(path.join(root, 'new.ts'), 'const result = unsafe(data);\n'); await git('add', '.'); await git('commit', '-m', 'new recurrence');
  const r = await review([], { providers: new Map() });
  expect(r.result.ruleChecks.results[0].matches).toHaveLength(1); expect(r.result.calls).toEqual([]);
  const markdown = await readFile(path.join(root, `.quorum/reports/${r.result.runId}.md`), 'utf8');
  expect(markdown).toContain('## Rule matches'); expect(markdown).toContain('new.ts:1');
});
it.each(['1', '51', '2.5', 'no'])('rejects invalid proposal minimum %s', async min => {
  const r = await invoke(['rules', 'propose', '--min', min]); expect(r.code).toBe(2); expect(r.err).toContain('--min');
});
it('reports no qualifying history with exit zero', async () => {
  const r = await invoke(['rules', 'propose']); expect(r.code, r.err).toBe(0); expect(r.out).toMatch(/no .*qualif/i); expect(r.out).toContain('0');
});
it('runs rules when bughunt has no unchanged window', async () => {
  await writeFile(path.join(root, 'sample.ts'), 'const replaced = unsafe(data);\n');
  await git('add', '.'); await git('commit', '-m', 'replace all lines');
  const r = await invoke(['review', '--mode', 'bughunt', '--diff', 'base...HEAD', '--json'], { providers: new Map() });
  expect(r.code, r.err).toBe(1); expect(JSON.parse(r.out).ruleChecks.results[0].matches).toHaveLength(1);
});
it('keeps no-checks dry-run rule count zero and does not write proposal output into rules file', async () => {
  const r = await review(['--no-checks', '--dry-run']);
  expect(r.out).toContain('Deterministic rules: 0'); expect(r.provider.calls).toHaveLength(0);
  const before = await readFile(path.join(root, 'quorum.rules.json'), 'utf8');
  const invalid = await invoke(['rules', 'propose', '--out', 'quorum.rules.json']);
  expect(invalid.code).toBe(2); expect(await readFile(path.join(root, 'quorum.rules.json'), 'utf8')).toBe(before);
});
it('saves Markdown proposals while printing JSON without changing configuration', async () => {
  const before = await readFile(path.join(root, 'quorum.rules.json'), 'utf8');
  const r = await invoke(['rules', 'propose', '--out', 'proposals.md', '--json']);
  expect(r.code, r.err).toBe(0); expect(JSON.parse(r.out).findingsSeen).toBe(0);
  expect(await readFile(path.join(root, 'proposals.md'), 'utf8')).toContain('# Proposed rules');
  expect(await readFile(path.join(root, 'quorum.rules.json'), 'utf8')).toBe(before);
});
it('caps displayed matches at 50 with the remaining count and never sends rule messages to models', async () => {
  await writeFile(path.join(root, 'sample.ts'), Array.from({ length: 55 }, (_, i) => `const x${i} = unsafe(input);`).join('\n') + '\n');
  await git('add', '.'); await git('commit', '-m', 'many matches');
  const r = await review();
  expect(r.code, r.err).toBe(1);
  expect(r.result.ruleChecks.results[0].totalMatches).toBe(55);
  expect(r.result.ruleChecks.results[0].matches).toHaveLength(50);
  const md = await readFile(path.join(root, `.quorum/reports/${r.result.runId}.md`), 'utf8');
  expect(md).toContain('+5 more');
  expect(r.provider.calls.every(call => !call.prompt.includes('Validate before calling'))).toBe(true);
});
it.each(['0', '3651', '1.5', 'NaN'])('rejects invalid proposal history window %s', async days => {
  const r = await invoke(['rules', 'propose', '--days', days]); expect(r.code).toBe(2); expect(r.err).toContain('--days');
});
