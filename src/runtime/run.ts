import { canonicalPath } from '../paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, type ResolveOptions } from '../checks/resolver.js';
import { CommandTimeoutError } from '../process/runner.js';
import { assertNoLinks } from '../context/contract.js';
import { git } from '../context/git.js';
import { prepareDependencies, PREPARATION_LIMITS, runnerCacheTmpfs } from '../reproduce/isolation.js';
import type { CommandRunner, QuorumConfig, ReviewContext } from '../types/index.js';
import { createReviewWorktree } from '../worktree/index.js';
import type { RuntimeConfig } from './config.js';
import { DEFAULT_RUNTIME_IMAGE, PLAYWRIGHT_CORE } from './image.js';
import { parseRuntimeReport, REPORT_BYTES, type RuntimeReport } from './report.js';
import { isScreenshotNote, stableObservations } from './stable.js';
import { scrubForDisplay, redact } from './signature.js';

export interface RuntimeShot { flow: string; step: number; mime: 'image/jpeg'; bytes: number; sha256: string; data: string }
export type StoredRuntimeShot = Omit<RuntimeShot, 'data'> & { path: string };
export interface SideResult { shots: StoredRuntimeShot[]; report: RuntimeReport; stable: ReturnType<typeof stableObservations>; durationMs: number }
export interface RuntimeEvidence { available: boolean; reasons: string[]; notes: string[]; base?: SideResult; head?: SideResult }
export function playwrightVolume(image: string): string {
  return `quorum-runtime-playwright-${PLAYWRIGHT_CORE.version}-${createHash('sha256').update(JSON.stringify([image, PLAYWRIGHT_CORE.integrity])).digest('hex').slice(0, 16)}`;
}

const SHOT_BYTES = 300 * 1024;
const SHOTS_BYTES = 6 * 1024 * 1024;
export const SHOTS_OUTPUT_BYTES = REPORT_BYTES + Math.ceil(SHOTS_BYTES * 4 / 3) + 64 * 1024;

export function runtimeShots(stdout: string, marker: string, config: RuntimeConfig): { shots: RuntimeShot[]; notes: string[] } {
  const shots: RuntimeShot[] = []; let dropped = 0;
  const flows = new Map(config.flows?.map(flow => [flow.name, flow]));
  const seen = new Set<string>(); const counts = new Map<string, number>(); const sizes = new Map<string, number>();
  const budget = Math.floor(SHOTS_BYTES / flows.size);
  const keys = ['flow', 'step', 'mime', 'bytes', 'sha256', 'data'];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(marker + 'IMG ')) continue;
    try {
      if (Buffer.byteLength(line) > 450 * 1024) throw new Error('line');
      const value: unknown = JSON.parse(line.slice(marker.length + 4));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error('object');
      const shot = value as RuntimeShot;
      const flow = flows.get(shot.flow);
      if (!flow || shot.mime !== 'image/jpeg' || !Number.isSafeInteger(shot.step) || shot.step < 0 || shot.step >= flow.steps.length
        || !Number.isSafeInteger(shot.bytes) || shot.bytes < 3 || shot.bytes > SHOT_BYTES
        || typeof shot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(shot.sha256) || typeof shot.data !== 'string') throw new Error('fields');
      const data = Buffer.from(shot.data, 'base64');
      if (data.length !== shot.bytes || data.toString('base64') !== shot.data
        || data[0] !== 255 || data[1] !== 216 || data[2] !== 255
        || createHash('sha256').update(data).digest('hex') !== shot.sha256) throw new Error('image');
      const key = JSON.stringify([shot.flow, shot.step]);
      const count = counts.get(shot.flow) ?? 0; const size = sizes.get(shot.flow) ?? 0;
      if (seen.has(key) || count >= 10 || size + data.length > budget) throw new Error('cap');
      seen.add(key); counts.set(shot.flow, count + 1); sizes.set(shot.flow, size + data.length);
      shots.push(shot);
    } catch { dropped++; }
  }
  return { shots, notes: dropped ? [`dropped ${dropped} invalid screenshots`] : [] };
}

