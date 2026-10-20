import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../context/git.js';
import { CommandOutputLimitError, runCommand } from '../process/runner.js';
import type { CommandRunner } from '../types/index.js';
import { tokenize } from '../verifier/semantic.js';
import { safeMatch } from './index.js';
import type { RuleLine } from './index.js';

interface HistoryFinding {
  runId: string;
  timestamp: string;
  file: string;
  line: number;
  severity: string;
  origin: string;
  trigger: string;
  evidence_quote: string;
}

export interface RuleCandidate {
  shape: string;
  count: number;
  runs: string[];
  files: string[];
  trigger: string;
  example: string;
  sites: Array<{ file: string; line: number }>;
  status: 'candidate' | 'no safe pattern';
  pattern?: string;
  noise?: {
    matches: number; knownSites: number; noisy: boolean;
    filesCapped: boolean; matchesCapped: boolean; scanCapped: boolean; timedOut: boolean; skippedLongLines: number;
  };
  rule?: { id: string; pattern: string; message: string; severity: 'warning' };
}

export interface ProposalReport {
  findingsSeen: number;
  skippedMultiline: number;
  invalidEntries: number;
  min: number;
  days: number;
  clusters: RuleCandidate[];
}

interface ShapeToken { text: string; abstract: boolean; word: boolean }
export function evidenceShape(quote: string): { shape: string; tokens: ShapeToken[] } | undefined {
  if (/[\r\n]/.test(quote)) return undefined;
  const scanned = tokenize(quote, true);
  if (scanned.length < 3 || scanned.length > 40) return undefined;
  const tokens = scanned.map(token => {
    const abstract = token.kind === 'ident' || token.kind === 'string' || token.kind === 'number';
    const text = token.kind === 'ident' ? 'ID' : token.kind === 'string' ? 'STR'
      : token.kind === 'number' ? 'NUM' : token.kind === 'template' ? `template:${token.text}` : token.text;
    return { text, abstract, word: token.kind === 'ident' || token.kind === 'word' || token.kind === 'number' };
  });
  return { shape: tokens.map(token => token.text).join(' '), tokens };
}

function patternFor(tokens: ShapeToken[]): string {
  return tokens.map((token, index) => {
    const spacing = index === 0 ? '' : token.word && tokens[index - 1]!.word ? '\\s+' : '\\s*';
    const value = token.abstract && token.text === 'ID' ? '[A-Za-z_$][\\w$]*'
      : token.abstract && token.text === 'STR' ? `(?:'[^'"\\r\\n]*'|"[^'"\\r\\n]*")`
      : token.abstract && token.text === 'NUM' ? '\\d+(?:\\.\\d+)?'
      : token.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return spacing + value;
  }).join('');
}

function isFinding(value: unknown): value is HistoryFinding {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['runId', 'timestamp', 'file', 'severity', 'origin', 'trigger', 'evidence_quote']
    .every(key => typeof entry[key] === 'string')
    && Number.isInteger(entry.line) && (entry.line as number) > 0;
}

