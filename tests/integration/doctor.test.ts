import { realpath, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_LOGIN_HINT } from '../../src/providers/claude.js';
import { runDoctor } from '../../src/doctor/index.js';
import { checkPermissions, checkQwen, permissionPath, readProbe } from '../../src/doctor/checks.js';
import { validateConfig } from '../../src/config/schema.js';
import type { CommandRunner } from '../../src/types/index.js';
import { createReviewWorktree, isClean } from '../../src/worktree/index.js';

vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: vi.fn(), isClean: vi.fn() }));

describe('doctor with synthetic executables and injected runner', () => {
  let root: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let settings: string;
  let runner: ReturnType<typeof vi.fn<CommandRunner>>;
  const model = 'gemini-3.8-flash-medium';
  const config = () => validateConfig({ checks: [['checker', 'test']], tiers: { triage: [`agy:${model}`], review: [`agy:${model}`], confirm: ['codex'], visual: [] } });
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen-test' }] }))));
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'quorum-doctor-test-')));
    home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    for (const name of ['git', 'agy', 'codex', 'claude', 'docker', 'podman', 'checker']) await writeFile(path.join(bin, name + (process.platform === 'win32' ? '.EXE' : '')), 'synthetic');
    env = { PATH: bin, PATHEXT: '.EXE' };
    settings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ permissions: { allow: [`read_file(${permissionPath(root)})`] } }));
    runner = vi.fn(async (_file, args) => {
      if (args.includes('--is-inside-work-tree')) return ok('true');
      if (args.includes('models')) return ok(`Fetching available models...\n${model}\tGemini Flash\n`);
      if (args.includes('--print=/usage')) return ok(JSON.stringify({ status: 'SUCCESS', command: { data: { groups: [{ name: 'Gemini Models', description: 'Gemini Flash and Pro', buckets: [{ name: 'weekly', remaining_fraction: 0.5 }] }] } } }));
      return ok();
    });
  });
  afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
  const status = (checks: Awaited<ReturnType<typeof runDoctor>>, id: string) => checks.find(check => check.id === id)?.status;
  it.each([{ checks: true, manifest: true, setup: false, warn: true },
    { checks: true, manifest: true, setup: true, warn: false },
    { checks: false, manifest: true, setup: false, warn: false },
    { checks: true, manifest: false, setup: false, warn: false }])('diagnoses fresh worktree dependencies %j', async row => {
    if (row.manifest) await writeFile(path.join(root, 'package.json'), '{}');
    const cfg = config(); if (!row.checks) cfg.checks = [];
    if (row.setup) Object.assign(cfg, { setup: [['checker', 'install']] });
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root });
    const warning = result.find(check => check.message.includes('checks run in a fresh worktree without node_modules'));
    expect(warning?.status).toBe(row.warn ? 'WARN' : undefined);
  });
  it.each([
    { selected: true, index: true, executable: true, version: 'ok', expected: 'PASS' },
    { selected: true, index: false, executable: true, version: 'ok', expected: 'WARN' },
    { selected: true, index: true, executable: false, version: 'ok', expected: 'WARN' },
    { selected: true, index: true, executable: true, version: 'fail', expected: 'WARN' },
    { selected: true, index: true, executable: true, version: 'timeout', expected: 'WARN' },
    { selected: false, index: true, executable: false, version: 'ok', expected: 'PASS' },
    { selected: false, index: false, executable: true, version: 'ok', expected: undefined },
  ])('diagnoses opt-in CodeGraph without indexing: %j', async ({ selected, index, executable, version, expected }) => {
    if (index) await mkdir(path.join(root, '.codegraph'));
    if (executable) await writeFile(path.join(root, 'bin', 'codegraph' + (process.platform === 'win32' ? '.EXE' : '')), 'synthetic');
    const cfg = config(); cfg.context = { provider: selected ? 'codegraph' : 'git' };
    const baseRunner = runner.getMockImplementation()!;
    runner.mockImplementation(async (file, args, options) => {
      if (path.basename(file).toLowerCase().startsWith('codegraph')) {
        expect(args).toEqual(['--version']); expect(options?.cwd).toBe(root); expect(options?.timeoutMs).toBe(10_000);
        if (version === 'timeout') throw new Error('timeout');
        return { ...ok('1.6.1'), exitCode: version === 'fail' ? 1 : 0 };
      }
      return baseRunner(file, args, options);
    });
    const checks = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root });
    expect(status(checks, 'context.codegraph')).toBe(expected);
    const calls = runner.mock.calls.filter(([file]) => path.basename(file).toLowerCase().startsWith('codegraph'));
    expect(calls).toHaveLength(selected && index && executable ? 1 : 0);
    if (!selected && index) expect(checks.find(c => c.id === 'context.codegraph')?.message).toBe('CodeGraph index found; set context.provider to use it');
  });
  it('checks models and required providers configured only in confirmation routes', async () => {
    const cfg = config();
    Object.assign(cfg.escalate, { routes: { money: ['claude:opus'], a11y: ['agy:gemini-4-argon-high'] } });
    const result = await runDoctor(cfg, { runner, env: { PATH: '' }, homedir: home, repoRoot: root });
    expect(status(result, 'claude.path')).toBe('FAIL');
    expect(status(result, 'agy.model.gemini-4-argon-high')).toBe('FAIL');
  });
  it('passes available checks, warns on unverified deny rules and never probes implicitly', async () => {
    const before = await readFile(settings, 'utf8');
    const result = await runDoctor(config(), { runner, env, homedir: home, repoRoot: root });
    expect(result.filter(check => check.status === 'FAIL')).toEqual([]);
    expect(status(result, 'agy.permissions.deny')).toBe('WARN');
    expect(status(result, 'agy.permissions.read')).toBe('PASS');
    expect(status(result, 'container')).toBe('PASS');
    expect(status(result, 'agy.quota')).toBe('PASS');
    expect(runner.mock.calls.some(([, args]) => args.includes('exec') || args.some(arg => arg.startsWith('--print=') && arg !== '--print=/usage'))).toBe(false);
    expect(createReviewWorktree).not.toHaveBeenCalled();
    expect(await readFile(settings, 'utf8')).toBe(before);
    expect(runner.mock.calls.every(([, , options]) => !options?.env?.MSYS_NO_PATHCONV)).toBe(true);
  });
  it('reads agy settings written with a UTF-8 BOM', async () => {
    await writeFile(settings, '﻿' + JSON.stringify({ permissions: { allow: [`read_file(${permissionPath(root)})`] } }));
    const result = await runDoctor(config(), { runner, env, homedir: home, repoRoot: root });
    expect(status(result, 'agy.permissions.read')).toBe('PASS');
  });
  it.each([true, false])('uses FAIL only when Claude/Qwen are required: %s', async required => {
    const cfg = config(); if (required) { cfg.tiers.triage = ['qwen']; cfg.tiers.review = ['claude:sonnet']; }
    const result = await runDoctor(cfg, { runner, env: { PATH: '' }, homedir: home, repoRoot: root,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED')) });
    for (const id of ['claude.path', 'qwen.endpoint', 'qwen.model']) expect(status(result, id)).toBe(required ? 'FAIL' : 'WARN');
  });
  it.each([true, false])('validates configured Qwen model membership: %s', async listed => {
    const cfg = config(); cfg.tiers.triage = ['qwen']; cfg.qwen = { endpoint: 'http://localhost/v1', model: listed ? 'second' : 'absent' };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }] })));
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, fetch: fetcher });
    expect(status(result, 'qwen.endpoint')).toBe('PASS'); expect(status(result, 'qwen.model')).toBe(listed ? 'PASS' : 'FAIL');
    expect(result.find(check => check.id === 'qwen.model')?.message).toContain(listed ? 'second' : 'absent');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('reports malformed models as a model failure and skips inference without a selected model', async () => {
    const cfg = config(); cfg.tiers.triage = ['qwen'];
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, fetch: fetcher, probe: true });
    expect(status(result, 'qwen.endpoint')).toBe('PASS'); expect(status(result, 'qwen.model')).toBe('FAIL');
    expect(status(result, 'qwen.probe')).toBe('FAIL'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['OK', ' ok! ', 'OK.', 'oK', 'OK?', 'OK extra', 'wrong', 'nonjson', 'connection'])('makes exactly one local chat probe and checks its answer: %s', async output => {
    const cfg = config(); cfg.tiers.triage = ['qwen'];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'selected-model' }] }));
      if (output === 'connection') throw new Error('ECONNREFUSED');
      return new Response(output === 'nonjson' ? 'invalid' : JSON.stringify({ choices: [{ message: { content: output } }] }));
    });
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, fetch: fetcher, probe: true });
    expect(status(result, 'qwen.probe')).toBe(['OK', ' ok! ', 'OK.', 'oK', 'OK?'].includes(output) ? 'PASS' : 'FAIL');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toMatchObject({ model: 'selected-model', messages: [
      { role: 'system', content: expect.stringContaining('connectivity probe') }, { role: 'user', content: 'Reply with OK' },
    ] });
  });
  it('warns and skips optional inference for providers absent from tiers', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'local' }] })));
    const result = await runDoctor(config(), { runner, env, homedir: home, repoRoot: root, fetch: fetcher, probe: true });
    expect(status(result, 'qwen.probe')).toBe('WARN'); expect(status(result, 'claude.probe')).toBe('WARN');
    expect(fetcher).toHaveBeenCalledOnce(); expect(runner.mock.calls.some(([, args]) => args.includes('-p'))).toBe(false);
  });
  it.each(['success', 'dirty', 'wrong', 'nonzero', 'invalid'])('Claude probe %s uses one restricted stdin call and cleans up', async failure => {
    await writeFile(path.join(root, 'README.md'), '# Synthetic');
    const cleanup = vi.fn(async () => {});
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup });
    vi.mocked(isClean).mockResolvedValue(failure !== 'dirty');
    runner.mockImplementation(async (_file, args) => args.includes('--verify') ? ok('a'.repeat(40)) : {
      stdout: failure === 'invalid' ? '{}' : JSON.stringify({ subtype: 'success', result: failure === 'wrong' ? 'wrong' : '# Synthetic' }),
      stderr: '', exitCode: failure === 'nonzero' ? 1 : 0,
    });
    const result = await readProbe('claude', 'sonnet', { runner, env, repoRoot: root });
    expect(result.status).toBe(failure === 'success' ? 'PASS' : 'FAIL'); expect(cleanup).toHaveBeenCalledOnce();
    const calls = runner.mock.calls.filter(([, args]) => args.includes('-p')); expect(calls).toHaveLength(1);
    const [, args, opts] = calls[0]!;
    expect(args).toEqual(['-p', '--output-format', 'json', '--model', 'sonnet', '--no-session-persistence', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk']);
    expect(opts?.cwd).toBe(root); expect(opts?.stdin).toContain('Read README.md');
    expect(opts?.stdin).not.toMatch(/never read|do not read/i);
  });
  it('wires the recorded expired-login envelope to the doctor hint', async () => {
    await writeFile(path.join(root, 'README.md'), '# Synthetic');
    const cleanup = vi.fn(async () => {});
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup });
    runner.mockImplementation(async (_file, args) => args.includes('--verify') ? ok('a'.repeat(40)) : {
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed', usage: { input_tokens: 0, output_tokens: 0 } }),
      stderr: '', exitCode: 1,
    });
    expect(await readProbe('claude', 'sonnet', { runner, env, repoRoot: root })).toMatchObject({
      status: 'FAIL', message: 'claude read-only probe failed: ' + CLAUDE_LOGIN_HINT + '.',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('runs the configured Claude alias probe only with --probe', async () => {
    await writeFile(path.join(root, 'README.md'), '# Synthetic');
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup: vi.fn(async () => {}) });
    vi.mocked(isClean).mockResolvedValue(true);
    const normal = runner.getMockImplementation()!;
    runner.mockImplementation(async (file, args, opts) => args.includes('--verify') ? ok('a'.repeat(40)) : args.includes('-p')
      ? ok(JSON.stringify({ subtype: 'success', result: '# Synthetic' })) : normal(file, args, opts));
    const cfg = config(); cfg.tiers.review = ['claude:opus'];
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, probe: true });
    expect(status(result, 'claude.probe')).toBe('PASS');
    const calls = runner.mock.calls.filter(([, args]) => args.includes('-p')); expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toContain('opus');
  });
  it('checks Claude availability and the Qwen model without inference', async () => {
    const cfg = config(); cfg.tiers.review = ['claude:sonnet']; cfg.tiers.triage.push('qwen');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen-test' }] })));
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, fetch: fetcher });
    for (const id of ['claude.path', 'qwen.endpoint', 'qwen.model']) expect(status(result, id)).toBe('PASS');
    expect(result.find(check => check.id === 'qwen.model')?.message).toContain('qwen-test');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls.filter(([file]) => /claude/i.test(path.basename(file))).map(([, args]) => args)).toEqual([['--version']]);
    expect(result.some(check => check.id.endsWith('.probe'))).toBe(false);
  });
  it('reports missing executables, checks, models, git and unknown quota without throwing', async () => {
    const result = await runDoctor(config(), { runner, env: { PATH: '' }, homedir: home, repoRoot: root });
    for (const id of ['git.repo', 'check.0', 'agy.path', 'agy.models', `agy.model.${model}`, 'codex.path']) expect(status(result, id)).toBe('FAIL');
    expect(status(result, 'agy.quota')).toBe('WARN');
    expect(status(result, 'container')).toBe('WARN');
    expect(runner).not.toHaveBeenCalled();
  });
  it('reports command failures and malformed quota, and falls back to Podman', async () => {
    const normal = runner.getMockImplementation()!;
    runner.mockImplementation(async (file, args, options) => {
      if (path.basename(file).startsWith('docker') || args.includes('--help') || args.includes('--version') && path.basename(file).startsWith('codex')) return { ...ok(), exitCode: 1 };
      if (args.includes('--print=/usage')) return ok('invalid');
      if (args.includes('models')) return ok('Fetching available models...');
      return normal(file, args, options);
    });
    const result = await runDoctor(config(), { runner, env, homedir: home, repoRoot: root });
    expect(status(result, 'agy.path')).toBe('FAIL');
    expect(status(result, 'agy.models')).toBe('FAIL');
    expect(status(result, 'codex.path')).toBe('FAIL');
    expect(status(result, 'agy.quota')).toBe('WARN');
    expect(status(result, 'container')).toBe('PASS');
  });
  it.each([
    { status: 'ERROR', command: { data: { groups: [{}] } } },
    { status: 'SUCCESS', command: { data: { groups: [{}] } } },
    { status: 'SUCCESS', command: { data: { groups: [{ description: 'Gemini Flash and Pro', buckets: [{ remaining_fraction: 2 }] }] } } },
  ])('marks malformed or failed usage as floor unchecked', async usage => {
    const normal = runner.getMockImplementation()!;
    runner.mockImplementation(async (file, args, options) => args.includes('--print=/usage') ? ok(JSON.stringify(usage)) : normal(file, args, options));
    const result = await runDoctor(config(), { runner, env, homedir: home, repoRoot: root });
    expect(result.find(check => check.id === 'agy.quota')).toMatchObject({ status: 'WARN', message: expect.stringContaining('floor unchecked') });
  });
  it('requires usable quota for every configured agy model group', async () => {
    const cfg = config(); cfg.tiers.confirm = ['agy:gpt-oss-120b-medium'];
    expect(status(await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root }), 'agy.quota')).toBe('WARN');
  });
  it('fails a missing settings file without writing it', async () => {
    await rm(settings);
    expect((await checkPermissions(home, root))[0]?.status).toBe('FAIL');
    await expect(readFile(settings)).rejects.toThrow();
  });
  it.each(['{}', '{bad SECRET', JSON.stringify({ permissions: { allow: ['read_file(/unrelated)', 'read_file(relative)'] } })])('never leaks invalid settings: %s', async content => {
    await writeFile(settings, content);
    const result = await checkPermissions(home, root);
    expect(result[0]?.status).toBe('FAIL');
    expect(result[0]?.fix).toContain(`read_file(${permissionPath(path.join(root, '.quorum', 'worktrees'))})`);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects sibling prefix rules and accepts the exact worktree parent', async () => {
    const parent = permissionPath(path.join(root, '.quorum', 'worktrees'));
    await writeFile(settings, JSON.stringify({ permissions: { allow: [`read_file(${parent.slice(0, -1)})`] } }));
    expect((await checkPermissions(home, root))[0]?.status).toBe('FAIL');
    await writeFile(settings, JSON.stringify({ permissions: { allow: [`read_file(${parent})`] } }));
    expect((await checkPermissions(home, root))[0]?.status).toBe('PASS');
  });
  it('refuses an unlisted probe model without inference', async () => {
    const cfg = config(); cfg.tiers.triage = ['agy:missing']; cfg.tiers.review = [];
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, probe: true });
    expect(result.find(check => check.id === 'agy.probe')).toMatchObject({ status: 'FAIL', message: expect.stringContaining('listed') });
    expect(runner.mock.calls.some(([, args]) => args.includes('--model'))).toBe(false);
    // Only Codex may create a probe worktree; agy must be rejected before setup.
    expect(createReviewWorktree).toHaveBeenCalledTimes(1);
  });
  it.each(['*', '/', 'ROOT', 'PARENT'])('read deny %s overrides allow', async denied => {
    const rule = denied === 'ROOT' ? permissionPath(root) : denied === 'PARENT' ? permissionPath(path.join(root, '.quorum', 'worktrees')) : denied;
    await writeFile(settings, JSON.stringify({ permissions: { allow: [`read_file(${permissionPath(root)})`], deny: [`read_file(${rule})`] } }));
    expect((await checkPermissions(home, root))[0]?.status).toBe('FAIL');
  });
  it('runs independent checks without config', async () => {
    const result = await runDoctor(undefined!, { runner, env, homedir: home, repoRoot: root });
    for (const id of ['git.repo', 'agy.path', 'codex.path', 'container']) expect(status(result, id)).toBe('PASS');
    expect(result.find(check => check.id === 'config')).toMatchObject({ status: 'FAIL', fix: expect.stringContaining('quorum.config.json') });
  });
  it('runs exactly one call per requested probe, verifies output and cleans up', async () => {
    await writeFile(path.join(root, 'README.md'), '# Synthetic\nsecond');
    const cleanup = vi.fn(async () => {});
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup });
    vi.mocked(isClean).mockResolvedValue(true);
    const normal = runner.getMockImplementation()!;
    let outputFile = '';
    runner.mockImplementation(async (file, args, options) => {
      if (args.includes('--verify')) return ok('a'.repeat(40));
      if (args.some(arg => arg.startsWith('--print=Using'))) return ok(JSON.stringify({ status: 'SUCCESS', response: '# Synthetic' }));
      if (args.includes('exec')) { outputFile = args[args.indexOf('-o') + 1]!; await writeFile(outputFile, '# Synthetic'); return ok(); }
      return normal(file, args, options);
    });
    const result = await runDoctor(config(), { runner, env, homedir: home, repoRoot: root, probe: true });
    expect(status(result, 'agy.probe')).toBe('PASS');
    expect(status(result, 'codex.probe')).toBe('PASS');
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(createReviewWorktree).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.filter(([, args]) => args.includes('exec'))).toHaveLength(1);
    await expect(readFile(outputFile)).rejects.toThrow();
  });
  it.each(['dirty', 'wrong', 'nonzero', 'invalid'])('fails an agy %s probe and still cleans up', async failure => {
    await writeFile(path.join(root, 'README.md'), '# Synthetic');
    const cleanup = vi.fn(async () => {});
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup });
    vi.mocked(isClean).mockResolvedValue(failure !== 'dirty');
    runner.mockImplementation(async (_file, args) => args.includes('--verify') ? ok('a'.repeat(40)) : { stdout: failure === 'invalid' ? '{}' : JSON.stringify({ status: 'SUCCESS', response: failure === 'wrong' ? 'wrong' : '# Synthetic' }), stderr: '', exitCode: failure === 'nonzero' ? 1 : 0 });
    expect((await readProbe('agy', model, { runner, env, repoRoot: root })).status).toBe('FAIL');
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('does not retry a failing Codex probe', async () => {
    await writeFile(path.join(root, 'README.md'), '# Synthetic');
    const cleanup = vi.fn(async () => {});
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup });
    runner.mockImplementation(async (_file, args) => args.includes('--verify') ? ok('a'.repeat(40)) : { ...ok(), exitCode: 1 });
    expect((await readProbe('codex', 'codex', { runner, env, repoRoot: root })).status).toBe('FAIL');
    expect(runner.mock.calls.filter(([, args]) => args.includes('exec'))).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('does not forbid shell commands in the Codex probe, and names the failure reason', async () => {
    // Codex reads files through its shell; its read-only guarantee is the sandbox flag.
    await writeFile(path.join(root, 'README.md'), '# Synthetic');
    vi.mocked(createReviewWorktree).mockResolvedValue({ path: root, cleanup: vi.fn(async () => {}) });
    runner.mockImplementation(async (_file, args) => args.includes('--verify') ? ok('a'.repeat(40)) : { ...ok(), exitCode: 3 });
    const result = await readProbe('codex', 'codex', { runner, env, repoRoot: root });
    const exec = runner.mock.calls.find(([, args]) => args.includes('exec'))!;
    expect(exec[1]).toEqual(expect.arrayContaining(['-s', 'read-only']));
    expect(exec[2]?.stdin).not.toMatch(/shell|command/i);
    expect(result.message).toContain('exit code 3');
  });
  it('handles worktree creation failure as a failed probe', async () => {
    vi.mocked(createReviewWorktree).mockRejectedValue(new Error('not ignored'));
    expect((await readProbe('agy', model, { runner, env, repoRoot: root })).status).toBe('FAIL');
  });
  it('skips agy probe when no agy model is configured', async () => {
    const cfg = config(); cfg.tiers.triage = ['codex']; cfg.tiers.review = ['codex'];
    const result = await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root, probe: true });
    expect(status(result, 'agy.probe')).toBe('FAIL');
    expect(runner.mock.calls.some(([, args]) => args.some(arg => arg.startsWith('--print=Using')))).toBe(false);
  });
  it.each(['https://example.com', 'http://127.0.0.2', 'file:///tmp/models', 'http://user:pass@localhost'])('refuses non-loopback/unsafe endpoint %s without HTTP', async endpoint => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await checkQwen(endpoint)).status).toBe('FAIL');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1', 'http://localhost:8080/v1/'])('requests loopback models with timeout and no redirects: %s', async endpoint => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'local-model' }] }))); vi.stubGlobal('fetch', fetcher);
    expect((await checkQwen(endpoint)).status).toBe('PASS');
    const [url, init] = fetcher.mock.calls[0]!;
    expect((url as URL).pathname).toBe('/v1/models'); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('warns for HTTP failure and timeout, and only checks Qwen when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal('fetch', fetcher);
    expect((await checkQwen('http://localhost:8080')).status).toBe('FAIL');
    fetcher.mockRejectedValue(new Error('timeout'));
    const cfg = config(); cfg.qwen = { endpoint: 'http://localhost:8080' };
    expect(status(await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root }), 'qwen.endpoint')).toBe('WARN');
  });
});
