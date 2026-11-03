import { canonicalPath } from '../paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { machineTestCommand } from './command.js';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, type ResolveOptions } from '../checks/resolver.js';
import { CommandTimeoutError } from '../process/runner.js';
import type { CommandRunner, QuorumConfig, TestReport } from '../types/index.js';
import { infrastructureFailure, parseTestReport } from './evaluate.js';

// The multi-platform index digest, read from the registry on 2026-10-19 with
// `docker buildx imagetools inspect node:22-bookworm-slim`. To update it, run the same
// command, take the top-level Digest line, then run the opt-in container test.
export const DEFAULT_REPRODUCE_IMAGE = 'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392';

export interface IsolationOptions {
  warn?: (message: string) => void;
  resolveOptions?: ResolveOptions;
  // Remaining run budget in milliseconds, matching provider ReviewOptions.
  deadlineMs?: number;
  now?: () => number;
}

export interface IsolationResult {
  timedOut: boolean;
  report: TestReport | null;
  exitCode: number;
  reason?: string;
}

// No shell: the child receives an argv array; its reporter writes inside tmpfs.
// Only the wrapper reads that file and prints a fresh marker followed by JSON.
export const REPORT_WRAPPER = `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [marker, reportPath, encoded] = process.argv.slice(1);
const [command, ...args] = JSON.parse(encoded);
const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
if (result.error) process.stderr.write(result.error.message + '\\n');
try { process.stdout.write('\\n' + marker + fs.readFileSync(reportPath, 'utf8') + '\\n'); } catch {}
process.exitCode = result.status ?? 1;`;

const CACHE_ENV = ['--env', 'XDG_CACHE_HOME=/tmp', '--env', 'npm_config_cache=/tmp', '--env', 'TMPDIR=/tmp'];
const READY_FILE = '/work/node_modules/.quorum-ready';
// Directories that test runners write inside node_modules (vite bundles its config into .vite-temp).
// They are created in the writable preparation step and covered by tmpfs in the test step, so the
// dependency volume itself stays read-only. Bump LAYOUT when this list changes so old volumes rebuild.
export const RUNNER_CACHE_DIRS = ['.vite-temp', '.vite', '.vitest', '.cache'];
/**
 * `--tmpfs` arguments that make the runner cache directories writable for the container user.
 * Docker accepts uid/gid on a tmpfs; Podman rejects them ("unknown mount option uid"), so there the
 * directory is sticky and world-writable instead: it is private to this container and discarded with it.
 */
export function runnerCacheTmpfs(engine: string, uid: number): string[] {
  const options = engine === 'podman' ? 'rw,mode=1777' : `rw,uid=${uid},gid=${uid},mode=0700`;
  return RUNNER_CACHE_DIRS.flatMap(dir => ['--tmpfs', `/work/node_modules/${dir}:${options}`]);
}
const LAYOUT = 'layout-2';
export const PREPARATION_LIMITS = ['--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
  '--memory', '2g', '--pids-limit', '512', '--cpus', '2', '--read-only', '--tmpfs', '/tmp'];

// Hash names and raw bytes in stable order; never follow repository symlinks.
// Walking includes workspaces regardless of which manager/glob syntax they use.
export async function dependencyKey(root: string, lockfile: string, manager: string, version: string, image: string, scripts: boolean): Promise<string> {
  const inputs: string[] = [];
  let directories = 0;
  async function walk(relative = '', inPatches = false): Promise<void> {
    if (++directories > 10000) throw new Error('dependency metadata directory cap exceeded');
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const patches = inPatches || entry.name === 'patches' || name === '.yarn/releases' || name === '.yarn/plugins';
      const selected = inPatches || entry.name === 'package.json'
        || !relative && [lockfile, '.npmrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pnpm-workspace.yaml'].includes(entry.name);
      if (entry.isSymbolicLink()) {
        if (selected || patches) throw new Error('symlink dependency metadata');
        continue;
      }
      if (entry.isDirectory()) { await walk(name, patches); continue; }
      if (selected) {
        if (!entry.isFile()) throw new Error('invalid dependency metadata');
        if (inputs.length >= 500) throw new Error('dependency metadata file cap exceeded (500)');
        inputs.push(name);
      }
    }
  }
  await walk();
  const hash = createHash('sha256').update(JSON.stringify([manager, version, image, scripts]));
  for (const name of inputs.sort()) {
    const stat = await lstat(path.join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('invalid dependency metadata');
    const bytes = await readFile(path.join(root, name));
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
  }
  return hash.digest('hex');
}

function failure(reason: string, timedOut = false): IsolationResult {
  return { timedOut, report: null, exitCode: 1, reason };
}

