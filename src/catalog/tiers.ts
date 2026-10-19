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
} = {}): { models: CatalogEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const models: CatalogEntry[] = [];
  for (const ref of config.tiers[tier]) {
    const parsed = parseModelRef(ref, catalog);
    const entry = catalog.find(item => item.provider === parsed.provider && item.id === parsed.model)!;
    if (models.includes(entry) || options.unavailableGroups?.has(entry.quotaGroup)
      || quotaStatus(entry, snapshot, config.budget.quotaFloorPercent, options.nowMs) === 'unavailable'
      || (options.available && !options.available(entry)) || (options.excludeLocal && entry.family === 'local')) continue;
    models.push(entry);
  }
  const author = config.author ? resolveAuthorFamily(config.author) : options.authorFamily;
  if (author && models.length) {
    const independent = models.filter(entry => entry.family !== author);
    if (independent.length) return { models: independent, warnings };
    warnings.push(`Independence rule cannot be met in ${tier}: only ${author} models are available.`);
  }
  return { models, warnings };
}
