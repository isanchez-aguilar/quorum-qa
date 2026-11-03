import { runCascade } from '../../src/cascade/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { validateConfig } from '../../src/config/schema.js';
import { catalog } from '../fixtures/cascade.js';
import { realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(context.requestedBaseCommit).toBe(base);
    expect(context.headCommit).toBe(head);
    expect(path.resolve(context.worktreeRoot)).toBe(await realpath(cwd));
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
  it('uses the merge base when the target branch has advanced', async () => {
    const blobResult = await runner(gitPath!, ['hash-object', '-w', '--stdin'], { cwd, stdin: 'main-only content\n' });
    expect(blobResult.exitCode).toBe(0);
    const blob = blobResult.stdout.trim();
    const index = path.join(cwd, '.git', 'synthetic-index');
    const indexRunner: CommandRunner = (command, args, options) =>
      runCommand(command, args, { ...options, env: { ...env, GIT_INDEX_FILE: index } });
    expect((await indexRunner(gitPath!, ['read-tree', base], { cwd })).exitCode).toBe(0);
    expect((await indexRunner(gitPath!, ['update-index', '--add', '--cacheinfo', `100644,${blob},main-only.txt`], { cwd })).exitCode).toBe(0);
    const treeResult = await indexRunner(gitPath!, ['write-tree'], { cwd });
    expect(treeResult.exitCode).toBe(0);
    const mainTree = treeResult.stdout.trim();
    const main = await git('commit-tree', mainTree, '-p', base, '-m', 'Main only file');
    const context = await buildReviewContext({ base: main, head, cwd, mode: 'feature', runner });
    expect(context.touchedFiles).not.toContain('main-only.txt');
    expect(context.diff).not.toContain('main-only.txt');
    expect(context.diff).not.toContain('main-only content');
    expect(context.baseCommit).toBe(base);
    expect(context.requestedBaseCommit).toBe(main);
  });
  it('ignores hostile global diff formatting', async () => {
    const config = path.join(cwd, '.git', 'hostile.gitconfig');
    await writeFile(config, '[color]\n ui = always\n[diff]\n noprefix = true\n renames = true\n[core]\n quotePath = true\n');
    const hostileRunner: CommandRunner = (command, args, options) => runCommand(command, args,
      { ...options, env: { ...env, GIT_CONFIG_GLOBAL: config } });
    const diff = await diffRange(`${base}..${head}`, cwd, hostileRunner);
    expect(diff).not.toContain('\u001b');
    expect(diff).toContain('--- a/sample.txt');
    expect(diff).toContain('+++ b/sample.txt');
  });
  it.each(['context', 'existence', 'blame', 'diff', 'files'])('rejects subdirectory cwd for %s', async helper => {
    const subdir = path.join(cwd, 'subdir');
    await mkdir(subdir, { recursive: true });
    const calls = {
      context: () => buildReviewContext({ base, head, cwd: subdir, mode: 'feature', runner }),
      existence: () => fileExistsAtCommit(base, 'sample.txt', subdir, runner),
      blame: () => determineOrigin('sample.txt', 1, base, head, subdir, runner),
      diff: () => diffRange(`${base}..${head}`, subdir, runner),
      files: () => changedFiles(`${base}..${head}`, subdir, runner),
    };
    await expect(calls[helper as keyof typeof calls]()).rejects.toThrow('cwd must be the repository root');
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
  it('reviews real git paths with spaces and Unicode', async () => {
    await mkdir(path.join(cwd, 'dir x'), {recursive:true});
    await writeFile(path.join(cwd, 'dir x/my file.ts'), 'value\n');
    await writeFile(path.join(cwd, 'café.txt'), 'value\n');
    await git('add', '.'); await git('commit', '-m', 'Paths');
    const ctx = await buildReviewContext({base:later, head:'HEAD', cwd, mode:'feature', runner});
    const fake = new FakeProvider('agy', 'google', runner, {flash:['[]']});
    const cfg = validateConfig({checks:[], tiers:{triage:['agy:flash'], review:['agy:pro'], confirm:['codex'], visual:[]}});
    const result = await runCascade(ctx, cfg, new Map([['agy',fake]]), {catalog});
    expect(result.coverage.reviewedFiles).toEqual(['café.txt', 'dir x/my file.ts']);
    expect(result.coverage.complete).toBe(true);
  });
  it('caps a large real diff with a marker and preserves its beginning', async () => {
    await writeFile(path.join(cwd, 'large.txt'), 'synthetic content\n'.repeat(80_000));
    await git('add', '.'); await git('commit', '-m', 'Large');
    const context = await buildReviewContext({ base: later, head: 'HEAD', cwd, mode: 'feature', runner });
    expect(context.diff.startsWith('diff --git')).toBe(true);
    expect(context.diff.endsWith(DIFF_TRUNCATION_MARKER)).toBe(true);
    expect(context.diffTruncated).toBe(true);
    expect(Buffer.byteLength(context.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
  });
});

it.each(['HEAD~1', 'HEAD~1...HEAD', 'main~~', 'origin/main~3..feature/x', 'HEAD~'])('accepts ancestry suffix %j', ref => {
  expect(() => validateRef(ref)).not.toThrow();
});

it.each(['--output=x', 'a b', 'a\nb', 'a\0b', 'HEAD^', 'HEAD^1', 'HEAD~1^2', '~1', 'HEAD~-1', 'HEAD~12345', '-~1', 'a....b', 'a..', '..b', 'a..b..c', 'a^{commit}'])('rejects unsafe ref %j', async ref => {
  const runner = vi.fn<CommandRunner>();
  expect(() => validateRef(ref)).toThrow('Invalid git ref');
  await expect(revParse(ref, process.cwd(), runner)).rejects.toThrow('Invalid git ref');
  expect(runner).not.toHaveBeenCalled();
});
