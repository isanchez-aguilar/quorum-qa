import { canonicalPath } from '../paths.js';
import { homedir } from 'node:os';
import { checksWorktreePath } from './paths.js';
import { cleanupWorktree } from './cleanup.js';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { git, requireWorktreeRoot, validateRef } from '../context/git.js';
import type { CommandRunner } from '../types/index.js';

const creations = new Map<string, Promise<void>>();

async function serializeCreation<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
  const actual = canonicalPath(repoRoot);
  const key = process.platform === 'win32' ? actual.toLowerCase() : actual;
  const previous = creations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  creations.set(key, pending);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (creations.get(key) === pending) creations.delete(key);
  }
}

export async function createReviewWorktree(repoRoot: string, sha: string, runner: CommandRunner, warn: (message: string) => void = console.warn, options: { checks?: boolean } = {}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  repoRoot = canonicalPath(repoRoot);
  return serializeCreation(repoRoot, () => createUnlocked(repoRoot, sha, runner, warn, options));
}

async function createUnlocked(repoRoot: string, sha: string, runner: CommandRunner, warn: (message: string) => void = console.warn, options: { checks?: boolean } = {}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  validateRef(sha, false);
  await requireWorktreeRoot(repoRoot, runner);
  // Check the link first: on Linux `git check-ignore` fails for a path beyond a symlink, which would
  // otherwise hide the real reason behind a misleading "not git-ignored" message.
  try {
    const quorum = await lstat(path.join(repoRoot, '.quorum'));
    if (quorum.isSymbolicLink() || !quorum.isDirectory()) throw new Error('Review worktree parent must be a real directory inside the repository.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const ignored = await git(['check-ignore', '--quiet', '--', '.quorum/'], repoRoot, runner);
  if (ignored.exitCode !== 0) throw new Error('Review worktrees require .quorum/ to be git-ignored. Add .quorum/ to .gitignore.');
  const home = options.checks ? canonicalPath(homedir()) : undefined;
  const selected = options.checks ? checksWorktreePath(repoRoot, home!, randomUUID(), process.platform) : undefined;
  const parent = selected?.parent ?? path.join(repoRoot, '.quorum', 'worktrees');
  if (selected?.warning) warn(selected.warning);
  const anchor = selected?.short ? home! : repoRoot;
  for (const directory of [path.join(anchor, '.quorum'), parent]) {
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Review worktree parent must be a real directory inside the repository.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(parent, { recursive: true });
  const actualParent = canonicalPath(parent);
  const relative = path.relative(canonicalPath(anchor), actualParent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Review worktree parent must stay inside the repository.');
  const pruned = await git(['worktree', 'prune'], repoRoot, runner);
  if (pruned.exitCode !== 0) throw new Error(`git worktree prune failed: ${pruned.stderr}`);
  const listed = await git(['worktree', 'list', '--porcelain', '-z'], repoRoot, runner);
  if (listed.exitCode !== 0) throw new Error(`git worktree list failed: ${listed.stderr}`);
  const normalize = (value: string) => {
    const actual = canonicalPath(value);
    return process.platform === 'win32' ? actual.toLowerCase() : actual;
  };
  const registered = new Set<string>();
  for (const item of listed.stdout.split('\0').filter(item => item.startsWith('worktree '))) {
    try { registered.add(normalize(item.slice(9))); }
    catch (error) {
      // Git can retain a locked registration for a directory that is currently absent.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const entry of selected?.short ? [] : await readdir(parent, { withFileTypes: true })) {
    const candidate = path.resolve(parent, entry.name);
    if (path.dirname(candidate) !== path.resolve(parent)) continue;
    try {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory() || Date.now() - stat.mtimeMs <= 24 * 60 * 60 * 1000) continue;
    if (registered.has(normalize(candidate))) continue;
    const actual = canonicalPath(candidate);
    if (path.dirname(actual) !== canonicalPath(parent)) throw new Error('Stale worktree must stay inside its parent.');
    await rm(candidate, { recursive: true, force: true });
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      warn(`Stale worktree cleanup failed: ${candidate}: ${(error as Error).message}`);
    }
  }
  const location = selected?.location ?? path.join(parent, randomUUID());
  const added = await git(['worktree', 'add', '--detach', location, sha], repoRoot, runner);
  if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
  let cleaned = false;
  let pending: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleaned) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      await serializeCreation(repoRoot, () => cleanupWorktree(repoRoot, parent, location, runner, { expectedParent: actualParent, latePrune: action => serializeCreation(repoRoot, action) }));
      cleaned = true;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return { path: location, cleanup };
}

export async function isClean(location: string, runner: CommandRunner): Promise<boolean> {
  const result = await git(['status', '--porcelain', '--untracked-files=all'], location, runner);
  if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr}`);
  return result.stdout.trim() === '';
}
