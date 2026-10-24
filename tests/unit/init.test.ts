import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main, type CliDependencies } from '../../src/cli/index.js';
import { defaultConfig } from '../../src/config/schema.js';
import { permissionPath } from '../../src/doctor/checks.js';
import { runCommand } from '../../src/process/runner.js';

let temporary: string; let root: string; let home: string;
const doctor = vi.fn<NonNullable<CliDependencies['runDoctor']>>(async () => []);
beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'quorum-init-'));
  root = path.join(temporary, 'repo'); home = path.join(temporary, 'home');
  await mkdir(root); await mkdir(home);
  expect((await runCommand('git', ['init'], { cwd: root })).exitCode).toBe(0);
  doctor.mockClear();
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });
async function init(args: string[] = [], dependencies: CliDependencies = {}) {
  let out = ''; let err = '';
  const code = await main(['init', ...args], { out: text => { out += text; }, err: text => { err += text; } },
    { repoRoot: root, runDoctor: doctor, homedir: home, ...dependencies });
  return { code, out, err };
}
async function config() { return JSON.parse(await readFile(path.join(root, 'quorum.config.json'), 'utf8')); }

it.each([
  ['pnpm-lock.yaml', undefined, 'pnpm', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']],
  ['package-lock.json', undefined, 'npm', ['npm', 'ci']],
  ['yarn.lock', undefined, 'yarn', ['yarn', 'install', '--frozen-lockfile']],
  ['bun.lockb', undefined, 'bun', ['bun', 'install', '--frozen-lockfile']],
  ['package-lock.json', 'pnpm@9.15.0', 'pnpm', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']],
  ['pnpm-lock.yaml', 'yarn@4.5.0', 'yarn', ['yarn', 'install', '--immutable']],
  ['yarn.lock', 'yarn@1.22.22', 'yarn', ['yarn', 'install', '--frozen-lockfile']],
  [undefined, undefined, 'npm', ['npm', 'ci']],
] as const)('detects %s with packageManager %s', async (lock, packageManager, manager, setup) => {
  if (lock) await writeFile(path.join(root, lock), '');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager, scripts: { typecheck: 'tsc', lint: 'eslint', test: 'vitest', build: 'tsc' } }));
  const result = await init();
  expect(result.code, result.err).toBe(0);
  expect(await config()).toEqual({ setup: [[...setup]], checks: ['typecheck', 'lint', 'test'].map(script => [manager, 'run', script]),
    tiers: defaultConfig().tiers, budget: { checkTimeoutSeconds: 600 } });
  expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe('.quorum/\n');
  expect(doctor).toHaveBeenCalledWith(expect.objectContaining({ checks: expect.any(Array) }), { repoRoot: root, probe: false, homedir: home });
  expect(result.out).toContain(`read_file(${permissionPath(path.join(root, '.quorum', 'worktrees'))})`);
  expect(result.out).toContain('~/.gemini/antigravity-cli/settings.json');
  expect(result.out).toContain('base branch');
  expect(result.out).toContain('quorum review --diff origin/main...HEAD --dry-run');
});

it.each([{}, { build: 'tsc' }, { lint: 'eslint' }])('only includes supported existing checks: %j', async scripts => {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts }));
  expect((await init()).code).toBe(0);
  expect((await config()).checks).toEqual('lint' in scripts ? [['npm', 'run', 'lint']] : []);
  expect((await config()).budget).toBeUndefined();
});

it('recognizes Berry lock metadata without packageManager', async () => {
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'yarn.lock'), '# Synthetic Berry lockfile\n__metadata:\n  version: 8\n');
  expect((await init()).code).toBe(0);
  expect((await config()).setup).toEqual([['yarn', 'install', '--immutable']]);
});

it('detects Berry from the head of a lockfile larger than the bounded-read limit', async () => {
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(root, 'yarn.lock'), '__metadata:\n  version: 8\n' + '# synthetic\n'.repeat(800_000));
  expect((await init()).code).toBe(0);
  expect((await config()).setup).toEqual([['yarn', 'install', '--immutable']]);
});

it('requires the repository root before writing files', async () => {
  const child = path.join(root, 'child'); await mkdir(child);
  const result = await init([], { repoRoot: child });
  expect(result.code).toBe(2); expect(result.err).toContain('repository root');
  expect(await readdir(child)).toEqual([]); expect(doctor).not.toHaveBeenCalled();
});

