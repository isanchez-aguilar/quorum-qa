import { realpathSync } from 'node:fs';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
// C0 and C1 control characters, DEL included. NUL is rejected before this runs.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function comparable(p: string): string {
  return IS_WINDOWS ? p.toLowerCase() : p;
}

function isInside(realRoot: string, target: string): boolean {
  const root = comparable(realRoot);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return comparable(target).startsWith(prefix);
}

// Resolves symlinks on the deepest ancestor that exists and re-appends the missing tail, so a
// not-yet-existing file is still confined by the real location of its parent directories.
function realpathOfDeepestExisting(absolute: string): string | null {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Turns a path cited by a model into an absolute path that is safely inside `root`, or null.
 * Paths are never URL-decoded. Any colon is rejected: it covers drive letters, URL schemes and
 * Windows alternate data streams (name:stream).
 */
export function normalizePath(root: string, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) return null;

  const cleaned = relativePath.replace(/\\/g, '/').replace(CONTROL_CHARS, '').trim();
  if (cleaned === '') return null;
  if (cleaned.startsWith('/')) return null; // POSIX absolute, and UNC once backslashes are slashes
  if (cleaned.includes(':')) return null; // drive letter, URL scheme, alternate data stream

  // Windows drops trailing dots and spaces from a name, so "..  " would act as "..".
  for (const segment of cleaned.split('/')) {
    if (segment !== '.' && segment !== '..' && /^[. ]+$/.test(segment)) return null;
  }

  const normalized = path.posix.normalize(cleaned);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return null;
  }

  const absolute = path.resolve(root, normalized);
  const real = realpathOfDeepestExisting(absolute);
  if (real === null || !isInside(realRoot, real)) return null;
  return absolute;
}
