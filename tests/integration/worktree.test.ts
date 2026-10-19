import { mkdtemp, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/checks/resolver.js';
import { runCommand } from '../../src/process/runner.js';
import { createReviewWorktree, isClean } from '../../src/worktree/index.js';
import type { CommandRunner } from '../../src/types/index.js';

let gitPath: string | undefined;
try { gitPath = resolveCommand('git', []).file; } catch { /* Same optional Git prerequisite as M2. */ }
const roots: string[] = [];
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic',
  GIT_COMMITTER_EMAIL: 'synthetic@example.invalid', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
const runner: CommandRunner = (command, args, options) => runCommand(command, args, { ...options, env });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function repository(ignore: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum worktree ')); roots.push(root);
  const git = async (...args: string[]) => {
    const result = await runner(gitPath!, args, { cwd: root });
    if (result.exitCode) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git('init'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(root, 'README.md'), 'Synthetic repository\n');
  if (ignore) await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
  await git('add', '.'); await git('commit', '-m', 'Synthetic fixture');
  return { root, sha: await git('rev-parse', 'HEAD'), git };
}
describe.skipIf(!gitPath)('disposable review worktrees', () => {
  it('creates detached head, detects tracked/untracked writes and cleans idempotently', async () => {
    const { root, sha, git } = await repository(true);
    const tree = await createReviewWorktree(root, sha, runner);
    expect(tree.path.startsWith(path.join(root, '.quorum', 'worktrees'))).toBe(true);
    expect(await isClean(tree.path, runner)).toBe(true);
    const head = await runner(gitPath!, ['symbolic-ref', '-q', 'HEAD'], { cwd: tree.path });
    expect(head.exitCode).toBe(1);
    await writeFile(path.join(tree.path, 'README.md'), 'Changed\n');
    expect(await isClean(tree.path, runner)).toBe(false);
    await runner(gitPath!, ['checkout', '--', 'README.md'], { cwd: tree.path });
    await writeFile(path.join(tree.path, 'untracked.txt'), 'new\n');
    expect(await isClean(tree.path, runner)).toBe(false);
    await Promise.all([tree.cleanup(), tree.cleanup()]); await tree.cleanup();
    await expect(access(tree.path)).rejects.toThrow();
    expect(await git('worktree', 'list', '--porcelain')).not.toContain(tree.path.replaceAll('\\', '/'));
    expect(await isClean(root, runner)).toBe(true);
  });
  it('refuses an unignored .quorum directory', async () => {
    const { root, sha } = await repository(false);
    await expect(createReviewWorktree(root, sha, runner)).rejects.toThrow('git-ignored');
  });
  it('rejects a linked parent before creating any external directory', async () => {
    const { root, sha } = await repository(true);
    const outside = await mkdtemp(path.join(tmpdir(), 'quorum outside ')); roots.push(outside);
    await symlink(outside, path.join(root, '.quorum'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createReviewWorktree(root, sha, runner)).rejects.toThrow('real directory');
    await expect(access(path.join(outside, 'worktrees'))).rejects.toThrow();
  });
});
