import { createHash } from 'node:crypto';
import path from 'node:path';
import { ConfigError } from '../config/schema.js';
import { loadTrustedJson } from '../config/trusted-file.js';
import { git } from '../context/git.js';
import type { CommandRunner, Finding } from '../types/index.js';

export const SUPPRESSIONS_FILE_NAME = 'quorum.suppress.json';
export interface Suppression { id: string; file: string; quote: string; reason: string; created?: string; expires?: string }
export interface SuppressedFinding extends Finding { suppression: { id: string; reason: string } }
export const normalizePath = (file: string): string => path.posix.normalize(file.replace(/\\/g, '/'));
// The verifier exports token comparison, not a whitespace/quote normalizer. Keep this literal:
// do not adopt its identifier typo tolerance or ignore operators when matching a human decision.
export const normalizeQuote = (quote: string): string => quote.trim().replace(/\s+/g, ' ').replace(/['"\u2018\u2019\u201c\u201d]/g, '"');
export const suppressionId = (file: string, quote: string): string =>
  createHash('sha256').update(normalizePath(file) + '\n' + normalizeQuote(quote)).digest('hex').slice(0, 10);
export const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const controls = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
export const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const expired = (entry: Suppression, today: string): boolean => entry.expires !== undefined && entry.expires < today;

export function validateSuppressions(raw: unknown): Suppression[] {
  const issues: string[] = [];
  const keys = (value: Record<string, unknown>, allowed: string[], at: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`unknown key "${key}" in ${at}`);
  };
  if (!object(raw)) throw new ConfigError(['suppressions file must be an object'], 'Invalid quorum suppressions');
  keys(raw, ['suppressions'], 'suppressions file');
  const entries: Suppression[] = []; const ids = new Set<string>(); const fingerprints = new Set<string>();
  if (!Array.isArray(raw.suppressions)) issues.push('suppressions must be an array');
  else {
    if (raw.suppressions.length > 400) issues.push('suppressions must contain at most 400 entries');
    raw.suppressions.forEach((value: unknown, index) => {
      const at = `suppressions[${index}]`;
      if (!object(value)) { issues.push(`${at} must be an object`); return; }
      keys(value, ['id', 'file', 'quote', 'reason', 'created', 'expires'], at);
      const before = issues.length;
      for (const [key, min, max] of [['file', 1, 2000], ['quote', 1, 2000], ['reason', 10, 500], ['id', 1, 2000]] as const) {
        if (key === 'id' && value.id === undefined) continue;
        const text = value[key];
        if (typeof text !== 'string' || text.trim().length < min || text.length > max || controls.test(text)) {
          issues.push(`${at}.${key} must be control-character free, ${min}..${max} characters`);
        }
      }
      if (typeof value.file === 'string') {
        const file = normalizePath(value.file);
        if (file === '.' || file === '..' || file.startsWith('../') || file.startsWith('/') || /^[a-z]:/i.test(file)) issues.push(`${at}.file must be a repository-relative path`);
      }
      for (const key of ['created', 'expires']) if (value[key] !== undefined && !validDate(value[key])) issues.push(`${at}.${key} must be an ISO date YYYY-MM-DD`);
      if (issues.length !== before) return;
      const fingerprint = suppressionId(value.file as string, value.quote as string);
      const id = value.id as string | undefined ?? fingerprint;
      if (ids.has(id)) issues.push(`${at}.id must be unique: ${id}`);
      if (fingerprints.has(fingerprint)) issues.push(`${at} has a duplicate fingerprint`);
      ids.add(id); fingerprints.add(fingerprint);
      entries.push({ id, file: normalizePath(value.file as string), quote: value.quote as string, reason: value.reason as string,
        ...(value.created !== undefined ? { created: value.created as string } : {}), ...(value.expires !== undefined ? { expires: value.expires as string } : {}) });
    });
  }
  if (issues.length) throw new ConfigError(issues, 'Invalid quorum suppressions');
  return entries;
}

export async function loadSuppressionsAt(commit: string, root: string, runner: CommandRunner): Promise<Suppression[]> {
  const raw = await loadTrustedJson(commit, SUPPRESSIONS_FILE_NAME, root, runner);
  return raw === undefined ? [] : validateSuppressions(raw);
}

export function matchesSuppression(finding: Pick<Finding, 'file' | 'evidence_quote'>, entry: Suppression, today: string): boolean {
  if (normalizePath(finding.file) !== normalizePath(entry.file) || expired(entry, today)) return false;
  const a = normalizeQuote(finding.evidence_quote); const b = normalizeQuote(entry.quote);
  return Math.min(a.length, b.length) >= 12 && (a.includes(b) || b.includes(a));
}

export function applySuppressions(findings: Finding[], entries: Suppression[], today: string): { active: Finding[]; suppressed: SuppressedFinding[]; warnings: string[] } {
  const active: Finding[] = []; const suppressed: SuppressedFinding[] = [];
  const warnings = entries.filter(entry => expired(entry, today)).map(entry => `suppression ${entry.id} expired (${entry.expires})`);
  for (const finding of findings) {
    const entry = entries.find(entry => matchesSuppression(finding, entry, today));
    if (!entry) { active.push(finding); continue; }
    if (finding.severity === 'BLOCKER' && finding.reproduction?.status === 'reproduced' && new Set(finding.confirmationFamilies ?? []).size >= 2) {
      warnings.push(`suppression ${entry.id} ignored: reproduced BLOCKER`); active.push(finding);
    } else suppressed.push({ ...finding, suppression: { id: entry.id, reason: entry.reason } });
  }
  return { active, suppressed, warnings };
}

/** Compare blobs, including reason/date edits; invalid HEAD content cannot invalidate trusted entries. */
export async function suppressionChanges(base: string, head: string, root: string, runner: CommandRunner): Promise<string[]> {
  if (base === head) return [];
  const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', base, head, '--', SUPPRESSIONS_FILE_NAME], root, runner);
  if (diff.exitCode !== 0) throw new Error(`Cannot compare suppressions: ${diff.stderr}`);
  if (!diff.stdout.trim()) return [];
  let count: number | undefined;
  try {
    const before = new Set((await loadSuppressionsAt(base, root, runner)).map(entry => suppressionId(entry.file, entry.quote)));
    count = (await loadSuppressionsAt(head, root, runner)).filter(entry => !before.has(suppressionId(entry.file, entry.quote))).length;
  } catch { /* Malformed untrusted changes are reported, never applied. */ }
  return [`${SUPPRESSIONS_FILE_NAME} changed in this change; its new entries are not applied until merged (${count === undefined ? 'added entries unavailable: invalid file' : `${count} added entries`})`];
}