async function headLines(root: string, runner: CommandRunner): Promise<{ lines: RuleLine[]; filesCapped: boolean; scanCapped: boolean }> {
  let listing;
  let listingCapped = false;
  try { listing = await git(['ls-tree', '-r', '-l', '-z', 'HEAD'], root, runner); }
  catch (error) {
    if (!(error instanceof CommandOutputLimitError) || error.exitCode !== 0) throw error;
    // A prefix can end inside a path. Only NUL-terminated records are trustworthy.
    listing = { exitCode: 0, stdout: error.stdout.slice(0, error.stdout.lastIndexOf('\0') + 1), stderr: error.stderr };
    listingCapped = true;
  }
  if (listing.exitCode !== 0) throw new Error(`Cannot inspect HEAD for rule noise: ${listing.stderr}`);
  const files = listing.stdout.split('\0').flatMap(record => {
    const match = /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(record);
    return match ? [{ oid: match[1]!, size: Number(match[2]), file: match[3]! }] : [];
  });
  const selected = files.slice(0, 3000);
  const lines: RuleLine[] = [];
  let bytes = 0;
  let scanCapped = false;
  // Each blob comes from HEAD, never from the potentially modified working tree.
  scan: for (let start = 0; start < selected.length; start += 16) {
    const batch = await Promise.all(selected.slice(start, start + 16).map(async file => {
      if (file.size > 256 * 1024) return undefined;
      const result = await git(['cat-file', 'blob', file.oid], root, runner);
      if (result.exitCode !== 0) throw new Error(`Cannot read HEAD file ${file.file}: ${result.stderr}`);
      const size = Buffer.byteLength(result.stdout);
      if (result.stdout.includes('\0') || size > 256 * 1024) return undefined;
      return { file: file.file, text: result.stdout, size };
    }));
    for (const blob of batch) {
      if (!blob) continue;
      if (bytes + blob.size > 16 * 1024 * 1024) { scanCapped = true; break scan; }
      bytes += blob.size;
      let at = 0;
      let line = 1;
      while (at <= blob.text.length) {
        if (lines.length >= 100_000) { scanCapped = true; break scan; }
        const newline = blob.text.indexOf('\n', at);
        const end = newline === -1 ? blob.text.length : newline;
        const text = blob.text.slice(at, end).replace(/\r$/, '');
        lines.push({ file: blob.file, line: line++, text });
        if (newline === -1) break;
        at = newline + 1;
      }
    }
  }
  return { lines, filesCapped: listingCapped || files.length > 3000, scanCapped };
}

