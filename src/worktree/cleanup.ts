import { canonicalPath } from '../paths.js';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../context/git.js';
import type { CommandRunner } from '../types/index.js';

export async function cleanupWorktree(repo: string, parent: string, location: string, runner: CommandRunner,
  options: { expectedParent?: string; remove?: typeof rm; timeoutMs?: number; latePrune?: (action: () => Promise<void>) => Promise<void> } = {}): Promise<void> {
  if (path.dirname(path.resolve(location)) !== path.resolve(parent)) throw new Error('Worktree cleanup must stay inside its root.');
  const parentStat = await lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('Worktree cleanup root must be a real directory.');
  if (options.expectedParent && canonicalPath(parent) !== options.expectedParent) throw new Error('Worktree cleanup root changed since creation.');
  try {
    const stat = await lstat(location);
    if (stat.isSymbolicLink() || path.dirname(canonicalPath(location)) !== canonicalPath(parent)) throw new Error('Worktree cleanup must stay inside its root.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const prune = async () => {
    const result = await git(['worktree', 'prune', '--expire', 'now'], repo, runner);
    if (result.exitCode !== 0) throw new Error(`git worktree prune failed: ${result.stderr}`);
  };
  const removing = Promise.resolve().then(() => (options.remove ?? rm)(location, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removalError: unknown;
  try {
    await Promise.race([removing, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worktree directory cleanup timed out after generous removal deadline.')), options.timeoutMs ?? 300_000);
    })]);
  } catch (error) { removalError = error; }
  finally { clearTimeout(timer); }
  let unregisterError: unknown;
  try {
    const result = await git(['worktree', 'remove', '--force', location], repo, runner);
    if (result.exitCode !== 0) unregisterError = new Error(`git worktree remove failed: ${result.stderr}`);
  } catch (error) { unregisterError = error; }
  finally {
    // rm has no cancellation API. If it finishes after the deadline, prune again.
    if (removalError) void removing.then(() => options.latePrune ? options.latePrune(prune) : prune(), () => {}).catch(() => {});
    await prune();
  }
  try { await lstat(location); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw removalError ?? unregisterError ?? new Error('Worktree directory still exists after cleanup.');
}
