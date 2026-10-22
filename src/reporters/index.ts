import { createHash } from 'node:crypto';
import type { CascadeResult } from '../cascade/index.js';
import type { runDeterministicChecks } from '../checks/index.js';
import type { Family, Finding } from '../types/index.js';
import type { RuleRun } from '../rules/index.js';
import { cell, refactorMarkdown, refactorSarif, type RefactorReport } from './refactor.js';
import { runtimeMarkdown, runtimeSarif, type RuntimeReport } from './runtime.js';

export interface ReviewResult extends CascadeResult {
  runId: string;
  timestamp: string;
  mode: 'feature' | 'redesign' | 'bughunt' | 'contract' | 'refactor' | 'runtime';
  refactor?: RefactorReport;
  runtime?: RuntimeReport;
  range: string;
  headSha: string;
  baseSha: string;
  checks: Awaited<ReturnType<typeof runDeterministicChecks>> | null;
  ruleChecks?: RuleRun | null;
  clauses?: string[];
  contractFiles?: Array<{ file: string; imports: string[] }>;
  copyFiles?: string[];
  criteria: string[];
  inventory: string[];
  families: Family[];
  exitCode: number;
}
const details = (findings: Finding[], refactor = false) => findings.length ? findings.map((f, i) => [
  `### ${i + 1}. ${cell(f.trigger)}`, `- **Location:** ${cell(f.file)}:${f.line}${refactor ? ' (suspected behaviour change)' : ` (${f.origin})`}`,
  `- **Severity:** ${f.severity} · **Confidence:** ${f.confidence} · ${cell(f.provider)}:${cell(f.model)} (${f.family})`,
  f.clauseNote ? `- **Rule:** ${cell(f.clauseNote)}` : f.clause ? `- **Rule:** ${cell(f.clause)}` : '',
  f.singleSource ? '- **single model, not confirmed**' : '',
  `- **Impact:** ${cell(f.impact)}`, `- **Evidence Quote:** ${cell(f.evidence_quote)}`,
  `- **Proposed Fix:** ${cell(f.fix)}`, f.severity === 'BLOCKER' ? `- **Reproduction Proof:** ${f.reproduction?.status ?? 'unproven'} (${cell(f.reproduction?.failureReason ?? 'reproduction not requested')}).` : '',
].filter(Boolean).join('\n')).join('\n\n') : 'None.';

function reproductionDetails(findings: Finding[]): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return findings.filter(f => f.severity === 'BLOCKER' || f.reproduction?.status && f.reproduction.status !== 'pending').map(f => {
    const proposal = f.reproduction;
    const summary = escape((proposal?.path || '(none)').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ''))
      .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
    let fenceLength = 3;
    for (const match of (proposal?.content ?? '').matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    return `### ${cell(f.file)}:${f.line}\n\nStatus: **${proposal?.status ?? 'unproven'}**\n\n`
      + `Reason: ${cell(proposal?.failureReason ?? 'reproduction not requested')}\n\n`
      + (proposal?.content ? `<details><summary>${summary}</summary>\n\n${fence}\n${proposal.content}\n${fence}\n\n</details>` : 'No proposed test.');
  }).join('\n\n') || 'No BLOCKERs required reproduction.';
}

