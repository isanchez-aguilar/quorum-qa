import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../cli/args.js';
import type { ReviewContext } from '../types/index.js';

export interface ContractFile { file: string; content: string }
export interface ContractContext {
  groups: Array<{ file: ContractFile; imports: ContractFile[] }>;
  copy: ContractFile[];
  notes: string[];
  skippedFiles: string[];
  binaryFiles: string[];
}
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const copyExtensions = new Set(['.json', '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.html', '.po']);
export const contractHash = (text: string) => createHash('sha256').update(text).digest('hex');
const relative = (root: string, file: string) => path.relative(root, file).replace(/\\/g, '/');
const inside = (file: string) => file !== '..' && !file.startsWith('../') && !path.isAbsolute(file);

/** Check only the input itself, or components strictly below a worktree boundary. */
export async function assertNoLinks(file: string, boundary?: string): Promise<void> {
  let cursor = path.resolve(file);
  const stop = boundary === undefined ? path.dirname(cursor) : path.resolve(boundary);
  if (!inside(relative(stop, cursor))) throw new UsageError('Input is outside its boundary.');
  if (cursor === stop) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new UsageError('Input must not contain a symlink.');
    return;
  }
  while (cursor !== stop) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new UsageError('Input must not contain a symlink.');
    cursor = path.dirname(cursor);
  }
}

/**
 * A forward-only lexical scan, not a parser. Each character is visited once.
 * Only named binding braces allow line breaks; a specifier never spans lines.
 * A pending keyword expires after 4 KiB, even inside a named binding list.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  let kind = ''; let deadline = 0; let braces = 0; let from = false; let call = false;
  const reset = () => { kind = ''; braces = 0; from = false; call = false; };
  const word = (char: string) => /[A-Za-z0-9_$]/.test(char);
  for (let i = 0; i < source.length;) {
    if (kind && i >= deadline) reset();
    const char = source[i]!;
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if ((source[i] === '\n' || source[i] === '\r') && braces === 0) reset();
        i++;
      }
      i = Math.min(i + 2, source.length); continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = ++i;
      while (i < source.length && source[i] !== char && source[i] !== '\n' && source[i] !== '\r') {
        if (source[i] === '\\') i++;
        i++;
      }
      if (kind && i < deadline && source[i] === char && char !== '`' && braces === 0
        && (from || kind === 'import' || (kind === 'require' && call))) specs.push(source.slice(start, i));
      reset();
      if (source[i] === char) i++;
      continue;
    }
    if (word(char)) {
      const start = i++;
      while (i < source.length && word(source[i]!)) i++;
      const token = source.slice(start, i);
      if (!kind && (token === 'import' || token === 'export' || token === 'require')) {
        kind = token; deadline = i + 4096;
      } else if (kind && token === 'from' && braces === 0) from = true;
      continue;
    }
    if (char === ';' || ((char === '\n' || char === '\r') && braces === 0)) reset();
    else if (kind && char === '{') braces++;
    else if (kind && char === '}') braces = Math.max(0, braces - 1);
    else if (kind && char === '(') call = true;
    i++;
  }
  return specs;
}

export async function loadCopy(input: string, root: string, rulesPath?: string): Promise<{ files: ContractFile[]; notes: string[] }> {
  const files: ContractFile[] = []; const notes: string[] = []; let count = 0;
  const base = path.resolve(input);
  const baseStat = await lstat(base);
  await assertNoLinks(base);
  async function walk(file: string): Promise<void> {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new UsageError('--copy does not accept symlinks.');
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await walk(path.join(file, name));
      return;
    }
    if (!copyExtensions.has(path.extname(file).toLowerCase())) return;
    if (++count > 50) throw new UsageError('--copy accepts at most 50 files.');
    if (!stat.isFile() || stat.size > 64 * 1024) throw new UsageError('--copy files must be regular files of at most 64 KiB.');
    const identity = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (rulesPath && identity(file) === identity(rulesPath)) throw new UsageError('--copy must not include the rules document.');
    const rel = relative(root, file);
    const label = inside(rel) ? rel : `__quorum_copy__/${baseStat.isDirectory() ? relative(base, file) : path.basename(file)}`;
    const content = await readFile(file, 'utf8');
    if (content.includes('\0')) { notes.push(`${label}: binary copy skipped.`); return; }
    files.push({ file: label, content });
  }
  await walk(base);
  if (!baseStat.isDirectory() && !copyExtensions.has(path.extname(base).toLowerCase())) throw new UsageError('--copy requires a supported text file or directory.');
  return { files, notes };
}

/** Deliberately one hop: imported files are never scanned for further imports. */
export async function buildContractContext(context: ReviewContext, headRoot: string): Promise<ContractContext> {
  const result: ContractContext = { groups: [], copy: [], notes: [], skippedFiles: [], binaryFiles: [] };
  const imported = new Set<string>();
  async function read(file: string): Promise<ContractFile | undefined> {
    if (!inside(file) || file.split('/').includes('node_modules') || file === context.rulesFile) return;
    try {
      const full = path.resolve(headRoot, file);
      await assertNoLinks(full, headRoot);
      const stat = await lstat(full);
      if (!stat.isFile() || stat.size > 64 * 1024) { result.notes.push(`${file}: not regular text within 64 KiB; skipped.`); return; }
      const content = await readFile(full, 'utf8');
      if (content.includes('\0')) { result.binaryFiles.push(file); return; }
      return { file, content };
    } catch { return; }
  }
  for (const file of context.touchedFiles) {
    if (file === context.rulesFile) continue;
    const source = await read(file);
    if (!source) { result.skippedFiles.push(file); result.notes.push(`${file}: HEAD file missing, unsafe, binary or over 64 KiB; skipped.`); continue; }
    const group = { file: source, imports: [] as ContractFile[] }; result.groups.push(group);
    for (const spec of importSpecifiers(source.content)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = relative(headRoot, path.resolve(headRoot, path.dirname(file), spec));
      if (!inside(target) || target.split('/').includes('node_modules')) continue;
      const ext = path.extname(target);
      const candidates = ext ? (extensions.includes(ext) ? [target, ...(ext === '.js' ? [target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx'] : ext === '.jsx' ? [target.slice(0, -4) + '.tsx'] : [])] : []) : [...(target ? extensions.map(e => target + e) : []), ...extensions.map(e => `${target ? target + '/' : ''}index${e}`)];
      let dependency: ContractFile | undefined;
      for (const candidate of candidates) { dependency = await read(candidate); if (dependency) break; }
      if (!dependency || dependency.file === file || group.imports.some(item => item.file === dependency!.file)) continue;
      if (group.imports.length >= 20) { result.notes.push(`${file}: 20 imported files cap hit.`); result.skippedFiles.push(dependency.file); break; }
      if (!imported.has(dependency.file) && imported.size >= 60) { result.notes.push(`${file}: 60 imported files per run cap hit.`); result.skippedFiles.push(dependency.file); break; }
      imported.add(dependency.file); group.imports.push(dependency);
    }
  }
  return result;
}
