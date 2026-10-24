import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Finding } from '../types/index.js';
import { isCitableLine, splitLines, WINDOW_RADIUS } from './lines.js';
import { normalizePath } from './path.js';
import {
  countAlphanumeric,
  findQuote,
  FUZZY,
  matchAtLine,
  MAX_LINE,
  MAX_QUOTE_CHARS,
  MAX_QUOTE_LINES,
  MAX_RAW_QUOTE,
  MIN_ALNUM,
  normalizeQuote,
  WORK_BUDGET,
} from './quote.js';
import { semanticDifference, withoutComments } from './semantic.js';

// Files bigger than this are not read: a model citing a bundle or a data dump is not a review.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// How much of the code a note quotes back.
const FOUND_NOTE_CHARS = 240;

export interface VerifyResult {
  verified: boolean;
  // Present when verified: a copy of the finding with `verified: true`, the real line, and a
  // `verification_note` when the line was corrected or the match was fuzzy. `evidence_quote`
  // stays the ORIGINAL quote (minus diff markers or line-number prefixes); a fuzzy note carries the
  // text actually found in the code.
  correctedFinding?: Finding;
  reason?: string;
  readError?: boolean;
}

function reject(reason: string): VerifyResult {
  return { verified: false, reason };
}

function formatSimilarity(similarity: number): string {
  return similarity.toFixed(2);
}

function showCode(text: string): string {
  const shown = text.length > FOUND_NOTE_CHARS ? `${text.slice(0, FOUND_NOTE_CHARS)}...` : text;
  return JSON.stringify(shown);
}

// Only quote-side presentation is removed. Prefer an existing code line (notably unary +)
// over interpreting its first character as a diff marker.
function stripQuoteMarkers(raw: string, lines: string[], file: string): { quote: string; stripped: boolean; reason?: string } {
  let source: Set<string> | undefined;
  const lineKey = (line: string) => line.replace(/\t/g, '  ').trimEnd();
  const isSource = (line: string): boolean => {
    source ??= new Set(lines.filter(value => value.length <= MAX_LINE).map(lineKey));
    return source.has(lineKey(line));
  };
  const filePrefix = `${file.replace(/\\/g, '/')}:`;
  const withoutPrefix = (line: string): string => {
    const numbered = line.replace(/\\/g, '/').startsWith(filePrefix) ? line.slice(filePrefix.length) : line;
    const prefix = /^\d+(?:: | \| )/.exec(numbered);
    return prefix ? numbered.slice(prefix[0].length) : line;
  };
  const codeChars = (line: string) => line.replace(/\s/g, '').length;
  const diff = /^(?:[+-]|@@ .* @@)/m.test(raw);
  let stripped = false;
  let removed = false;
  let removedChars = 0;
  const kept: string[] = [];
  for (let line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    // Preserve real lines before interpreting any part of them as presentation.
    if (/^(?:[+\- @]|\d)/.test(line) || line.replace(/\\/g, '/').startsWith(filePrefix)) {
      if (isSource(line)) {
        kept.push(line);
        continue;
      }
      if (/^@@ .* @@/.test(line)) {
        stripped = true;
        continue;
      }
      const numbered = withoutPrefix(line);
      if (numbered !== line && isSource(numbered)) {
        line = numbered;
        stripped = true;
      } else if (line.startsWith('-')) {
        removed = true;
        stripped = true;
        removedChars += codeChars(withoutPrefix(line.slice(1)));
        continue;
      } else if (line.startsWith('+') || (diff && line.startsWith(' '))) {
        // Prefer the single marker; an extra presentation space is stripped only
        // when that first candidate is not itself a real source line.
        const candidates = [line.slice(1)];
        if (line[1] === ' ') candidates.push(line.slice(2));
        const candidate = candidates.flatMap(value => [value, withoutPrefix(value)]).find(isSource);
        if (candidate !== undefined) {
          line = candidate;
          stripped = true;
        }
      }
    }
    kept.push(line);
  }
  const quote = normalizeQuote(kept.join('\n'));
  if (removed && quote === '') return { quote, stripped, reason: 'quote is removed code from the diff' };
  const keptChars = codeChars(quote);
  if (removed && keptChars < (keptChars + removedChars) * 0.6) {
    return { quote, stripped, reason: 'quote retains less than 60% after removing deleted diff lines' };
  }
  return { quote, stripped };
}

