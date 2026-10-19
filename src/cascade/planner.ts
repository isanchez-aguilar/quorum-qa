import { reviewChunks } from './prompts.js';
import { systemClock, type Clock } from './budget.js';
import type { CatalogEntry, QuorumConfig, ReviewContext, Tier } from '../types/index.js';
import { resolveAuthorFamily, TIERS } from '../config/schema.js';
import { modelRef, parseModelRef } from '../catalog/index.js';
import { quotaStatus, type QuotaSnapshot } from '../catalog/groups.js';
import { resolveTier } from '../catalog/tiers.js';

export interface ExecutionPlan {
  nowMs: number;
  context: ReviewContext;
  config: QuorumConfig;
  tiers: Record<Tier, CatalogEntry[]>;
  routes: Record<string, CatalogEntry[]>;
  quotas: Array<{ group: string; remainingPercent: number | 'unknown'; timestamp?: string; status: 'unavailable' | 'eligible' | 'unchecked' }>;
  warnings: string[];
  payloadCharacters: number;
  chunkCount: number;
  confirmationReserve: number;
  budgetCoversChunks: boolean;
}

export function createExecutionPlan(context: ReviewContext, config: QuorumConfig, catalog: readonly CatalogEntry[], quotaSnapshot: QuotaSnapshot = {}, options: { clock?: Clock } = {}): ExecutionPlan {
  const warnings: string[] = [];
  const nowMs = (options.clock ?? systemClock).now();
  const tiers = {} as ExecutionPlan['tiers'];
  for (const tier of TIERS) {
    const resolved = resolveTier(tier, config, catalog, quotaSnapshot, { authorFamily: context.authorFamily, nowMs });
    tiers[tier] = resolved.models;
    warnings.push(...resolved.warnings);
  }
  const routes = Object.fromEntries(Object.entries(config.escalate.routes ?? {}).map(([keyword, refs]) => {
    const resolved = resolveTier('confirm', config, catalog, quotaSnapshot, {
      refs, label: `route "${keyword}"`, authorFamily: context.authorFamily, nowMs, excludeLocal: true,
    });
    warnings.push(...resolved.warnings);
    if (!resolved.models.length) warnings.push(`Confirmation route "${keyword}" unavailable; falling back to confirm tier.`);
    return [keyword, resolved.models];
  }));
  const configured = new Set([...Object.values(config.tiers).flat(), ...Object.values(config.escalate.routes ?? {}).flat()].map(ref => {
    const parsed = parseModelRef(ref, catalog);
    return `${parsed.provider}:${parsed.model}`;
  }));
  const groups = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    if (configured.has(`${entry.provider}:${entry.id}`)) groups.set(entry.quotaGroup, entry);
  }
  const quotas = [...groups].map(([group, entry]) => {
    const status = quotaStatus(entry, quotaSnapshot, config.budget.quotaFloorPercent, nowMs);
    if (status === 'unchecked') warnings.push(`${group}: unknown quota; floor unchecked.`);
    return { group, remainingPercent: status === 'unchecked' ? 'unknown' as const : quotaSnapshot[group]!.remainingPercent,
      timestamp: quotaSnapshot[group]?.timestamp, status };
  });
  const payload = reviewChunks(context);
  for (const file of payload.skippedFiles) warnings.push(file + ': skipped review; no diff content fits.');
  for (const item of payload.truncatedHunks) warnings.push(item.file + ': truncated hunk ' + item.hunk + '.');
  const confirmationReserve = Math.max(1, Math.floor(config.budget.maxCalls / 3));
  return { nowMs, confirmationReserve, context: structuredClone(context), config: structuredClone(config), tiers, routes, quotas, warnings,
    chunkCount: payload.chunks.length, budgetCoversChunks: config.budget.maxCalls - confirmationReserve >= payload.chunks.length,
    payloadCharacters: payload.chunks.reduce((sum, chunk) => sum + chunk.prompt.length, 0) };
}

export function formatDryRun(plan: ExecutionPlan): string {
  const { context, config } = plan;
  const author = config.author ? resolveAuthorFamily(config.author) : context.authorFamily;
  const names = (tier: Tier) => plan.tiers[tier].map(item => `${modelRef(item)} (${item.family})`).join(' -> ') || 'none available';
  const added = context.diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = context.diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return [
    '=== Quorum Review Plan (Dry Run) ===', '', 'Configuration & Context:',
    `  Base Commit: ${config.base} (${context.baseCommit})`, `  Head Commit: ${context.headCommit}`,
    `  Review Mode: ${context.mode}`, `  Spec: ${context.specContent === undefined ? 'not supplied' : 'supplied as content'}`,
    `  Author Family: ${author ?? 'unknown'}`, `  Files Changed: ${context.touchedFiles.length} files (+${added}, -${removed} lines)`,
    `  Independence Rule: ${!author ? 'author unknown' : plan.warnings.some(item => item.startsWith('Independence')) ? 'cannot be met in every tier (see warnings)' : 'enforced'}`,
    '', 'Deterministic Pre-flight Checks (Phase 1):',
    ...config.checks.map((check, index) => `  [${index + 1}] ${check.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`),
    '', 'Provider Quota Status:',
    ...plan.quotas.map(quota => `  ${quota.group}: ${quota.remainingPercent === 'unknown' ? 'unknown' : `${quota.remainingPercent}%`}`
      + `${quota.timestamp ? ` at ${quota.timestamp} (age ${Math.max(0, Math.floor((plan.nowMs - Date.parse(quota.timestamp)) / 1000))}s) from the ledger (unknown after 6 hours)` : ' (no reading time in the ledger)'}`
      + ` [${quota.status === 'unavailable' ? 'UNAVAILABLE' : quota.status === 'unchecked' ? 'ELIGIBLE, floor unchecked' : 'ELIGIBLE'}]`),
    '', 'Execution Cascade:', '  [Phase 2: Triage]', `    Provider / Model: ${names('triage')}`,
    `    Payload: surgical diff + supplied spec, inventory and rules (${context.diff.split('\n').length} diff lines)`,
    `    Payload size: ${plan.payloadCharacters} characters (not tokens)`,
    `    Review chunks: ${plan.chunkCount}; call budget ${plan.budgetCoversChunks ? 'covers' : 'does not cover'} initial triage (retries and escalation extra; time depends on providers)`,
    '  [Phase 3: Conditional Escalation Paths]',
    `    Triggers: findings matching [${[...new Set([...config.escalate.focus, ...Object.keys(plan.routes)])].join(', ')}] OR confidence < ${config.escalate.belowConfidence.toFixed(2)} OR BLOCKER`,
    ...Object.entries(plan.routes).map(([keyword, entries]) => `    Route ${keyword}: ${entries.map(item => `${modelRef(item)} (${item.family})`).join(' -> ') || 'none available; fall back to confirm'}`),
    `    Confirm: ${names('confirm')}`, `    Local-only / parse failure / timeout -> review: ${names('review')}`,
    '    Possibly related, cross-family pairs -> confirm: same defect?',
    '  [Phase 4: Reproduction Lane]', '    Enabled: No (M6; requires opt-in)',
    '', 'Budget Ceilings:', `    Max API Calls: ${config.budget.maxCalls}`,
    `    Confirmation reserve: ${plan.confirmationReserve} calls (released when no findings need escalation)`,
    `    Max Run Time: ${config.budget.maxMinutes} minutes`, `    Quota Floor: ${config.budget.quotaFloorPercent}%`,
    ...plan.warnings.map(warning => `Warning: ${warning}`), '', 'Nothing was called: dry-run spends no quota.',
  ].join('\n');
}
