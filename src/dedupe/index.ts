import path from 'node:path';
import type { Finding } from '../types/index.js';
import { clusterByProximity, mergeCluster, type MergeOptions } from './cluster.js';

export type DedupeOptions = MergeOptions;

// Backslashes, "./" prefixes and redundant separators must not split one file into two buckets.
function fileKey(file: string): string {
  const slashed = file.replace(/\\/g, '/');
  return path.posix.normalize(slashed).replace(/^\.\//, '');
}

/**
 * Merges findings that report the same defect: same file, within 5 lines, similar text. Severity
 * is the highest of the cluster and confidence follows IMPLEMENTATION.md 5.3 (a family counts once
 * even when it reached the cluster through two CLIs). The input is not modified.
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

  const result: Finding[] = [];
  for (const bucket of buckets.values()) {
    for (const cluster of clusterByProximity(bucket)) {
      result.push(mergeCluster(cluster, options));
    }
  }
  return result;
}

export { PROXIMITY_LINES, CROSS_FAMILY_BOOST, combinedConfidence } from './cluster.js';
export {
  DEDUPE_THRESHOLD,
  MIN_SHARED_TOKENS,
  findingSimilarity,
  isSameDefect,
} from './similarity.js';
