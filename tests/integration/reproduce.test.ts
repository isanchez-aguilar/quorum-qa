import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type CliDependencies } from '../../src/cli/index.js';
import { runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { reproduceBlocker } from '../../src/reproduce/index.js';
import { validateConfig } from '../../src/config/index.js';
import type { CommandRunner, ReproductionProposal } from '../../src/types/index.js';
import type { ReviewResult } from '../../src/reporters/index.js';
import { generateMarkdownReport } from '../../src/reporters/index.js';
import { catalog, context, finding, source } from '../fixtures/cascade.js';

let root: string;
let base: string;
let head: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const gitRunner: CommandRunner = (command, args, options) => runCommand(command, args, { ...options, env });
async function git(...args: string[]) {
  const result = await gitRunner('git', args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
}
const config = () => validateConfig({ base: 'base', checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] },
  jules: { enabled: false, repo: 'synthetic/repro' },
  escalate: { focus: [], belowConfidence: 0.6 }, budget: { maxCalls: 6, maxMinutes: 2, quotaFloorPercent: 10 },
  reproduce: { testCommand: ['pnpm', 'exec', 'vitest', 'run'], testGlobs: ['**/*.test.ts'] } });
const proposal: ReproductionProposal = { path: 'tests/proposed.test.ts', content: '// Synthetic proposed test; fake runner only\n', expect: 'expected 2 to be 1' };
const resolveOptions = { platform: 'linux' as const, env: { PATH: '/fake/bin' }, exists: (file: string) => file === '/fake/bin/docker' };
function report(status = 'failed', message = 'AssertionError: expected 2 to be 1', file = '/work/tests/proposed.test.ts') {
  return JSON.stringify({ testResults: [{ name: file, status, message: '', assertionResults: [{ fullName: 'synthetic proof', status,
    failureMessages: status === 'failed' ? [message] : [] }] }] });
}
function container(reports: string[] = [report(), report('passed')], unavailable = false): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (unavailable) return { stdout: '', stderr: 'no runtime', exitCode: 1 };
    if (args[0] === 'image' || args[0] === 'volume' && args[1] === 'inspect') return { stdout: '', stderr: '', exitCode: 1 };
    const marker = args.find(arg => arg.startsWith('QUORUM_REPORT_'));
    return { stdout: marker ? `${marker}${reports.shift() ?? report('passed')}` : '', stderr: '', exitCode: marker ? 1 : 0 };
  };
  return Object.assign(run, { calls });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-m6-'));
  await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
  await writeFile(path.join(root, 'sample.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'spec.md'), '# Acceptance\n- [ ] Correct result\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(config()));
  await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
  base = await git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'sample.ts'), source); await git('add', '.'); await git('commit', '-m', 'head');
  head = await git('rev-parse', 'HEAD');
}, 20000);
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function review(runner: CommandRunner, flags: string[] = [], overrides: CliDependencies = {}) {
  const triage = new FakeProvider('agy', 'google', gitRunner, { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])] });
  const confirm = new FakeProvider('codex', 'openai', gitRunner, { codex: [JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote }),
    'Untrusted status is ignored. {"noise":true}\n' + JSON.stringify({ ...proposal, status: 'reproduced' })] });
  let output = ''; let errors = '';
  const code = await main(['review', '--diff', 'base...HEAD', '--spec', 'spec.md', '--no-checks', '--no-cache', '--json', '--sarif', '.quorum/report.sarif',
    '--out', '.quorum/report.md', ...flags], { out: value => { output += value; }, err: value => { errors += value; } },
  { repoRoot: root, providers: new Map([['agy', triage], ['codex', confirm]]), catalog, gitRunner, containerRunner: runner,
    reproductionOptions: { isTTY: false, isolationOptions: { resolveOptions } }, ...overrides });
  expect(errors).toBe('');
  return { code, result: JSON.parse(output) as ReviewResult, triage, confirm };
}