export async function proposeRules(
  root: string,
  options: { min?: number; days?: number; now?: Date; runner?: CommandRunner } = {},
): Promise<ProposalReport> {
  const min = options.min ?? 3;
  const days = options.days ?? 90;
  if (!Number.isInteger(min) || min < 2 || min > 50) throw new Error('--min must be an integer from 2 to 50');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('--days must be an integer from 1 to 3650');
  const now = (options.now ?? new Date()).getTime();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const report: ProposalReport = { findingsSeen: 0, skippedMultiline: 0, invalidEntries: 0, min, days, clusters: [] };
  let history: string;
  try { history = await readFile(path.join(root, '.quorum', 'findings.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report; throw error; }
  const groups = new Map<string, { shape: string; tokens: ShapeToken[]; members: HistoryFinding[] }>();
  for (const row of history.split('\n')) {
    if (!row.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(row); } catch { report.invalidEntries++; continue; }
    if (!isFinding(value) || !Number.isFinite(Date.parse(value.timestamp))) { report.invalidEntries++; continue; }
    const time = Date.parse(value.timestamp);
    if (time < cutoff || time > now) continue;
    report.findingsSeen++;
    if (/[\r\n]/.test(value.evidence_quote)) { report.skippedMultiline++; continue; }
    if (value.severity === 'OPTIONAL' || value.origin === 'improvement') continue;
    if (value.severity !== 'IMPORTANT' && value.severity !== 'BLOCKER') continue;
    const shape = evidenceShape(value.evidence_quote);
    if (!shape) continue;
    // Distinguish literal keyword ID from an abstract identifier with the same display text.
    const key = JSON.stringify(shape.tokens);
    const group = groups.get(key) ?? { ...shape, members: [] };
    group.members.push(value);
    groups.set(key, group);
  }
  let repo: Awaited<ReturnType<typeof headLines>> | undefined;
  for (const group of groups.values()) {
    const members = group.members;
    const runs = [...new Set(members.map(member => member.runId))];
    const files = [...new Set(members.map(member => member.file))];
    if (members.length < min || runs.length < 2 || files.length < 2) continue;
    const triggers = new Map<string, number>();
    for (const member of members) triggers.set(member.trigger, (triggers.get(member.trigger) ?? 0) + 1);
    const trigger = [...triggers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const candidate: RuleCandidate = {
      shape: group.shape, count: members.length, runs, files, trigger, example: members[0]!.evidence_quote,
      sites: members.map(member => ({ file: member.file, line: member.line })), status: 'no safe pattern',
    };
    report.clusters.push(candidate);
    const pattern = patternFor(group.tokens);
    if (pattern.length > 500 || group.tokens.some(token => token.text.startsWith('template:'))) continue;
    // An ASCII identifier/decimal abstraction must cover the whole quote, not merely the
    // ASCII prefix of a Unicode identifier or the leading zero of a hexadecimal literal.
    const verification = await safeMatch(`^\\s*(?:${pattern})\\s*$`, '', members.map(member => ({
      file: member.file, line: member.line, text: member.evidence_quote,
    })), { maxMatches: members.length });
    if (verification.timedOut || verification.totalMatches !== members.length) continue;
    candidate.status = 'candidate';
    candidate.pattern = pattern;
    repo ??= await headLines(root, options.runner ?? runCommand);
    const noise = await safeMatch(pattern, '', repo.lines, { maxMatches: 2000, stopAfterMatches: 2000 });
    const knownSites = noise.matches.filter(match => members.some(member =>
      member.file === match.file && Math.abs(member.line - match.line) <= 2)).length;
    candidate.noise = {
      matches: noise.totalMatches, knownSites,
      noisy: knownSites === 0 || noise.totalMatches > 50 || noise.timedOut || repo.scanCapped || repo.filesCapped,
      filesCapped: repo.filesCapped, matchesCapped: noise.totalMatches >= 2000, scanCapped: repo.scanCapped,
      timedOut: noise.timedOut, skippedLongLines: noise.skippedLongLines,
    };
    candidate.rule = {
      id: `mined-${createHash('sha256').update(group.shape).digest('hex').slice(0, 12)}`,
      pattern, message: trigger.slice(0, 300), severity: 'warning',
    };
  }
  return report;
}

export function renderRuleProposals(report: ProposalReport): string {
  const output = [
    '# Proposed rules', '',
    `${report.findingsSeen} findings seen; ${report.skippedMultiline} multi-line quotes skipped; ${report.invalidEntries} invalid history entries skipped.`,
    '',
  ];
  if (!report.clusters.length) output.push('No qualifying clusters.');
  for (const candidate of report.clusters) {
    output.push(`## ${candidate.rule?.id ?? 'No safe pattern'}`, '',
      `Shape: ${JSON.stringify(candidate.shape)}`, '',
      `${candidate.count} findings from ${candidate.runs.length} runs and ${candidate.files.length} files.`,
      `Runs: ${candidate.runs.join(', ')}`, `Files: ${candidate.files.join(', ')}`, '',
      `Common trigger: ${candidate.trigger}`, `Example quote: ${JSON.stringify(candidate.example)}`, '',
      ...candidate.sites.map(site => `- ${site.file}:${site.line}`), '');
    if (!candidate.rule || !candidate.noise) { output.push('no safe pattern', ''); continue; }
    const noise = candidate.noise;
    output.push(`Regex: ${JSON.stringify(candidate.pattern)}`, '',
      `matches in repo: ${noise.matches}, of which ${noise.knownSites} are known finding sites.`,
      ...(noise.noisy ? ['noisy: review before enabling'] : []),
      ...(noise.filesCapped ? ['Noise scan incomplete: 3000 tracked files or listing output limit reached.'] : []),
      ...(noise.matchesCapped ? ['Noise scan capped at 2000 matches.'] : []),
      ...(noise.scanCapped ? ['Noise scan incomplete: aggregate limit of 100000 lines or 16 MiB reached.'] : []),
      ...(noise.skippedLongLines ? [`${noise.skippedLongLines} lines longer than 2000 characters skipped.`] : []),
      ...(noise.timedOut ? ['Noise scan timed out; estimate is incomplete.'] : []),
      '', 'Ready-to-paste quorum.rules.json entry (human review required):', '',
      '```json', JSON.stringify(candidate.rule, null, 2), '```', '');
  }
  return output.join('\n');
}
