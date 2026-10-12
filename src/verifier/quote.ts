import { lineDistance, localWindow } from './lines.js';

// The single similarity threshold used everywhere, inclusive.
export const FUZZY = 0.85;
// A quote bigger than this makes the search unreasonable and is rejected, not truncated.
export const MAX_QUOTE_LINES = 40;
export const MAX_QUOTE_CHARS = 8 * 1024;

// Tabs become 2 spaces, trailing whitespace goes, interior space runs collapse, and the indentation
// common to all non-empty lines is removed. Relative indentation inside the block is kept.
function normalizeBlock(lines: readonly string[]): string[] {
  const prepared = lines.map((line) => line.replace(/\t/g, '  ').replace(/\s+$/, ''));
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of prepared) {
    if (line === '') continue;
    minIndent = Math.min(minIndent, line.length - line.trimStart().length);
  }
  return prepared.map((line) => {
    if (line === '') return line;
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent).replace(/ {2,}/g, ' ');
    return ' '.repeat(indent - minIndent) + body;
  });
}

export function normalizeQuote(raw: string): string {
  const lines = normalizeBlock(raw.replace(/\r\n?/g, '\n').split('\n'));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Levenshtein edit distance over UTF-16 code units (characters, not tokens), with two rows.
 * When `maxDistance` is given, returns early with any value above it once the distance is known to
 * exceed it.
 */
export function levenshtein(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  let long = a;
  let short = b;
  if (long.length < short.length) [long, short] = [short, long];
  if (short.length === 0) return long.length;
  if (long.length - short.length > maxDistance) return maxDistance + 1;

  let previous = new Array<number>(short.length + 1);
  let current = new Array<number>(short.length + 1);
  for (let j = 0; j <= short.length; j += 1) previous[j] = j;

  for (let i = 1; i <= long.length; i += 1) {
    current[0] = i;
    let rowMin = i;
    const code = long.charCodeAt(i - 1);
    for (let j = 1; j <= short.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (code === short.charCodeAt(j - 1) ? 0 : 1);
      const value = Math.min(substitution, (previous[j] as number) + 1, (current[j - 1] as number) + 1);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }
  return previous[short.length] as number;
}

// 1 - levenshtein(a, b) / max(len(a), len(b)). Callers normalize first.
export function calculateSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

// The similarity when it reaches FUZZY, otherwise null. The bound is computed on integers so the
// inclusive threshold does not depend on floating point.
function similarityAtLeastFuzzy(a: string, b: string): number | null {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const bound = Math.floor(longest * (1 - FUZZY) + 1e-9);
  if (Math.abs(a.length - b.length) > bound) return null;
  const distance = levenshtein(a, b, bound);
  return distance > bound ? null : 1 - distance / longest;
}

export interface QuoteMatch {
  // 1-indexed line where the matching slice starts.
  line: number;
  similarity: number;
  // The normalized quote appears verbatim inside the normalized slice.
  exact: boolean;
  scope: 'local' | 'global';
}

function isBetter(candidate: QuoteMatch, best: QuoteMatch | null, cited: number): boolean {
  if (best === null) return true;
  if (candidate.similarity !== best.similarity) return candidate.similarity > best.similarity;
  const candidateDistance = lineDistance(candidate.line, cited);
  const bestDistance = lineDistance(best.line, cited);
  if (candidateDistance !== bestDistance) return candidateDistance < bestDistance;
  return candidate.line < best.line;
}

/**
 * Finds a normalized quote in a file. `quote` must come from normalizeQuote and be non-empty.
 *
 * Order, as in IMPLEMENTATION.md 4.3: inside the +-10 line window first, then the whole file. In
 * each scope an exact match beats a fuzzy one, then the higher similarity wins, then the smaller
 * distance to the cited line, then the lower line number. Exact means the quote appears verbatim
 * inside the slice of lines (a quote may be a fragment of a line). Fuzzy compares the whole slice,
 * of the same number of lines as the quote, with the quote.
 */
export function findQuote(
  fileLines: readonly string[],
  quote: string,
  citedLine: number,
): QuoteMatch | null {
  const span = quote.split('\n').length;
  const lastStart = fileLines.length - span + 1;
  if (lastStart < 1) return null;

  const search = (first: number, last: number, scope: QuoteMatch['scope']): QuoteMatch | null => {
    let best: QuoteMatch | null = null;
    for (let start = first; start <= last; start += 1) {
      const text = normalizeBlock(fileLines.slice(start - 1, start - 1 + span)).join('\n');
      let candidate: QuoteMatch | null = null;
      if (text.includes(quote)) {
        candidate = { line: start, similarity: 1, exact: true, scope };
      } else {
        const similarity = similarityAtLeastFuzzy(quote, text);
        if (similarity !== null) candidate = { line: start, similarity, exact: false, scope };
      }
      if (candidate !== null && isBetter(candidate, best, citedLine)) best = candidate;
    }
    return best;
  };

  const range = localWindow(citedLine, fileLines.length);
  if (range !== null) {
    const local = search(range.first, Math.min(range.last, lastStart), 'local');
    if (local !== null) return local;
  }
  return search(1, lastStart, 'global');
}
