import { createHash } from 'node:crypto';
import type { CascadeResult } from '../cascade/index.js';
import type { runDeterministicChecks } from '../checks/index.js';
import type { Family, Finding } from '../types/index.js';

export interface ReviewResult extends CascadeResult {
  runId: string;
  timestamp: string;
  mode: 'feature' | 'redesign';
  range: string;
  headSha: string;
  baseSha: string;
  checks: Awaited<ReturnType<typeof runDeterministicChecks>> | null;
  criteria: string[];
  inventory: string[];
  families: Family[];
  exitCode: number;
}
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/</g, '&lt;');
const details = (findings: Finding[]) => findings.length ? findings.map((f, i) => [
  `### ${i + 1}. ${cell(f.trigger)}`, `- **Location:** ${cell(f.file)}:${f.line} (${f.origin})`,
  `- **Severity:** ${f.severity} · **Confidence:** ${f.confidence} · ${f.provider}:${f.model} (${f.family})`,
  `- **Impact:** ${cell(f.impact)}`, `- **Evidence Quote:** ${cell(f.evidence_quote)}`,
  `- **Proposed Fix:** ${cell(f.fix)}`, f.severity === 'BLOCKER' ? '- **Reproduction Proof:** unproven (M6 not implemented).' : '',
].filter(Boolean).join('\n')).join('\n\n') : 'None.';

export function generateMarkdownReport(result: ReviewResult): string {
  const { coverage } = result;
  const all = [...result.findings, ...result.unconfirmed.filter(f => f.family !== 'local')];
  return [
    '# Quorum QA Review Report', `**Run ID:** ${result.runId} · **Mode:** ${result.mode} · **Diff:** ${cell(result.range)}`,
    `**Time:** ${result.timestamp} · Provider duration: ${(result.ledgerDraft.reduce((sum, row) => sum + row.durationMs, 0) / 1000).toFixed(2)}s`,
    `**Status:** exit ${result.exitCode} · ${all.filter(f => f.severity === 'BLOCKER').length} Blockers Found · Cache hits: ${result.cacheHits}`,
    '## Executive Summary', '| Category | Introduced | Pre-existing | Improvement | Total |', '|---|---:|---:|---:|---:|',
    ...(['BLOCKER', 'IMPORTANT', 'OPTIONAL'] as const).map(severity => {
      const rows = all.filter(f => f.severity === severity);
      return `| ${severity} | ${['introduced', 'pre-existing', 'improvement'].map(origin => rows.filter(f => f.origin === origin).length).join(' | ')} | ${rows.length} |`;
    }),
    `| Total | ${['introduced', 'pre-existing', 'improvement'].map(origin => all.filter(f => f.origin === origin).length).join(' | ')} | ${all.length} |`,
    '## Coverage', coverage.complete ? '**COMPLETE**' : '> **INCOMPLETE — this run did not review everything. A run without BLOCKERs exits 2.**',
    `- Reviewed: ${coverage.reviewedFiles.map(cell).join(', ') || 'none'}`,
    `- Skipped: ${coverage.skippedFiles.map(cell).join(', ') || 'none'}`,
    `- Truncated: ${coverage.truncatedHunks.map(h => `${cell(h.file)} hunk ${h.hunk}`).join(', ') || 'none'}`,
    `- Binary: ${coverage.binaryFiles.map(cell).join(', ') || 'none'} (excluded from text review)`,
    `- Lost: ${coverage.lostFindings.map(f => `${cell(f.reason)}: ${f.count}`).join(', ') || 'none'}`,
    ...(result.mode === 'feature' ? ['## Acceptance criteria', '| Criterion | Status |', '|---|---|',
      ...result.criteria.map((criterion, i) => `| AC${i + 1}: ${cell(criterion)} | ${all.some(f => new RegExp(`\\bAC${i + 1}\\b`, 'i').test(f.trigger + '\n' + f.impact)) ? 'unmet' : 'not assessed (no finding)'} |`)]
      : ['## Inventory', '| Feature | Status |', '|---|---|', ...result.inventory.map(feature => `| ${cell(feature)} | ${all.some(f => (f.trigger + '\n' + f.impact).toLowerCase().includes(feature.toLowerCase())) ? 'reported missing' : 'no finding'} |`)]),
    '## Blockers', details(result.findings.filter(f => f.severity === 'BLOCKER')),
    '## Important Findings', details(result.findings.filter(f => f.severity === 'IMPORTANT')),
    '## Optional Findings', details(result.findings.filter(f => f.severity === 'OPTIONAL')),
    '## Unconfirmed (local model only)', details(result.unconfirmed.filter(f => f.family === 'local')),
    '## Unconfirmed (other reviewers)', details(result.unconfirmed.filter(f => f.family !== 'local')),
    '## Deterministic checks', 'Checks execute the change\'s own code in a disposable HEAD worktree, just as CI does.',
    result.checks === null ? 'Skipped (--no-checks).' : result.checks.results.length ? result.checks.results.map(check =>
      `- ${cell(check.argv.join(' '))}: ${check.exitCode === 0 && !check.timedOut ? 'passed' : 'FAILED'} (exit ${check.exitCode})\n\n${cell(check.stdoutTail + '\n' + check.stderrTail)}`).join('\n') : 'No checks configured.',
    '## Warnings', [...result.warnings, ...result.errors].map(w => `- ${cell(w)}`).join('\n') || 'None.',
    '## Independence', `Families that reviewed: ${result.families.join(', ') || 'none'}.`,
    ...result.warnings.filter(w => w.startsWith('Independence')),
    '## Review Metadata', `Head: ${result.headSha} · Base: ${result.baseSha} · Calls: ${result.ledgerDraft.reduce((n, row) => n + row.callsUsed, 0)}`,
  ].join('\n\n').replace(/\|\n\n(?=\|)/g, '|\n') + '\n';
}

export function generateSarifReport(findings: Finding[]): string {
  const rules = [
    { id: 'QRM001', name: 'Blocker', shortDescription: { text: 'Blocker defect' }, defaultConfiguration: { level: 'error' } },
    { id: 'QRM002', name: 'ImportantDefect', shortDescription: { text: 'Important defect' }, defaultConfiguration: { level: 'warning' } },
    { id: 'QRM003', name: 'OptionalImprovement', shortDescription: { text: 'Optional improvement' }, defaultConfiguration: { level: 'note' } },
  ];
  return JSON.stringify({ $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{
    tool: { driver: { name: 'Quorum', version: '0.0.0', rules } },
    results: findings.map(f => {
      const rule = rules[(['BLOCKER', 'IMPORTANT', 'OPTIONAL'] as const).indexOf(f.severity)]!;
      return { ruleId: rule.id, level: rule.defaultConfiguration.level, message: { text: `Trigger: ${f.trigger}. Impact: ${f.impact}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' }, region: { startLine: f.line, snippet: { text: f.evidence_quote } } } }],
        properties: { origin: f.origin, confidence: f.confidence, family: f.family, provider: f.provider, model: f.model, fix: f.fix },
        partialFingerprints: { 'quorum/v1': createHash('sha256').update(f.file.replace(/\\/g, '/') + '\n' + f.evidence_quote.trim().replace(/\s+/g, ' ')).digest('hex') },
      };
    }),
  }] }, null, 2);
}
