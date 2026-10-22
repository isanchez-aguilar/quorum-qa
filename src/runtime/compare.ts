import type { RuntimeConfig } from './config.js';
import type { Observation } from './report.js';
import { runtimeText, type SideResult } from './run.js';
import { signature } from './signature.js';

export interface RuntimeEntry {
  signature: string; kind: Observation['kind']; flow: string; step?: number; message: string; path?: string;
  counts: { base: [number, number]; head: [number, number] };
}
export interface FlowBroke extends RuntimeEntry { step: number; errorClass: NonNullable<Observation['errorClass']> }
export interface FlowComparison { newAtHead: RuntimeEntry[]; fixed: RuntimeEntry[]; preExisting: RuntimeEntry[]; flowBroke: FlowBroke[] }
export interface RuntimeComparison extends FlowComparison {
  flows: Record<string, FlowComparison>;
  flaky: Array<{ flow: string; side: 'base' | 'head' }>;
  incomplete: Array<{ flow: string; side: 'base' | 'head' }>;
  coveredFlows: string[]; uncoveredFlows: string[];
  blockedExternal: Record<'base' | 'head', Record<string, number>>;
}

function stableFailures(side: SideResult, flow: string): Observation[] {
  const runs = [1, 2].map(index => side.report.runs.find(run => run.flow === flow && run.run === index));
  return (runs[0]?.observations ?? []).filter(observation => observation.kind === 'flow-failure'
    && runs[1]?.observations.some(other => other.kind === 'flow-failure' && other.step === observation.step));
}
function completed(side: SideResult, flow: string): boolean {
  return [1, 2].every(index => side.report.runs.some(run => run.flow === flow && run.run === index && run.completed));
}

export function compareRuntime(base: SideResult, head: SideResult, config: RuntimeConfig): RuntimeComparison {
  const result: RuntimeComparison = { flows: Object.create(null) as RuntimeComparison['flows'], newAtHead: [], fixed: [], preExisting: [], flowBroke: [],
    flaky: [], incomplete: [], coveredFlows: [], uncoveredFlows: [], blockedExternal: { base: {}, head: {} } };
  const text = (value: string) => runtimeText(value, config);
  for (const [name, side] of [['base', base], ['head', head]] as const) {
    for (const category of ['flaky', 'incomplete'] as const) result[category] = [...result[category], ...side.stable[category].map(flow => ({ flow: text(flow), side: name }))];
    const hosts = new Map<string, number>();
    for (const run of side.report.runs) for (const [host, count] of Object.entries(run.blockedExternal)) hosts.set(text(host), (hosts.get(text(host)) ?? 0) + count);
    result.blockedExternal[name] = Object.fromEntries(hosts);
  }
  for (const { name: flow } of config.flows ?? []) {
    const row: FlowComparison = { newAtHead: [], fixed: [], preExisting: [], flowBroke: [] };
    result.flows[text(flow)] = row;
    const missing = [base, head].some(side => ![1, 2].every(index => side.report.runs.some(run => run.flow === flow && run.run === index && !run.notes.includes('missing run'))));
    if (missing) result.uncoveredFlows.push(text(flow));
    if (!missing && [base, head].every(side => !side.stable.incomplete.includes(flow) && (completed(side, flow) || stableFailures(side, flow).length))) result.coveredFlows.push(text(flow));
    const before = base.stable.flows[flow] ?? new Set<string>();
    const after = head.stable.flows[flow] ?? new Set<string>();
    const entry = (key: string, observation: Observation): RuntimeEntry => ({
      signature: text(key), kind: observation.kind, flow: text(flow), message: text(observation.message),
      ...(['blank', 'technicalText', 'flow-failure'].includes(observation.kind) ? { step: observation.step } : {}),
      ...(observation.path !== undefined ? { path: text(observation.path) } : {}),
      counts: { base: [...(base.stable.counts[key] ?? [0, 0])], head: [...(head.stable.counts[key] ?? [0, 0])] },
    });
    for (const key of new Set([...before, ...after])) {
      const source = after.has(key) ? head : base;
      const observation = source.report.runs.filter(run => run.flow === flow).flatMap(run => run.observations).find(item => signature(item, flow) === key);
      // Flow failures are matched by step below: their error text may differ between revisions.
      if (!observation || observation.kind === 'flow-failure') continue;
      const category = before.has(key) ? after.has(key) ? 'preExisting' : 'fixed' : 'newAtHead';
      row[category].push(entry(key, observation));
    }
    const failureCounts = (side: SideResult, step: number) => [1, 2].map(index => side.report.runs.find(run => run.flow === flow && run.run === index)
      ?.observations.filter(other => other.kind === 'flow-failure' && other.step === step).length ?? 0) as [number, number];
    const failedSteps = (side: SideResult) => new Map(stableFailures(side, flow).map(observation => [observation.step!, observation]));
    const baseFailed = failedSteps(base); const headFailed = failedSteps(head);
    for (const [step, observation] of headFailed) {
      const item = entry(signature(observation, flow)!, observation);
      item.counts = { base: failureCounts(base, step), head: failureCounts(head, step) };
      // Same failing step at both revisions is pre-existing; a step that fails only at head broke,
      // whether base completed the flow or failed earlier at another step.
      if (baseFailed.has(step)) row.preExisting.push(item);
      else row.flowBroke.push({ ...item, step, errorClass: observation.errorClass ?? 'other' });
    }
    for (const [step, observation] of baseFailed) if (!headFailed.has(step)) {
      const item = entry(signature(observation, flow)!, observation);
      item.counts = { base: failureCounts(base, step), head: failureCounts(head, step) };
      row.fixed.push(item);
    }
    for (const category of ['newAtHead', 'fixed', 'preExisting'] as const) result[category].push(...row[category]);
    result.flowBroke.push(...row.flowBroke);
  }
  return result;
}

export function summarizeRuntimeComparison(comparison: RuntimeComparison): string {
  // Page text remains JSON data; retain totals when bounded samples are omitted.
  const categories = ['newAtHead', 'fixed', 'preExisting', 'flowBroke', 'flaky', 'incomplete', 'coveredFlows', 'uncoveredFlows'] as const;
  const summary = {
    totals: Object.fromEntries(categories.map(key => [key, comparison[key].length])),
    newAtHead: comparison.newAtHead.slice(0, 5).map(item => ({ kind: item.kind, flow: item.flow, step: item.step, message: item.message.slice(0, 100) })),
    flowBroke: comparison.flowBroke.slice(0, 5).map(item => ({ flow: item.flow, step: item.step, errorClass: item.errorClass })),
    flaky: comparison.flaky.slice(0, 5), incomplete: comparison.incomplete.slice(0, 5),
    coveredFlows: comparison.coveredFlows.slice(0, 20), uncoveredFlows: comparison.uncoveredFlows.slice(0, 20),
  };
  const lists = [summary.newAtHead, summary.flowBroke, summary.flaky, summary.incomplete, summary.coveredFlows, summary.uncoveredFlows];
  while (Buffer.byteLength(JSON.stringify(summary)) > 4096) {
    const largest = lists.sort((a, b) => b.length - a.length)[0]!;
    if (!largest.length) break;
    largest.pop();
  }
  return JSON.stringify(summary);
}
