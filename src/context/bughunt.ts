import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewContext } from '../types/index.js';
import { MAX_FILE_BYTES } from '../verifier/index.js';
import { splitLines } from '../verifier/lines.js';
import { normalizePath } from '../verifier/path.js';
import { cleanDiff, diffSectionPath } from './diff.js';

export interface WindowRange { start: number; end: number }
export interface ReviewWindow extends WindowRange { file: string }
export interface BughuntWindow extends ReviewWindow { content: string; orientation: string }
export interface BughuntContext {
  windows: BughuntWindow[];
  skippedFiles: string[];
  binaryFiles: string[];
  notes: string[];
}

function hunks(diff: string, totalLines: number) {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@[^\n]*(?:\n(?!@@ |diff --git )[^\n]*)*/gm)].map(match => {
    const count = Number(match[2] ?? 1);
    // A zero-length range is the boundary AFTER its line; an out-of-bounds hunk is at EOF.
    const start = Math.min(totalLines + 1, Math.max(1, Number(match[1]) + (count === 0 ? 1 : 0)));
    const end = Math.min(totalLines, start + count - 1);
    return { start, end, text: match[0] };
  });
}

/** Select flanks of HEAD hunk ranges, excluding every hunk (including unified context). */
export function selectWindows(diff: string, totalLines: number, radius: number): WindowRange[] {
  radius = Math.max(0, Math.min(200, Math.trunc(radius)));
  if (!radius || !totalLines) return [];
  const changes = hunks(diff, totalLines);
  const candidates = changes.flatMap(({ start, end }) => [
    { start: Math.max(1, start - radius), end: start - 1 },
    { start: end + 1, end: Math.min(totalLines, end + radius) },
  ]).filter(range => range.start <= range.end).sort((a, b) => a.start - b.start);
  const merged: WindowRange[] = [];
  for (const range of candidates) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  // A neighboring hunk can lie inside another hunk's flank. Never label it unchanged.
  return changes.reduce((ranges, change) => change.start > change.end ? ranges : ranges.flatMap(range => {
    if (change.start > range.end || change.end < range.start) return [range];
    return [
      { start: range.start, end: change.start - 1 },
      { start: change.end + 1, end: range.end },
    ].filter(part => part.start <= part.end);
  }), merged);
}

/** Read only the disposable HEAD worktree, never the user's possibly dirty checkout. */
export async function buildBughuntContext(context: ReviewContext, headRoot: string): Promise<BughuntContext> {
  const result: BughuntContext = { windows: [], skippedFiles: [], binaryFiles: [], notes: [] };
  const sections = cleanDiff(context.diff).diff.split(/(?=^diff --git )/m);
  const radius = context.radius ?? 40;
  for (const file of context.touchedFiles) {
    const section = sections.find(item => diffSectionPath(item) === file);
    if (section && /^Binary files .* differ\r?$/m.test(section)) {
      result.binaryFiles.push(file);
      result.notes.push(`${file}: binary file skipped (no text windows).`);
      continue;
    }
    const skip = (reason: string) => { result.skippedFiles.push(file); result.notes.push(`${file}: ${reason}; bughunt windows skipped.`); };
    if (!section) { skip('no usable diff section'); continue; }
    const safePath = normalizePath(headRoot, file);
    if (!safePath) { skip('unsafe HEAD path'); continue; }
    try {
      const stat = await lstat(path.resolve(headRoot, file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) { skip('HEAD file is not regular text within the 2 MiB limit'); continue; }
      const content = await readFile(safePath, 'utf8');
      if (content.includes('\0')) { result.binaryFiles.push(file); result.notes.push(`${file}: binary HEAD content skipped.`); continue; }
      const lines = splitLines(content);
      const changes = hunks(section, lines.length);
      for (const range of selectWindows(section, lines.length, radius)) {
        // NNNN: is a minimum-four-digit, one-based HEAD line number, followed by the exact line.
        const numbered = lines.slice(range.start - 1, range.end).map((line, index) => `${String(range.start + index).padStart(4, '0')}: ${line}`).join('\n');
        const orientation = changes.filter(change => range.start <= change.end + radius && range.end >= change.start - radius)
          .map(change => change.text).join('\n');
        result.windows.push({ file, ...range, content: numbered, orientation });
      }
    } catch (error) {
      skip((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no HEAD version (deleted file)' : 'HEAD file could not be read');
    }
  }
  return result;
}
