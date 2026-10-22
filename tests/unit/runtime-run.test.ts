import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runRuntimeEvidence, playwrightVolume, runtimePayload } from '../../src/runtime/run.js';
import { DEFAULT_RUNTIME_IMAGE, PLAYWRIGHT_CORE } from '../../src/runtime/image.js';
import { defaultConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/schema.js';
import { createReviewWorktree } from '../../src/worktree/index.js';
import { CommandTimeoutError } from '../../src/process/runner.js';
import { REPORT_BYTES } from '../../src/runtime/report.js';
import { RUNNER_CACHE_DIRS } from '../../src/reproduce/isolation.js';
import type { CommandRunner, ReviewContext } from '../../src/types/index.js';

vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: vi.fn() }));
let root: string; let trees: string[]; let cleanups: ReturnType<typeof vi.fn>[];
const resolver = { platform: 'linux' as const, env: { PATH: '/tools' }, exists: () => true };
const config = () => validateConfig({ checks: [], budget: { maxMinutes: 10 }, runtime: { start: ['node', 'server.cjs'], readyUrl: 'http://127.0.0.1:4173/',
  flows: [{ name: 'home', steps: [{ goto: '/' }, { fill: '#input', value: 'PRIVATE_VALUE' }] }] } });
const context: ReviewContext = { mode: 'runtime', diff: '', baseCommit: 'a'.repeat(40), mergeBaseCommit: 'c'.repeat(40), headCommit: 'b'.repeat(40), worktreeRoot: '.', touchedFiles: [] };
const report = { version: 1, runs: [1, 2].map(run => ({ flow: 'home', run, completed: true, observations: [], blockedExternal: {}, notes: [] })) };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'quorum-runtime-unit-')); trees = []; cleanups = [];
  vi.mocked(createReviewWorktree).mockReset().mockImplementation(async () => {
    const directory = path.join(root, String(trees.length)); await mkdir(directory); trees.push(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ packageManager: 'npm@11.0.0' }));
    await writeFile(path.join(directory, 'package-lock.json'), '{}');
    const cleanup = vi.fn(async () => { await rm(directory, { recursive: true, force: true }); }); cleanups.push(cleanup);
    return { path: directory, cleanup };
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.useRealTimers(); });

function fake(options: { ready?: boolean; mismatch?: boolean; timeout?: boolean; throws?: boolean; error?: object; daemon?: boolean } = {}) {
  return vi.fn<CommandRunner>(async (_file, args) => {
    const result = { stdout: '', stderr: '', exitCode: 0 };
    if (args[0] === 'info') return { ...result, exitCode: options.daemon === false ? 1 : 0 };
    if (args[0] === 'image' || args[0] === 'volume' && args[1] === 'inspect') return { ...result, exitCode: 1 };
    if (args.some(arg => arg.includes("readFileSync(root + '/.quorum-ready'"))) return { ...result, exitCode: options.ready ? 0 : 1 };
    if (args.some(arg => arg.includes("writeFileSync(root + '/.quorum-ready'"))) return { ...result, exitCode: options.mismatch ? 42 : 0 };
    if (args.includes('/quorum/bin/runner.cjs')) {
      if (options.timeout) throw new CommandTimeoutError('PRIVATE_VALUE', 'PRIVATE_VALUE');
      if (options.throws) throw new Error('PRIVATE_VALUE');
      const marker = args.at(-2)!;
      return { ...result, stdout: 'QUORUM_RUNTIME_FORGED:{}\n' + marker + '{}' + '\n' + marker + JSON.stringify(options.error ?? report) + '\n' };
    }
    return result;
  });
}
function execute(containerRunner = fake(), extra = {}, value = config()) {
  return runRuntimeEvidence(context, value, { root, gitRunner: async () => { throw new Error('unexpected git'); }, containerRunner, resolveOptions: resolver, ...extra });
}

it('reports unavailable when no container runtime exists', async () => {
  const result = await runRuntimeEvidence({ mode: 'runtime', diff: '', baseCommit: 'a', headCommit: 'b', worktreeRoot: '.', touchedFiles: [] }, { ...defaultConfig(), checks: [] }, {
    root: '.', gitRunner: async () => { throw new Error('unexpected git'); }, containerRunner: async () => { throw new Error('missing'); },
  });
  expect(result).toMatchObject({ available: false, reasons: ['no container runtime'] });
});

