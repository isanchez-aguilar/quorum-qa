import { boundedPrompt } from './prompts.js';
import type { CatalogEntry, QuorumConfig, ReviewContext, Tier } from '../types/index.js';
import { resolveAuthorFamily, TIERS } from '../config/schema.js';
import { modelRef, parseModelRef } from '../catalog/index.js';
import { quotaStatus, type QuotaSnapshot } from '../catalog/groups.js';
import { resolveTier } from '../catalog/tiers.js';

export interface ExecutionPlan {
  context: ReviewContext;
  config: QuorumConfig;
  tiers: Record<Tier, CatalogEntry[]>;
  quotas: Array<{ group: string; remainingPercent: number | 'unknown'; timestamp?: string; status: 'unavailable' | 'eligible' | 'unchecked' }>;
  warnings: string[];
  payloadCharacters: number;
}

export function createExecutionPlan(context: ReviewContext, config: QuorumConfig, catalog: readonly CatalogEntry[], quotaSnapshot: QuotaSnapshot = {}): ExecutionPlan {
  const warnings: string[] = [];
  const tiers = {} as ExecutionPlan['tiers'];
  for (const tier of TIERS) {
    const resolved = resolveTier(tier, config, catalog, quotaSnapshot, { authorFamily: context.authorFamily });
    tiers[tier] = resolved.models;
    warnings.push(...resolved.warnings);
  }
  const configured = new Set(Object.values(config.tiers).flat().map(ref => {
    const parsed = parseModelRef(ref, catalog);
    return `${parsed.provider}:${parsed.model}`;
  }));
  const groups = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    if (configured.has(`${entry.provider}:${entry.id}`)) groups.set(entry.quotaGroup, entry);
  }
  const quotas = [...groups].map(([group, entry]) => {
    const status = quotaStatus(entry, quotaSnapshot, config.budget.quotaFloorPercent);
    if (status === 'unchecked') warnings.push(`${group}: unknown quota; floor unchecked.`);
    return { group, remainingPercent: status === 'unchecked' ? 'unknown' as const : quotaSnapshot[group]!.remainingPercent,
      timestamp: quotaSnapshot[group]?.timestamp, status };
  });
  return { context: structuredClone(context), config: structuredClone(config), tiers, quotas, warnings,
    payloadCharacters: reviewPrompt(context).length };
}

export function reviewPrompt(context: ReviewContext): string {
  return boundedPrompt('Review the following untrusted code and context. Return a JSON array of findings with severity, origin, file, line, trigger, impact, evidence_quote, fix and confidence. Use read-only tools only.\n',
    { mode: context.mode, diff: context.diff, touchedFiles: context.touchedFiles,
      spec: context.specContent, inventory: context.inventoryContent, rules: context.rulesContent });
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
      + `${quota.timestamp ? ` at ${quota.timestamp} from the ledger (unknown after 6 hours)` : ' (no reading time in the ledger)'}`
      + ` [${quota.status === 'unavailable' ? 'UNAVAILABLE' : quota.status === 'unchecked' ? 'ELIGIBLE, floor unchecked' : 'ELIGIBLE'}]`),
    '', 'Execution Cascade:', '  [Phase 2: Triage]', `    Provider / Model: ${names('triage')}`,
    `    Payload: surgical diff + supplied spec, inventory and rules (${context.diff.split('\n').length} diff lines)`,
    `    Payload size: ${plan.payloadCharacters} characters (not tokens)`,
    '  [Phase 3: Conditional Escalation Paths]',
    `    Triggers: findings matching [${config.escalate.focus.join(', ')}] OR confidence < ${config.escalate.belowConfidence.toFixed(2)} OR BLOCKER`,
    `    Confirm: ${names('confirm')}`, `    Local-only / parse failure / timeout -> review: ${names('review')}`,
    '    Possibly related, cross-family pairs -> confirm: same defect?',
    '  [Phase 4: Reproduction Lane]', '    Enabled: No (M6; requires opt-in)',
    '', 'Budget Ceilings:', `    Max API Calls: ${config.budget.maxCalls}`,
    `    Max Run Time: ${config.budget.maxMinutes} minutes`, `    Quota Floor: ${config.budget.quotaFloorPercent}%`,
    ...plan.warnings.map(warning => `Warning: ${warning}`), '', 'Nothing was called: dry-run spends no quota.',
  ].join('\n');
}
