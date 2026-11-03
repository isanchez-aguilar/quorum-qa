import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { permissionPath, checkPermissions } from '../../src/doctor/checks.js';
import { buildReviewContext } from '../../src/context/index.js';
import { createReviewWorktree } from '../../src/worktree/index.js';
import { writeProposedTest } from '../../src/reproduce/write.js';
import { runCommand } from '../../src/process/runner.js';
import type { CommandRunner } from '../../src/types/index.js';

it('reviews and cleans a synthetic repository with TEMP and TMP using an 8.3 alias', async test => {
  if (process.platform !== 'win32') { test.skip('8.3 path aliases require Windows'); return; }
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'quorum long temporary regression ')));
  try {
    if (/[&|<>^%!"\r\n]/.test(directory)) { test.skip('Temporary path cannot safely be passed to cmd FOR'); return; }
    const command = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${directory}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true });
    if (command.error) throw command.error;
    expect(command.status, command.stderr).toBe(0);
    const short = command.stdout.trim();
    if (!short.includes('~') || short.toLowerCase() === directory.toLowerCase()) {
      test.skip('Host volume does not create 8.3 short names'); return;
    }
    expect(await realpath(short)).toBe(directory);
    vi.stubEnv('TEMP', short); vi.stubEnv('TMP', short);
    const root = await mkdtemp(path.join(os.tmpdir(), 'synthetic repository '));
    expect(root).toContain('~');
    expect(permissionPath(path.join(root, '.quorum', 'worktrees'))).toBe(permissionPath(path.join(await realpath(root), '.quorum', 'worktrees')));
    const home = path.join(root, 'synthetic-home');
    const settings = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    await mkdir(path.dirname(settings), { recursive: true });
    const rawRule = root.replace(/\\/g, '/').replace(/^[a-z]:/i, '');
    await writeFile(settings, JSON.stringify({ permissions: { allow: [`read_file(${rawRule})`] } }));
    expect((await checkPermissions(home, await realpath(root)))[0]?.status).toBe('PASS');
    await writeFile(settings, JSON.stringify({ permissions: { allow: ['read_file(*)'], deny: [`read_file(${rawRule})`] } }));
    expect((await checkPermissions(home, await realpath(root)))[0]?.status).toBe('FAIL');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
      GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
    const runner: CommandRunner = (file, args, options) => runCommand(file, args, { ...options, env });
    const git = async (...args: string[]) => {
      const result = await runner('git', args, { cwd: root });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git('init'); await git('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
    await writeFile(path.join(root, 'sample.ts'), 'export const value = 1;\n');
    await git('add', '.'); await git('commit', '-m', 'Synthetic base');
    const base = await git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'sample.ts'), 'export const value = 2;\n');
    await git('add', '.'); await git('commit', '-m', 'Synthetic head');
    const context = await buildReviewContext({ base, head: 'HEAD', cwd: root, mode: 'feature', runner });
    expect(context.worktreeRoot).toBe(await realpath(root));
    expect(context.touchedFiles).toEqual(['sample.ts']);
    const tree = await createReviewWorktree(root, context.headCommit, runner);
    try {
      expect(tree.path).toBe(await realpath(tree.path));
      const written = await writeProposedTest(tree.path, 'synthetic.test.ts', 'synthetic', ['**/*.test.*']);
      expect(written.absolute).toBe(await realpath(written.absolute));
    } finally { await tree.cleanup(); }
    await expect(lstat(tree.path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