it('runs merge-base then head with exact locked-down argv and only readonly run mounts', async () => {
  const runner = fake(); const announce = vi.fn(); const result = await execute(runner, { announce, now: () => 1000 });
  expect(result.available).toBe(true); expect(result.base?.stable.flows.home?.size).toBe(0);
  expect(vi.mocked(createReviewWorktree).mock.calls.map(call => call[1])).toEqual([context.mergeBaseCommit, context.headCommit]);
  expect(announce).toHaveBeenCalledOnce(); expect(announce.mock.calls[0]![0]).toMatch(/code and install scripts.*refuses --no-checks/);
  const runs = runner.mock.calls.filter(([, args]) => args.includes('/quorum/bin/runner.cjs'));
  expect(runs).toHaveLength(2);
  for (const [, args, options] of runs) {
    const mount = args.find(arg => arg.includes('dst=/quorum/bin'))!;
    const image = args.find(arg => arg.startsWith('quorum-prep:'))!;
    const deps = args.find(arg => arg.startsWith('type=volume,src=quorum-deps-'))!;
    const work = args.find(arg => arg.includes('dst=/work,readonly'))!;
    expect(args).toEqual(['run', '--name', args[2], '--rm', '--network', 'none', '--user', '1001:1001', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm:rw,size=512m',
      '--memory', '2048m', '--pids-limit', '512', '--cpus', '2', '--workdir', '/work', '--env', 'HOME=/tmp',
      '--mount', work, '--mount', deps,
      ...RUNNER_CACHE_DIRS.flatMap(dir => ['--tmpfs', `/work/node_modules/${dir}:rw,uid=1001,gid=1001,mode=0700`]),
      '--mount', `type=volume,src=${playwrightVolume(DEFAULT_RUNTIME_IMAGE)},dst=/quorum/playwright,readonly`, '--mount', mount,
      image, 'node', '/quorum/bin/runner.cjs', '/quorum/bin/plan.json', args.at(-2), '["node","server.cjs"]']);
    expect(args[2]).toMatch(/^quorum-runtime-[\da-f-]+$/); expect(options?.timeoutMs).toBe(210000);
    expect(options?.maxOutputBytes).toBe(REPORT_BYTES + 4096);
    for (let i = 0; i < args.length; i++) if (args[i] === '--mount') expect(args[i + 1]).toMatch(/,readonly$/);
    await expect(access(mount.split('src=')[1]!.split(',dst=')[0]!)).rejects.toThrow();
  }
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
});

it('hardens every container and reserves network for installation; CHOWN is the only added capability', async () => {
  const runner = fake(); await execute(runner);
  for (const [, args, options] of runner.mock.calls) {
    expect(args.join(' ')).not.toMatch(/--privileged|seccomp=unconfined|--network host|--pid host|docker\.sock|podman\.sock|PRIVATE_VALUE/);
    expect(options?.env).toBeUndefined();
    if (args.includes('--cap-add')) { expect(args[args.indexOf('--cap-add') + 1]).toBe('CHOWN'); expect(args).toContain('chown'); }
    if (args[0] !== 'run') continue;
    expect(args).toContain('--read-only'); expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    if (args[args.indexOf('--network') + 1] !== 'none') expect(args.includes('install') || args.includes('ci')).toBe(true);
  }
  const install = runner.mock.calls.filter(([, args]) => args.includes('playwright-core@1.64.0'));
  expect(install).toHaveLength(1); expect(install[0]![1]).toEqual(expect.arrayContaining(['--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']));
  // A --workdir on the volume mount point makes Docker recreate it as root and undo the chown
  // (seen on Docker 29.8.1); the install must target the volume with --prefix instead.
  const installArgs = install[0]![1] as string[];
  expect(installArgs).not.toContain('--workdir');
  expect(installArgs[installArgs.indexOf('--prefix') + 1]).toBe('/quorum/playwright');
});

it('keys playwright volumes by image and integrity; uses a ready marker without reinstalling', async () => {
  const runner = fake({ ready: true }); const warn = vi.fn(); const value = config(); value.runtime!.image = 'custom@sha256:' + 'A'.repeat(64);
  await execute(runner, { warn }, value);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('pairing is unverified'));
  expect(playwrightVolume(value.runtime!.image)).not.toBe(playwrightVolume(DEFAULT_RUNTIME_IMAGE));
  expect(runner.mock.calls.some(([, args]) => args.includes('playwright-core@1.64.0'))).toBe(false);
  expect(runner.mock.calls.some(([, args]) => args[0] === 'pull')).toBe(false);
  const check = runner.mock.calls.find(([, args]) => args.some(arg => arg.includes("readFileSync(root + '/.quorum-ready'")))![1];
  expect(check.join(' ')).toContain(PLAYWRIGHT_CORE.integrity); expect(check.join(' ')).toContain('pkg.version');
  expect(check.join(' ')).toContain(playwrightVolume(value.runtime!.image));
});