describe('M6 main() reproduction with fake containers', () => {
  it.each([false, true])('counts independent families even when the representative is local (reproduce=%s)', async reproduce => {
    const settings = config(); settings.tiers = { triage: ['qwen'], review: ['agy:pro'], confirm: [], visual: [] };
    await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(settings));
    await git('add', '.'); await git('commit', '-m', 'synthetic independent local source');
    const local = new FakeProvider('qwen', 'local', gitRunner, { qwen: [JSON.stringify([finding({ severity: 'BLOCKER', confidence: 0.95 })])] });
    const other = new FakeProvider('agy', 'google', gitRunner, { pro: [JSON.stringify({ decision: 'confirm', confidence: 0.6, evidence_quote: finding().evidence_quote })] });
    const result = await review(container(), ['--allow-unproven', '--trust-head-config', ...(reproduce ? ['--reproduce'] : [])], { providers: new Map([['qwen', local], ['agy', other]]) });
    expect(result.result.unconfirmed[0]).toMatchObject({ family: 'local', confirmationFamilies: ['local', 'google'] });
    expect(result.code).toBe(1);
  });
  it('reports explicit install-script opt-in', async () => {
    const settings = config(); settings.reproduce.allowInstallScripts = true;
    await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(settings));
    await git('add', '.'); await git('commit', '-m', 'synthetic scripts opt-in');
    const result = await review(container(), ['--reproduce', '--trust-head-config']);
    expect(result.result.warnings).toContain('Reproduction preparation: install scripts are enabled (allowInstallScripts=true); preparation has network access to fetch packages.');
    expect(await readFile(path.join(root, '.quorum/report.md'), 'utf8')).toContain('install scripts are enabled');
  });
  it('prepares head and base from their own manifests', async () => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'synthetic' } }));
    await git('add', '.'); await git('commit', '-m', 'synthetic manifest change');
    const run = container();
    const result = await review(run, ['--reproduce']);
    expect(result.result.findings[0]?.reproduction?.status).toBe('reproduced');
    const volumes = run.calls.filter(args => args[0] === 'volume' && args[1] === 'create').map(args => args[2]);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).not.toBe(volumes[1]);
  });
  it.each([false, true])('waives same-family confirmation consistently (reproduce=%s)', async reproduce => {
    const triage = new FakeProvider('agy', 'google', gitRunner, { flash: [JSON.stringify([finding({ severity: 'BLOCKER' })])] });
    const confirm = new FakeProvider('codex', 'google', gitRunner, { codex: [JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })] });
    const result = await review(container(), ['--allow-unproven', ...(reproduce ? ['--reproduce'] : [])], {
      catalog: catalog.map(entry => entry.provider === 'codex' ? { ...entry, family: 'google' as const } : entry),
      providers: new Map([['agy', triage], ['codex', confirm]]),
    });
    expect(result.code).toBe(0);
  });
  it('never waives a cross-family BLOCKER at the reproduction cap', async () => {
    const files = ['sample.ts', 'second.ts', 'third.ts', 'fourth.ts'];
    for (const file of files.slice(1)) await writeFile(path.join(root, file), source);
    const settings = config(); settings.budget.maxCalls = 12;
    await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(settings));
    await git('add', '.'); await git('commit', '-m', 'synthetic cap fixture');
    const triage = new FakeProvider('agy', 'google', gitRunner, { flash: [JSON.stringify(files.map(file => finding({ file, severity: 'BLOCKER' })))] });
    const confirm = new FakeProvider('codex', 'openai', gitRunner, { codex: [
      ...files.map(() => JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote })),
      ...files.slice(1).map(() => JSON.stringify(proposal)),
    ] });
    const result = await review(container([report('passed')]), ['--reproduce', '--allow-unproven', '--trust-head-config'], { providers: new Map([['agy', triage], ['codex', confirm]]) });
    expect(result.result.findings.some(f => f.reproduction?.failureReason === 'reproduction cap')).toBe(true);
    expect(result.code).toBe(1);
  });
  it('does nothing without opt-in even when confirmed', async () => {
    const run = container(); const result = await review(run, ['--allow-unproven']);
    expect(result.code).toBe(1); expect(result.confirm.calls).toHaveLength(1); expect(run.calls).toHaveLength(0);
  });
  it('keeps a reproduced BLOCKER, records proof in Markdown/SARIF/ledger and removes worktrees', async () => {
    const run = container(); const result = await review(run, ['--reproduce', '--allow-unproven']);
    expect(result.code).toBe(1);
    expect(result.result.findings[0]).toMatchObject({ severity: 'BLOCKER', reproduction: { status: 'reproduced', path: proposal.path, content: proposal.content } });
    expect(result.result.calls.map(call => call.purpose)).toEqual(['review', 'confirm', 'reproduce']);
    expect(result.confirm.calls[1]?.prompt).toContain('untrusted data');
    const markdown = await readFile(path.join(root, '.quorum/report.md'), 'utf8');
    expect(markdown).toContain('## Reproduction'); expect(markdown).toContain('<details>'); expect(markdown).toContain(proposal.content.trim());
    const sarif = JSON.parse(await readFile(path.join(root, '.quorum/report.sarif'), 'utf8'));
    expect(sarif.runs[0].results[0].properties.reproduction.status).toBe('reproduced');
    expect(result.result.ledgerDraft.reduce((sum, row) => sum + row.reproducedBlockersCount, 0)).toBe(1);
    expect(await readdir(path.join(root, '.quorum/worktrees'))).toEqual([]);
    await expect(readFile(path.join(root, proposal.path))).rejects.toThrow();
    expect(await git('status', '--porcelain')).toBe('');
  });
  it.each([
    [report('passed'), 'passed'], [report('failed', 'AssertionError: wrong message'), 'assertion-failure-other-message'],
    [report('failed', 'SyntaxError: Unexpected token'), 'non-assertion-failure'],
    [report('failed', "Error: Cannot find module 'missing'"), 'non-assertion-failure'],
  ])('downgrades a head result that does not prove the defect', async (headReport, reason) => {
    const run = container([headReport]); const result = await review(run, ['--reproduce', '--allow-unproven']);
    expect(result.code).toBe(0); expect(result.result.findings[0]).toMatchObject({ severity: 'IMPORTANT', reproduction: { status: 'not-reproduced', failureReason: reason } });
  });
  it('does not reproduce a trivial assertion failing both at head and base', async () => {
    const result = await review(container([report(), report()]), ['--reproduce']);
    expect(result.code).toBe(0); expect(result.result.findings[0]?.reproduction?.failureReason).toBe('test did not pass at base');
  });
  it.each([false, true])('keeps cross-family unproven findings failing (%s)', async allow => {
    const result = await review(container([], true), ['--reproduce', ...(allow ? ['--allow-unproven'] : [])]);
    expect(result.code).toBe(1);
    expect(result.result.findings[0]).toMatchObject({ severity: 'BLOCKER', reproduction: { status: 'unproven', failureReason: 'no container runtime' } });
  });
  it('marks new code unproven without trusting a trivial assertion', async () => {
    await git('checkout', 'base'); await git('rm', 'sample.ts'); await git('commit', '-m', 'base without code');
    await writeFile(path.join(root, 'sample.ts'), source); await git('checkout', '-b', 'new-code'); await git('add', '.'); await git('commit', '-m', 'new code');
    const run = container(); const result = await review(run, ['--reproduce']);
    expect(result.code).toBe(1); expect(result.result.findings[0]?.reproduction?.failureReason).toBe('new code: nothing to compare against');
    expect(run.calls).toHaveLength(0);
  });

  it.each(['{"testResults":[]}', report('passed', '', '/work/other.test.ts'), report('skipped'),
    ...['worker crash', 'out of memory', 'ENOSPC', 'EMFILE', 'process killed', 'signal SIGTERM'].map(message => JSON.stringify({ testResults: [{ name: '/work/tests/proposed.test.ts', message, assertionResults: [] }] })), ''])
  ('keeps tests that never ran unproven: %s', async raw => {
    const result = await review(container([raw]), ['--reproduce', '--allow-unproven']);
    expect(result.code).toBe(1);
    expect(result.result.findings[0]?.reproduction).toMatchObject({ status: 'unproven', failureReason: expect.any(String) });
  });

  it('contains hostile Markdown entirely inside a longer fence', async () => {
    const result = await review(container(), []);
    const content = '\n\n## heading\n![img](https://example.invalid/x.png)\n`````\n</details>\n';
    result.result.findings[0]!.reproduction = { ...proposal, path: 'bad\u001b<path>.test.ts', content };
    const markdown = generateMarkdownReport(result.result);
    const fenced = '\n``````\n' + content + '\n``````\n';
    expect(markdown).toContain(fenced);
    const outside = markdown.replace(fenced, '');
    expect(outside).not.toContain('## heading');
    expect(outside).not.toContain('![img]');
    expect(markdown).toContain('<summary>bad&lt;path&gt;.test.ts</summary>\n\n');
    expect(markdown).not.toContain('<pre><code>');
  }, 30_000);
});

