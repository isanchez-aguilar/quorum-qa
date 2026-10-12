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

// Two thresholds, because "same defect" cannot be decided by a lexical metric.
//
// MERGE_JACCARD: findings are merged automatically only on a STRONG match: the token Jaccard of
// the trigger AND the token Jaccard of the impact are each at or above this value. Paraphrases of
// one defect score 0.12 to 0.21 on the ten rows of IMPLEMENTATION.md 5.5, and two different
// defects ("Missing authorization when deleting users" and "Missing audit when deleting users")
// share enough words to look alike. They are compared field by field because a long impact
// sentence in common would otherwise drown the three words of the trigger that make them
// different (combined Jaccard 0.895 for that pair, trigger Jaccard 0.5). A missed merge costs a
// duplicate; a false merge hides a defect, so the threshold errs high.
export const MERGE_JACCARD = 0.85;
// RELATED_OVERLAP: below the merge threshold, findings at the same place whose overlap coefficient
// reaches this value are not merged but annotated as possibly related, on both findings. The
// overlap divides by the smaller token set, so paraphrases of one defect (0.23 to 0.36 on the
// rows) clear it while the unrelated rows (0.00 and 0.09) do not.
export const RELATED_OVERLAP = 0.15;
// Both rules need at least this many shared words: one shared word between two short texts would
// otherwise pass either threshold.
export const MIN_SHARED_TOKENS = 2;

export type TokenSet = ReadonlySet<string>;

// The word tokens of a finding: the trigger and the impact apart (the merge compares them one by
// one), and both together (the related annotation compares the whole text).
export interface FindingTokens {
  trigger: TokenSet;
  impact: TokenSet;
  all: TokenSet;
}

/** The word tokens two findings are compared on: trigger, impact, and both together. */
export function findingTokens(finding: Pick<Finding, 'trigger' | 'impact'>): FindingTokens {
  const trigger = toSet(tokenize(finding.trigger));
  const impact = toSet(tokenize(finding.impact));
  return { trigger, impact, all: new Set([...trigger, ...impact]) };
}

// Jaccard of two token sets. Two sets without a single content word say nothing different from
// each other, so they count as equal; the shared-words rule of the callers still applies.
function jaccard(a: TokenSet, b: TokenSet): number {
  if (a.size === 0 && b.size === 0) return 1;
  const shared = intersectionSize(a, b);
  return shared / (a.size + b.size - shared);
}

/**
 * The merge score of two findings: the LOWER of the Jaccard of their triggers and the Jaccard of
 * their impacts, so both must reach MERGE_JACCARD. It is 0 when the findings share fewer than
 * MIN_SHARED_TOKENS words in total.
 */
export function strongSimilarity(a: FindingTokens, b: FindingTokens): number {
  if (intersectionSize(a.all, b.all) < MIN_SHARED_TOKENS) return 0;
  return Math.min(jaccard(a.trigger, b.trigger), jaccard(a.impact, b.impact));
}

/** Overlap coefficient of the whole text of two findings, or 0 under MIN_SHARED_TOKENS shared words. */
export function relatedSimilarity(a: FindingTokens, b: FindingTokens): number {
  const shared = intersectionSize(a.all, b.all);
  if (shared < MIN_SHARED_TOKENS) return 0;
  return shared / Math.min(a.all.size, b.all.size);
}

/** The merge score of two findings (see strongSimilarity). */
export function findingJaccard(a: Finding, b: Finding): number {
  return strongSimilarity(findingTokens(a), findingTokens(b));
}

/** Overlap coefficient of two findings on trigger + impact (0 under two shared words). */
export function findingOverlap(a: Finding, b: Finding): number {
  return relatedSimilarity(findingTokens(a), findingTokens(b));
}

/** The trigger and the impact are each near-identical: the only case that is merged. */
export function isStrongMatch(a: Finding, b: Finding): boolean {
  return findingJaccard(a, b) >= MERGE_JACCARD;
}

/** The text overlaps enough to point a human at the pair, never enough to merge. */
export function isRelated(a: Finding, b: Finding): boolean {
  return findingOverlap(a, b) >= RELATED_OVERLAP;
}