// Reads at most size + 1 bytes from the descriptor that was already checked with fstat. A file
// that grows between the fstat and the read is reported, never read past its checked size.
async function readBounded(handle: FileHandle, size: number): Promise<string | null> {
  const capacity = size + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let total = 0;
  while (total < capacity) {
    const { bytesRead } = await handle.read(buffer, total, capacity - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total > size ? null : buffer.toString('utf8', 0, total);
}

/**
 * Checks that a finding points at real code: the path stays inside the worktree, the file exists,
 * and the evidence quote is found at (or near) the cited line. Never mutates the finding.
 *
 * A quote is verified when it appears verbatim, or when a fuzzy match (similarity >= 0.85) has the
 * same code tokens in the same order: grouping, operators, keywords such as true/false/null, numbers,
 * string contents (ordinary quote style may differ; template `${...}` expressions are code) and identifiers, where
 * an identifier may carry a typo (see semantic.ts). A fuzzy match that differs in a token is
 * rejected naming the token.
 *
 * A quote with fewer than MIN_ALNUM letters or digits is weak evidence. It is verified only when it
 * appears exactly on the cited line; it is never relocated, never fuzzy-matched and never searched
 * for in the rest of the file. A quote with no letter or digit at all is rejected outright.
 *
 * Confinement: normalizePath returns the REAL path, which is opened once; the checks (regular
 * file, size) and the read use that one descriptor. This is meant for a worktree the provider
 * process has already stopped writing to. It is not a defence against a concurrent attacker who
 * swaps path components between the confinement check and the open.
 */
export async function verifyFinding(worktreeRoot: string, finding: Finding): Promise<VerifyResult> {
  const real = normalizePath(worktreeRoot, finding.file);
  if (real === null) {
    return reject(`invalid path: "${String(finding.file)}" is not a relative path inside the worktree`);
  }

  let handle: FileHandle;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open; the fstat below then rejects it.
    handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return reject(`file not found: "${finding.file}" does not exist in the worktree`);
    }
    // Only to word the reason: a directory cannot be opened as a file on every platform.
    const info = await stat(real).catch(() => null);
    if (info?.isDirectory() === true) return reject(`"${finding.file}" is a directory, not a file`);
    return { ...reject(`file not readable: "${finding.file}"`), readError: true };
  }

  try {
    const info = await handle.stat();
    if (info.isDirectory()) return reject(`"${finding.file}" is a directory, not a file`);
    if (!info.isFile()) return reject(`"${finding.file}" is not a regular file`);
    if (info.size > MAX_FILE_BYTES) {
      return reject(
        `file too large to verify: "${finding.file}" is ${info.size} bytes (limit ${MAX_FILE_BYTES})`,
      );
    }

    // Checked before the quote is normalized, so a huge quote costs nothing.
    const raw = typeof finding.evidence_quote === 'string' ? finding.evidence_quote : '';
    if (raw.length > MAX_RAW_QUOTE) {
      return reject(
        `evidence quote too large to verify (${raw.length} characters before normalization; ` +
          `limit ${MAX_RAW_QUOTE})`,
      );
    }
    let quote = normalizeQuote(raw);
    if (quote === '') return reject('empty evidence quote');
    let alphanumeric = countAlphanumeric(quote);
    if (alphanumeric === 0) {
      return reject(
        'evidence quote too short to verify: it has no letters or digits, so it says nothing ' +
          'about the code',
      );
    }
    let quoteLines = quote.split('\n').length;
    if (quoteLines > MAX_QUOTE_LINES || quote.length > MAX_QUOTE_CHARS) {
      return reject(
        `evidence quote too large to verify (${quoteLines} lines, ${quote.length} characters; ` +
          `limits ${MAX_QUOTE_LINES} lines and ${MAX_QUOTE_CHARS} characters)`,
      );
    }

    let content: string | null;
    try {
      content = await readBounded(handle, info.size);
    } catch {
      return { ...reject(`file not readable: "${finding.file}"`), readError: true };
    }
    if (content === null) {
      return reject(`file changed while it was being verified: "${finding.file}" grew past ${info.size} bytes`);
    }
    const lines = splitLines(content);
    if (lines.length === 0) return reject(`"${finding.file}" is empty, so the quote cannot be there`);

    const presentation = stripQuoteMarkers(raw, lines, finding.file);
    if (presentation.reason) return reject(presentation.reason);
    quote = presentation.quote;
    alphanumeric = countAlphanumeric(quote);
    quoteLines = quote.split('\n').length;
    if (alphanumeric === 0) return reject('empty evidence quote after stripping diff markers');
    const notes: string[] = presentation.stripped ? ['stripped diff markers from the quote'] : [];
    // Compare only at the accepted match, never normalize/search the whole file
    // again just to decide which evidence to store.
    const cleanedAt = (line: number) => presentation.stripped &&
      matchAtLine(lines, normalizeQuote(raw), line) === null
      ? { evidence_quote: presentation.quote } : {};

    // Weak evidence counts only where it was cited: no window, no correction, no fuzzy match.
    if (alphanumeric < MIN_ALNUM) {
      const here = matchAtLine(lines, quote, finding.line);
      if (here === null) {
        return reject(
          `evidence quote too short to verify: it has ${alphanumeric} letters or digits and at ` +
            `least ${MIN_ALNUM} are needed unless it appears exactly on the cited line, and it ` +
            `does not appear on line ${String(finding.line)} of "${finding.file}"`,
        );
      }
      const correctedFinding: Finding = { ...finding, line: here.line, verified: true, ...cleanedAt(here.line) };
      if (notes.length > 0) correctedFinding.verification_note = notes.join('; ');
      return { verified: true, correctedFinding };
    }

    let outcome = findQuote(lines, quote, finding.line, WORK_BUDGET);
    if (outcome.kind === 'none' && (/\/[/\*]/.test(raw) || /\/[/\*]/.test(content))) {
      const strippedQuote = normalizeQuote(withoutComments(quote));
      if (countAlphanumeric(strippedQuote) >= MIN_ALNUM) {
        const strippedLines = splitLines(withoutComments(content));
        // Removing a comment must not make an over-long source line eligible for search.
        const searchable = strippedLines.map((line, index) => lines[index]!.length > MAX_LINE ? lines[index]! : line);
        const candidate = findQuote(searchable, strippedQuote, finding.line, WORK_BUDGET);
        if (candidate.kind === 'match') {
          candidate.match.exact = false;
          candidate.match.text = lines.slice(candidate.match.line - 1, candidate.match.line - 1 + quoteLines).join('\n');
        }
        outcome = candidate;
      }
    }
    if (outcome.kind === 'budget') {
      return reject(
        `search budget exceeded: finding the quote in "${finding.file}" needs more than ` +
          `${WORK_BUDGET} comparisons`,
      );
    }
    if (outcome.kind === 'ambiguous') {
      return reject(
        `ambiguous: matches ${outcome.places} places in "${finding.file}" and none is within ` +
          `${WINDOW_RADIUS} lines of line ${String(finding.line)}, so the line cannot be corrected safely`,
      );
    }
    if (outcome.kind === 'none') {
      const skipped =
        outcome.skippedLongLines > 0
          ? `; ${outcome.skippedLongLines} over-long lines were skipped`
          : '';
      return reject(
        `evidence quote not found in "${finding.file}": no match within ${WINDOW_RADIUS} lines of ` +
          `line ${String(finding.line)} or anywhere else in the file (similarity threshold ${FUZZY})${skipped}`,
      );
    }

    const { match } = outcome;
    if (!match.exact) {
      const difference = semanticDifference(quote, match.text);
      if (difference !== null) {
        return reject(
          `fuzzy match at line ${match.line} (similarity ${formatSimilarity(match.similarity)}) ` +
            `changes the meaning of the quote: ${difference}; found in code: ${showCode(match.text)}`,
        );
      }
    }

    if (match.line !== finding.line) {
      const cited = isCitableLine(finding.line)
        ? `line ${finding.line}`
        : `unusable line ${String(finding.line)}`;
      const where =
        match.scope === 'local' ? `within ${WINDOW_RADIUS} lines` : 'elsewhere in the file';
      notes.push(`corrected from ${cited} to line ${match.line} (${where})`);
    }
    if (!match.exact) {
      notes.push(
        `fuzzy quote match, similarity ${formatSimilarity(match.similarity)}; ` +
          `found in code: ${showCode(match.text)}`,
      );
    }

    // Diff markers and line-number prefixes are presentation, not evidence: keep the code as found.
    const correctedFinding: Finding = { ...finding, line: match.line, verified: true, ...cleanedAt(match.line) };
    if (notes.length > 0) correctedFinding.verification_note = notes.join('; ');
    return { verified: true, correctedFinding };
  } catch {
    return { ...reject(`file not readable: "${finding.file}"`), readError: true };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
