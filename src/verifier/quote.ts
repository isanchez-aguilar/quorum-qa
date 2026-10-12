import { lineDistance, localWindow } from './lines.js';

// The single similarity threshold used everywhere, inclusive.
export const FUZZY = 0.85;
// A quote bigger than this makes the search unreasonable and is rejected, not truncated.
export const MAX_QUOTE_LINES = 40;
export const MAX_QUOTE_CHARS = 8 * 1024;
// A raw quote over this is rejected before it is normalized at all.
export const MAX_RAW_QUOTE = 64 * 1024;
// A quote with fewer letters and digits than this (`}`, `});`, `;`) proves nothing.
export const MIN_ALNUM = 4;
// A file line longer than this is skipped by the search: it is a minified bundle or a data dump.
export const MAX_LINE = 16 * 1024;
// Total dynamic-programming cells (plus character-bag steps) one search may spend.
export const WORK_BUDGET = 20_000_000;
// Outside the window a fuzzy match is trusted only when no other candidate is this close to it.
export const AMBIGUITY_MARGIN = 0.05;
// The first band of the banded edit distance; it doubles up to the real bound.
const INITIAL_BAND = 16;

// A line after tabs became 2 spaces, trailing whitespace went and interior space runs collapsed.
interface PreparedLine {
  indent: number;
  body: string;
}

// Every step is linear: no `\s+$`, only trimEnd and `/ {2,}/g`.
function prepareLine(raw: string): PreparedLine {
  const text = raw.replace(/\t/g, '  ').trimEnd();
  if (text === '') return { indent: 0, body: '' };
  const stripped = text.trimStart();
  return { indent: text.length - stripped.length, body: stripped.replace(/ {2,}/g, ' ') };
}

// The indentation common to all non-empty lines is removed. Relative indentation is kept.
function blockLines(lines: readonly PreparedLine[]): string[] {
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.body !== '') minIndent = Math.min(minIndent, line.indent);
  }
  return lines.map((line) =>
    line.body === '' ? '' : ' '.repeat(line.indent - minIndent) + line.body,
  );
}