export async function storeRuntimeShots(shots: RuntimeShot[], config: RuntimeConfig, options: {
  root: string; runId: string; side: 'base' | 'head'; gitRunner: CommandRunner; warn?: (message: string) => void;
}): Promise<{ shots: StoredRuntimeShot[]; notes: string[] }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(options.runId) || !['base', 'head'].includes(options.side)) throw new Error('Invalid screenshot destination');
  const slugs = new Map<string, string>(); const used = new Set<string>();
  for (const flow of config.flows ?? []) {
    const slug = flow.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    // Case uniqueness alone does not exclude punctuation collisions (a.b / a-b).
    if (used.has(slug)) throw new Error('Screenshot flow slug collision');
    used.add(slug); slugs.set(flow.name, slug);
  }
  const ignored = await git(['check-ignore', '--quiet', '--', '.quorum/'], options.root, options.gitRunner);
  if (ignored.exitCode !== 0) {
    const note = 'screenshots not stored: .quorum/ is not git-ignored'; options.warn?.(note);
    return { shots: [], notes: [note] };
  }
  if (!shots.length) return { shots: [], notes: [] };
  let directory = path.resolve(options.root);
  await assertNoLinks(directory);
  // Check each existing parent before creating its child; never recurse through a link.
  for (const part of ['.quorum', 'runtime-shots', options.runId, options.side]) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await assertNoLinks(directory, options.root);
  }
  const stored: StoredRuntimeShot[] = [];
  for (const [index, shot] of shots.entries()) {
    const slug = slugs.get(shot.flow);
    const flow = config.flows?.find(flow => flow.name === shot.flow);
    if (slug === undefined || !Number.isSafeInteger(shot.step) || shot.step < 0 || shot.step >= flow!.steps.length) throw new Error('Invalid screenshot destination');
    const file = path.join(directory, `${String(index + 1).padStart(2, '0')}-${slug}-${shot.step}.jpg`);
    await assertNoLinks(directory, options.root);
    await writeFile(file, Buffer.from(shot.data, 'base64'), { flag: 'wx' });
    stored.push({ flow: shot.flow, step: shot.step, mime: shot.mime, bytes: shot.bytes, sha256: shot.sha256,
      path: path.relative(options.root, file).replace(/\\/g, '/') });
  }
  return { shots: stored, notes: [] };
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
      // Fixed capture diagnostics are structural: redacting a short fill value must not
      // turn an informational screenshot note into incomplete deterministic coverage.
      run.notes = run.notes.map(note => isScreenshotNote(note) ? note : runtimeText(note, config));
      for (const observation of run.observations) {
        observation.message = runtimeText(observation.message, config);
        if (observation.path !== undefined) observation.path = runtimeText(observation.path, config, true);
      }
    }
    return report;
  } catch { return { error: 'Invalid runtime report' }; }
}

