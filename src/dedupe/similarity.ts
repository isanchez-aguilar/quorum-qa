import type { Finding } from '../types/index.js';
import { levenshtein } from '../verifier/quote.js';

// Function words and "absence" words. Absence words (missing, never, without...) say that something
// is wrong, not what, so sharing them is no evidence that two findings are the same defect.
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'and', 'or', 'is',
  'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'so',
  'can', 'could', 'will', 'would', 'may', 'might', 'if', 'when', 'then', 'than', 'which', 'who',
  'has', 'have', 'had', 'do', 'does', 'into', 'over', 'under', 'before', 'after', 'because',
  'while', 'each', 'every', 'any', 'all', 'more', 'most', 'other', 'such', 'only', 'also', 'one',
  'missing', 'lack', 'lacks', 'without', 'never', 'no', 'not', 'omitted', 'instead',
]);

// Light stemming: enough to put retries/retried/retry and documentation/documented close together.
function stem(token: string): string {
  let word = token;
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ied')) return `${word.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 'ly', 's']) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix) && !word.endsWith('ss')) {
      word = word.slice(0, -suffix.length);
      break;
    }
  }
  return word;
}

/** Lowercase word tokens without stop words, camelCase and snake_case split, lightly stemmed. */
export function tokenize(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
  return words.map(stem).filter((word) => word.length > 1);
}

function toSet(tokens: readonly string[]): Set<string> {
  return new Set(tokens);
}

function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

/** |A n B| / |A u B| over stemmed word tokens. */
export function tokenJaccard(a: string, b: string): number {
  const first = toSet(tokenize(a));
  const second = toSet(tokenize(b));
  const shared = intersectionSize(first, second);
  const union = first.size + second.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** |A n B| / min(|A|, |B|) over stemmed word tokens. */
export function tokenOverlap(a: string, b: string): number {
  const first = toSet(tokenize(a));
  const second = toSet(tokenize(b));
  const smallest = Math.min(first.size, second.size);
  return smallest === 0 ? 0 : intersectionSize(first, second) / smallest;
}

function trigrams(text: string): Set<string> {
  const flat = ` ${tokenize(text).join(' ')} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= flat.length; i += 1) grams.add(flat.slice(i, i + 3));
  return grams;
}

/** Sorensen-Dice coefficient over character trigrams of the stemmed content words. */
export function trigramDice(a: string, b: string): number {
  const first = trigrams(a);
  const second = trigrams(b);
  const total = first.size + second.size;
  return total === 0 ? 0 : (2 * intersectionSize(first, second)) / total;
}

/** 1 - levenshtein / max length over the stemmed content words, as used by the verifier. */
export function characterSimilarity(a: string, b: string): number {
  const first = tokenize(a).join(' ');
  const second = tokenize(b).join(' ');
  const longest = Math.max(first.length, second.length);
  return longest === 0 ? 0 : 1 - levenshtein(first, second) / longest;
}

export type SimilarityMetric = (a: string, b: string) => number;

// The candidates compared during calibration (see tests/unit/dedupe.test.ts).
export const CANDIDATE_METRICS: Readonly<Record<string, SimilarityMetric>> = {
  tokenJaccard,
  trigramDice,
  tokenOverlap,
  characterSimilarity,
};

/** The text two findings are compared on: what the defect is and what it causes. */
export function findingText(finding: Pick<Finding, 'trigger' | 'impact'>): string {
  return `${finding.trigger}. ${finding.impact}`;
}

// Chosen metric: the token overlap coefficient over trigger + impact.
//
// The Jaccard threshold of 0.70 in IMPLEMENTATION.md 5.2 does not reproduce table 5.5: paraphrases
// of one defect share a few words out of many, so their Jaccard is 0.12 to 0.21. On the ten rows
// of 5.5, token Jaccard, trigram Dice and the overlap coefficient each separate the rows to merge
// from the rows to keep apart at some threshold, and character-level Levenshtein cannot. The
// overlap coefficient has the widest gap (rows to merge score at least 0.23, rows to keep apart
// at most 0.09) and tolerates one reviewer being wordier than the other. Rows 3 and 7 are kept
// apart by the line and file rules, not by text. The numbers are in docs/IMPLEMENTATION.md.
export const DEDUPE_THRESHOLD = 0.15;
// The coefficient divides by the smaller token set, so one shared word between two short texts
// would pass the threshold. One shared word is never enough evidence.
export const MIN_SHARED_TOKENS = 2;

export const dedupeMetric: SimilarityMetric = tokenOverlap;

/** Overlap of two findings on trigger + impact, or 0 when they share fewer than two words. */
export function findingSimilarity(a: Finding, b: Finding): number {
  const first = toSet(tokenize(findingText(a)));
  const second = toSet(tokenize(findingText(b)));
  if (intersectionSize(first, second) < MIN_SHARED_TOKENS) return 0;
  return dedupeMetric(findingText(a), findingText(b));
}

export function isSameDefect(a: Finding, b: Finding): boolean {
  return findingSimilarity(a, b) >= DEDUPE_THRESHOLD;
}