export function normalizeQuote(raw: string): string {
  const prepared = raw.replace(/\r\n?/g, '\n').split('\n').map(prepareLine);
  const lines = blockLines(prepared);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/** The number of letters and digits (any script) in a text. */
export function countAlphanumeric(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

export class BudgetExceeded extends Error {
  constructor() {
    super('search budget exceeded');
    this.name = 'BudgetExceeded';
  }
}

/** A counter of work units shared by every comparison of one search. */
export class WorkBudget {
  used = 0;
  readonly limit: number;

  constructor(limit: number = WORK_BUDGET) {
    this.limit = limit;
  }

  charge(units: number): void {
    this.used += units;
    if (this.used > this.limit) throw new BudgetExceeded();
  }
}

// Exact edit distance when it is at most `k`, otherwise k + 1. Only cells with |i - j| <= k are
// computed (a band), and the scan stops as soon as a whole band row is above `k`.
function bandedDistance(long: string, short: string, k: number, budget?: WorkBudget): number {
  const n = long.length;
  const m = short.length;
  const over = k + 1;
  let previous = new Int32Array(m + 1).fill(over);
  let current = new Int32Array(m + 1).fill(over);
  for (let j = 0, last = Math.min(m, k); j <= last; j += 1) previous[j] = j;

  for (let i = 1; i <= n; i += 1) {
    const low = Math.max(1, i - k);
    const high = Math.min(m, i + k);
    if (low > high) return over;
    budget?.charge(high - low + 1);

    let rowMin = over;
    if (low === 1) {
      const edge = i <= k ? i : over;
      current[0] = edge;
      if (edge < rowMin) rowMin = edge;
    } else {
      current[low - 1] = over;
    }
    const code = long.charCodeAt(i - 1);
    for (let j = low; j <= high; j += 1) {
      let value = previous[j - 1]! + (code === short.charCodeAt(j - 1) ? 0 : 1);
      const deletion = previous[j]! + 1;
      if (deletion < value) value = deletion;
      const insertion = current[j - 1]! + 1;
      if (insertion < value) value = insertion;
      if (value > over) value = over;
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (high < m) current[high + 1] = over;
    if (rowMin > k) return over;
    [previous, current] = [current, previous];
  }
  return Math.min(previous[m]!, over);
}

/**
 * Levenshtein edit distance over UTF-16 code units (characters, not tokens). When `maxDistance`
 * is given it returns the exact distance if that is at most the bound and `maxDistance + 1`
 * otherwise. The work is a band of width 2k + 1 that starts narrow and doubles up to the bound,
 * so two near-identical long strings cost O(length * distance), not O(length * bound). An
 * optional budget is charged for every cell computed and throws BudgetExceeded when spent.
 * `lowerBound` is a distance the caller already knows the strings cannot beat; the first band
 * starts at twice that, so strings known to be far apart do not pay for the narrow passes.
 */
export function levenshtein(
  a: string,
  b: string,
  maxDistance = Number.POSITIVE_INFINITY,
  budget?: WorkBudget,
  lowerBound = 0,
): number {
  if (a === b) return 0;
  let long = a;
  let short = b;
  if (long.length < short.length) [long, short] = [short, long];
  if (short.length === 0) return long.length;
  if (long.length - short.length > maxDistance) return maxDistance + 1;

  const cap = Math.min(maxDistance, long.length);
  let k = Math.min(cap, Math.max(INITIAL_BAND, 2 * lowerBound));
  for (;;) {
    const distance = bandedDistance(long, short, k, budget);
    if (distance <= k) return distance;
    if (k >= cap) return maxDistance + 1;
    k = Math.min(cap, k * 2);
  }
}

// 1 - levenshtein(a, b) / max(len(a), len(b)). Callers normalize first.
export function calculateSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

// The largest edit distance that still reaches a similarity floor (FUZZY by default), computed so
// the inclusive threshold does not depend on floating point.
function distanceBound(longest: number, floor: number = FUZZY): number {
  return Math.floor(longest * (1 - floor) + 1e-9);
}

export interface QuoteMatch {
  // 1-indexed line where the matching slice starts.
  line: number;
  similarity: number;
  // The normalized quote appears verbatim inside the normalized slice.
  exact: boolean;
  scope: 'local' | 'global';
  // The normalized text found in the file at that line (same number of lines as the quote).
  text: string;
}

export type SearchOutcome =
  | { kind: 'match'; match: QuoteMatch }
  // The quote was found, but in more than one place and none of them is inside the window.
  | { kind: 'ambiguous'; places: number }
  | { kind: 'budget' }
  | { kind: 'none'; skippedLongLines: number };

interface FileLine extends PreparedLine {
  tooLong: boolean;
  // Characters other than spaces in `body`.
  visible: number;
}

interface Candidate {
  start: number;
  similarity: number;
}

type StartRange = readonly [number, number];

function prepareFileLine(raw: string): FileLine {
  if (raw.length > MAX_LINE) return { indent: 0, body: '', tooLong: true, visible: 0 };
  const prepared = prepareLine(raw);
  let visible = 0;
  for (let i = 0; i < prepared.body.length; i += 1) {
    if (prepared.body.charCodeAt(i) !== 32) visible += 1;
  }
  return { ...prepared, tooLong: false, visible };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

// Higher similarity, then the smaller distance to the cited line, then the lower line number.
function isBetter(candidate: Candidate, best: Candidate | null, cited: number): boolean {
  if (best === null) return true;
  if (candidate.similarity !== best.similarity) return candidate.similarity > best.similarity;
  const candidateDistance = lineDistance(candidate.start, cited);
  const bestDistance = lineDistance(best.start, cited);
  if (candidateDistance !== bestDistance) return candidateDistance < bestDistance;
  return candidate.start < best.start;
}

function bestOf(candidates: readonly Candidate[], cited: number): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (isBetter(candidate, best, cited)) best = candidate;
  }
  return best;
}

/**
 * Finds a normalized quote in a file. `quote` must come from normalizeQuote and be non-empty.
 *
 * Inside the +-10 line window the nearest match wins: an exact one first, then the best fuzzy one
 * (higher similarity, then smaller distance to the cited line, then lower line number). Outside the
 * window nothing is resolved by distance: the line is corrected only when the quote has exactly one
 * place in the file, either one exact occurrence or one fuzzy candidate with no other within
 * AMBIGUITY_MARGIN of it. Otherwise the outcome is `ambiguous`. All exact scans run before any
 * fuzzy one, and one WorkBudget bounds the whole search.
 *
 * Exact means the quote appears verbatim inside the normalized slice of lines (a quote may be a
 * fragment of a line). Fuzzy compares the whole slice, of the same number of lines as the quote,
 * with the quote. A line over MAX_LINE characters can never match and is skipped. This function
 * only LOCATES a fuzzy candidate; whether it means the same thing is decided by the caller.
 */
export function findQuote(
  fileLines: readonly string[],
  quote: string,
  citedLine: number,
  workBudget: number = WORK_BUDGET,
): SearchOutcome {
  const quoteLines = quote.split('\n');
  const span = quoteLines.length;
  const total = fileLines.length;
  const lastStart = total - span + 1;
  const file = fileLines.map(prepareFileLine);
  const skippedLongLines = file.reduce((count, line) => count + (line.tooLong ? 1 : 0), 0);
  if (lastStart < 1) return { kind: 'none', skippedLongLines };

  // longBefore[i] is the number of over-long lines among the first i lines.
  const longBefore = new Int32Array(total + 1);
  for (let i = 0; i < total; i += 1) longBefore[i + 1] = longBefore[i]! + (file[i]!.tooLong ? 1 : 0);
  const hasLongLine = (start: number): boolean =>
    longBefore[start + span - 1]! - longBefore[start - 1]! > 0;

  const sliceText = (start: number): string =>
    blockLines(file.slice(start - 1, start - 1 + span)).join('\n');

  const budget = new WorkBudget(workBudget);
  const firstQuoteLine = (quoteLines[0] as string).trimStart();

  // Every start whose slice contains the quote, with how many times.
  const exactHits = (ranges: readonly StartRange[]) => {
    const hits: Array<{ start: number; occurrences: number }> = [];
    for (const [first, last] of ranges) {
      for (let start = first; start <= last; start += 1) {
        if (hasLongLine(start)) continue;
        const head = file[start - 1] as FileLine;
        // Cheap necessary condition: the quote's first line is the tail of the slice's first line.
        if (span === 1 ? !head.body.includes(quote) : !head.body.endsWith(firstQuoteLine)) continue;
        const occurrences = countOccurrences(sliceText(start), quote);
        if (occurrences > 0) hits.push({ start, occurrences });
      }
    }
    return hits;
  };

  // Every slice at least FUZZY similar to the quote. Cheap bounds run first: the length, and the
  // multiset of non-space characters (an edit distance is at least the number of characters of the
  // longer side that cannot be paired with an equal character of the other side). The multiset of
  // the sliding window is updated line by line, so the bound costs O(file) in total. The slices
  // that pass are then compared in order of that bound, closest first. With `tighten`, once one
  // candidate is known, a slice only matters if it is within AMBIGUITY_MARGIN of the best, so the
  // rest are compared against a much smaller distance bound and mostly rejected by the cheap one.
  const fuzzyCandidates = (ranges: readonly StartRange[], tighten: boolean): Candidate[] => {
    const quoteCounts = new Int32Array(65536);
    let quoteVisible = 0;
    for (let i = 0; i < quote.length; i += 1) {
      const code = quote.charCodeAt(i);
      if (code === 32 || code === 10) continue;
      quoteCounts[code] = quoteCounts[code]! + 1;
      quoteVisible += 1;
    }
    const windowCounts = new Int32Array(65536);
    let common = 0;
    const apply = (line: FileLine, delta: 1 | -1): void => {
      budget.charge(line.body.length + 1);
      for (let i = 0; i < line.body.length; i += 1) {
        const code = line.body.charCodeAt(i);
        if (code === 32) continue;
        if (delta === 1) {
          if (windowCounts[code]! < quoteCounts[code]!) common += 1;
          windowCounts[code] = windowCounts[code]! + 1;
        } else {
          windowCounts[code] = windowCounts[code]! - 1;
          if (windowCounts[code]! < quoteCounts[code]!) common -= 1;
        }
      }
    };

    const probes: Array<{ start: number; lower: number; longest: number }> = [];
    for (const [first, last] of ranges) {
      if (first > last) continue;
      windowCounts.fill(0);
      common = 0;
      let visibleInWindow = 0;
      for (let i = first; i < first + span; i += 1) {
        apply(file[i - 1] as FileLine, 1);
        visibleInWindow += (file[i - 1] as FileLine).visible;
      }
      for (let start = first; start <= last; start += 1) {
        if (!hasLongLine(start)) {
          // The size of the normalized slice, from the lines alone.
          let minIndent = Number.POSITIVE_INFINITY;
          for (let k = 0; k < span; k += 1) {
            const line = file[start - 1 + k] as FileLine;
            if (line.body !== '') minIndent = Math.min(minIndent, line.indent);
          }
          let length = span - 1;
          for (let k = 0; k < span; k += 1) {
            const line = file[start - 1 + k] as FileLine;
            if (line.body !== '') length += line.indent - minIndent + line.body.length;
          }
          const longest = Math.max(quote.length, length);
          const lower = Math.max(
            Math.abs(quote.length - length),
            Math.max(quoteVisible, visibleInWindow) - common,
          );
          if (lower <= distanceBound(longest)) probes.push({ start, lower, longest });
        }
        if (start < last) {
          const leaving = file[start - 1] as FileLine;
          const arriving = file[start - 1 + span] as FileLine;
          apply(leaving, -1);
          apply(arriving, 1);
          visibleInWindow += arriving.visible - leaving.visible;
        }
      }
    }
    probes.sort((a, b) => a.lower - b.lower || a.start - b.start);

    const candidates: Candidate[] = [];
    let bestSimilarity = 0;
    for (const probe of probes) {
      const floor =
        tighten && candidates.length > 0
          ? Math.max(FUZZY, bestSimilarity - AMBIGUITY_MARGIN)
          : FUZZY;
      const bound = distanceBound(probe.longest, floor);
      if (probe.lower > bound) continue;
      const distance = levenshtein(quote, sliceText(probe.start), bound, budget, probe.lower);
      if (distance > bound) continue;
      const similarity = 1 - distance / probe.longest;
      candidates.push({ start: probe.start, similarity });
      if (similarity > bestSimilarity) bestSimilarity = similarity;
    }
    return candidates;
  };

  const range = localWindow(citedLine, total);
  const localRange: StartRange | null =
    range !== null && range.first <= Math.min(range.last, lastStart)
      ? [range.first, Math.min(range.last, lastStart)]
      : null;
  const outside: StartRange[] =
    localRange === null
      ? [[1, lastStart]]
      : [
          [1, localRange[0] - 1],
          [localRange[1] + 1, lastStart],
        ];
  const globalRanges = outside.filter(([first, last]) => first <= last);

  const found = (
    start: number,
    similarity: number,
    exact: boolean,
    scope: QuoteMatch['scope'],
  ): SearchOutcome => ({
    kind: 'match',
    match: { line: start, similarity, exact, scope, text: sliceText(start) },
  });

  try {
    // All exact scans first: they are cheap, and a fuzzy scan is only worth its cost when they fail.
    const localExact = localRange === null ? [] : exactHits([localRange]);
    const globalExact = exactHits(globalRanges);

    if (localExact.length > 0) {
      const best = bestOf(
        localExact.map((hit) => ({ start: hit.start, similarity: 1 })),
        citedLine,
      ) as Candidate;
      return found(best.start, 1, true, 'local');
    }

    // A local fuzzy match beats a global exact one (table 4.4 row 21).
    if (localRange !== null) {
      const best = bestOf(fuzzyCandidates([localRange], false), citedLine);
      if (best !== null) return found(best.start, best.similarity, false, 'local');
    }

    if (globalExact.length > 0) {
      // Every occurrence counts, also several in one line: ambiguity is never resolved by guessing.
      let places = 0;
      for (const hit of globalExact) places += hit.occurrences;
      if (places === 1) return found((globalExact[0] as { start: number }).start, 1, true, 'global');
      return { kind: 'ambiguous', places };
    }

    const candidates = fuzzyCandidates(globalRanges, true);
    let best: Candidate | null = null;
    for (const candidate of candidates) {
      if (best === null || candidate.similarity > best.similarity) best = candidate;
    }
    if (best === null) return { kind: 'none', skippedLongLines };

    const anchor = best;
    const rivals = candidates
      .filter(
        (candidate) =>
          Math.abs(candidate.start - anchor.start) >= span &&
          candidate.similarity >= anchor.similarity - AMBIGUITY_MARGIN - 1e-9,
      )
      .sort((a, b) => a.start - b.start);
    let places = 1;
    let lastCounted = anchor.start;
    for (const rival of rivals) {
      if (Math.abs(rival.start - lastCounted) < span) continue;
      places += 1;
      lastCounted = rival.start;
    }
    if (places > 1) return { kind: 'ambiguous', places };
    return found(anchor.start, anchor.similarity, false, 'global');
  } catch (error) {
    if (error instanceof BudgetExceeded) return { kind: 'budget' };
    throw error;
  }
}
