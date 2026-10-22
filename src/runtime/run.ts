import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, type ResolveOptions } from '../checks/resolver.js';
import { CommandTimeoutError } from '../process/runner.js';
import { prepareDependencies, PREPARATION_LIMITS, RUNNER_CACHE_DIRS } from '../reproduce/isolation.js';
import type { CommandRunner, QuorumConfig, ReviewContext } from '../types/index.js';
import { createReviewWorktree } from '../worktree/index.js';
import type { RuntimeConfig } from './config.js';
import { DEFAULT_RUNTIME_IMAGE, PLAYWRIGHT_CORE } from './image.js';
import { parseRuntimeReport, REPORT_BYTES, type RuntimeReport } from './report.js';
import { stableObservations } from './stable.js';
import { scrubForDisplay, redact } from './signature.js';

export interface SideResult { report: RuntimeReport; stable: ReturnType<typeof stableObservations>; durationMs: number }
export interface RuntimeEvidence { available: boolean; reasons: string[]; notes: string[]; base?: SideResult; head?: SideResult }
export function playwrightVolume(image: string): string {
  return `quorum-runtime-playwright-${PLAYWRIGHT_CORE.version}-${createHash('sha256').update(JSON.stringify([image, PLAYWRIGHT_CORE.integrity])).digest('hex').slice(0, 16)}`;
}

// Never interpolate exception messages, command output or flow input into diagnostics.
export function runtimeText(text: string, config: RuntimeConfig, resourcePath = false): string {
  text = redact(text, config);
  text = resourcePath ? scrubForDisplay('http://runtime' + text).slice('http://runtime'.length) : scrubForDisplay(text);
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function runtimePayload(stdout: string, marker: string, config: RuntimeConfig): RuntimeReport | { error: string; note?: string } {
  const index = stdout.lastIndexOf(marker);
  if (index < 0) return { error: 'missing runtime report' };
  const raw = stdout.slice(index + marker.length).trim();
  if (Buffer.byteLength(raw) > REPORT_BYTES) return { error: 'Invalid runtime report' };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
      const error = value as { error: unknown; exitCode?: unknown; stderrTail?: unknown };
      if (error.error === 'not-ready' || error.error === 'app-exited') return {
        error: error.error === 'not-ready' ? 'app did not become ready'
          : `app exited before ready${Number.isSafeInteger(error.exitCode) ? ` (exit ${error.exitCode})` : ''}`,
        ...(typeof error.stderrTail === 'string' ? { note: runtimeText(error.stderrTail, config).slice(-2000) } : {}),
      };
    }
    // Redact only free text (messages, paths, notes), after validation: redacting structural fields
    // too would let a short fill value (say "e") corrupt `kind: "console"` and void every report.
    const report = parseRuntimeReport(raw, config);
    if ('error' in report) return report;
    for (const run of report.runs) {
      run.notes = run.notes.map(note => runtimeText(note, config));
      for (const observation of run.observations) {
        observation.message = runtimeText(observation.message, config);
        if (observation.path !== undefined) observation.path = runtimeText(observation.path, config, true);
      }
    }
    return report;
  } catch { return { error: 'Invalid runtime report' }; }
}

