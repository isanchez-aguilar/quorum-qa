import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** Canonical identity of an existing path, including Windows 8.3 aliases.
 * Callers that forbid links must lstat the original path before resolving it.
 */
export function canonicalPath(value: string, allowMissing = false): string {
  try { return realpathSync.native(value); }
  catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Do not mistake an existing dangling link for an absent component.
    try { lstatSync(value); }
    catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      const absolute = path.resolve(value);
      const parent = path.dirname(absolute);
      if (parent !== absolute) {
        const resolved = canonicalPath(parent, true);
        try {
          if (!statSync(resolved).isDirectory()) throw Object.assign(new Error('Path parent is not a directory.'), { code: 'ENOTDIR' });
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
        }
        return path.join(resolved, path.basename(absolute));
      }
    }
    throw error;
  }
}
