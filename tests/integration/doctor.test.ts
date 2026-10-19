import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    root = await mkdtemp(path.join(tmpdir(), 'quorum-doctor-test-'));
    home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    for (const name of ['git', 'agy', 'codex', 'docker', 'podman', 'checker']) await writeFile(path.join(bin, name + (process.platform === 'win32' ? '.EXE' : '')), 'synthetic');
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
    const fetcher = vi.fn().mockResolvedValue({ ok: true, body: { cancel: vi.fn() } }); vi.stubGlobal('fetch', fetcher);
    expect((await checkQwen(endpoint)).status).toBe('PASS');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url.pathname).toBe('/v1/models'); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('warns for HTTP failure and timeout, and only checks Qwen when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal('fetch', fetcher);
    expect((await checkQwen('http://localhost:8080')).status).toBe('WARN');
    fetcher.mockRejectedValue(new Error('timeout'));
    const cfg = config(); cfg.qwen = { endpoint: 'http://localhost:8080' };
    expect(status(await runDoctor(cfg, { runner, env, homedir: home, repoRoot: root }), 'qwen.endpoint')).toBe('WARN');
  });
});