it('removes a mismatched playwright volume and leaves both sides unavailable', async () => {
  const runner = fake({ mismatch: true }); const result = await execute(runner);
  expect(result.available).toBe(false); expect(result.reasons).toEqual(['base: playwright-core integrity mismatch', 'head: playwright-core integrity mismatch']);
  expect(runner.mock.calls.filter(([, args]) => args[0] === 'volume' && args[1] === 'rm' && args[2] === playwrightVolume(DEFAULT_RUNTIME_IMAGE)).length).toBeGreaterThanOrEqual(2);
  expect(runner.mock.calls.some(([, args]) => args.includes('/quorum/bin/runner.cjs'))).toBe(false);
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
});

it.each([{ timeout: true }, { throws: true }])('cleans up failures and kills timed-out containers by name (%j)', async options => {
  const runner = fake(options); const result = await execute(runner);
  expect(result.available).toBe(false); expect(result.reasons.join()).not.toContain('PRIVATE_VALUE');
  if (options.timeout) {
    expect(result.reasons).toEqual(['base: timeout', 'head: timeout']);
    for (const [, args] of runner.mock.calls.filter(([, args]) => args.includes('/quorum/bin/runner.cjs'))) {
      expect(runner.mock.calls.some(([, call]) => call[0] === 'kill' && call[1] === args[2])).toBe(true);
    }
  }
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
});

it('caps the run timeout by the remaining global budget', async () => {
  const runner = fake(); const value = config(); value.budget.maxMinutes = 1;
  await execute(runner, { now: () => 1000 }, value);
  expect(runner.mock.calls.filter(([, args]) => args.includes('/quorum/bin/runner.cjs')).map(call => call[2]?.timeoutMs)).toEqual([60000, 60000]);
});

it.each([
  [{ error: 'not-ready', stderrTail: '\u001b[31mPRIVATE_VALUE\u0000' }, 'app did not become ready'],
  [{ error: 'app-exited', exitCode: 7, stderrTail: 'PRIVATE_VALUE' }, 'app exited before ready (exit 7)'],
])('maps runner errors without exposing app output or fill values', async (error, reason) => {
  const warn = vi.fn(); const announce = vi.fn(); const result = await execute(fake({ error }), { warn, announce });
  expect(result.reasons).toEqual([`base: ${reason}`, `head: ${reason}`]);
  expect(result.notes).toEqual(['base: [redacted]', 'head: [redacted]']);
  expect(JSON.stringify([result, warn.mock.calls, announce.mock.calls])).not.toContain('PRIVATE_VALUE');
});

it('passes only collector plan fields in the readonly temp directory and removes it', async () => {
  const runner = fake(); const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (command, args, options) => {
    if (args.includes('/quorum/bin/runner.cjs')) {
      const mount = args.find(arg => arg.includes('dst=/quorum/bin'))!;
      const directory = mount.split('src=')[1]!.split(',dst=')[0]!;
      const plan = JSON.parse(await readFile(path.join(directory, 'plan.json'), 'utf8'));
      expect(Object.keys(plan).sort()).toEqual(['readyUrl', 'readyTimeoutSeconds', 'flowTimeoutSeconds', 'stepTimeoutSeconds', 'screenshots', 'flows'].sort());
      expect(plan.flows[0].steps[1].value).toBe('PRIVATE_VALUE');
      expect(await readFile(path.join(directory, 'collector.cjs'), 'utf8')).toContain("require('/quorum/playwright/node_modules/playwright-core')");
    }
    return original(command, args, options);
  });
  expect((await execute(runner)).available).toBe(true);
});

