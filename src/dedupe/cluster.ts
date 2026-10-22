import type { Family, Finding, Origin, Severity, Tier } from '../types/index.js';
import {
  findingTokens,
  MERGE_JACCARD,
  RELATED_OVERLAP,
  relatedSimilarity,
  strongSimilarity,
  type FindingTokens,
} from './similarity.js';

// Findings further apart than this (in lines) are never the same defect.
export const PROXIMITY_LINES = 5;
// Added to the best confidence when two distinct families agree.
export const CROSS_FAMILY_BOOST = 0.25;

const SEVERITY_RANK: Record<Severity, number> = { OPTIONAL: 0, IMPORTANT: 1, BLOCKER: 2 };
// An introduced defect is the one the author must act on, an improvement the least urgent.
const ORIGIN_RANK: Record<Origin, number> = { improvement: 0, 'pre-existing': 1, introduced: 2 };
// confirm > review > triage. The visual tier only reviews images and ranks with review.
const TIER_RANK: Record<Tier, number> = { triage: 0, review: 1, visual: 1, confirm: 2 };

export interface MergeOptions {
  // Which tier produced a finding. Finding carries no tier, so the cascade supplies it. When it is
  // missing, or returns undefined, the fix of the most confident finding is used.
  tierOf?: (finding: Finding) => Tier | undefined;
}

export type RelatedEntry = NonNullable<Finding['possibly_related']>[number];

// Where the word tokens of a finding come from. dedupeFindings passes a cached one.
export type TokensOf = (finding: Finding) => FindingTokens;

function lineOf(finding: Finding): number {
  return Number.isFinite(finding.line) ? finding.line : Number.POSITIVE_INFINITY;
}

/**
 * Groups findings of one file into clusters of the same defect. Findings are visited by ascending
 * line and join a cluster only when they STRONGLY match at least one member (the token Jaccard of
 * the trigger AND of the impact are each >= MERGE_JACCARD) and are within PROXIMITY_LINES of EVERY
 * member; the best
 * strong match wins. Checking against every member, not just the nearest, stops a chain of
 * findings 5 lines apart from swallowing lines that are 20 apart. Anything weaker stays separate.
 */
export function clusterByProximity(
  findings: readonly Finding[],
  tokensOf: TokensOf = findingTokens,
): Finding[][] {
  const ordered = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => lineOf(a.finding) - lineOf(b.finding) || a.index - b.index)
    .map((entry) => entry.finding);

  const clusters: Finding[][] = [];
  for (const finding of ordered) {
    const tokens = tokensOf(finding);
    let target: Finding[] | null = null;
    let bestScore = MERGE_JACCARD;
    for (const cluster of clusters) {
      const first = cluster[0] as Finding;
      // Written so that a non-finite line (NaN) never counts as near.
      if (!(lineOf(finding) - lineOf(first) <= PROXIMITY_LINES)) continue;
      let score = 0;
      for (const member of cluster) score = Math.max(score, strongSimilarity(tokens, tokensOf(member)));
      if (score >= bestScore && (target === null || score > bestScore)) {
        target = cluster;
        bestScore = score;
      }
    }
    if (target === null) clusters.push([finding]);
    else target.push(finding);
  }
  return clusters;
}

/**
 * For each cluster, the other findings it is possibly related to: a member of another cluster in
 * the same file, within PROXIMITY_LINES, whose text overlaps (overlap coefficient >= RELATED_OVERLAP,
 * at least two shared words) but was not merged. The relation is symmetric. Findings of the same
 * cluster are not related to each other. Entries are sorted and unique per provider, model and line.
 */