export async function runRuntimeEvidence(context: ReviewContext, config: QuorumConfig, options: {
  root: string; gitRunner: CommandRunner; containerRunner: CommandRunner;
  warn?: (message: string) => void; announce?: (message: string) => void; now?: () => number;
  resolveOptions?: ResolveOptions;
}): Promise<RuntimeEvidence> {
  const evidence: RuntimeEvidence = { available: false, reasons: [], notes: [] };
  const now = options.now ?? Date.now;
  const expires = now() + config.budget.maxMinutes * 60_000;
  const remaining = () => Math.max(0, expires - now());
  let engine: string | undefined;
  for (const candidate of ['docker', 'podman']) {
    if (!remaining()) break;
    try {
      const resolved = resolveCommand(candidate, ['info'], options.resolveOptions);
      const probe = await options.containerRunner(resolved.file, resolved.args, { timeoutMs: Math.min(5000, remaining()), windowsVerbatimArguments: resolved.windowsVerbatimArguments });
      if (probe.exitCode === 0) { engine = candidate; break; }
    } catch { /* An installed client is insufficient without its daemon. */ }
  }
  if (!engine) { evidence.reasons.push(remaining() ? 'no container runtime' : 'timeout'); return evidence; }
  const runtime = config.runtime;
  if (!runtime?.start?.length || !runtime.readyUrl || !runtime.flows?.length) {
    evidence.reasons.push('runtime start, readyUrl and flows are required'); return evidence;
  }
  const image = runtime.image ?? DEFAULT_RUNTIME_IMAGE;
  const warn = (message: string) => options.warn?.(runtimeText(message, runtime));
  if (image !== DEFAULT_RUNTIME_IMAGE) warn('Runtime image override: the browser/playwright-core pairing is unverified.');
  const invoke = (args: string[], limit = remaining()) => {
    if (limit <= 0) return Promise.reject(new CommandTimeoutError('', ''));
    const resolved = resolveCommand(engine!, args, options.resolveOptions);
    return options.containerRunner(resolved.file, resolved.args, {
      timeoutMs: limit, windowsVerbatimArguments: resolved.windowsVerbatimArguments, maxOutputBytes: REPORT_BYTES + 4096,
    });
  };
  const runContainer = async (args: string[], limit = remaining(), name = `quorum-runtime-${randomUUID()}`) => {
    if (limit <= 0) throw new CommandTimeoutError('', '');
    let killed = false; let killing: Promise<unknown> | undefined;
    const kill = () => { killed = true; return killing ??= invoke(['kill', name], 5000).catch(() => undefined); };
    const timer = setTimeout(() => { void kill(); }, limit);
    try {
      const result = await invoke(['run', '--name', name, ...args], limit);
      if (killed) throw new CommandTimeoutError('', '');
      return result;
    } catch (error) {
      if (error instanceof CommandTimeoutError) await kill();
      throw error;
    } finally {
      clearTimeout(timer); if (killing) await killing;
      await invoke(['rm', '--force', name], 5000).catch(() => undefined);
    }
  };
  const network = engine === 'podman' ? 'private' : 'default';
  const volume = playwrightVolume(image);
  const pwMount = `type=volume,src=${volume},dst=/quorum/playwright`;
  const identity = JSON.stringify(PLAYWRIGHT_CORE);
  const verify = `const fs = require('node:fs'); const root = '/quorum/playwright'; const lock = JSON.parse(fs.readFileSync(root + '/package-lock.json')); const pkg = JSON.parse(fs.readFileSync(root + '/node_modules/playwright-core/package.json')); if (lock.packages?.['node_modules/playwright-core']?.integrity !== ${JSON.stringify(PLAYWRIGHT_CORE.integrity)} || pkg.version !== ${JSON.stringify(PLAYWRIGHT_CORE.version)}) process.exit(42);`;
  let playwrightReady = false;
  async function preparePlaywright(): Promise<string | undefined> {
    if (playwrightReady) return;
    const check = await runContainer(['--rm', '--network', 'none', '--user', '1001:1001', ...PREPARATION_LIMITS,
      '--mount', pwMount + ',readonly', image, 'node', '-e',
      verify + `process.exit(fs.readFileSync(root + '/.quorum-ready', 'utf8') === ${JSON.stringify(identity)} ? 0 : 1);`]);
    if (check.exitCode === 0) { playwrightReady = true; return; }
    if (check.exitCode === 42) {
      await invoke(['volume', 'rm', volume]); return 'playwright-core integrity mismatch';
    }
    let complete = false;
    try {
      // Rebuild an interrupted preparation; never install over an untrusted partial tree.
      // --force: an engine that did not auto-create the volume during the check (Podman) must not fail here.
      const removed = await invoke(['volume', 'rm', '--force', volume]);
      if (removed.exitCode !== 0) return 'playwright-core preparation failed';
      if ((await invoke(['volume', 'create', volume])).exitCode !== 0) return 'playwright-core preparation failed';
      const chown = await runContainer(['--rm', '--network', 'none', '--user', '0:0', ...PREPARATION_LIMITS,
        '--cap-add', 'CHOWN', '--mount', pwMount, image, 'chown', '1001:1001', '/quorum/playwright']);
      if (chown.exitCode !== 0) return 'playwright-core preparation failed';
      // No --workdir: Docker recreates a workdir that only exists as a volume mount point as root,
      // which undoes the chown above. --prefix targets the volume instead.
      const installed = await runContainer(['--rm', '--network', network, '--user', '1001:1001', ...PREPARATION_LIMITS,
        '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/tmp', '--mount', pwMount,
        image, 'npm', 'install', '--prefix', '/quorum/playwright', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `playwright-core@${PLAYWRIGHT_CORE.version}`]);
      if (installed.exitCode !== 0) return 'playwright-core preparation failed';
      const checked = await runContainer(['--rm', '--network', 'none', '--user', '1001:1001', ...PREPARATION_LIMITS,
        '--mount', pwMount, image, 'node', '-e', verify + `fs.writeFileSync(root + '/.quorum-ready', ${JSON.stringify(identity)});`]);
      if (checked.exitCode !== 0) return 'playwright-core integrity mismatch';
      complete = playwrightReady = true;
    } finally { if (!complete) await invoke(['volume', 'rm', volume], 5000).catch(() => undefined); }
    return;
  }
  options.announce?.(runtimeText(`quorum: running ${config.setup?.length ?? 0} setup commands and runtime flows from the reviewed change in disposable base/head worktrees inside containers; this executes the change's code and install scripts invoked by setup; dependency install scripts are ${config.reproduce.allowInstallScripts ? 'enabled' : 'disabled'} (runtime mode refuses --no-checks)\n`, runtime));
  for (const side of ['base', 'head'] as const) {
    let tree: Awaited<ReturnType<typeof createReviewWorktree>> | undefined; let directory: string | undefined;
    let runVolume: string | undefined;
    const started = now();
    try {
      if (!remaining()) throw new CommandTimeoutError('', '');
      tree = await createReviewWorktree(options.root, side === 'base' ? context.mergeBaseCommit ?? context.baseCommit : context.headCommit, options.gitRunner, () => warn('Runtime worktree cleanup warning.'));
      const problem = await preparePlaywright();
      if (problem) { evidence.reasons.push(`${side}: ${problem}`); continue; }
      const deps = await prepareDependencies(tree.path, config.reproduce, invoke, args => runContainer(args), network, { image, user: '1001:1001', warn });
      if (!('root' in deps)) {
        evidence.reasons.push(`${side}: ${deps.timedOut ? 'timeout' : deps.reason === 'preparation failed: dependency volume in use' ? 'dependency volume in use' : 'app dependency preparation failed'}`); continue;
      }
      let dependencyMount = deps.dependencyMount;
      if (config.setup?.length) {
        runVolume = `quorum-runtime-run-${randomUUID()}`;
        if ((await invoke(['volume', 'create', runVolume])).exitCode !== 0) throw new Error('dependency copy volume failed');
        dependencyMount = `type=volume,src=${runVolume},dst=/work/node_modules`;
        // The prepared image owns this mount point as UID 1001. Docker populates
        // the new volume from it before cp runs; cp preserves symlinks and modes.
        const copied = await runContainer(['--rm', '--network', 'none', '--user', '1001:1001', ...PREPARATION_LIMITS,
          '--mount', deps.dependencyMount.replace('dst=/work/node_modules', 'dst=/quorum/source') + ',readonly',
          '--mount', dependencyMount, deps.image, 'cp', '-a', '/quorum/source/.', '/work/node_modules/']);
        if (copied.exitCode !== 0) throw new Error('dependency copy failed');
      }
      // Setup can write only to this disposable worktree and its dependency volume, offline.
      for (const command of config.setup ?? []) {
        const setup = await runContainer(['--rm', '--network', 'none', '--user', '1001:1001', ...PREPARATION_LIMITS,
          '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'XDG_CACHE_HOME=/tmp',
          '--mount', `type=bind,src=${deps.root},dst=/work`, '--mount', dependencyMount, deps.image, ...command]);
        if (setup.exitCode !== 0) throw new Error('setup failure');
      }
      directory = await mkdtemp(path.join(os.tmpdir(), 'quorum-runtime-'));
      if (directory.includes(',') || /[\r\n\0]/.test(directory)) throw new Error('invalid script mount');
      for (const file of ['collector.cjs', 'runner.cjs', 'scrub.cjs']) await copyFile(new URL(`../../src/runtime/${file}`, import.meta.url), path.join(directory, file));
      const plan = { readyUrl: runtime.readyUrl, readyTimeoutSeconds: runtime.readyTimeoutSeconds,
        flowTimeoutSeconds: runtime.flowTimeoutSeconds, stepTimeoutSeconds: runtime.stepTimeoutSeconds,
        screenshots: runtime.screenshots, flows: runtime.flows };
      await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan), { flag: 'wx' });
      const marker = `QUORUM_RUNTIME_${randomUUID()}:`;
      const limit = Math.min(remaining(), (runtime.readyTimeoutSeconds + runtime.flows.length * 2 * runtime.flowTimeoutSeconds + 30) * 1000);
      const result = await runContainer(['--rm', '--network', 'none', '--user', '1001:1001', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm:rw,size=512m',
        '--memory', `${runtime.memoryMiB}m`, '--pids-limit', String(runtime.pids), '--cpus', '2', '--workdir', '/work', '--env', 'HOME=/tmp',
        '--mount', `type=bind,src=${deps.root},dst=/work,readonly`, '--mount', dependencyMount + ',readonly',
        ...RUNNER_CACHE_DIRS.flatMap(dir => ['--tmpfs', `/work/node_modules/${dir}:rw,uid=1001,gid=1001,mode=0700`]),
        '--mount', pwMount + ',readonly', '--mount', `type=bind,src=${directory},dst=/quorum/bin,readonly`,
        deps.image, 'node', '/quorum/bin/runner.cjs', '/quorum/bin/plan.json', marker, JSON.stringify(runtime.start)], limit);
      const report = runtimePayload(result.stdout, marker, runtime);
      if ('error' in report) {
        evidence.reasons.push(`${side}: ${report.error}`);
        if (report.note) evidence.notes.push(`${side}: ${report.note}`);
      } else if (result.exitCode !== 0) evidence.reasons.push(`${side}: collector failed`);
      else evidence[side] = { report, stable: stableObservations(report), durationMs: now() - started };
    } catch (error) {
      evidence.reasons.push(`${side}: ${error instanceof CommandTimeoutError ? 'timeout' : 'runtime execution failed'}`);
    } finally {
      if (runVolume) {
        try { if ((await invoke(['volume', 'rm', runVolume], 5000)).exitCode !== 0) evidence.reasons.push(`${side}: dependency volume cleanup failed`); }
        catch { evidence.reasons.push(`${side}: dependency volume cleanup failed`); }
      }
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => { evidence.reasons.push(`${side}: script cleanup failed`); });
      if (tree) await tree.cleanup().catch(() => { evidence.reasons.push(`${side}: worktree cleanup failed`); });
    }
  }
  evidence.available = Boolean(evidence.base && evidence.head && !evidence.reasons.length);
  return evidence;
}
