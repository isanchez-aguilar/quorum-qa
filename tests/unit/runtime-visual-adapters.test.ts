import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgyProvider, AGY_NO_TOOLS } from '../../src/providers/agy.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import type { CommandRunner, ReviewContext } from '../../src/types/index.js';

it.each(['agy', 'claude'] as const)('gives %s only the image directory without any git operation', async name => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quorum-runtime-images-'));
  const images = [path.join(root, 'home-0-before.jpg'), path.join(root, 'home-0-after.jpg')];
  try {
    for (const image of images) await writeFile(image, Buffer.from([255, 216, 255, 1]));
    const runner = vi.fn<CommandRunner>(async (file, args, options) => {
      expect(path.basename(file)).toBe(name); expect(options!.cwd).toBe(root);
      expect(await readdir(root)).toEqual(['home-0-after.jpg', 'home-0-before.jpg']);
      const prompt = name === 'agy' ? args.find(arg => arg.startsWith('--print='))! : options!.stdin!;
      expect(prompt).toContain('home-0-before.jpg'); expect(prompt).toContain('home-0-after.jpg');
      expect(prompt).not.toContain(AGY_NO_TOOLS);
      return { stdout: JSON.stringify(name === 'agy' ? { status: 'SUCCESS', response: '[]' } : { subtype: 'success', result: '[]' }), stderr: '', exitCode: 0 };
    });
    const options = { runner, platform: 'linux' as const, env: { PATH: '/synthetic/bin' }, exists: () => true };
    const provider = name === 'agy' ? new AgyProvider(options) : new ClaudeProvider(options);
    const context: ReviewContext = { mode: 'runtime', worktreeRoot: root, images, diff: '', touchedFiles: [], baseCommit: '', headCommit: '' };
    expect(await provider.executeReview(context, 'synthetic', 'Compare images', { deadlineMs: 1000 })).toMatchObject({ rawOutput: '[]', worktreeClean: true });
    expect(runner).toHaveBeenCalledOnce();
  } finally { await rm(root, { recursive: true, force: true }); }
});