it('selects the last fresh marker, rejects oversized/invalid reports and redacts report notes', () => {
  const runtime = config().runtime!; const marker = 'FRESH:';
  expect(runtimePayload('FORGED:{}' + marker + '{}' + marker + JSON.stringify(report), marker, runtime)).toEqual(report);
  expect(runtimePayload(marker + 'x'.repeat(REPORT_BYTES + 1), marker, runtime)).toEqual({ error: 'Invalid runtime report' });
  expect(runtimePayload('other marker{}', marker, runtime)).toEqual({ error: 'missing runtime report' });
  expect(runtimePayload(marker + '{bad}', marker, runtime)).toEqual({ error: 'Invalid runtime report' });
  const raw = structuredClone(report); raw.runs[0]!.notes = ['PRIVATE_VALUE'] as never[];
  expect(JSON.stringify(runtimePayload(marker + JSON.stringify(raw), marker, runtime))).not.toContain('PRIVATE_VALUE');
});

it('runs setup offline before collection and suppresses a failed setup output', async () => {
  const value = config(); value.setup = [['node', 'setup.cjs']]; const runner = fake(); const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (command, args, options) => args.includes('setup.cjs')
    ? { exitCode: 1, stdout: 'PRIVATE_VALUE', stderr: 'PRIVATE_VALUE' } : original(command, args, options));
  const result = await execute(runner, {}, value);
  expect(result.available).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
  expect(runner.mock.calls.some(([, args]) => args.includes('/quorum/bin/runner.cjs'))).toBe(false);
  const setup = runner.mock.calls.filter(([, args]) => args.includes('setup.cjs'));
  expect(setup).toHaveLength(2);
  for (const [, args] of setup) expect(args[args.indexOf('--network') + 1]).toBe('none');
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
});

it('cleans both worktrees after a preparation exception without surfacing its message', async () => {
  const runner = fake(); const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (command, args, options) => {
    if (args.includes('playwright-core@1.64.0')) throw new Error('PRIVATE_VALUE');
    return original(command, args, options);
  });
  const result = await execute(runner); expect(result.available).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
  expect(cleanups).toHaveLength(2); for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
});

it('uses the runtime image and UID in dependency preparation and keys app volumes by metadata', async () => {
  const runner = fake(); const original = runner.getMockImplementation()!; const dockerfiles: string[] = [];
  runner.mockImplementation(async (command, args, options) => {
    if (args[0] === 'build') dockerfiles.push(await readFile(path.join(args.at(-1)!, 'Dockerfile'), 'utf8'));
    return original(command, args, options);
  });
  await execute(runner);
  expect(dockerfiles).toHaveLength(2);
  for (const content of dockerfiles) { expect(content).toContain(`FROM ${DEFAULT_RUNTIME_IMAGE}`); expect(content).toContain('"chown","1001:1001"'); }
  const volumes = runner.mock.calls.filter(([, args]) => args[0] === 'volume' && args[1] === 'create' && args[2]!.startsWith('quorum-deps-')).map(call => call[1][2]);
  expect(volumes[0]).toBe(volumes[1]); expect(volumes[0]).toMatch(/^quorum-deps-[a-f0-9]{64}-uid-1001-1001$/);
});

it('tries Podman after an unavailable Docker daemon', async () => {
  const runner = fake({ ready: true }); const original = runner.getMockImplementation()!;
  runner.mockImplementation((command, args, options) => command.endsWith('docker')
    ? Promise.resolve({ stdout: '', stderr: '', exitCode: 1 }) : original(command, args, options));
  expect((await execute(runner)).available).toBe(true);
  expect(runner.mock.calls.filter(([, args]) => args[0] === 'run').every(([command]) => command === '/tools/podman')).toBe(true);
  expect(runner.mock.calls.some(([, args]) => args.includes('private'))).toBe(true);
});

it('kills by the wall-clock deadline even when the client has not reported a timeout', async () => {
  vi.useFakeTimers(); const runner = fake({ ready: true }); const original = runner.getMockImplementation()!;
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
  const stopped = new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => { finish = resolve; });
  runner.mockImplementation(async (command, args, options) => {
    if (args.includes('/quorum/bin/runner.cjs')) { entered(); return stopped; }
    if (args[0] === 'kill') finish({ exitCode: 137, stdout: '', stderr: '' });
    return original(command, args, options);
  });
  const value = config(); value.budget.maxMinutes = 0.001;
  const pending = execute(runner, {}, value); await started; await vi.advanceTimersByTimeAsync(60);
  const result = await pending;
  expect(result.reasons).toEqual(['base: timeout', 'head: timeout']);
  expect(runner.mock.calls.filter(([, args]) => args[0] === 'kill')).toHaveLength(1);
  expect(cleanups).toHaveLength(1); expect(cleanups[0]).toHaveBeenCalledOnce();
});