async function regularFile(root: string, name: string): Promise<string> {
  const file = path.join(root, name);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
    throw new Error(`Invalid reproduction metadata: ${name}`);
  }
  return readFile(file, 'utf8');
}

export interface PreparedDependencies { root: string; image: string; dependencyMount: string }
type ContainerInvoke = (args: string[], limit?: number) => ReturnType<CommandRunner>;
const preparations = new Map<string, Promise<void>>();

async function lockPreparation(key: string): Promise<() => void> {
  const previous = preparations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  preparations.set(key, current);
  await previous;
  return () => { if (preparations.get(key) === current) preparations.delete(key); release(); };
}

// Shared preparation; the caller owns runtime detection and deadlines.
export async function prepareDependencies(worktreePath: string, config: QuorumConfig['reproduce'],
  invoke: ContainerInvoke, runAuxiliary: (args: string[]) => ReturnType<CommandRunner>, networkOn: string,
  options: { image?: string; user?: string; warn?: (message: string) => void } = {},
): Promise<PreparedDependencies | IsolationResult> {
  const user = options.user ?? '1000:1000';
  let volume: string | undefined;
  let createdVolume = false;
  let preparationComplete = false;
  let context: string | undefined;
  let release: (() => void) | undefined;
  let lease: string | undefined;
  try {
    // Canonical, so a container engine never receives an 8.3 alias it cannot resolve.
    const root = canonicalPath(path.resolve(worktreePath));
    // Docker's --mount syntax treats commas as separators; reject rather than
    // letting a repository name alter the mount configuration.
    if (root.includes(',') || /[\r\n\0]/.test(root)) return failure('unsupported worktree mount path');
    const modules = await lstat(path.join(root, 'node_modules')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (modules && (modules.isSymbolicLink() || !modules.isDirectory())) return failure('node_modules must be a directory, not a symlink or file');
    // The preparation step mounts the worktree read-only and the dependency volume at
    // /work/node_modules; Docker can't create that mount point inside a read-only bind
    // mount, so it must already exist. Git ignores an empty directory, so the worktree stays clean.
    if (!modules) await mkdir(path.join(root, 'node_modules'));
    const manifest = JSON.parse(await regularFile(root, 'package.json')) as { packageManager?: unknown };
    const manager = typeof manifest.packageManager === 'string'
      ? /^(pnpm|npm|yarn)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(manifest.packageManager)
      : null;
    if (!manager) return failure('preparation failed: packageManager must pin npm, pnpm or yarn to an exact version');
    const managerName = manager[1]!;
    const lockfile = managerName === 'pnpm' ? 'pnpm-lock.yaml' : managerName === 'npm' ? 'package-lock.json' : 'yarn.lock';
    await regularFile(root, lockfile);
    if (managerName === 'yarn' && !config.allowInstallScripts) {
      const yarnConfig = await regularFile(root, '.yarnrc.yml').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      // A bounded line scanner, not a YAML evaluator: only top-level keys.
      if (yarnConfig.replace(/^\uFEFF/, '').split(/\r?\n/).some(line => /^(?:yarnPath|plugins|"(?:yarnPath|plugins)"|'(?:yarnPath|plugins)')[ \t]*:/.test(line))) {
        return failure('yarn configuration runs repository code (set reproduce.allowInstallScripts to allow it)');
      }
    }
    let image = options.image ?? config.image ?? DEFAULT_REPRODUCE_IMAGE;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(image)) return failure('preparation failed: invalid image reference');
    if (!/@sha256:[a-f0-9]{64}$/i.test(image)) {
      const pulled = await invoke(['pull', image]);
      if (pulled.exitCode !== 0) return failure('preparation failed: image digest resolution');
      const inspected = await invoke(['image', 'inspect', '--format', '{{json .RepoDigests}}', image]);
      const digests: unknown = JSON.parse(inspected.stdout);
      if (inspected.exitCode !== 0 || !Array.isArray(digests) || typeof digests[0] !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/i.test(digests[0])) return failure('preparation failed: image digest resolution');
      image = digests[0];
    }
    const hash = await dependencyKey(root, lockfile, managerName, manager[2]!, image, config.allowInstallScripts === true);
    const suffix = user !== '1000:1000' ? '-uid-' + user.replace(':', '-') : '';
    const identity = `${hash}:${LAYOUT}${suffix}`;
    const preparedImage = `quorum-prep:${hash}${suffix}`;
    volume = `quorum-deps-${hash}${suffix}`;
    release = await lockPreparation(volume);
    context = await mkdtemp(path.join(canonicalPath(os.tmpdir()), 'quorum-build-'));
    // This context contains only this generated Dockerfile, never repository data.
    await writeFile(path.join(context, 'Dockerfile'), `FROM ${image}\nRUN ${JSON.stringify(['npm', 'install', '-g', `${managerName}@${manager[2]}`])}\nRUN ${JSON.stringify(['mkdir', '-p', '/work/node_modules'])}\nRUN ${JSON.stringify(['chown', user, '/work/node_modules'])}\n`, { flag: 'wx' });
    const imageExists = await invoke(['image', 'inspect', '--format', '{{ index .Config.Labels "quorum.preparation" }}', preparedImage]);
    if (imageExists.exitCode !== 0 || imageExists.stdout.trim() !== identity) {
      const build = await invoke(['build', '--network', networkOn, '--label', `quorum.preparation=${identity}`, '--tag', preparedImage, context]);
      if (build.exitCode !== 0) return failure('preparation failed: image build');
    }
    // Container names are atomic across processes. Never steal a live or stale lease:
    // a competing preparation is unavailable rather than installing over its files.
    const leaseName = `quorum-deps-preparing-${hash}${suffix}`;
    const acquired = await invoke(['create', '--name', leaseName, '--network', 'none', '--user', user,
      ...PREPARATION_LIMITS, preparedImage, 'node', '-e', '']);
    if (acquired.exitCode !== 0) return failure('preparation failed: dependency volume in use');
    lease = leaseName;
    const volumeExists = await invoke(['volume', 'inspect', volume]);
    const dependencyMount = `type=volume,src=${volume},dst=/work/node_modules`;
    const preparationMounts = ['--mount', `type=bind,src=${root},dst=/work,readonly`, '--mount', dependencyMount];
    let reusable = false;
    if (volumeExists.exitCode === 0) {
      // A failed or interrupted install must never turn into a valid cache hit.
      const ready = await runAuxiliary(['--rm', '--network', 'none', '--user', user, ...PREPARATION_LIMITS,
        '--mount', `${dependencyMount},readonly`, preparedImage, 'node', '-e',
        `process.exit(require('node:fs').readFileSync(${JSON.stringify(READY_FILE)}, 'utf8') === ${JSON.stringify(identity)} ? 0 : 1)`]);
      reusable = ready.exitCode === 0;
      if (!reusable) {
        options.warn?.('Reproduction preparation: removing orphan dependency volume and rebuilding once.');
        const removed = await invoke(['volume', 'rm', volume]);
        if (removed.exitCode !== 0) return failure('preparation failed: orphan volume removal');
      }
    }
    if (!reusable) {
      const create = await invoke(['volume', 'create', volume]);
      if (create.exitCode !== 0) return failure('preparation failed: dependency volume');
      createdVolume = true;
      const command = managerName === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile']
        : managerName === 'npm' ? ['npm', 'ci'] : ['yarn', 'install', '--immutable'];
      if (!config.allowInstallScripts) command.push(managerName === 'yarn' ? '--mode=skip-build' : '--ignore-scripts');
      if (managerName === 'pnpm' && !config.allowInstallScripts) command.push('--ignore-pnpmfile');
      const prepare = await runAuxiliary(['--rm', '--network', networkOn, '--user', user,
        ...PREPARATION_LIMITS, '--workdir', '/work', ...preparationMounts, ...CACHE_ENV,
        '--env', 'npm_config_store_dir=/work/node_modules/.pnpm-store', preparedImage, ...command]);
      if (prepare.exitCode !== 0) return failure('preparation failed: dependency installation');
      const mark = await runAuxiliary(['--rm', '--network', 'none', '--user', user,
        ...PREPARATION_LIMITS, '--mount', dependencyMount, preparedImage, 'node', '-e',
        `const fs = require('node:fs'); for (const dir of ${JSON.stringify(RUNNER_CACHE_DIRS)}) fs.mkdirSync('/work/node_modules/' + dir, { recursive: true }); fs.writeFileSync(${JSON.stringify(READY_FILE)}, ${JSON.stringify(identity)})`]);
      if (mark.exitCode !== 0) return failure('preparation failed: dependency cache marker');
    }
    preparationComplete = true;

    return { root, image: preparedImage, dependencyMount };

  } catch (error) {
    return failure(error instanceof CommandTimeoutError ? 'container timeout' : `preparation failed: ${error instanceof Error ? error.message : 'invalid metadata'}`, error instanceof CommandTimeoutError);
  } finally {
    try {
      if (createdVolume && !preparationComplete && volume) await invoke(['volume', 'rm', volume], 5000).catch(() => undefined);
      if (lease) await invoke(['rm', '--force', lease], 5000).catch(() => undefined);
      if (context) await rm(context, { recursive: true, force: true });
    } finally { release?.(); }
  }
}

