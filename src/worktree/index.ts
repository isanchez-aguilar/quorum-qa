import { randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, requireWorktreeRoot, validateRef } from '../context/git.js';
import type { CommandRunner } from '../types/index.js';

export async function createReviewWorktree(repoRoot: string, sha: string, runner: CommandRunner): Promise<{ path: string; cleanup: () => Promise<void> }> {
  validateRef(sha, false);
  await requireWorktreeRoot(repoRoot, runner);
  const ignored = await git(['check-ignore', '--quiet', '--', '.quorum/'], repoRoot, runner);
  if (ignored.exitCode !== 0) throw new Error('Review worktrees require .quorum/ to be git-ignored. Add .quorum/ to .gitignore.');
  const parent = path.join(repoRoot, '.quorum', 'worktrees');
  for (const directory of [path.join(repoRoot, '.quorum'), parent]) {
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Review worktree parent must be a real directory inside the repository.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(parent, { recursive: true });
  const relative = path.relative(await realpath(repoRoot), await realpath(parent));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Review worktree parent must stay inside the repository.');
  const location = path.join(parent, randomUUID());
  const added = await git(['worktree', 'add', '--detach', location, sha], repoRoot, runner);
  if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
  let removed = false;
  let cleaned = false;
  let pending: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleaned) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      if (!removed) {
        const result = await git(['worktree', 'remove', '--force', location], repoRoot, runner);
        if (result.exitCode !== 0) throw new Error(`git worktree remove failed: ${result.stderr}`);
        removed = true;
      }
      const result = await git(['worktree', 'prune'], repoRoot, runner);
      if (result.exitCode !== 0) throw new Error(`git worktree prune failed: ${result.stderr}`);
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
