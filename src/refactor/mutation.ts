import { canonicalPath } from '../paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNoLinks } from '../context/contract.js';
import { runDeterministicChecks } from '../checks/index.js';
import { machineTestCommand } from '../reproduce/command.js';
import { parseTestReport } from '../reproduce/evaluate.js';
import { matchesTestGlob } from '../reproduce/write.js';
import type { CommandRunner, TestReport } from '../types/index.js';
import { API_INPUT_BYTES } from './api.js';
import { isTestFile, sourceExtensions } from './blast.js';

export interface Mutant { file: string; line: number; column: number; operator: string; before: string; after: string; text: string }
export interface MutationEvidence {
  requested: true; candidates: number; attempted: number; killed: number; invalid: number;
  survived: Array<Pick<Mutant, 'file' | 'line' | 'operator' | 'before' | 'after'>>;
  budgetExhausted: boolean; skipped?: string[]; maxMutants: number;
}
export const emptyMutation = (maxMutants = 8): MutationEvidence => ({ requested: true, candidates: 0, attempted: 0, killed: 0, invalid: 0, survived: [], budgetExhausted: false, skipped: [], maxMutants });

function diffPath(value: string): string {
  if (!value.startsWith('"')) return value.split('\t')[0]!;
  if (!value.endsWith('"')) return '';
  const body = value.slice(1, -1); const parts: Buffer[] = [];
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
  let offset = 0;
  for (const match of body.matchAll(/\\([0-7]{1,3}|.)/g)) {
    parts.push(Buffer.from(body.slice(offset, match.index)));
    const escaped = match[1]!;
    if (/^[0-7]/.test(escaped)) parts.push(Buffer.from([parseInt(escaped, 8)]));
    else if (Object.hasOwn(escapes, escaped)) parts.push(Buffer.from(escapes[escaped]!));
    else return '';
    offset = match.index + match[0].length;
  }
  parts.push(Buffer.from(body.slice(offset)));
  return Buffer.concat(parts).toString('utf8');
}