it.each(['invalid JSON', '[]', '{"packageManager":"unknown@1.0.0"}'])('rejects invalid manifests without writing files: %s', async manifest => {
  await writeFile(path.join(root, 'package.json'), manifest);
  expect((await init()).code).toBe(2);
  expect(await readdir(root)).toEqual(['.git', 'package.json']); expect(doctor).not.toHaveBeenCalled();
});

it('handles a repository without package.json and never writes the injected home', async () => {
  const settings = path.join(home, '.gemini', 'antigravity-cli'); await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, 'settings.json'), '{"synthetic":true}\n');
  const result = await init();
  expect(result.code).toBe(0); expect(result.out).toContain('No package.json');
  expect(await config()).toEqual({ checks: [], setup: [], tiers: defaultConfig().tiers });
  expect(await readFile(path.join(settings, 'settings.json'), 'utf8')).toBe('{"synthetic":true}\n');
  expect(await readdir(temporary)).toEqual(['home', 'repo']);
});

it('refuses an existing config before editing gitignore and allows --force', async () => {
  await writeFile(path.join(root, 'quorum.config.json'), '{"existing":true}');
  const result = await init();
  expect(result.code).toBe(2); expect(result.err).toContain('--force'); expect(doctor).not.toHaveBeenCalled();
  expect(await readFile(path.join(root, 'quorum.config.json'), 'utf8')).toBe('{"existing":true}');
  expect(await readdir(root)).not.toContain('.gitignore');
  expect((await init(['--force'])).code).toBe(0); expect((await config()).checks).toEqual([]);
});

it('dry-run prints the proposed file without doctor calls or writes, including existing config', async () => {
  await writeFile(path.join(root, 'quorum.config.json'), 'existing');
  const before = await readdir(root);
  const result = await init(['--dry-run']);
  expect(result.code).toBe(0); expect(result.out).toContain('"checks": []');
  expect(result.out).toContain('.quorum/'); expect(doctor).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual(before);
  expect(await readFile(path.join(root, 'quorum.config.json'), 'utf8')).toBe('existing');
});

it.each(['node_modules/\n', 'node_modules/\r\n', 'node_modules/', '.quorum/\n', '/.quorum/\r\n'])('preserves line endings and gitignore idempotence: %j', async original => {
  await writeFile(path.join(root, '.gitignore'), original);
  expect((await init()).code).toBe(0);
  const first = await readFile(path.join(root, '.gitignore'), 'utf8');
  const ending = original.includes('\r\n') ? '\r\n' : '\n';
  expect(first).toBe(original.includes('.quorum/') ? original : original + (original.endsWith('\n') ? '' : ending) + '.quorum/' + ending);
  expect((await init(['--force'])).code).toBe(0);
  expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(first);
});

it.each(['.quorum/\n!dist/\n', '.quorum\n', '.quorum/\n!.gitignore\n'])('keeps .quorum ignored despite unrelated negations: %j', async original => {
  await writeFile(path.join(root, '.gitignore'), original);
  expect((await init()).code).toBe(0);
  expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(original);
});

it.each(['.quorum/\n!.quorum/\n', '.quorum/\n!/.quorum/reports/\n', ' .quorum/\n'])('adds an effective ignore after negation or a different leading-space pattern: %j', async original => {
  await writeFile(path.join(root, '.gitignore'), original);
  expect((await init()).code).toBe(0);
  expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(original + '.quorum/\n');
  expect((await init(['--force'])).code).toBe(0);
  expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(original + '.quorum/\n');
});

it.each(['quorum.config.json', '.gitignore'])('refuses linked %s without touching outside files', async name => {
  const outside = path.join(home, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, path.join(root, name), 'junction');
  const result = await init(['--force']);
  expect(result.code).toBe(2); expect(result.err).toMatch(/regular|symlink/);
  expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  expect(await readdir(outside)).toEqual(['sentinel']);
  expect(doctor).not.toHaveBeenCalled();
});

it('prints doctor failures and next steps and returns its failure status', async () => {
  const result = await init([], { runDoctor: async () => [{ id: 'synthetic', status: 'FAIL', message: 'Unavailable', fix: 'Install it' }] });
  expect(result.code).toBe(2); expect(result.out).toContain('[FAIL] synthetic: Unavailable');
  expect(result.out).toContain('Fix: Install it'); expect(result.out).toContain('base branch');
  expect((await config()).checks).toEqual([]);
});

it.each([['--probe'], ['--mode', 'general'], ['extra']])('rejects unsupported init arguments %j', async (...args) => {
  expect((await init(args)).code).toBe(2); expect(await readdir(root)).toEqual(['.git']);
});
