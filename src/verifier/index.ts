import { readFile, stat } from 'node:fs/promises';
import type { Finding } from '../types/index.js';
import { isCitableLine, splitLines, WINDOW_RADIUS } from './lines.js';
import { normalizePath } from './path.js';
import {
  FUZZY,
  findQuote,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  normalizeQuote,
} from './quote.js';

// Files bigger than this are not read: a model citing a bundle or a data dump is not a review.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface VerifyResult {
  verified: boolean;
  // Present when verified: a copy of the finding with `verified: true`, the real line, and a
  // `verification_note` when the line was corrected or the match was fuzzy.
  correctedFinding?: Finding;
  reason?: string;
}

function reject(reason: string): VerifyResult {
  return { verified: false, reason };
}

function formatSimilarity(similarity: number): string {
  return similarity.toFixed(2);
}

/**
 * Checks that a finding points at real code: the path stays inside the worktree, the file exists,
 * and the evidence quote is found at (or near) the cited line. Never mutates the finding.
 */
export async function verifyFinding(worktreeRoot: string, finding: Finding): Promise<VerifyResult> {
  const absolute = normalizePath(worktreeRoot, finding.file);
  if (absolute === null) {
    return reject(`invalid path: "${String(finding.file)}" is not a relative path inside the worktree`);
  }

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return reject(`file not found: "${finding.file}" does not exist in the worktree`);
  }
  if (info.isDirectory()) return reject(`"${finding.file}" is a directory, not a file`);
  if (!info.isFile()) return reject(`"${finding.file}" is not a regular file`);
  if (info.size > MAX_FILE_BYTES) {
    return reject(
      `file too large to verify: "${finding.file}" is ${info.size} bytes (limit ${MAX_FILE_BYTES})`,
    );
  }

  const quote = typeof finding.evidence_quote === 'string' ? normalizeQuote(finding.evidence_quote) : '';
  if (quote === '') return reject('empty evidence quote');
  const quoteLines = quote.split('\n').length;
  if (quoteLines > MAX_QUOTE_LINES || quote.length > MAX_QUOTE_CHARS) {
    return reject(
      `evidence quote too large to verify (${quoteLines} lines, ${quote.length} characters; ` +
        `limits ${MAX_QUOTE_LINES} lines and ${MAX_QUOTE_CHARS} characters)`,
    );
  }

  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch {
    return reject(`file not readable: "${finding.file}"`);
  }
  const lines = splitLines(content);
  if (lines.length === 0) return reject(`"${finding.file}" is empty, so the quote cannot be there`);

  const match = findQuote(lines, quote, finding.line);
  if (match === null) {
    return reject(
      `evidence quote not found in "${finding.file}": no match within ${WINDOW_RADIUS} lines of ` +
        `line ${String(finding.line)} or anywhere else in the file (similarity threshold ${FUZZY})`,
    );
  }

  const notes: string[] = [];
  if (match.line !== finding.line) {
    const cited = isCitableLine(finding.line)
      ? `line ${finding.line}`
      : `unusable line ${String(finding.line)}`;
    const where =
      match.scope === 'local' ? `within ${WINDOW_RADIUS} lines` : 'elsewhere in the file';
    notes.push(`corrected from ${cited} to line ${match.line} (${where})`);
  }
  if (!match.exact) {
    notes.push(`fuzzy quote match, similarity ${formatSimilarity(match.similarity)}`);
  }

  const correctedFinding: Finding = { ...finding, line: match.line, verified: true };
  if (notes.length > 0) correctedFinding.verification_note = notes.join('; ');
  return { verified: true, correctedFinding };
}