export function generateMarkdownReport(result: ReviewResult): string {
  const budget = result.callBudget ? [`**Call budget:** ${result.callBudget.maxCalls} (${result.callBudget.auto ? 'auto' : 'from budget.maxCalls'})`] : [];
  if (result.runtime) return ['# Quorum Runtime Review Report', ...budget, ...runtimeMarkdown(result.runtime),
    '## Warnings', result.warnings.map(warning => `- ${cell(warning)}`).join('\n') || 'None.'].join('\n\n').replace(/\|\n\n(?=\|)/g, '|\n') + '\n';
  const { coverage } = result;
  const all = [...result.findings, ...result.unconfirmed.filter(f => f.family !== 'local')];
  const refactor = result.mode === 'refactor';
  const findingDetails = (findings: Finding[]) => details(findings, refactor);
  return [
    '# Quorum QA Review Report', `**Run ID:** ${cell(result.runId)} · **Mode:** ${result.mode} · **Diff:** ${cell(result.range)}`,
    ...budget,
    ...(result.refactor ? [`**Verdict:** ${result.refactor.verdict}`] : []),
    `**Time:** ${cell(result.timestamp)} · Provider duration: ${(result.ledgerDraft.reduce((sum, row) => sum + row.durationMs, 0) / 1000).toFixed(2)}s`,
    `**Status:** exit ${result.exitCode} · ${all.filter(f => f.severity === 'BLOCKER').length} Blockers Found · ${result.checks?.results.filter(check => check.exitCode !== 0 || check.timedOut).length ?? 0} failed deterministic checks · Cache hits: ${result.cacheHits}`,
    '## Executive Summary', ...(refactor ? ['| Category | Suspected behaviour changes |', '|---|---:|',
      ...(['BLOCKER', 'IMPORTANT', 'OPTIONAL'] as const).map(severity => `| ${severity} | ${all.filter(f => f.severity === severity).length} |`)] : [
    '| Category | Introduced | Pre-existing | Improvement | Total |', '|---|---:|---:|---:|---:|',
    ...(['BLOCKER', 'IMPORTANT', 'OPTIONAL'] as const).map(severity => {
      const rows = all.filter(f => f.severity === severity);
      return `| ${severity} | ${['introduced', 'pre-existing', 'improvement'].map(origin => rows.filter(f => f.origin === origin).length).join(' | ')} | ${rows.length} |`;
    }),
    `| Total | ${['introduced', 'pre-existing', 'improvement'].map(origin => all.filter(f => f.origin === origin).length).join(' | ')} | ${all.length} |`]),
    ...(result.refactor ? refactorMarkdown(result.refactor) : []),
    '## Coverage', coverage.complete ? '**COMPLETE**' : '> **INCOMPLETE — this run did not review everything. A run without BLOCKERs or error-severity rule matches exits 2.**',
    `- Reviewed: ${coverage.reviewedFiles.map(cell).join(', ') || 'none'}`,
    ...(result.mode === 'bughunt' ? [
      `- Windows reviewed: ${(coverage.reviewedWindows ?? []).map(window => `${cell(window.file)}:${window.start}-${window.end}`).join(', ') || 'none'}`,
      `- Windows skipped: ${(coverage.skippedWindows ?? []).map(window => `${cell(window.file)}:${window.start}-${window.end}`).join(', ') || 'none'}`,
    ] : []),
    ...(result.mode === 'contract' ? [
      ...(result.contractFiles ?? []).map(group => `- ${cell(group.file)}; imports: ${group.imports.map(cell).join(', ') || 'none'}`),
      `- Copy files: ${(result.copyFiles ?? []).map(cell).join(', ') || 'none'}`,
      `- Clauses: ${(result.clauses ?? []).map((_, i) => `R${i + 1}`).join(', ')}`,
    ] : []),
    `- Skipped: ${coverage.skippedFiles.map(cell).join(', ') || 'none'}`,
    `- Truncated: ${coverage.truncatedHunks.map(h => `${cell(h.file)} hunk ${h.hunk}`).join(', ') || 'none'}`,
    `- Binary: ${coverage.binaryFiles.map(cell).join(', ') || 'none'} (excluded from text review)`,
    `- Lost: ${coverage.lostFindings.map(f => `${cell(f.reason)}: ${f.count}`).join(', ') || 'none'}`,
    ...(result.mode === 'feature' ? ['## Acceptance criteria', '| Criterion | Status |', '|---|---|',
      ...result.criteria.map((criterion, i) => `| AC${i + 1}: ${cell(criterion)} | ${all.some(f => new RegExp(`\\bAC${i + 1}\\b`, 'i').test(f.trigger + '\n' + f.impact)) ? 'unmet' : 'not assessed (no finding)'} |`)]
      : result.mode === 'contract' ? ['## Rules', '| Clause | Status | Count |', '|---|---|---:|', ...(result.clauses ?? []).map((text, i) => {
        const count = all.filter(f => f.verified && f.clause === `R${i + 1}`).length;
        return `| R${i + 1}: ${cell(text)} | ${count ? 'contradicted' : 'no finding'} | ${count} |`;
      })]
      : result.mode === 'redesign' ? ['## Inventory', '| Feature | Status |', '|---|---|', ...result.inventory.map(feature => `| ${cell(feature)} | ${all.some(f => (f.trigger + '\n' + f.impact).toLowerCase().includes(feature.toLowerCase())) ? 'reported missing' : 'no finding'} |`)] : refactor ? [] : ['## Pre-existing bugs', 'Only pre-existing findings count toward this bughunt summary and exit status.']),
    '## Blockers', findingDetails(result.findings.filter(f => f.severity === 'BLOCKER')),
    '## Important Findings', findingDetails(result.findings.filter(f => f.severity === 'IMPORTANT')),
    '## Optional Findings', findingDetails(result.findings.filter(f => f.severity === 'OPTIONAL')),
    '## Rejected on confirmation', result.rejectedOnConfirmation?.length ? result.rejectedOnConfirmation.map(({ finding, sources, confirmer }) =>
      `- **${cell(finding.trigger)}** — ${cell(finding.file)}:${finding.line} — ${sources.map(source => cell(`${source.provider}:${source.model}`)).join(', ')}; rejected by ${cell(`${confirmer.provider}:${confirmer.model}`)}`).join('\n') : 'None.',
    '## Unconfirmed (local model only)', findingDetails(result.unconfirmed.filter(f => f.family === 'local')),
    '## Unconfirmed (other reviewers)', findingDetails(result.unconfirmed.filter(f => f.family !== 'local')),
    ...(result.mode === 'bughunt' ? ['## Points at the change (use feature mode)', details(result.pointsAtChange ?? [])] : []),
    '## Reproduction', reproductionDetails([...result.findings, ...result.unconfirmed]),
    '## Deterministic checks', 'Checks execute the change\'s own code in a disposable HEAD worktree, just as CI does.',
    result.checks === null ? refactor ? 'Setup and suite tests are reported above for merge-base and HEAD.' : 'Skipped (--no-checks).' : result.checks.results.length ? result.checks.results.map(check =>
      `- ${cell(check.argv.join(' '))}: ${check.exitCode === 0 && !check.timedOut ? 'passed' : 'FAILED'} (exit ${check.exitCode})\n\n${cell(check.stdoutTail + '\n' + check.stderrTail)}`).join('\n') : 'No checks configured.',
    '## Rule matches',
    result.ruleChecks === null ? 'Skipped (--no-checks).' : result.ruleChecks?.results.filter(row => row.totalMatches).map(row =>
      `### ${cell(row.rule.id)} (${row.rule.severity})\n\n${cell(row.rule.message)}\n\n` +
      row.matches.slice(0, 50).map(match => `- ${cell(match.file)}:${match.line} — ${cell(match.text)}`).join('\n') +
      (row.totalMatches > 50 ? `\n\n+${row.totalMatches - 50} more` : '')).join('\n\n') || 'None.',
    '## Warnings', [...result.warnings, ...result.errors].map(w => `- ${cell(w)}`).join('\n') || 'None.',
    '## Independence', `Families that reviewed: ${result.families.join(', ') || 'none'}.`,
    ...result.warnings.filter(w => w.startsWith('Independence')).map(cell),
    '## Review Metadata', `Head: ${cell(result.headSha)} · Base: ${cell(result.baseSha)} · Calls: ${result.ledgerDraft.reduce((n, row) => n + row.callsUsed, 0)}`,
  ].join('\n\n').replace(/\|\n\n(?=\|)/g, '|\n') + '\n';
}

