import type { RuntimeConfig } from '../runtime/config.js';
import { DEFAULT_RUNTIME_IMAGE } from '../runtime/image.js';
import type { RuntimeEvidence } from '../runtime/run.js';
import type { RuntimeComparison } from '../runtime/compare.js';
import { UsageError } from './args.js';
import type { CliIo } from './index.js';
import { runtimeText } from '../runtime/run.js';
import type { VisualReview } from '../runtime/visual.js';

export function runtimeReview(config: RuntimeConfig | undefined, dryRun: boolean, io: CliIo): number {
  for (const key of ['start', 'readyUrl', 'flows'] as const) {
    if (!config?.[key]) throw new UsageError(`runtime.${key} is required in runtime mode.`);
  }
  const runtime = config!;
  if (!dryRun) {
    return 2;
  }
  io.out('Runtime plan (no commands run):\n'
    + `  Start: ${runtimeText(runtime.start!.join(' '), runtime)}\n`
    + `  Ready URL: ${runtimeText(runtime.readyUrl!, runtime)}\n`
    + `  Flows: ${runtime.flows!.length}; steps: ${runtime.flows!.reduce((count, flow) => count + flow.steps.length, 0)}\n`
    + `  Timeouts: ready ${runtime.readyTimeoutSeconds}s; flow ${runtime.flowTimeoutSeconds}s; step ${runtime.stepTimeoutSeconds}s\n`
    + `  Image: ${runtime.image ?? DEFAULT_RUNTIME_IMAGE}\n`
    + `  Limits: ${runtime.memoryMiB} MiB; ${runtime.pids} pids\n`
    + `  Screenshots: ${runtime.screenshots ? 'on (stored under .quorum/runtime-shots/, up to 10 per flow, 300 KB each)' : 'off'}\n`);
  return 0;
}

export type RuntimeVerdict = 'NEW RUNTIME PROBLEMS' | 'SUSPECT' | 'NO NEW RUNTIME PROBLEMS FOUND' | 'UNKNOWN';
export interface RuntimeVerdictResult { verdict: RuntimeVerdict; exitCode: number; reasons: string[] }
export function evaluateRuntimeVerdict(evidence: RuntimeEvidence, comparison: RuntimeComparison | undefined,
  { strictFlows, visual }: { strictFlows: boolean; visual?: VisualReview }): RuntimeVerdictResult {
  const deterministic = deterministicVerdict(evidence, comparison, strictFlows);
  if (!visual?.requested) return deterministic;
  for (const label of visual.corroboratedLabels) {
    const families = new Set(visual.findings.filter(finding => finding.corroborated && `${finding.flow}/${finding.step}` === label).map(finding => finding.family));
    if (families.size < 2) continue;
    deterministic.reasons.push(`Visual review (advisory, ${families.size} families agreed): ${label}`);
    if (deterministic.verdict === 'NO NEW RUNTIME PROBLEMS FOUND') deterministic.verdict = 'SUSPECT';
  }
  return deterministic;
}

function deterministicVerdict(evidence: RuntimeEvidence, comparison: RuntimeComparison | undefined, strictFlows: boolean): RuntimeVerdictResult {
  const reasons = [...evidence.reasons];
  if (!evidence.available) reasons.push('Runtime evidence unavailable.');
  for (const side of ['base', 'head'] as const) {
    if (!evidence[side]) reasons.push(`${side}: runtime evidence missing.`);
    else for (const flow of evidence[side].stable.incomplete) reasons.push(`${side}: incomplete flow ${flow}.`);
  }
  if (!comparison) reasons.push('Runtime comparison unavailable.');
  for (const item of comparison?.incomplete ?? []) reasons.push(`${item.side}: incomplete flow ${item.flow}.`);
  if (comparison?.uncoveredFlows.length) reasons.push(`Uncovered flows: ${comparison.uncoveredFlows.join(', ')}.`);
  const unknown = reasons.length > 0;
  const count = comparison?.newAtHead.length ?? 0;
  if (count) reasons.push(`${count} new problem(s) confirmed at head.`);
  if (comparison?.flowBroke.length) reasons.push(`Flows broke at head: ${comparison.flowBroke.map(item => item.flow).join(', ')}${strictFlows ? ' (--strict-flows)' : ''}.`);
  if (comparison?.flaky.length) reasons.push(`Flaky flows: ${comparison.flaky.map(item => `${item.side}: ${item.flow}`).join(', ')}.`);
  const unique = [...new Set(reasons)];
  if (unknown) return { verdict: count ? 'NEW RUNTIME PROBLEMS' : 'UNKNOWN', exitCode: count ? 1 : 2, reasons: unique };
  if (count || strictFlows && comparison!.flowBroke.length) return { verdict: 'NEW RUNTIME PROBLEMS', exitCode: 1, reasons: unique };
  if (comparison!.flowBroke.length || comparison!.flaky.length) return { verdict: 'SUSPECT', exitCode: 0, reasons: unique };
  return { verdict: 'NO NEW RUNTIME PROBLEMS FOUND', exitCode: 0, reasons: [`no new problems found in flows: ${comparison!.coveredFlows.join(', ')}`] };
}