/** Head-side additions only. Hunk counters prevent source text from becoming diff headers. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let file = ''; let line = 0; let remaining = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) { file = ''; remaining = 0; continue; }
    if (row.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
      line = Number(match?.[1] ?? 0); remaining = Number(match ? match[2] ?? 1 : 0); continue;
    }
    if (remaining) {
      if (row.startsWith('+')) { if (file) { if (!result.has(file)) result.set(file, new Set()); result.get(file)!.add(line); } line++; remaining--; }
      else if (row.startsWith(' ')) { line++; remaining--; }
      continue;
    }
    if (row.startsWith('+++ ')) {
      const name = diffPath(row.slice(4).replace(/\r$/, ''));
      file = name.startsWith('b/') ? name.slice(2) : '';
    }
  }
  return result;
}
interface Token { value: string; start: number; end: number; line: number; column: number }
const word = (c: string) => /[\w$]/.test(c);
/** Opaque literals and conservative ambiguity rejection; deliberately not a JS/TS parser. */
export function generateMutants(file: string, content: string, lines: Set<number>): Mutant[] {
  if (!sourceExtensions.includes(path.extname(file)) || isTestFile(file) || Buffer.byteLength(content) > API_INPUT_BYTES || content.includes('\0')) return [];
  const contentBytes = Buffer.byteLength(content);
  const rows = content.split('\n'); const tokens: Token[] = [];
  let line = 1; let column = 1;
  const advance = (end: number, start: number) => { for (let j = start; j < end; j++) { if (content[j] === '\n') { line++; column = 1; } else column++; } };
  for (let i = 0; i < content.length;) {
    const start = i; const c = content[i]!;
    if (/\s/.test(c)) { i++; advance(i, start); continue; }
    if (content.startsWith('//', i)) { while (i < content.length && content[i] !== '\n') i++; advance(i, start); continue; }
    if (content.startsWith('/*', i)) { const end = content.indexOf('*/', i + 2); i = end < 0 ? content.length : end + 2; advance(i, start); continue; }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i = Math.min(i + 2, content.length); continue; }
        // Nested interpolated templates require a parser: omit the remaining file conservatively.
        if (c === '`' && content.startsWith('${', i)) { i = content.length; break; }
        if (content[i++] === c) break;
      }
      tokens.push({ value: '#literal', start, end: i, line, column }); advance(i, start); continue;
    }
    if (c === '/') {
      // Treat slash ambiguities as opaque through end of line, including regex after control parens.
      while (i < content.length && content[i] !== '\n') i++;
      tokens.push({ value: '#opaque', start, end: i, line, column }); advance(i, start); continue;
    }
    if (word(c)) { i++; while (i < content.length && word(content[i]!)) i++; }
    else {
      const op = ['===', '!==', '>>>', '**=', '&&=', '||=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '=>', '<<', '>>', '?.', '**', '??'].find(op => content.startsWith(op, i));
      i += op?.length ?? 1;
    }
    tokens.push({ value: content.slice(start, i), start, end: i, line, column }); advance(i, start);
  }
  const result: Mutant[] = [];
  const skip = new Set<number>();
  rows.forEach((row, i) => {
    if (/^\s*(?:type\s|interface\s|import\s|export\s+type\b|export\b.*\bfrom\s|declare\s|@)/.test(row)) skip.add(i + 1);
  });
  const add = (token: Token, end: number, operator: string, after: string) => {
    if (end - token.start > 4096) return; // Bound compound replacements, never truncate a mutation.
    const before = content.slice(token.start, end);
    if (Buffer.byteLength(after) - Buffer.byteLength(before) + contentBytes > API_INPUT_BYTES) return;
    result.push({ file, line: token.line, column: token.column, operator, before, after,
      get text() { return content.slice(0, token.start) + after + content.slice(end); } });
  };
  const operand = (t: Token | undefined) => t !== undefined && (/^(?:[\w$]+|\)|\]|#literal)$/.test(t.value));
  const swaps: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '&&': '||', '||': '&&', true: 'false', false: 'true' };
  // Precompute generic-looking lines once, avoiding repeated suffix searches.
  const ambiguous = new Set<number>();
  rows.forEach((row, i) => { if (/[\w$]\s*</.test(row) && />/.test(row) || /\bas\b|\bsatisfies\b/.test(row)) ambiguous.add(i + 1); });
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!; const v = t.value; const prev = tokens[i - 1]; const next = tokens[i + 1];
    if (!lines.has(t.line) || skip.has(t.line) || ambiguous.has(t.line)) continue;
    if (Object.hasOwn(swaps, v)) add(t, t.end, ['true', 'false'].includes(v) ? 'boolean' : v, swaps[v]!);
    else if (['<', '<=', '>', '>='].includes(v) && operand(prev) && next && /^(?:[\w$]+|#literal)$/.test(next.value)) add(t, t.end, v, v.length === 1 ? v + '=' : v[0]!);
    else if (['+', '-'].includes(v) && operand(prev) && !['return', 'throw', 'yield', 'case', 'void', 'typeof', 'delete', 'await'].includes(prev!.value)
      && next && /^(?:[\w$]+|\(|#literal)$/.test(next.value)) add(t, t.end, 'arithmetic', v === '+' ? '-' : '+');
    else if (/^\d+$/.test(v) && prev?.value !== '.' && next?.value !== '.' && Number.isSafeInteger(Number(v)) && Number(v) < Number.MAX_SAFE_INTEGER)
      add(t, t.end, 'integer', String(v === '0' ? 1 : v === '1' ? 0 : Number(v) + 1));
    else if (v === 'return' && next && ![';', 'undefined'].includes(next.value)) {
      const stack: string[] = [];
      for (let j = i + 1; j < tokens.length && tokens[j]!.line === t.line && tokens[j]!.end - t.start <= 4096; j++) {
        const value = tokens[j]!.value;
        if (value === ';' && !stack.length) { add(t, tokens[j]!.end, 'return', 'return undefined;'); break; }
        if (['(', '[', '{'].includes(value)) stack.push(value);
        else if ([')', ']', '}'].includes(value)) {
          if (stack.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[value]) break;
        }
        if (value === 'return' || value === '#opaque') break;
      }
    } else if (v === 'if' && next?.value === '(') {
      let depth = 0;
      for (let j = i + 1; j < tokens.length && tokens[j]!.line === t.line && tokens[j]!.end - t.start <= 4096; j++) {
        if (tokens[j]!.value === '(') depth++;
        if (tokens[j]!.value === ')' && --depth === 0) {
          add(t, tokens[j]!.end, 'if', `if (!(${content.slice(next.end, tokens[j]!.start)}))`); break;
        }
      }
    }
  }
  return result;
}

export function selectMutants(candidates: Mutant[], maxMutants: number): Mutant[] {
  const groups = new Map<string, Array<{ mutant: Mutant; hash: string }>>();
  for (const mutant of candidates) {
    if (!groups.has(mutant.operator)) groups.set(mutant.operator, []);
    groups.get(mutant.operator)!.push({ mutant, hash: createHash('sha1').update(`${mutant.file}:${mutant.line}:${mutant.column}:${mutant.operator}`).digest('hex') });
  }
  const ordered = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, items]) => items.sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const result: Mutant[] = [];
  for (let i = 0; result.length < Math.min(25, maxMutants); i++) {
    let found = false;
    for (const group of ordered) if (group[i] && result.length < Math.min(25, maxMutants)) { result.push(group[i]!.mutant); found = true; }
    if (!found) break;
  }
  return result;
}

export async function runMutation(options: {
  root: string; sources: Map<string, string>; diff: string; head?: TestReport; command: string[]; runner: CommandRunner;
  timeoutMs: number; maxMutants?: number; budgetSeconds?: number; testGlobs?: string[]; reasons: string[]; now?: () => number;
}): Promise<MutationEvidence> {
  const evidence = emptyMutation(options.maxMutants); const note = (text: string) => evidence.skipped!.push(`mutation skipped: ${text}`);
  const head = options.head;
  if (!head || !head.tests.length || head.suiteErrors.length || head.tests.some(test => test.status === 'failed')) {
    note(head?.tests.some(test => test.status === 'failed') ? 'head has failing tests' : 'head report missing or has suite errors'); return evidence;
  }
  const now = options.now ?? Date.now; const deadline = now() + (options.budgetSeconds ?? 300) * 1000;
  const candidates: Mutant[] = [];
  for (const [file, lines] of changedLines(options.diff)) {
    if (options.testGlobs?.some(glob => matchesTestGlob(file, glob))) continue;
    const content = options.sources.get(file);
    if (content !== undefined) {
      if (Buffer.byteLength(content) > API_INPUT_BYTES || content.split('\n').some(line => line.length > 4096) || content.includes('${')) note(`${file}: lexical/input limits may omit candidates`);
      for (const mutant of generateMutants(file, content, lines)) candidates.push(mutant);
    }
  }
  evidence.candidates = candidates.length;
  for (const mutant of selectMutants(candidates, evidence.maxMutants)) {
    const remaining = deadline - now();
    if (remaining <= 0) { evidence.budgetExhausted = true; break; }
    const full = path.resolve(options.root, mutant.file); const original = options.sources.get(mutant.file)!;
    try {
      await assertNoLinks(full, options.root);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.nlink !== 1 || await readFile(full, 'utf8') !== original) { note(`${mutant.file}: on-disk content mismatch or not a regular file`); break; }
    } catch { note(`${mutant.file}: target could not be read safely`); break; }
    const reportPath = path.join(canonicalPath(os.tmpdir()), `quorum-mutation-${randomUUID()}.json`);
    let restored = false;
    evidence.attempted++;
    try {
      await writeFile(full, mutant.text);
      const checked = await runDeterministicChecks([machineTestCommand(options.command, reportPath)], options.root, options.runner, { timeoutMs: Math.min(options.timeoutMs, remaining) });
      let report: TestReport | null = null;
      try {
        const stat = await lstat(reportPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024) report = parseTestReport(await readFile(reportPath, 'utf8'), options.root);
      } catch { /* Absent reports are invalid mutants. */ }
      if (report?.tests.some(test => test.status === 'failed')) evidence.killed++;
      else if (!checked.passed || !report || report.suiteErrors.length || report.tests.length !== head.tests.length) evidence.invalid++;
      else { const { file, line, operator, before, after } = mutant; evidence.survived.push({ file, line, operator, before, after }); }
    } catch { evidence.invalid++; }
    finally {
      try {
        await assertNoLinks(full, options.root);
        const stat = await lstat(full);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Not a regular unlinked file');
        await writeFile(full, original);
        restored = await readFile(full, 'utf8') === original;
      } catch { /* Do not follow a replaced link while restoring. */ }
      await rm(reportPath, { force: true }).catch(() => undefined);
    }
    if (!restored) { options.reasons.push(`mutation: could not restore ${mutant.file}`); break; }
  }
  if (!evidence.attempted) note('0 mutants ran');
  return evidence;
}
