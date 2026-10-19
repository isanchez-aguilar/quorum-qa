import type { CatalogEntry, Family, QuorumConfig, Tier } from '../types/index.js';
import { resolveAuthorFamily } from '../config/schema.js';
import { parseModelRef } from './index.js';
import { quotaStatus, type QuotaSnapshot } from './groups.js';

export function resolveTier(tier: Tier, config: QuorumConfig, catalog: readonly CatalogEntry[], snapshot: QuotaSnapshot = {}, options: {
  unavailableGroups?: ReadonlySet<string>;
  available?: (entry: CatalogEntry) => boolean;
  authorFamily?: Family;
  excludeLocal?: boolean;
  nowMs?: number;
  refs?: readonly string[];
  label?: string;
} = {}): { models: CatalogEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const models: CatalogEntry[] = [];
  for (const ref of options.refs ?? config.tiers[tier]) {
    const parsed = parseModelRef(ref, catalog);
    const entry = catalog.find(item => item.provider === parsed.provider && item.id === parsed.model)!;
    if (options.unavailableGroups?.has(entry.quotaGroup)) {
      const message = `${entry.quotaGroup}: quota exhausted earlier in this run, skipped`;
      if (!warnings.includes(message)) warnings.push(message);
      continue;
    }
    if (quotaStatus(entry, snapshot, config.budget.quotaFloorPercent, options.nowMs) === 'unavailable') {
      const message = `${entry.quotaGroup}: quota below floor (${snapshot[entry.quotaGroup]!.remainingPercent}%), skipped`;
      if (!warnings.includes(message)) warnings.push(message);
      continue;
    }
    if (models.includes(entry) || (options.available && !options.available(entry)) || (options.excludeLocal && entry.family === 'local')) continue;
    models.push(entry);
  }
  const author = config.author ? resolveAuthorFamily(config.author) : options.authorFamily;
  if (author && models.length) {
    const independent = models.filter(entry => entry.family !== author);
    if (independent.length) return { models: independent, warnings };
    warnings.push(`Independence rule cannot be met in ${options.label ?? tier}: only ${author} models are available.`);
  }
  return { models, warnings };
}
