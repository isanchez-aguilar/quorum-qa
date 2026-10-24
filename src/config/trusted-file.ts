import { ConfigError } from './schema.js';
import { git, validateRef } from '../context/git.js';
import type { CommandRunner } from '../types/index.js';

export const CONFIG_MAX_BYTES = 8 * 1024 * 1024;

/** Read a root configuration blob from an explicitly selected trusted commit. */
export async function loadTrustedJson(commit: string, file: string, root: string, runner: CommandRunner): Promise<unknown | undefined> {
  validateRef(commit, false);
  const listing = await git(['ls-tree', '-z', commit, '--', file], root, runner);
  if (listing.exitCode !== 0) throw new Error(`Cannot load ${file}: ${listing.stderr}`);
  if (!listing.stdout) return undefined;
  if (!/^100(?:644|755) blob /.test(listing.stdout)) throw new ConfigError([`${file} must be a regular file, not a symlink`]);
  const result = await git(['show', `${commit}:${file}`], root,
    (command, args, options) => runner(command, args, { ...options, maxOutputBytes: CONFIG_MAX_BYTES }));
  if (result.exitCode !== 0) throw new Error(`Cannot load ${file}: ${result.stderr}`);
  if (Buffer.byteLength(result.stdout) > CONFIG_MAX_BYTES) throw new ConfigError([`${file} exceeds the size limit of 8 MiB`]);
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new ConfigError([`${file} is not valid JSON`]); }
}
