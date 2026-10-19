import type { CatalogEntry } from '../types/index.js';

export interface QuotaReading {
  remainingPercent: number | 'unknown';
  timestamp?: string;
}
export type QuotaSnapshot = Readonly<Record<string, QuotaReading>>;

export function quotaStatus(entry: CatalogEntry, snapshot: QuotaSnapshot, floor: number): 'unavailable' | 'eligible' | 'unchecked' {
  const value = snapshot[entry.quotaGroup]?.remainingPercent;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return 'unchecked';
  return value <= floor ? 'unavailable' : 'eligible';
}
