import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createReviewWorktree } from '../../src/worktree/index.js';
import type { CommandRunner } from '../../src/types/index.js';

it('serializes creation and cleanup pruning but permits concurrent worktree lifetimes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum-create-lock-'));
  const registered = new Set<string>();
  let creating = 0; let collisions = 0; let maxRegistered = 0;
  const runner: CommandRunner = async (_command, args) => {
    let stdout = '';
    if (args.includes('--show-toplevel')) stdout = root;
    if (args.includes('prune') && creating) collisions++;
    if (args.includes('list')) stdout = [...registered].map(directory => `worktree ${directory}\0`).join('');
    if (args.includes('add')) {
      if (creating) collisions++;
      creating++;
      await new Promise(resolve => setTimeout(resolve, 5));
      const directory = args[args.indexOf('--detach') + 1]!;
      await mkdir(directory);
      registered.add(directory);
      maxRegistered = Math.max(maxRegistered, registered.size);
      creating--;
    }
    if (args.includes('remove')) {
      const directory = args.at(-1)!;
      registered.delete(directory);
      await rm(directory, { recursive: true, force: true });
    }
    return { stdout, stderr: '', exitCode: 0 };
  };
  try {
    const trees = await Promise.all(Array.from({ length: 6 }, () => createReviewWorktree(root, 'a'.repeat(40), runner)));
    expect(maxRegistered).toBe(6);
    expect(collisions).toBe(0);
    await Promise.all(trees.map(tree => tree.cleanup()));
    expect(registered.size).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('releases the creation mutex after a failed add', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum-create-failure-'));
  let attempts = 0;
  const runner: CommandRunner = async (_command, args) => ({
    stdout: args.includes('--show-toplevel') ? root : '', stderr: 'synthetic failure',
    exitCode: args.includes('add') && ++attempts === 1 ? 1 : 0,
  });
  try {
    const settled = await Promise.allSettled([createReviewWorktree(root, 'a'.repeat(40), runner), createReviewWorktree(root, 'a'.repeat(40), runner)]);
    // realpath precedes lock acquisition, so invocation order is not lock order.
    expect(settled.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(attempts).toBe(2);
    for (const item of settled) {
      if (item.status === 'fulfilled') await item.value.cleanup();
      else expect(item.reason).toMatchObject({ message: 'git worktree add failed: synthetic failure' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
