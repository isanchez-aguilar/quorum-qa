import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchesTestGlob, MAX_TEST_BYTES, writeProposedTest } from '../../src/reproduce/write.js';

let sandbox: string;
let root: string;
const globs = ['**/*.test.*', '**/*.spec.*'];

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'quorum-reproduce-write-')));
  root = path.join(sandbox, 'worktree');
  await mkdir(root);
});
afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe('small test glob matcher', () => {
  it.each([
    ['a.test.ts', '**/*.test.*', true],
    ['src/nested/a.test.ts', '**/*.test.*', true],
    ['src/a.spec.js', '**/*.test.*', false],
    ['src/a.test.ts', '*.test.*', false],
    ['src/a.test.ts', 'src/*.test.*', true],
    ['src/nested/a.test.ts', 'src/*.test.*', false],
    ['src/a.test.ts', 'src/**/*.test.*', true],
    ['src/nested/a.test.ts', 'src/**/a.test.ts', true],
    ['src/a.test.ts', 'src/?.test.ts', true],
    ['src/ab.test.ts', 'src/?.test.ts', false],
    ['src/.test.ts', 'src/?.test.ts', false],
    ['src/.test.ts', 'src/*.test.ts', true],
    ['src/[a].test.ts', '**/[a].test.ts', true],
    ['src/a.test.ts', '**/[a].test.ts', false],
    ['src/{a,b}.test.ts', '**/{a,b}.test.ts', true],
    ['src\\nested\\a.test.ts', 'src/**/a.test.ts', true],
    ['a.testXts', 'a.test.ts', false],
    ['src/test.ts', '**', true],
    ['src/test.ts', 'src/**', true],
    ['src/nested/a.test.ts', '**/**/a.test.ts', true],
    ['src/🧪.test.ts', 'src/🧪.test.ts', true],
  ])('%s against %s is %s', (file, glob, expected) => {
    expect(matchesTestGlob(file, glob)).toBe(expected);
  });
});

describe('writeProposedTest', () => {
  it.each(['/tmp/pwn.test.ts', '\\pwn.test.ts', 'C:\\pwn.test.ts', '//host/share/pwn.test.ts', '../pwn.test.ts',
    'src/../pwn.test.ts', 'src\\..\\pwn.test.ts', 'src/pwn.test.ts:stream', 'src/\0pwn.test.ts', 'src/.. /pwn.test.ts'])('rejects unsafe path %j', async relative => {
    await expect(writeProposedTest(root, relative, 'test', globs)).rejects.toThrow(/relative path/);
  });
  it('rejects a nonmatching glob before creating parents', async () => {
    await expect(writeProposedTest(root, 'new/src.ts', 'test', globs)).rejects.toThrow(/testGlobs/);
    await expect(lstat(path.join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('writes nested new directories and returns the host and relative paths', async () => {
    const result = await writeProposedTest(root, 'new\\nested\\case.test.ts', 'synthetic test', globs);
    expect(result).toEqual({ absolute: path.join(root, 'new', 'nested', 'case.test.ts'), relative: 'new/nested/case.test.ts' });
    expect(await readFile(result.absolute, 'utf8')).toBe('synthetic test');
  });
  it('never overwrites an existing file', async () => {
    await writeFile(path.join(root, 'existing.test.ts'), 'original');
    await expect(writeProposedTest(root, 'existing.test.ts', 'changed', globs)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(root, 'existing.test.ts'), 'utf8')).toBe('original');
  });
  it('rejects a file as a parent', async () => {
    await writeFile(path.join(root, 'tests'), 'file');
    await expect(writeProposedTest(root, 'tests/a.test.ts', 'test', globs)).rejects.toThrow(/real directory/);
  });
  it.each(['inside', 'outside'])('rejects a symlink or Windows junction to an %s directory before making new parents', async location => {
    const target = path.join(location === 'inside' ? root : sandbox, 'target');
    await mkdir(target);
    await symlink(target, path.join(root, 'tests'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeProposedTest(root, 'tests/nested/a.test.ts', 'test', globs)).rejects.toThrow(/symlink or junction/);
    await expect(lstat(path.join(target, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a linked worktree root', async () => {
    const linked = path.join(sandbox, 'linked');
    await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeProposedTest(linked, 'a.test.ts', 'test', globs)).rejects.toThrow(/symlink or junction/);
  });
  it('permits exactly 64 KiB and rejects one byte more', async () => {
    const content = 'a'.repeat(MAX_TEST_BYTES);
    const result = await writeProposedTest(root, 'limit.test.ts', content, globs);
    expect((await readFile(result.absolute)).byteLength).toBe(MAX_TEST_BYTES);
    await expect(writeProposedTest(root, 'nested/large.test.ts', content + 'a', globs)).rejects.toThrow(/64 KiB/);
    await expect(lstat(path.join(root, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('counts UTF-8 bytes instead of characters', async () => {
    await expect(writeProposedTest(root, 'large.test.ts', 'é'.repeat(MAX_TEST_BYTES / 2 + 1), globs)).rejects.toThrow(/64 KiB/);
  });
  it('exclusive create refuses a dangling leaf link', async context => {
    try { await symlink(path.join(sandbox, 'missing'), path.join(root, 'a.test.ts'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip('Windows refused file symlink creation'); return;
      }
      throw error;
    }
    await expect(writeProposedTest(root, 'a.test.ts', 'test', globs)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(lstat(path.join(sandbox, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
