import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveCommand } from '../../src/checks/resolver.js';
import { runCommand } from '../../src/process/runner.js';
import { buildReviewContext, DIFF_TRUNCATION_MARKER, MAX_DIFF_BYTES } from '../../src/context/index.js';
import { changedFiles, diffRange, fileExistsAtCommit, mergeBase, revParse, validateRef } from '../../src/context/git.js';
import { determineOrigin } from '../../src/context/blame.js';
import type { CommandRunner } from '../../src/types/index.js';

let gitPath: string | undefined;
try { gitPath = resolveCommand('git', []).file; } catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('Command not found on PATH:')) throw error;
  console.warn('Skipping context integration tests: git is not on PATH.');
}

describe.skipIf(!gitPath)('synthetic git context', () => {
  let cwd: string;
  let base: string;
  let head: string;
  let later: string;
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic Author', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Author', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
  const runner: CommandRunner = (command, args, options) => runCommand(command, args, { ...options, env });
  async function git(...args: string[]) {
    const result = await runner(gitPath!, args, { cwd, timeoutMs: 10_000 });
    if (result.exitCode) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'quorum context '));
    await git('init');
    await git('config', 'commit.gpgsign', 'false');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(path.join(cwd, 'sample.txt'), 'old line\nunchanged\n');
    await writeFile(path.join(cwd, 'deleted.txt'), 'deleted\n');
    await git('add', '.'); await git('commit', '-m', 'Base');
    base = await git('rev-parse', 'HEAD');
    await writeFile(path.join(cwd, 'sample.txt'), 'old line\nunchanged\nintroduced\n');
    await writeFile(path.join(cwd, 'new file.txt'), 'new file\n');
    await rm(path.join(cwd, 'deleted.txt'));
    await git('add', '.'); await git('commit', '-m', 'Head');
    head = await git('rev-parse', 'HEAD');
    await writeFile(path.join(cwd, 'sample.txt'), 'changed later\nunchanged\nintroduced\n');
    await git('add', '.'); await git('commit', '-m', 'Later');
    later = await git('rev-parse', 'HEAD');
  }, 30_000);
  afterAll(async () => { if (cwd) await rm(cwd, { recursive: true, force: true }); });
  it('extracts diff, statuses, commits and existence at base', async () => {
    expect(await revParse(head, cwd, runner)).toBe(head);
    expect(await mergeBase(base, head, cwd, runner)).toBe(base);
    const context = await buildReviewContext({ base, head, cwd, mode: 'feature', runner });
    expect(context.diff).toContain('+introduced');
    expect(context.diff).not.toContain('+changed later');
    expect(context.baseCommit).toBe(base);
    expect(context.headCommit).toBe(head);
    expect(path.resolve(context.worktreeRoot)).toBe(path.resolve(cwd));
    expect(context.touchedFiles).toEqual(['deleted.txt', 'new file.txt', 'sample.txt']);
    expect(await changedFiles(`${base}..${head}`, cwd, runner)).toEqual([
      { status: 'D', path: 'deleted.txt' }, { status: 'A', path: 'new file.txt' }, { status: 'M', path: 'sample.txt' },
    ]);
    expect(await fileExistsAtCommit(base, 'sample.txt', cwd, runner)).toBe(true);
    expect(await fileExistsAtCommit(base, 'new file.txt', cwd, runner)).toBe(false);
    await expect(fileExistsAtCommit('missing-ref', 'sample.txt', cwd, runner)).rejects.toThrow();
    expect(await diffRange(`${base}...${head}`, cwd, runner)).toBe(context.diff);
  });
  it('testBlame_IntroducedLine', async () => {
    expect(await determineOrigin('sample.txt', 3, base, head, cwd, runner)).toBe('introduced');
  });
  it('testBlame_PreexistingLine', async () => {
    expect(await determineOrigin('sample.txt', 1, base, head, cwd, runner)).toBe('pre-existing');
  });
  it('classifies a new file and a later changed line', async () => {
    expect(await determineOrigin('new file.txt', 1, base, head, cwd, runner)).toBe('introduced');
    expect(await determineOrigin('sample.txt', 1, head, later, cwd, runner)).toBe('introduced');
    expect(await determineOrigin('sample.txt', 2, head, later, cwd, runner)).toBe('pre-existing');
    await expect(determineOrigin('sample.txt', 999, base, head, cwd, runner)).rejects.toThrow('git blame failed');
  });
  it('caps a large real diff with a marker and preserves its beginning', async () => {
    await writeFile(path.join(cwd, 'large.txt'), 'synthetic content\n'.repeat(80_000));
    await git('add', '.'); await git('commit', '-m', 'Large');
    const context = await buildReviewContext({ base: later, head: 'HEAD', cwd, mode: 'feature', runner });
    expect(context.diff.startsWith('diff --git')).toBe(true);
    expect(context.diff.endsWith(DIFF_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(context.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
  });
});

it.each(['--output=x', 'a b', 'a\nb', 'a\0b', 'HEAD~1', 'a....b', 'a..', '..b', 'a..b..c', 'a^{commit}'])('rejects unsafe ref %j', async ref => {
  const runner = vi.fn<CommandRunner>();
  expect(() => validateRef(ref)).toThrow('Invalid git ref');
  await expect(revParse(ref, process.cwd(), runner)).rejects.toThrow('Invalid git ref');
  expect(runner).not.toHaveBeenCalled();
});
