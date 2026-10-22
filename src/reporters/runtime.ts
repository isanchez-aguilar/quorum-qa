import { evaluateRuntimeVerdict, type RuntimeVerdictResult } from '../cli/runtime.js';
import { compareRuntime, summarizeRuntimeComparison, type RuntimeComparison, type RuntimeEntry } from '../runtime/compare.js';
import type { RuntimeConfig } from '../runtime/config.js';
import { runtimeText, type RuntimeEvidence } from '../runtime/run.js';
import { cell } from './refactor.js';

export interface RuntimeReport extends RuntimeVerdictResult {
  available: boolean; comparison?: RuntimeComparison; strictFlows: boolean; notes: string[]; summary: string;
}
export function buildRuntimeReport(evidence: RuntimeEvidence, config: RuntimeConfig, options: { strictFlows: boolean }): RuntimeReport {
  const comparison = evidence.base && evidence.head ? compareRuntime(evidence.base, evidence.head, config) : undefined;
  const verdict = evaluateRuntimeVerdict(evidence, comparison, options);
  return { ...verdict, reasons: verdict.reasons.map(reason => runtimeText(reason, config)), available: evidence.available,
    ...(comparison ? { comparison } : {}), strictFlows: options.strictFlows,
    notes: evidence.notes.map(note => runtimeText(note, config)),
    summary: comparison ? summarizeRuntimeComparison(comparison) : JSON.stringify({ available: false }),
  };
}

// Escape Markdown syntax as well as HTML: browser text must stay literal data.
const literal = (text: string) => cell(text.replace(/&/g, '&amp;').replace(/\\/g, '&#92;')
  .replace(/[`\[\]*_#]/g, character => `&#${character.charCodeAt(0)};`).replace(/>/g, '&gt;').replace(/\r/g, ' '));
const list = (items: string[]) => items.map(item => `- ${literal(item)}`).join('\n') || 'None.';

export function runtimeMarkdown(report: RuntimeReport): string[] {
  const comparison = report.comparison;
  return [
    `**Verdict:** ${report.verdict} · exit ${report.exitCode}`,
    '## Runtime comparison',
    ...Object.entries(comparison?.flows ?? {}).flatMap(([flow, result]) => [
      `### Flow: ${literal(flow)}`,
      '| Category | Kind | Step | Path | Message | Base runs | Head runs |', '|---|---|---:|---|---|---|---|',
      ...(['newAtHead', 'preExisting', 'fixed'] as const).flatMap(category => result[category].map(item =>
        `| ${{ newAtHead: 'New at head', preExisting: 'Pre-existing', fixed: 'Fixed' }[category]} | ${item.kind} | ${item.step ?? ''} | ${literal(item.path ?? '')} | ${literal(item.message.slice(0, 300))} | ${item.counts.base.join(', ')} | ${item.counts.head.join(', ')} |`)),
      ...(!result.newAtHead.length && !result.preExisting.length && !result.fixed.length ? ['No stable problem signatures.'] : []),
    ]),
    '### Flow broke', list(comparison?.flowBroke.map(item => `${item.flow}: step ${item.step} (${item.errorClass}); ${item.message.slice(0, 300)}`) ?? []),
    '### Flaky flows', list(comparison?.flaky.map(item => `${item.side}: ${item.flow}`) ?? []),
    '### Incomplete flows', list(comparison?.incomplete.map(item => `${item.side}: ${item.flow}`) ?? []),
    '### Uncovered flows', list(comparison?.uncoveredFlows ?? []),
    '### Blocked external hosts (information only)',
    ...(['base', 'head'] as const).map(side => `${side}:\n\n${list(Object.entries(comparison?.blockedExternal[side] ?? {}).map(([host, count]) => `${host}: ${count}`))}`),
    '### Verdict reasons', list(report.reasons),
    '### Notes', list(report.notes),
    `Covered flows: ${(comparison?.coveredFlows ?? []).map(literal).join(', ') || 'none'}.`,
    'The statement "no new problems found" covers only the listed flows; it is not a claim about the whole app.',
    'Runtime comparison is deterministic; no provider calls.',
  ];
}

export function runtimeSarif(report?: RuntimeReport) {
  const result = (item: RuntimeEntry, level: string) => ({
    ruleId: `quorum-runtime/${item.kind}`, level, message: { text: item.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: 'quorum.config.json', uriBaseId: '%SRCROOT%' } },
      logicalLocations: [{ name: item.flow, kind: 'function' }, ...(item.step === undefined ? [] : [{ name: `step ${item.step}`, kind: 'member' }])],
    }],
    properties: { deterministic: true, flow: item.flow, step: item.step, path: item.path, counts: item.counts },
  });
  return [
    ...(report?.comparison?.newAtHead ?? []).map(item => result(item, 'error')),
    ...(report?.comparison?.flowBroke ?? []).map(item => result(item, report?.strictFlows ? 'error' : 'warning')),
    ...(report?.comparison?.preExisting ?? []).map(item => result(item, 'note')),
  ];
}
