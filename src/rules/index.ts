import { Worker } from 'node:worker_threads';
import { ConfigError } from '../config/schema.js';
import { cleanDiff, diffSectionPath } from '../context/diff.js';
import { git, validateRef } from '../context/git.js';
import { matchesTestGlob } from '../reproduce/write.js';
import type { CommandRunner, ReviewContext } from '../types/index.js';

export const RULES_FILE_NAME = 'quorum.rules.json';
export interface Rule {
  id: string;
  pattern: string;
  flags?: string;
  message: string;
  severity: 'error' | 'warning';
  paths?: string[];
}
export interface RuleLine { file: string; line: number; text: string }
export interface MatchResult {
  matches: RuleLine[];
  totalMatches: number;
  timedOut: boolean;
  skippedLongLines: number;
}
export interface RuleResult extends MatchResult { rule: Rule }
export interface RuleRun { passed: boolean; results: RuleResult[]; notes: string[] }

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateRules(raw: unknown): Rule[] {
  const issues: string[] = [];
  const unknownKeys = (value: Record<string, unknown>, keys: string[], at: string) => {
    for (const key of Object.keys(value)) if (!keys.includes(key)) issues.push(`unknown key "${key}" in ${at}`);
  };
  if (!object(raw)) throw new ConfigError(['rules file must be an object'], 'Invalid quorum rules');
  unknownKeys(raw, ['rules'], 'rules file');
  if (!Array.isArray(raw.rules)) issues.push('rules must be an array');
  else {
    if (raw.rules.length > 200) issues.push('rules must contain at most 200 entries');
    const ids = new Set<string>();
    raw.rules.forEach((rule: unknown, index) => {
      const at = `rules[${index}]`;
      if (!object(rule)) { issues.push(`${at} must be an object`); return; }
      unknownKeys(rule, ['id', 'pattern', 'flags', 'message', 'severity', 'paths'], at);
      if (typeof rule.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rule.id)) {
        issues.push(`${at}.id must match ^[a-z0-9][a-z0-9-]{0,63}$`);
      } else {
        if (ids.has(rule.id)) issues.push(`${at}.id must be unique: ${rule.id}`);
        ids.add(rule.id);
      }
      if (rule.flags !== undefined && rule.flags !== '' && rule.flags !== 'i') issues.push(`${at}.flags only permits "i"`);
      if (typeof rule.pattern !== 'string' || rule.pattern.length > 500) issues.push(`${at}.pattern must be a string of at most 500 characters`);
      else {
        try { new RegExp(rule.pattern, rule.flags === 'i' ? 'i' : ''); }
        catch { issues.push(`${at}.pattern must compile as a regular expression`); }
      }
      if (typeof rule.message !== 'string' || rule.message.length > 300) issues.push(`${at}.message must be a string of at most 300 characters`);
      if (rule.severity !== 'error' && rule.severity !== 'warning') issues.push(`${at}.severity must be "error" or "warning"`);
      if (rule.paths !== undefined && (!Array.isArray(rule.paths) || !rule.paths.every(item => typeof item === 'string' && item.trim() !== ''))) {
        issues.push(`${at}.paths must be an array of non-empty strings`);
      }
    });
  }
  if (issues.length) throw new ConfigError(issues, 'Invalid quorum rules');
  return (raw.rules as Rule[]).map(rule => ({ ...rule, ...(rule.paths ? { paths: [...rule.paths] } : {}) }));
}

/** The caller selects merge-base (default) or head only after explicit trust opt-in. */
export async function loadRulesAt(commit: string, root: string, runner: CommandRunner): Promise<Rule[]> {
  validateRef(commit, false);
  const listing = await git(['ls-tree', '-z', commit, '--', RULES_FILE_NAME], root, runner);
  if (listing.exitCode !== 0) throw new Error(`Cannot load rules: ${listing.stderr}`);
  if (!listing.stdout) return [];
  // A git symlink (mode 120000) would make `git show` return its target path as text.
  if (!/^100(?:644|755) blob /.test(listing.stdout)) {
    throw new ConfigError(['quorum.rules.json must be a regular file, not a symlink'], 'Invalid quorum rules');
  }
  const result = await git(['show', `${commit}:${RULES_FILE_NAME}`], root, runner);
  if (result.exitCode !== 0) throw new Error(`Cannot load rules: ${result.stderr}`);
  let raw: unknown;
  try { raw = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new ConfigError(['quorum.rules.json is not valid JSON'], 'Invalid quorum rules'); }
  return validateRules(raw);
}

