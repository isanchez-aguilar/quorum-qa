import path from 'node:path';
import { ConfigError } from '../config/schema.js';
import { mergeBase, revParse } from '../context/git.js';
import type { DoctorCheck } from '../doctor/checks.js';
import type { CommandRunner } from '../types/index.js';
import { readBoundedFile, readJsonFile } from './commands.js';
import { expired, loadSuppressionsAt, normalizeQuote, SUPPRESSIONS_FILE_NAME, suppressionId, validateSuppressions } from './index.js';

export async function checkSuppressions(root: string, runner: CommandRunner, base = 'origin/main', today = new Date().toISOString().slice(0, 10)): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let entries;
  try {
    entries = validateSuppressions(await readJsonFile(path.join(root, SUPPRESSIONS_FILE_NAME)));
    checks.push({ id: 'suppressions', status: 'PASS', message: `${SUPPRESSIONS_FILE_NAME} is valid (${entries.length} suppressions).` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ id: 'suppressions', status: 'WARN', message: `${SUPPRESSIONS_FILE_NAME}: ${error instanceof ConfigError ? error.issues[0] : String(error)}` }];
  }
  const files = new Map<string, string | undefined>();
  for (const entry of entries) {
    if (expired(entry, today)) {
      checks.push({ id: `suppressions.${entry.id}`, status: 'WARN', message: `suppression ${entry.id} expired (${entry.expires})` });
      continue;
    }
    if (!files.has(entry.file)) {
      try { files.set(entry.file, normalizeQuote(await readBoundedFile(path.join(root, entry.file)))); }
      catch (error) {
        files.set(entry.file, undefined);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') checks.push({ id: `suppressions.${entry.id}.source`, status: 'WARN', message: `Cannot inspect suppression ${entry.id}: ${String(error)}` });
      }
    }
    const quote = normalizeQuote(entry.quote);
    if (quote.length < 12 || !files.get(entry.file)?.includes(quote)) checks.push({ id: `suppressions.${entry.id}`, status: 'WARN',
      message: `unused suppression ${entry.id}: quote no longer appears in ${entry.file}; changed code stops matching and findings return.` });
  }
  try {
    const commit = await mergeBase(await revParse(base, root, runner), await revParse('HEAD', root, runner), root, runner);
    const trusted = new Set((await loadSuppressionsAt(commit, root, runner)).map(entry => suppressionId(entry.file, entry.quote)));
    const added = entries.filter(entry => !trusted.has(suppressionId(entry.file, entry.quote)));
    checks.push({ id: 'suppressions.branch', status: 'PASS', message: `Info: ${added.length} entries added in the current branch${added.length ? `: ${added.map(entry => entry.id).join(', ')}` : ''}; new entries apply after merging (or --trust-head-config for committed HEAD).` });
  } catch { checks.push({ id: 'suppressions.branch', status: 'WARN', message: `Cannot determine entries added in the current branch: base ${base} is unavailable or invalid.` }); }
  return checks;
}
