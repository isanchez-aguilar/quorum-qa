import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { assertNoLinks } from '../context/contract.js';
import { CONFIG_MAX_BYTES } from '../config/trusted-file.js';
import { atomicWrite } from '../storage/index.js';
import { UsageError, type ParsedFlags } from '../cli/args.js';
import type { Finding } from '../types/index.js';
import { expired, matchesSuppression, object, SUPPRESSIONS_FILE_NAME, validateSuppressions, type Suppression } from './index.js';

/** Bound reads as well as stat checks, so a growing file cannot bypass the cap. */
export async function readBoundedFile(file: string): Promise<string> {
  await assertNoLinks(file, path.parse(path.resolve(file)).root);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new UsageError(`${file} must be a regular file, not a symlink.`);
  if (stat.size > CONFIG_MAX_BYTES) throw new UsageError(`${file} exceeds the size limit of 8 MiB.`);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > CONFIG_MAX_BYTES) throw new UsageError(`${file} exceeds the size limit of 8 MiB.`);
    return buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}

export async function readJsonFile(file: string): Promise<unknown> {
  const text = await readBoundedFile(file);
  try { return JSON.parse(text); }
  catch { throw new UsageError(`${file} is not valid JSON.`); }
}

export async function workingSuppressions(root: string): Promise<Suppression[]> {
  try { return validateSuppressions(await readJsonFile(path.join(root, SUPPRESSIONS_FILE_NAME))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

const families = ['google', 'anthropic', 'openai', 'local'];
const findingKeys = ['severity', 'origin', 'file', 'line', 'trigger', 'impact', 'evidence_quote', 'fix', 'provider', 'model', 'family', 'confidence',
  'verified', 'confirmationFamilies', 'confirmed', 'singleSource', 'clause', 'clauseNote', 'verification_note', 'reproduction', 'possibly_related', 'suppression'];

function reportFinding(value: unknown, suppressed = false): value is Finding {
  if (!object(value) || Object.keys(value).some(key => !findingKeys.includes(key) || (key === 'suppression' && !suppressed))) return false;
  if (!['file', 'trigger', 'impact', 'evidence_quote', 'fix', 'provider', 'model'].every(key => typeof value[key] === 'string')) return false;
  if (!['BLOCKER', 'IMPORTANT', 'OPTIONAL'].includes((value.severity as string)) || !['introduced', 'pre-existing', 'improvement'].includes((value.origin as string))
    || !families.includes((value.family as string)) || !Number.isSafeInteger(value.line) || (value.line as number) < 1
    || typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) return false;
  for (const key of ['verified', 'confirmed', 'singleSource']) if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  for (const key of ['clause', 'clauseNote', 'verification_note']) if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  if (value.confirmationFamilies !== undefined && (!Array.isArray(value.confirmationFamilies) || !value.confirmationFamilies.every(f => families.includes(f)))) return false;
  if (value.reproduction !== undefined) {
    const r = value.reproduction;
    if (!object(r) || Object.keys(r).some(key => !['path', 'content', 'expect', 'status', 'failureReason'].includes(key))
      || !['path', 'content', 'expect'].every(key => typeof r[key] === 'string')
      || (r.status !== undefined && !['pending', 'reproduced', 'not-reproduced', 'rejected', 'unproven'].includes((r.status as string)))
      || (r.failureReason !== undefined && typeof r.failureReason !== 'string')) return false;
  }
  if (value.possibly_related !== undefined && (!Array.isArray(value.possibly_related) || !value.possibly_related.every(item => object(item)
    && Object.keys(item).every(key => ['provider', 'model', 'line', 'similarity'].includes(key)) && typeof item.provider === 'string' && typeof item.model === 'string'
    && Number.isSafeInteger(item.line) && (item.line as number) > 0 && typeof item.similarity === 'number' && item.similarity >= 0 && item.similarity <= 1))) return false;
  if (suppressed && (!object(value.suppression) || Object.keys(value.suppression).some(key => !['id', 'reason'].includes(key))
    || typeof value.suppression.id !== 'string' || typeof value.suppression.reason !== 'string')) return false;
  // Validate the path and quote using the same boundary as the destination file. Reports can have multiline quotes.
  try { validateSuppressions({ suppressions: [{ file: value.file, quote: (value.evidence_quote as string).trim().replace(/\s+/g, ' ').slice(0, 400), reason: 'Report validation' }] }); }
  catch { return false; }
  return true;
}

/** Accept Quorum review envelopes, never arbitrary provider JSON or a bare finding array. */
export function validateSuppressionReport(raw: unknown): { findings: Finding[]; unconfirmed: Finding[]; suppressed: Finding[] } {
  const fail = (): never => { throw new UsageError('Invalid Quorum report JSON. Use the complete output of review --json.'); };
  const keys = ['runId', 'timestamp', 'mode', 'range', 'headSha', 'baseSha', 'checks', 'ruleChecks', 'criteria', 'inventory', 'families', 'exitCode',
    'findings', 'unconfirmed', 'suppressed', 'pointsAtChange', 'rejectedOnConfirmation', 'warnings', 'errors', 'coverage', 'calls', 'ledgerDraft', 'cacheHits',
    'reviewedFamilies', 'related', 'durations', 'checksParallel', 'callBudget', 'refactor', 'runtime', 'clauses', 'contractFiles', 'copyFiles'];
  if (!object(raw) || Object.keys(raw).some(key => !keys.includes(key))) return fail();
  if (!['runId', 'timestamp', 'range', 'headSha', 'baseSha'].every(key => typeof raw[key] === 'string' && raw[key] !== '')
    || !Number.isFinite(Date.parse(raw.timestamp as string)) || !['feature', 'redesign', 'bughunt', 'contract', 'refactor', 'runtime'].includes((raw.mode as string))
    || ![0, 1, 2].includes(raw.exitCode as number) || !Number.isSafeInteger(raw.cacheHits) || (raw.cacheHits as number) < 0) return fail();
  for (const key of ['criteria', 'inventory', 'warnings', 'errors', 'families', 'reviewedFamilies']) {
    if (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(item => typeof item === 'string')) return fail();
  }
  if (!(raw.families as string[]).every(f => families.includes(f)) || !(raw.reviewedFamilies as string[]).every(f => families.includes(f))) return fail();
  if (!object(raw.coverage) || typeof raw.coverage.complete !== 'boolean'
    || !['reviewedFiles', 'skippedFiles', 'truncatedHunks', 'binaryFiles', 'lostFindings'].every(key => Array.isArray(raw.coverage && (raw.coverage as Record<string, unknown>)[key]))
    || !(raw.checks === null || object(raw.checks)) || !Array.isArray(raw.calls) || !Array.isArray(raw.ledgerDraft)) return fail();
  for (const key of ['findings', 'unconfirmed']) if (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every(item => reportFinding(item))) return fail();
  if (raw.suppressed !== undefined && (!Array.isArray(raw.suppressed) || !raw.suppressed.every(item => reportFinding(item, true)))) return fail();
  return { findings: raw.findings as Finding[], unconfirmed: raw.unconfirmed as Finding[], suppressed: (raw.suppressed ?? []) as Finding[] };
}

export async function suppressCommand(positionals: string[], flags: ParsedFlags, root: string, today: string): Promise<string> {
  const [command, id] = positionals;
  const allowed = command === 'add' ? ['from', 'finding', 'reason', 'expires'] : command === 'list' ? ['from'] : [];
  if (!['add', 'list', 'remove'].includes(command ?? '') || positionals.length !== (command === 'remove' ? 2 : 1)) throw new UsageError('Use quorum suppress add|list|remove <id>.');
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new UsageError(`Option ${key} is not supported by suppress ${command}.`);
  let entries = await workingSuppressions(root);
  const report = flags.from ? validateSuppressionReport(await readJsonFile(path.resolve(root, flags.from))) : undefined;
  if (command === 'list') return entries.map(entry => {
    const status = expired(entry, today) ? 'expired' : report && ![...report.findings, ...report.unconfirmed, ...report.suppressed].some(f => matchesSuppression(f, entry, today)) ? 'unused' : 'active';
    return `${entry.id} ${status} ${entry.file} — ${entry.reason}`;
  }).join('\n') + (entries.length ? '\n' : 'No suppressions.\n');
  if (command === 'add') {
    if (!report || !flags.finding || !flags.reason || !/^[1-9]\d*$/.test(flags.finding) || !Number.isSafeInteger(Number(flags.finding))) throw new UsageError('suppress add requires --from <report.json>, --finding <1-based integer>, and --reason <text>.');
    const finding = [...report.findings, ...report.unconfirmed][Number(flags.finding) - 1];
    if (!finding) throw new UsageError('Finding number is outside the report.');
    const quote = finding.evidence_quote.trim().replace(/\s+/g, ' ').slice(0, 400);
    entries = validateSuppressions({ suppressions: [...entries, { file: finding.file, quote, reason: flags.reason.trim(), created: today,
      ...(flags.expires !== undefined ? { expires: flags.expires } : {}) }] });
  } else {
    if (!entries.some(entry => entry.id === id)) throw new UsageError(`Unknown suppression id: ${id}`);
    entries = entries.filter(entry => entry.id !== id);
  }
  await atomicWrite(path.join(root, SUPPRESSIONS_FILE_NAME), JSON.stringify({ suppressions: entries }, null, 2) + '\n', root);
  return `${command === 'add' ? `Added suppression ${entries.at(-1)!.id}` : `Removed suppression ${id}`} in ${SUPPRESSIONS_FILE_NAME}. Commit this file to apply it to future reviews.\n`;
}
