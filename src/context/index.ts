import type { CommandRunner, ReviewContext } from '../types/index.js';
import { changedFiles, diffRange, mergeBase, requireWorktreeRoot, revParse } from './git.js';

export const MAX_DIFF_BYTES = 512 * 1024;
export const DIFF_TRUNCATION_MARKER = '\n[Quorum: diff truncated at 512 KiB]\n';

export async function buildReviewContext({ base, head, cwd, mode, runner }: {
  base: string; head: string; cwd: string; mode: ReviewContext['mode']; runner: CommandRunner;
}): Promise<ReviewContext> {
  const requestedBaseCommit = await revParse(base, cwd, runner);
  const headCommit = await revParse(head, cwd, runner);
  const root = await requireWorktreeRoot(cwd, runner);
  const baseCommit = await mergeBase(requestedBaseCommit, headCommit, root, runner);
  const range = `${baseCommit}..${headCommit}`;
  const raw = Buffer.from(await diffRange(range, root, runner));
  let end = MAX_DIFF_BYTES - Buffer.byteLength(DIFF_TRUNCATION_MARKER);
  while (end > 0 && (raw[end]! & 0xc0) === 0x80) end--;
  const diff = raw.length > MAX_DIFF_BYTES
    ? raw.subarray(0, end).toString('utf8') + DIFF_TRUNCATION_MARKER : raw.toString('utf8');
  return { mode, diff, baseCommit, requestedBaseCommit, headCommit, worktreeRoot: root,
    touchedFiles: (await changedFiles(range, root, runner)).map(file => file.path) };
}
