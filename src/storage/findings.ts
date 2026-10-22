import type { Finding } from '../types/index.js';
import { appendLedger } from './index.js';

export const FINDINGS_MAX_BYTES = 5 * 1024 * 1024;

export interface HistoryEntry {
  suppressed?: boolean;
  runId: string;
  timestamp: string;
  mode: string;
  file: string;
  line: number;
  severity: Finding['severity'];
  origin: Finding['origin'];
  trigger: string;
  impact: string;
  evidence_quote: string;
  provider: string;
  model: string;
  family: Finding['family'];
  confirmed: boolean;
  reproduction: NonNullable<Finding['reproduction']>['status'];
}

/** The caller supplies the final reported list, after confirmation rejections. */
export function historyEntries(findings: readonly Finding[], metadata: Pick<HistoryEntry, 'runId' | 'timestamp' | 'mode'>): HistoryEntry[] {
  return findings.filter(finding => finding.verified === true).map(finding => ({
    ...metadata, file: finding.file, line: finding.line, severity: finding.severity, origin: finding.origin,
    trigger: finding.trigger, impact: finding.impact, evidence_quote: finding.evidence_quote.slice(0, 400),
    provider: finding.provider, model: finding.model, family: finding.family,
    confirmed: finding.confirmed === true || new Set(finding.confirmationFamilies ?? []).size >= 2,
    reproduction: finding.reproduction?.status ?? 'unproven',
  }));
}

export async function appendFindings(entries: readonly HistoryEntry[], file: string, repoRoot = process.cwd()): Promise<void> {
  await appendLedger(entries, file, repoRoot, FINDINGS_MAX_BYTES);
}