describe('reproduction revision and interactive contracts', () => {
  const ctx = () => ({ ...context(root), baseCommit: base, headCommit: head });
  it('skips base for a pre-existing defect', async () => {
    const run = container();
    const outcome = await reproduceBlocker(finding({ origin: 'pre-existing' }), proposal, ctx(), config(), run,
      { gitRunner, isolationOptions: { resolveOptions }, isTTY: false });
    expect(outcome.status).toBe('reproduced');
    expect(run.calls.filter(args => args.some(arg => arg.startsWith('QUORUM_REPORT_')))).toHaveLength(1);
  });
  it('rejects existing test paths at head and never overwrites checkout content', async () => {
    await writeFile(path.join(root, 'existing.test.ts'), 'sentinel'); await git('add', '.'); await git('commit', '-m', 'existing'); head = await git('rev-parse', 'HEAD');
    const run = container();
    const result = await reproduceBlocker(finding(), { ...proposal, path: 'existing.test.ts' }, ctx(), config(), run, { gitRunner, isolationOptions: { resolveOptions } });
    expect(result.status).toBe('rejected'); expect(run.calls).toHaveLength(0);
    expect(await readFile(path.join(root, 'existing.test.ts'), 'utf8')).toBe('sentinel');
  });
  it.each([false, true])('does not run host code after decline or --no-host-prompt (%s)', async suppress => {
    const confirm = vi.fn(async () => false); const run = container([], true);
    const result = await reproduceBlocker(finding(), proposal, ctx(), config(), run,
      { gitRunner, isTTY: true, confirm, display() {}, noHostPrompt: suppress, isolationOptions: { resolveOptions } });
    expect(result.status).toBe('unproven'); expect(confirm).toHaveBeenCalledTimes(suppress ? 0 : 1);
    expect(run.calls.every(args => args[0] === 'info')).toBe(true);
  });
  it('requires explicit consent at each revision and normalizes host reporter paths', async () => {
    const confirm = vi.fn(async () => true); let calls = 0;
    const host: CommandRunner = async (_command, args, options) => {
      calls++;
      const allowed = process.platform === 'win32' ? ['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'] : ['PATH', 'HOME', 'TMPDIR', 'LANG'];
      expect(Object.keys(options!.env!).every(key => allowed.includes(key.toUpperCase()))).toBe(true);
      const reportFile = args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      await writeFile(reportFile, report(calls === 1 ? 'failed' : 'passed', undefined, path.join(options!.cwd!, proposal.path)));
      return { stdout: '', stderr: '', exitCode: calls === 1 ? 1 : 0 };
    };
    const settings = config(); settings.reproduce.isolation = 'interactive'; settings.reproduce.testCommand = [process.execPath];
    let displayed = '';
    const hostile = { ...proposal, content: '\u001b[2J\u001b]0;title\u0007hello\u0085\u202E\u2066\u200E\n\tend' };
    const result = await reproduceBlocker(finding(), hostile, ctx(), settings, host, { gitRunner, isTTY: true, confirm, display(text) { displayed += text; } });
    expect(displayed).toContain('hello\n\tend');
    expect(displayed).not.toMatch(/[\u001b\u0007\u0085\u202E\u2066\u200E]/);
    expect(displayed).toContain(JSON.stringify(settings.reproduce.testCommand));
    expect(displayed).toContain('package.json scripts, test config, setup files and dependencies');
    expect(result.status).toBe('reproduced'); expect(confirm).toHaveBeenCalledTimes(2); expect(calls).toBe(2);
    expect(await readdir(path.join(root, '.quorum/worktrees'))).toEqual([]);
  });
  it('passes dash-prefixed proposed paths as filenames, never runner options', async () => {
    const proposed = { ...proposal, path: '--config=evil.test.ts' };
    const host: CommandRunner = async (_command, args, options) => {
      expect(args).toContain('./--config=evil.test.ts');
      expect(args).not.toContain('--config=evil.test.ts');
      const output = args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
      await writeFile(output, report('failed', undefined, path.join(options!.cwd!, proposed.path)));
      return { stdout: '', stderr: '', exitCode: 1 };
    };
    const settings = config(); settings.reproduce.isolation = 'interactive'; settings.reproduce.testCommand = [process.execPath];
    const result = await reproduceBlocker(finding({ origin: 'pre-existing' }), proposed, ctx(), settings, host,
      { gitRunner, isTTY: true, confirm: async () => true, display() {} });
    expect(result.status).toBe('reproduced');
  });
});