/** No pattern is executed on the main thread. Each invocation has one hard deadline. */
export async function safeMatch(
  pattern: string, flags: string, lines: RuleLine[],
  { maxMatches = 50, stopAfterMatches = Number.MAX_SAFE_INTEGER }: { maxMatches?: number; stopAfterMatches?: number } = {},
): Promise<MatchResult> {
  const bounded = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!bounded(maxMatches) || !bounded(stopAfterMatches)) throw new Error('Match limits must be positive safe integers');
  const skippedLongLines = lines.filter(line => line.text.length > 2000).length;
  const eligible = lines.filter(line => line.text.length <= 2000);
  const empty = { matches: [], totalMatches: 0, timedOut: false, skippedLongLines };
  if (!eligible.length) return empty;
  // Limits are validated numeric constants in trusted worker code. Only the pattern, flags and
  // lines cross the worker-data boundary; no checkout paths, credentials or configuration do.
  const source = `
    const { workerData, parentPort } = require('node:worker_threads');
    const regex = new RegExp(workerData.pattern, workerData.flags);
    const matches = [];
    let totalMatches = 0;
    for (const line of workerData.lines) {
      regex.lastIndex = 0;
      if (!regex.test(line.text)) continue;
      totalMatches++;
      if (matches.length < ${maxMatches}) matches.push(line);
      if (totalMatches >= ${stopAfterMatches}) break;
    }
    parentPort.postMessage({ matches, totalMatches });
  `;
  return new Promise<MatchResult>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { pattern, flags, lines: eligible } });
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      void worker.terminate().then(() => resolve({ ...empty, timedOut: true }), reject);
    }, 1000);
    worker.once('message', (message: { matches: RuleLine[]; totalMatches: number }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolve({ ...empty, ...message }), reject);
    });
    worker.once('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`Rule worker exited without a result (${code})`));
    });
  });
}

export function addedLines(diff: string): RuleLine[] {
  const output: RuleLine[] = [];
  for (const section of cleanDiff(diff).diff.split(/(?=^diff --git )/m)) {
    const file = diffSectionPath(section);
    if (!file || section.includes('\0')) continue;
    let line = 0;
    let inHunk = false;
    for (const text of section.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
      if (!inHunk) continue;
      if (text.startsWith('+')) { output.push({ file, line, text: text.slice(1) }); line++; }
      else if (text.startsWith(' ')) line++;
      else if (!text.startsWith('-') && !text.startsWith('\\')) inHunk = false;
    }
  }
  return output;
}

export async function runRules(rules: Rule[], context: Pick<ReviewContext, 'diff'>): Promise<RuleRun> {
  const lines = addedLines(context.diff);
  const results: RuleResult[] = [];
  const notes: string[] = [];
  for (const rule of rules) {
    let result: MatchResult;
    try {
      result = await safeMatch(rule.pattern, rule.flags ?? '', lines.filter(line =>
        rule.paths === undefined || rule.paths.some(glob => matchesTestGlob(line.file, glob))));
    } catch (error) {
      // A worker that dies (out of memory, internal error) must cost one rule, not the whole review.
      notes.push(`rule ${rule.id} failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}); skipped`);
      results.push({ rule, matches: [], totalMatches: 0, timedOut: true, skippedLongLines: 0 });
      continue;
    }
    results.push({ rule, ...result });
    if (result.timedOut) notes.push(`rule ${rule.id} timed out; skipped`);
    if (result.skippedLongLines) notes.push(`rule ${rule.id}: skipped ${result.skippedLongLines} lines longer than 2000 characters`);
  }
  return { results, notes, passed: results.every(result => result.rule.severity !== 'error' || result.totalMatches === 0) };
}