export async function runRuntimeEvidence(context: ReviewContext, config: QuorumConfig, options: {
  root: string; runId?: string; gitRunner: CommandRunner; containerRunner: CommandRunner;
  warn?: (message: string) => void; announce?: (message: string) => void; now?: () => number;
  resolveOptions?: ResolveOptions;
}): Promise<RuntimeEvidence> {
  const evidence: RuntimeEvidence = { available: false, reasons: [], notes: [] };
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `qrm-${randomUUID()}`;
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
  const invoke = (args: string[], limit = remaining(), maxOutputBytes = REPORT_BYTES + 4096) => {
    if (limit <= 0) return Promise.reject(new CommandTimeoutError('', ''));
    const resolved = resolveCommand(engine!, args, options.resolveOptions);
    return options.containerRunner(resolved.file, resolved.args, {
      timeoutMs: limit, windowsVerbatimArguments: resolved.windowsVerbatimArguments, maxOutputBytes,
    });
  };
  const runContainer = async (args: string[], limit = remaining(), name = `quorum-runtime-${randomUUID()}`, maxOutputBytes = REPORT_BYTES + 4096) => {
    if (limit <= 0) throw new CommandTimeoutError('', '');
    let killed = false; let killing: Promise<unknown> | undefined;
    const kill = () => { killed = true; return killing ??= invoke(['kill', name], 5000).catch(() => undefined); };
    const timer = setTimeout(() => { void kill(); }, limit);
    try {
      const result = await invoke(['run', '--name', name, ...args], limit, maxOutputBytes);
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
      directory = await mkdtemp(path.join(canonicalPath(os.tmpdir()), 'quorum-runtime-'));
      if (directory.includes(',') || /[\r\n\0]/.test(directory)) throw new Error('invalid script mount');
      for (const file of ['collector.cjs', 'runner.cjs', 'scrub.cjs']) await copyFile(new URL(`../../src/runtime/${file}`, import.meta.url), path.join(directory, file));
      const plan = { readyUrl: runtime.readyUrl, readyTimeoutSeconds: runtime.readyTimeoutSeconds,
        flowTimeoutSeconds: runtime.flowTimeoutSeconds, stepTimeoutSeconds: runtime.stepTimeoutSeconds,
        screenshots: runtime.screenshots, flows: runtime.flows };
      await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan), { flag: 'wx' });
      // The container runs as uid 1001, which is not the host user on Linux (rootless Podman maps it to a
      // sub-uid): a private 0700 temp directory would be unreadable there. 0711 lets it open the known file
      // names but not list the directory; the files stay readable (0644). No effect on Windows.
      await chmod(directory, 0o711);
      const marker = `QUORUM_RUNTIME_${randomUUID()}:`;
      const captureSeconds = runtime.screenshots ? runtime.flows.reduce((count, flow) => count + flow.steps.filter(step =>
        ['goto', 'click', 'press', 'waitForUrl', 'waitForSelector'].some(action => Object.hasOwn(step, action))).length * 2 * 5, 0) : 0;
      const limit = Math.min(remaining(), (runtime.readyTimeoutSeconds + runtime.flows.length * 2 * runtime.flowTimeoutSeconds + captureSeconds + 30) * 1000);
      const result = await runContainer(['--rm', '--network', 'none', '--user', '1001:1001', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm:rw,size=512m',
        '--memory', `${runtime.memoryMiB}m`, '--pids-limit', String(runtime.pids), '--cpus', '2', '--workdir', '/work', '--env', 'HOME=/tmp',
        '--mount', `type=bind,src=${deps.root},dst=/work,readonly`, '--mount', dependencyMount + ',readonly',
        ...runnerCacheTmpfs(engine, 1001),
        '--mount', pwMount + ',readonly', '--mount', `type=bind,src=${directory},dst=/quorum/bin,readonly`,
        deps.image, 'node', '/quorum/bin/runner.cjs', '/quorum/bin/plan.json', marker, JSON.stringify(runtime.start)], limit, undefined,
        runtime.screenshots ? SHOTS_OUTPUT_BYTES : REPORT_BYTES + 4096);
      const report = runtimePayload(result.stdout, marker, runtime);
      if ('error' in report) {
        evidence.reasons.push(`${side}: ${report.error}`);
        if (report.note) evidence.notes.push(`${side}: ${report.note}`);
      } else if (result.exitCode !== 0) evidence.reasons.push(`${side}: collector failed`);
      else {
        const collected: SideResult = { report, stable: stableObservations(report), durationMs: now() - started, shots: [] };
        if (runtime.screenshots) {
          const parsed = runtimeShots(result.stdout, marker, runtime);
          evidence.notes.push(...parsed.notes.map(note => `${side}: ${note}`));
          try {
            const stored = await storeRuntimeShots(parsed.shots, runtime, { root: options.root, runId, side, gitRunner: options.gitRunner, warn });
            collected.shots = stored.shots; evidence.notes.push(...stored.notes.map(note => `${side}: ${note}`));
          } catch { const note = 'screenshots not stored: unsafe or unavailable destination'; warn(note); evidence.notes.push(`${side}: ${note}`); }
        }
        evidence[side] = collected;
      }
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
