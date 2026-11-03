import { canonicalPath } from '../paths.js';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_TEST_BYTES = 64 * 1024;

// Only ** (whole path components), * and ? are special; brackets and braces are literal.
export function matchesTestGlob(file: string, glob: string): boolean {
  const segments = file.replace(/\\/g, '/').split('/');
  const patterns = glob.replace(/\\/g, '/').split('/');
  const segmentMatches = (value: string, pattern: string): boolean => {
    let previous = Array<boolean>(value.length + 1).fill(false);
    previous[0] = true;
    for (let tokenIndex = 0; tokenIndex < pattern.length; tokenIndex++) {
      const token = pattern[tokenIndex]!;
      const next = Array<boolean>(value.length + 1).fill(false);
      next[0] = token === '*' && previous[0] === true;
      for (let i = 1; i <= value.length; i++) {
        next[i] = token === '*'
          ? previous[i] === true || next[i - 1] === true
          : previous[i - 1] === true && (token === '?' || token === value[i - 1]);
      }
      previous = next;
    }
    return previous[value.length] === true;
  };
  let previous = Array<boolean>(segments.length + 1).fill(false);
  previous[0] = true;
  for (const pattern of patterns) {
    const next = Array<boolean>(segments.length + 1).fill(false);
    next[0] = pattern === '**' && previous[0] === true;
    for (let i = 1; i <= segments.length; i++) {
      next[i] = pattern === '**'
        ? previous[i] === true || next[i - 1] === true
        : previous[i - 1] === true && segmentMatches(segments[i - 1]!, pattern);
    }
    previous = next;
  }
  return previous[segments.length] === true;
}

export async function writeProposedTest(
  worktreePath: string, relPath: string, content: string, testGlobs: string[],
): Promise<{ absolute: string; relative: string }> {
  const relative = relPath.replace(/\\/g, '/');
  const segments = relative.split('/');
  if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relPath)
    || /[\0:]/.test(relative) || segments.some(segment => segment === '..' || segment === '.' || segment === ''
      // Windows strips trailing spaces/dots, including disguised parent paths.
      || /[. ]$/.test(segment))) {
    throw new Error('Proposed test must be a relative path without traversal, NUL or colon.');
  }
  if (!testGlobs.some(glob => matchesTestGlob(relative, glob))) throw new Error('Proposed test does not match testGlobs.');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEST_BYTES) throw new Error('Proposed test exceeds 64 KiB.');
  const root = canonicalPath(worktreePath);
  const checkDirectory = async (directory: string): Promise<void> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Proposed test parent must be a real directory, not a symlink or junction.');
    const actual = canonicalPath(directory);
    const fromRoot = path.relative(root, actual);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error('Proposed test parent escapes the worktree.');
    }
  };
  await checkDirectory(worktreePath);
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    try {
      await checkDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(directory);
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
      }
      await checkDirectory(directory);
    }
  }
  // Providers have stopped before this walk. Like the verifier, this does not claim
  // protection against a concurrent host attacker replacing checked parent directories.
  const absolute = path.join(directory, segments.at(-1)!);
  // Windows exclusive creation alone does not reliably reject dangling links.
  // lstat checks the leaf itself, including file/dir symlinks with missing targets.
  try {
    await lstat(absolute);
    throw Object.assign(new Error('Proposed test already exists.'), { code: 'EEXIST' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(absolute, content, { encoding: 'utf8', flag: 'wx' });
  return { absolute, relative };
}