export async function runIsolatedTest(
  worktreePath: string,
  testFile: string,
  config: QuorumConfig['reproduce'],
  runner: CommandRunner,
  options: IsolationOptions = {},
): Promise<IsolationResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = (config.timeoutSeconds ?? 120) * 1000;
  const expires = now() + (options.deadlineMs ?? Infinity);
  const remaining = () => Math.max(0, Math.min(timeoutMs, expires - now()));
  if (remaining() <= 0) return failure('container timeout', true);
  let runtime: string | undefined;
  for (const candidate of ['docker', 'podman']) {
    try {
      const resolved = resolveCommand(candidate, ['info'], options.resolveOptions);
      const result = await runner(resolved.file, resolved.args, {
        timeoutMs: Math.min(5000, remaining()), windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });
      if (result.exitCode === 0) { runtime = candidate; break; }
    } catch { /* An installed client without a daemon is not a usable runtime. */ }
  }
  if (!runtime) return failure('no container runtime');
  const invoke = (args: string[], limit = remaining()) => {
    if (limit <= 0) return Promise.reject(new CommandTimeoutError('', ''));
    const resolved = resolveCommand(runtime!, args, options.resolveOptions);
    return runner(resolved.file, resolved.args, {
      timeoutMs: limit, windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
  };
  const networkOn = runtime === 'podman' ? 'private' : 'default';
  const runAuxiliary = async (args: string[]) => {
    const name = `quorum-preparation-${randomUUID()}`;
    try { return await invoke(['run', '--name', name, ...args]); }
    catch (error) {
      if (error instanceof CommandTimeoutError) await invoke(['kill', name], 5000).catch(() => undefined);
      throw error;
    } finally {
      // Killing a Docker/Podman client does not kill its daemon-side container.
      await invoke(['rm', '--force', name], 5000).catch(() => undefined);
    }
  };

  const relative = testFile.replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || /[:\0]/.test(relative) || relative.split('/').includes('..')) return failure('invalid test path');
  const prepared = await prepareDependencies(worktreePath, config, invoke, runAuxiliary, networkOn, options);
  if (!('root' in prepared)) return prepared;
  const { root, image: preparedImage, dependencyMount } = prepared;
  try {
    const name = `quorum-test-${randomUUID()}`;
    const marker = `QUORUM_REPORT_${randomUUID()}:`;
    const reportPath = `/tmp/quorum-${randomUUID()}.json`;
    if (!config.testCommand.length) return failure('command not found');
    const command = machineTestCommand(config.testCommand, reportPath, relative);
    const args = ['run', '--rm', '--name', name, '--network', 'none', '--user', '1000:1000',
      '--read-only', '--tmpfs', '/tmp', '--workdir', '/work',
      '--mount', `type=bind,src=${root},dst=/work`, '--mount', `${dependencyMount},readonly`,
      ...runnerCacheTmpfs(runtime, 1000),
      ...CACHE_ENV, '--memory', '1g', '--pids-limit', '256', '--cpus', '2',
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', preparedImage,
      'node', '-e', REPORT_WRAPPER, marker, reportPath, JSON.stringify(command)];
    let killed = false;
    let killing: Promise<unknown> | undefined;
    const kill = () => {
      killed = true;
      killing ??= invoke(['kill', name], 5000).catch(() => undefined);
      return killing;
    };
    const timer = setTimeout(() => { void kill(); }, remaining());
    try {
      const result = await invoke(args);
      if (killed) return failure('container timeout', true);
      const markerIndex = result.stdout.lastIndexOf(marker);
      const report = markerIndex < 0 ? null : parseTestReport(result.stdout.slice(markerIndex + marker.length), '/work');
      const reason = infrastructureFailure(report, `${result.stderr}\n${markerIndex < 0 ? result.stdout : result.stdout.slice(0, markerIndex)}`);
      return { timedOut: false, report, exitCode: result.exitCode, ...(reason ? { reason } : {}) };
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        await kill();
        return failure('container timeout', true);
      }
      return failure('container execution failed');
    } finally {
      clearTimeout(timer);
      if (killing) await killing;
      // --rm handles ordinary exit; force-remove also handles a failed CLI client.
      await invoke(['rm', '--force', name], 5000).catch(() => undefined);
    }
  } catch (error) {
    return failure(error instanceof CommandTimeoutError ? 'container timeout' : 'container execution failed', error instanceof CommandTimeoutError);
  }
}