export function relatedAnnotations(
  clusters: ReadonlyArray<readonly Finding[]>,
  tokensOf: TokensOf = findingTokens,
): RelatedEntry[][] {
  const items = clusters
    .flatMap((members, cluster) => members.map((finding) => ({ finding, cluster })))
    .filter((item) => Number.isFinite(item.finding.line))
    .sort((a, b) => a.finding.line - b.finding.line);

  const found: Array<Map<string, RelatedEntry>> = clusters.map(() => new Map());
  const remember = (cluster: number, other: Finding, similarity: number): void => {
    const entry: RelatedEntry = {
      provider: other.provider,
      model: other.model,
      line: other.line,
      similarity: Math.round(similarity * 1000) / 1000,
    };
    const key = JSON.stringify([entry.provider, entry.model, entry.line]);
    const known = found[cluster]?.get(key);
    if (known === undefined || known.similarity < entry.similarity) found[cluster]?.set(key, entry);
  };

  for (let i = 0; i < items.length; i += 1) {
    const a = items[i] as (typeof items)[number];
    const aTokens = tokensOf(a.finding);
    for (let j = i + 1; j < items.length; j += 1) {
      const b = items[j] as (typeof items)[number];
      if (b.finding.line - a.finding.line > PROXIMITY_LINES) break;
      if (a.cluster === b.cluster) continue;
      const overlap = relatedSimilarity(aTokens, tokensOf(b.finding));
      if (overlap < RELATED_OVERLAP) continue;
      remember(a.cluster, b.finding, overlap);
      remember(b.cluster, a.finding, overlap);
    }
  }

  return found.map((entries) =>
    [...entries.values()].sort(
      (x, y) => x.line - y.line || compareText(x.provider, y.provider) || compareText(x.model, y.model),
    ),
  );
}

// Plain code-unit order, so the output never depends on the machine's locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** 5.3: one family keeps its best score, two distinct families add 0.25 (capped), three or more give 1. */
export function combinedConfidence(members: readonly Finding[]): number {
  const families = new Set<Family>(members.map((member) => member.family));
  const best = members.reduce((best, member) => Math.max(best, member.confidence), -Infinity);
  if (families.size >= 3) return 1;
  if (families.size === 2) return round(Math.min(1, best + CROSS_FAMILY_BOOST));
  return best;
}

// The most confident finding; ties go to the higher severity, then the lower line, then input order.
function mostConfident(members: readonly Finding[]): Finding {
  let best = members[0] as Finding;
  for (const member of members.slice(1)) {
    if (member.confidence !== best.confidence) {
      if (member.confidence > best.confidence) best = member;
    } else if (member.severity !== best.severity) {
      if (SEVERITY_RANK[member.severity] > SEVERITY_RANK[best.severity]) best = member;
    } else if (lineOf(member) < lineOf(best)) {
      best = member;
    }
  }
  return best;
}

function chooseFix(members: readonly Finding[], primary: Finding, tierOf: MergeOptions['tierOf']): string {
  if (tierOf === undefined) return primary.fix;
  let bestRank = -1;
  let pool: Finding[] = [];
  for (const member of members) {
    if (member.fix.trim() === '') continue;
    const tier = tierOf(member);
    const rank = tier === undefined ? -1 : TIER_RANK[tier];
    if (rank > bestRank) {
      bestRank = rank;
      pool = [member];
    } else if (rank === bestRank) {
      pool.push(member);
    }
  }
  return bestRank < 0 || pool.length === 0 ? primary.fix : mostConfident(pool).fix;
}

/** Merges one cluster into a single finding. Never mutates its members. */
export function mergeCluster(members: readonly Finding[], options: MergeOptions = {}): Finding {
  const primary = mostConfident(members);
  const merged: Finding = structuredClone(primary);
  if (members.length === 1) return merged;

  merged.severity = members.reduce<Severity>(
    (best, member) => (SEVERITY_RANK[member.severity] > SEVERITY_RANK[best] ? member.severity : best),
    primary.severity,
  );
  merged.origin = members.reduce<Origin>(
    (best, member) => (ORIGIN_RANK[member.origin] > ORIGIN_RANK[best] ? member.origin : best),
    primary.origin,
  );
  merged.confidence = combinedConfidence(members);
  merged.fix = chooseFix(members, primary, options.tierOf);

  if (merged.reproduction === undefined) {
    const withProof = members.find((member) => member.reproduction !== undefined);
    if (withProof?.reproduction !== undefined) merged.reproduction = structuredClone(withProof.reproduction);
  }

  const sources = new Set<string>();
  for (const member of members) {
    if (member === primary) continue;
    sources.add(`${member.provider}:${member.model} (${member.family})`);
  }
  sources.delete(`${primary.provider}:${primary.model} (${primary.family})`);
  if (sources.size > 0) {
    const note = `also reported by ${[...sources].join(', ')}`;
    merged.verification_note =
      primary.verification_note === undefined ? note : `${primary.verification_note}; ${note}`;
  }
  return merged;
}