export function generateSarifReport(findings: Finding[], result?: ReviewResult): string {
  const rules = [
    { id: 'QRM001', name: 'Blocker', shortDescription: { text: 'Blocker defect' }, defaultConfiguration: { level: 'error' } },
    { id: 'QRM002', name: 'ImportantDefect', shortDescription: { text: 'Important defect' }, defaultConfiguration: { level: 'warning' } },
    { id: 'QRM003', name: 'OptionalImprovement', shortDescription: { text: 'Optional improvement' }, defaultConfiguration: { level: 'note' } },
  ];
  return JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{
    tool: { driver: { name: 'Quorum', version: '0.0.0', rules } },
    invocations: [{ executionSuccessful: result ? !result.errors.length && result.coverage.complete : true }],
    properties: {
      coverage: { complete: result?.coverage.complete ?? true, skipped: result?.coverage.skippedFiles.length ?? 0,
        lost: result?.coverage.lostFindings.reduce((sum, item) => sum + item.count, 0) ?? 0 },
      unconfirmedCount: result?.unconfirmed.length ?? 0,
      ...(result?.refactor ? { refactor: result.refactor } : {}),
      ...(result?.runtime ? { runtime: Object.fromEntries(Object.entries(result.runtime).filter(([key]) => key !== 'shots')) } : {}),
    },
    results: [...findings.map(f => {
      const rule = rules[(['BLOCKER', 'IMPORTANT', 'OPTIONAL'] as const).indexOf(f.severity)]!;
      return { ruleId: rule.id, level: rule.defaultConfiguration.level, message: { text: `${result?.mode === 'refactor' ? 'suspected behaviour change. ' : ''}Trigger: ${f.trigger}. Impact: ${f.impact}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' }, region: { startLine: f.line, snippet: { text: f.evidence_quote } } } }],
        properties: { ...(result?.mode === 'refactor' ? {} : { origin: f.origin }), ...(result ? { mode: result.mode } : {}), confidence: f.confidence, family: f.family, provider: f.provider, model: f.model, fix: f.fix,
          ...(result?.mode === 'contract' ? { clause: f.clause ?? 'no clause cited' } : {}),
          ...(f.singleSource ? { singleSource: true } : {}),
          ...(f.reproduction ? { reproduction: { status: f.reproduction.status }, 'reproduction.status': f.reproduction.status } : {}) },
        partialFingerprints: { 'quorum/v1': createHash('sha256').update(f.file.replace(/\\/g, '/') + '\n' + f.evidence_quote.trim().replace(/\s+/g, ' ')).digest('hex') },
      };
    }), ...refactorSarif(result?.refactor), ...runtimeSarif(result?.runtime), ...(result?.ruleChecks?.results ?? []).flatMap(row => row.matches.map(match => ({
      ruleId: `quorum-rule/${row.rule.id}`, level: row.rule.severity, message: { text: row.rule.message },
      locations: [{ physicalLocation: { artifactLocation: { uri: match.file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' },
        region: { startLine: match.line, snippet: { text: match.text } } } }],
      properties: { deterministic: true },
    })))],
  }] }, null, 2);
}
