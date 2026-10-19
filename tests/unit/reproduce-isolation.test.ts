import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/schema.js';
import { CommandTimeoutError } from '../../src/process/runner.js';
import { DEFAULT_REPRODUCE_IMAGE, REPORT_WRAPPER, runIsolatedTest } from '../../src/reproduce/isolation.js';
import type { CommandRunner } from '../../src/types/index.js';

const config = defaultConfig().reproduce;
const lock = 'synthetic-lockfile';
const hash = createHash('sha256').update(lock).digest('hex');
const identity = createHash('sha256').update(JSON.stringify([DEFAULT_REPRODUCE_IMAGE, 'pnpm', '10.0.0'])).digest('hex');
const resolver = { platform: 'linux' as const, env: { PATH: '/tools' }, exists: () => true };
const report = {
  numTotalTests: 1, numFailedTests: 1, success: false,
  testResults: [{ name: '/work/src/repro.test.ts', status: 'failed', assertionResults: [
    { fullName: 'synthetic assertion', status: 'failed', failureMessages: ['AssertionError: expected true to be false'] },
  ] }],
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'quorum-isolation-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), lock);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fake(options: { cached?: boolean; diagnostic?: string; missingReport?: boolean; installFailure?: boolean; timeout?: boolean } = {}) {
  return vi.fn<CommandRunner>(async (_command, args) => {
    if (args[0] === 'image') return { stdout: options.cached ? identity : '', stderr: '', exitCode: options.cached ? 0 : 1 };
    if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: '', stderr: '', exitCode: options.cached ? 0 : 1 };
    if (args[0] === 'build') {
      const context = args.at(-1)!;
      expect(await readdir(context)).toEqual(['Dockerfile']);
      const dockerfile = await readFile(path.join(context, 'Dockerfile'), 'utf8');
      expect(dockerfile).toContain(`FROM ${DEFAULT_REPRODUCE_IMAGE}`);
      expect(dockerfile).toContain('RUN ["npm","install","-g","pnpm@10.0.0"]');
      expect(dockerfile).not.toMatch(/COPY|ADD/);
    }
    if (options.installFailure && args.includes('--frozen-lockfile')) return { stdout: '', stderr: 'install failed', exitCode: 1 };
    if (args.includes(REPORT_WRAPPER)) {
      if (options.timeout) throw new CommandTimeoutError('', '');
      const marker = args[args.indexOf(REPORT_WRAPPER) + 1]!;
      return { stdout: options.missingReport ? '' : marker + JSON.stringify(report), stderr: options.diagnostic ?? '', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

it('builds from a Dockerfile-only context and installs the pinned manager with frozen dependencies', async () => {
  const runner = fake();
  const result = await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver });
  expect(result.reason).toBeUndefined();
  expect(result.report?.tests).toHaveLength(1);
  const build = runner.mock.calls.find(([, args]) => args[0] === 'build')![1];
  expect(build.slice(0, -1)).toEqual(['build', '--network', 'default', '--label', `quorum.preparation=${identity}`, '--tag', `quorum-prep:${hash}`]);
  await expect(readdir(build.at(-1)!)).rejects.toMatchObject({ code: 'ENOENT' });
  const prep = runner.mock.calls.find(([, args]) => args.includes('--frozen-lockfile'))![1];
  expect(prep).toEqual(['run', '--name', prep[2]!, '--rm', '--network', 'default', '--user', '1000:1000', '--workdir', '/work',
    '--mount', `type=bind,src=${root},dst=/work,readonly`, '--mount', `type=volume,src=quorum-deps-${hash},dst=/work/node_modules`,
    '--env', 'XDG_CACHE_HOME=/tmp', '--env', 'npm_config_cache=/tmp', '--env', 'TMPDIR=/tmp',
    '--env', 'npm_config_store_dir=/work/node_modules/.pnpm-store', `quorum-prep:${hash}`, 'pnpm', 'install', '--frozen-lockfile']);
});

it('runs only the proposed test with exact isolated argv and the JSON report in tmpfs', async () => {
  const runner = fake();
  await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver });
  const call = runner.mock.calls.find(([, args]) => args.includes(REPORT_WRAPPER))!;
  const args = call[1];
  const name = args[3]!;
  const marker = args.at(-3)!;
  const reportPath = args.at(-2)!;
  expect(name).toMatch(/^quorum-test-/);
  expect(reportPath).toMatch(/^\/tmp\/quorum-[\w-]+\.json$/);
  expect(marker).toMatch(/^QUORUM_REPORT_[\w-]+:$/);
  expect(args).toEqual(['run', '--rm', '--name', name, '--network', 'none', '--user', '1000:1000',
    '--read-only', '--tmpfs', '/tmp', '--workdir', '/work',
    '--mount', `type=bind,src=${root},dst=/work`, '--mount', `type=volume,src=quorum-deps-${hash},dst=/work/node_modules,readonly`,
    '--env', 'XDG_CACHE_HOME=/tmp', '--env', 'npm_config_cache=/tmp', '--env', 'TMPDIR=/tmp',
    '--memory', '1g', '--pids-limit', '256', '--cpus', '2', '--security-opt', 'no-new-privileges',
    `quorum-prep:${hash}`, 'node', '-e', REPORT_WRAPPER, marker, reportPath,
    JSON.stringify(['pnpm', 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`, './src/repro.test.ts'])]);
  expect(call[2]?.timeoutMs).toBe(120000);
});

it('blocks the synthetic escape test through network, root filesystem and mount boundaries', async () => {
  const escape = await readFile('tests/fixtures/repro-repo/escape.test.js', 'utf8');
  expect(escape).toContain("writeFileSync('/quorum-escape'");
  expect(escape).toContain('createConnection');
  const runner = fake();
  await runIsolatedTest(root, 'escape.test.js', config, runner, { resolveOptions: resolver });
  const args = runner.mock.calls.find(([, argv]) => argv.includes(REPORT_WRAPPER))![1];
  expect(args[args.indexOf('--network') + 1]).toBe('none');
  expect(args).toContain('--read-only');
  const mounts = args.flatMap((part, index) => part === '--mount' ? [args[index + 1]!] : []);
  expect(mounts).toEqual([`type=bind,src=${root},dst=/work`, `type=volume,src=quorum-deps-${hash},dst=/work/node_modules,readonly`]);
  expect(args).not.toContain('--privileged');
  expect(args).not.toContain('--volume');
});

it('reuses a completed lockfile volume without reinstalling or rebuilding', async () => {
  const runner = fake({ cached: true });
  await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver });
  expect(runner.mock.calls.some(([, args]) => args[0] === 'build')).toBe(false);
  expect(runner.mock.calls.some(([, args]) => args.includes('--frozen-lockfile'))).toBe(false);
  expect(runner.mock.calls.some(([, args]) => args.some(arg => arg.includes('.quorum-ready')))).toBe(true);
});

it('uses podman when docker is unavailable, without executing a test on the host', async () => {
  const runner = fake();
  const options = { ...resolver, exists: (file: string) => file.endsWith('podman') };
  await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: options });
  expect(runner.mock.calls.every(([command]) => command === '/tools/podman')).toBe(true);
  const prep = runner.mock.calls.find(([, args]) => args.includes('--frozen-lockfile'))![1];
  expect(prep[prep.indexOf('--network') + 1]).toBe('private');
  const build = runner.mock.calls.find(([, args]) => args[0] === 'build')![1];
  expect(build[build.indexOf('--network') + 1]).toBe('private');
});

it('reports no runtime without executing anything when neither executable exists', async () => {
  const runner = fake();
  expect(await runIsolatedTest(root, 'src/repro.test.ts', config, runner, {
    resolveOptions: { ...resolver, exists: () => false },
  })).toMatchObject({ reason: 'no container runtime', report: null });
  expect(runner).not.toHaveBeenCalled();
});

it('does not mistake installed clients with unavailable daemons for runtimes', async () => {
  const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 1, stdout: '', stderr: 'daemon unavailable' }));
  expect((await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver })).reason).toBe('no container runtime');
  expect(runner.mock.calls.map(([command]) => command)).toEqual(['/tools/docker', '/tools/podman']);
});

it('removes a failed preparation volume so the next run cannot reuse it', async () => {
  const runner = fake({ installFailure: true });
  expect((await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver })).reason).toBe('preparation failed: dependency installation');
  expect(runner.mock.calls.some(([, args]) => args.includes(REPORT_WRAPPER))).toBe(false);
  expect(runner.mock.calls.some(([, args]) => JSON.stringify(args) === JSON.stringify(['volume', 'rm', `quorum-deps-${hash}`]))).toBe(true);
});

it('kills the named container on the runner deadline and force-removes it', async () => {
  const runner = fake({ timeout: true });
  expect(await runIsolatedTest(root, 'src/repro.test.ts', { ...config, timeoutSeconds: 3 }, runner, { resolveOptions: resolver }))
    .toMatchObject({ reason: 'container timeout', timedOut: true });
  const call = runner.mock.calls.find(([, args]) => args.includes(REPORT_WRAPPER))!;
  expect(call[2]?.timeoutMs).toBe(3000);
  const name = call[1][3]!;
  expect(runner.mock.calls.some(([, args]) => args[0] === 'kill' && args[1] === name)).toBe(true);
  expect(runner.mock.calls.some(([, args]) => args[0] === 'rm' && args[2] === name)).toBe(true);
});

it('kills and removes a timed-out preparation container before removing its volume', async () => {
  const runner = fake();
  const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (command, args, options) => {
    if (args.includes('--frozen-lockfile')) throw new CommandTimeoutError('', '');
    return original(command, args, options);
  });
  expect((await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver })).reason).toBe('container timeout');
  const prep = runner.mock.calls.find(([, args]) => args.includes('--frozen-lockfile'))![1];
  const name = prep[prep.indexOf('--name') + 1]!;
  expect(name).toMatch(/^quorum-preparation-/);
  const killed = runner.mock.calls.findIndex(([, args]) => args[0] === 'kill' && args[1] === name);
  const removed = runner.mock.calls.findIndex(([, args]) => args[0] === 'rm' && args[2] === name);
  const volumeRemoved = runner.mock.calls.findIndex(([, args]) => args[0] === 'volume' && args[1] === 'rm');
  expect(killed).toBeGreaterThan(0);
  expect(removed).toBeGreaterThan(killed);
  expect(volumeRemoved).toBeGreaterThan(removed);
});

it('interprets the supplied deadline as remaining duration, not an epoch', async () => {
  const runner = fake();
  const result = await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver, deadlineMs: 500, now: () => 1000000000 });
  expect(result.reason).toBeUndefined();
  expect(runner.mock.calls.find(([, args]) => args.includes(REPORT_WRAPPER))![2]?.timeoutMs).toBe(500);
});

describe('infrastructure failures', () => {
  it.each(['EROFS: read-only file system, mkdir /work/node_modules/.vite', 'EACCES: permission denied, mkdir /work/node_modules/.cache', 'pnpm: command not found'])('%s remains unproven', async diagnostic => {
    const result = await runIsolatedTest(root, 'src/repro.test.ts', config, fake({ diagnostic }), { resolveOptions: resolver });
    expect(result.reason).toBeDefined();
  });
  it('rejects a missing report', async () => {
    expect((await runIsolatedTest(root, 'src/repro.test.ts', config, fake({ missingReport: true }), { resolveOptions: resolver })).reason).toBe('missing test report');
  });
  it.each(['pnpm', 'pnpm@latest', 'pnpm@1.2.3\nRUN evil', 'curl@1.2.3'])('rejects unpinned or injected manager %s', async packageManager => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager }));
    const runner = fake();
    expect((await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver })).reason).toContain('packageManager');
    expect(runner.mock.calls).toHaveLength(1);
  });
});

it.each([
  ['npm', 'package-lock.json', ['npm', 'ci']],
  ['yarn', 'yarn.lock', ['yarn', 'install', '--immutable']],
] as const)('uses the frozen command for %s', async (manager, lockfile, command) => {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: `${manager}@10.0.0` }));
  await writeFile(path.join(root, lockfile), lock);
  const runner = vi.fn<CommandRunner>(async (_file, args) => {
    if (args[0] === 'volume' && args[1] === 'inspect') return { exitCode: 1, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver });
  expect(runner.mock.calls.some(([, args]) => JSON.stringify(args.slice(-command.length)) === JSON.stringify(command))).toBe(true);
});

it('rejects Dockerfile image injection before building', async () => {
  const runner = fake();
  expect((await runIsolatedTest(root, 'src/repro.test.ts', { ...config, image: 'node:22\nRUN evil' }, runner, { resolveOptions: resolver })).reason)
    .toBe('preparation failed: invalid image reference');
  expect(runner.mock.calls).toHaveLength(1);
});

it('refuses a cached volume without its completed installation marker', async () => {
  const runner = fake({ cached: true });
  const original = runner.getMockImplementation()!;
  runner.mockImplementation(async (command, args, options) => args.some(arg => arg.includes('readFileSync') && arg.includes('.quorum-ready'))
    ? { exitCode: 1, stdout: '', stderr: 'ENOENT' } : original(command, args, options));
  expect((await runIsolatedTest(root, 'src/repro.test.ts', config, runner, { resolveOptions: resolver })).reason)
    .toBe('preparation failed: incomplete or incompatible dependency volume');
  expect(runner.mock.calls.some(([, args]) => args.includes(REPORT_WRAPPER))).toBe(false);
});
