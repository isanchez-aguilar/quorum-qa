import { agyQuotaGroup } from './agy-groups.js';
import type { CatalogEntry, Family, Tier } from '../types/index.js';

function entry(provider: string, id: string, family: Family, defaultTier: Tier, quotaGroup: string, supportsImages = false): CatalogEntry {
  return { provider, id, family, defaultTier, quotaGroup: provider === 'agy' ? agyQuotaGroup(id) ?? quotaGroup : quotaGroup, supportsImages };
}

export const DEFAULT_CATALOG: readonly CatalogEntry[] = [
  ...['3.8', '3.7', '3.6'].flatMap(version => ['low', 'medium', 'high'].map(effort =>
    entry('agy', `gemini-${version}-flash-${effort}`, 'google', 'triage', 'agy:google', true))),
  ...['low', 'medium', 'high'].map(effort => entry('agy', `gemini-4-argon-${effort}`, 'google', 'review', 'agy:argon', true)),
  // Listed by agy until mid-October 2026; kept so older configs still resolve, and doctor flags them when agy drops them.
  ...['low', 'high'].map(effort => entry('agy', `gemini-3.1-pro-${effort}`, 'google', 'review', 'agy:google', true)),
  ...['low', 'medium', 'high'].flatMap(effort => [
    entry('agy', `claude-sonnet-5-5-${effort}`, 'anthropic', 'review', 'agy:anthropic', true),
    entry('agy', `claude-opus-5-5-${effort}`, 'anthropic', 'confirm', 'agy:anthropic', true),
  ]),
  entry('agy', 'gpt-oss-120b-medium', 'openai', 'triage', 'agy:openai'),
  entry('codex', 'codex', 'openai', 'confirm', 'codex:openai'),
  entry('claude', 'sonnet', 'anthropic', 'review', 'claude:anthropic', true),
  entry('claude', 'opus', 'anthropic', 'confirm', 'claude:anthropic', true),
  entry('qwen', 'qwen', 'local', 'triage', 'qwen:local'),
];

export function modelRef(entry: CatalogEntry): string {
  return entry.provider === entry.id ? entry.id : `${entry.provider}:${entry.id}`;
}

export function withQwenModel(catalog: readonly CatalogEntry[], model?: string): readonly CatalogEntry[] {
  return model ? catalog.map(item => item.provider === 'qwen' ? { ...item, id: model } : item) : catalog;
}

export function parseModelRef(ref: string, catalog: readonly CatalogEntry[] = DEFAULT_CATALOG): { provider: string; model: string; family: Family } {
  const [provider, explicit, ...extra] = ref.split(':');
  if (!provider || !['agy', 'codex', 'claude', 'qwen'].includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const model = explicit ?? (provider === 'claude' ? 'sonnet' : provider === 'qwen' ? catalog.find(item => item.provider === 'qwen')?.id ?? provider : provider);
  const found = catalog.find(item => item.provider === provider && item.id === model);
  if (extra.length || !found) throw new Error(`Unknown model reference: ${ref}`);
  return { provider, model, family: found.family };
}

export { resolveTier } from './tiers.js';
export type { QuotaSnapshot, QuotaReading } from './groups.js';
