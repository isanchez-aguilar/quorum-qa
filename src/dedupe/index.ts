import path from 'node:path';
import type { Finding } from '../types/index.js';
import {
  clusterByProximity,
  mergeCluster,
  relatedAnnotations,
  type MergeOptions,
  type TokensOf,
} from './cluster.js';
import { findingTokens, type FindingTokens } from './similarity.js';

export type DedupeOptions = MergeOptions;

// Backslashes, "./" prefixes and redundant separators must not split one file into two buckets.
function fileKey(file: string): string {
  const slashed = file.replace(/\\/g, '/');
  return path.posix.normalize(slashed).replace(/^\.\//, '');
}

/**
 * Merges findings that report the same defect, and only when that is nearly certain: same file,
 * within 5 lines, and a token Jaccard of at least MERGE_JACCARD (0.85) on the trigger AND, apart,
 * on the impact. Everything weaker stays separate, including two findings whose combined text is
 * near-identical but whose triggers differ, because a missed merge costs a duplicate and a false merge
 * hides a defect. Separate findings within 5 lines whose text overlaps are annotated with
 * `possibly_related` on both; the annotation never changes severity or confidence. Whether a
 * related pair really is one defect is a question for the confirm tier (M3), not for a lexical
 * metric. Severity is the highest of a cluster and confidence follows IMPLEMENTATION.md 5.3 (a
 * family counts once even when it reached the cluster through two CLIs), the cross-family boost
 * applying only inside a strong merge. The input is not modified.
 *
 * Output order: files by first appearance, then ascending line.
 */
export function dedupeFindings(
  findings: readonly Finding[],
  options: DedupeOptions = {},
): Finding[] {
  const buckets = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = fileKey(finding.file);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [finding]);
    else bucket.push(finding);
  }

  const cache = new Map<Finding, FindingTokens>();
  const tokensOf: TokensOf = (finding) => {
    let tokens = cache.get(finding);
    if (tokens === undefined) {
      tokens = findingTokens(finding);
      cache.set(finding, tokens);
    }
    return tokens;
  };

  const result: Finding[] = [];
  for (const bucket of buckets.values()) {
    const clusters = clusterByProximity(bucket, tokensOf);
    const related = relatedAnnotations(clusters, tokensOf);
    clusters.forEach((cluster, index) => {
      const merged = mergeCluster(cluster, options);
      // Annotations are recomputed on every run, so a stale one from an earlier pass is dropped.
      delete merged.possibly_related;
      const entries = related[index] ?? [];
      if (entries.length > 0) merged.possibly_related = entries;
      result.push(merged);
    });
  }
  return result;
}

export {
  PROXIMITY_LINES,
  CROSS_FAMILY_BOOST,
  combinedConfidence,
  type RelatedEntry,
} from './cluster.js';
export {
  MERGE_JACCARD,
  MIN_SHARED_TOKENS,
  RELATED_OVERLAP,
  findingJaccard,
  findingOverlap,
  isRelated,
  isStrongMatch,
} from './similarity.js';
