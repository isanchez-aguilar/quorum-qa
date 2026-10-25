import { lstat, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, validateConfig } from '../config/schema.js';
import { requireWorktreeRoot } from '../context/git.js';
import { runDoctor } from '../doctor/index.js';
import { permissionPath } from '../doctor/checks.js';
import { runCommand } from '../process/runner.js';
import { atomicWrite } from '../storage/index.js';
import { readBoundedFile } from '../suppressions/commands.js';
import { UsageError, type ParsedFlags } from './args.js';
import type { CliDependencies, CliIo } from './index.js';

async function regularFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new UsageError(`${path.basename(file)} must be a regular non-symlink file.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Berry writes __metadata near the top; a large lockfile need not be read whole.
async function readHead(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

async function proposal(root: string): Promise<{ config: Record<string, unknown>; notes: string[] }> {
  const notes: string[] = [];
  const config: Record<string, unknown> = { setup: [], checks: [], tiers: defaultConfig().tiers };
  if (!await regularFile(path.join(root, 'package.json'))) {
    notes.push('No package.json found; checks and setup are empty. Configure the commands for this repository manually.');
    return { config, notes };
  }
  const manifest: unknown = JSON.parse((await readBoundedFile(path.join(root, 'package.json'))).replace(/^\uFEFF/, ''));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new UsageError('package.json must contain an object.');
  const { packageManager, scripts } = manifest as { packageManager?: unknown; scripts?: unknown };
  const managers = [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun']] as const;
  let manager: string | undefined; let berry = false;
  if (packageManager !== undefined) {
    const match = typeof packageManager === 'string' ? /^(pnpm|npm|yarn|bun)@(\d+)(?:\.|$)/.exec(packageManager) : null;
    if (!match) throw new UsageError('Unsupported packageManager; use pnpm, npm, yarn or bun with a version.');
    manager = match[1]!; berry = manager === 'yarn' && Number(match[2]) >= 2;
  } else {
    for (const [lock, name] of managers) {
      if (await regularFile(path.join(root, lock))) {
        manager = name;
        if (name === 'yarn') berry = /^__metadata:/m.test(await readHead(path.join(root, lock)));
        break;
      }
    }
  }
  if (!manager) { manager = 'npm'; notes.push('No package manager lockfile found; assuming npm. Commit a package-lock.json before running npm ci.'); }
  const install = manager === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']
    : manager === 'npm' ? ['npm', 'ci']
    : manager === 'yarn' ? ['yarn', 'install', berry ? '--immutable' : '--frozen-lockfile']
    : ['bun', 'install', '--frozen-lockfile'];
  const present = scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts as Record<string, unknown> : {};
  const has = (name: string) => typeof present[name] === 'string' && present[name].trim().length > 0;
  config.setup = [install];
  config.checks = ['typecheck', 'lint', 'test'].filter(has).map(name => [manager, 'run', name]);
  if (has('test')) config.budget = { checkTimeoutSeconds: 600 };
  notes.push(`Package manager: ${manager}. Scripts: ${['typecheck', 'lint', 'test', 'build'].filter(has).join(', ') || 'none'}.`);
  return { config, notes };
}

export async function init(flags: ParsedFlags, positionals: string[], io: CliIo, dependencies: CliDependencies): Promise<number> {
  if (positionals.length || Object.keys(flags).some(key => !['dryRun', 'force'].includes(key))) throw new UsageError('Use quorum init [--dry-run] [--force].');
  const root = path.resolve(dependencies.repoRoot ?? process.cwd());
  await requireWorktreeRoot(root, dependencies.gitRunner ?? runCommand);
  const configFile = path.join(root, 'quorum.config.json'); const ignoreFile = path.join(root, '.gitignore');
  const existing = await regularFile(configFile);
  if (existing && !flags.force && !flags.dryRun) throw new UsageError('quorum.config.json already exists; use --force to replace it.');
  const ignoreExists = await regularFile(ignoreFile);
  const ignore = ignoreExists ? await readBoundedFile(ignoreFile) : '';
  const ending = ignore.includes('\r\n') ? '\r\n' : '\n';
  let ignored = false;
  for (const line of ignore.split(/\r?\n/)) {
    if (/^\/?\.quorum\/? *$/.test(line)) ignored = true;
    // A later negation of .quorum may re-include it; an entry at the end wins.
    else if (/^!\/?\.quorum(?:\/|\s|$)/.test(line)) ignored = false;
  }
  const nextIgnore = ignored ? ignore : ignore + (ignore && !ignore.endsWith('\n') ? ending : '') + '.quorum/' + ending;
  const { config, notes } = await proposal(root);
  // The remote's default branch is the usual review base; origin/main is the schema default.
  const head = await (dependencies.gitRunner ?? runCommand)('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: root, timeoutMs: 10_000 });
  const remoteBase = head.exitCode === 0 ? /^refs\/remotes\/(origin\/[\w./-]+)\s*$/.exec(head.stdout)?.[1] : undefined;
  if (remoteBase && remoteBase !== defaultConfig().base) config.base = remoteBase;
  notes.push(`Review base: ${remoteBase ?? `${defaultConfig().base} (origin/HEAD not set; edit base if the default branch differs)`}.`);
  const validated = validateConfig(config);
  const text = JSON.stringify(config, null, 2) + '\n';
  for (const note of notes) io.out(`${note}\n`);
  io.out(`${flags.dryRun ? 'Proposed' : 'Writing'} quorum.config.json:\n${text}`);
  io.out(`${ignored ? 'Keeping' : 'Adding'} .quorum/ in .gitignore.\n`);
  io.out(`Add read_file(${permissionPath(path.join(root, '.quorum', 'worktrees'))}) to permissions.allow in ~/.gemini/antigravity-cli/settings.json.\n`);
  const nextSteps = 'Next steps: commit quorum.config.json and .gitignore on the base branch first. Quorum reads trusted configuration from the merge-base.\nThen run: quorum review --diff origin/main...HEAD --dry-run\n';
  if (flags.dryRun) { io.out(nextSteps); return 0; }
  if (existing) await atomicWrite(configFile, text, root);
  else await writeFile(configFile, text, { flag: 'wx' });
  if (nextIgnore !== ignore) {
    if (ignoreExists) await atomicWrite(ignoreFile, nextIgnore, root);
    else await writeFile(ignoreFile, nextIgnore, { flag: 'wx' });
  }
  const checks = await (dependencies.runDoctor ?? runDoctor)(validated, { repoRoot: root, probe: false,
    ...(dependencies.homedir ? { homedir: dependencies.homedir } : {}) });
  for (const check of checks) {
    io.out(`[${check.status}] ${check.id}: ${check.message}\n`);
    if (check.fix) io.out(`  Fix: ${check.fix}\n`);
  }
  io.out(nextSteps);
  return checks.some(check => check.status === 'FAIL') ? 2 : 0;
}
