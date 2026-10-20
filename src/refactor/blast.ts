import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { importSpecifiers } from '../context/contract.js';
import { CodeGraphContextProvider, parseCallers } from '../context/codegraph.js';
import type { CommandRunner } from '../types/index.js';
import type { ApiExport } from './api.js';

export interface Dependent { file: string; touchedFile: string; hop: 1 | 2; isTest: boolean; source: 'imports' | 'codegraph' }
export interface BlastRadius { dependents: Dependent[]; withoutTests: string[]; notes: string[]; incomplete?: boolean; nonSource?: string[]; testsUnknown?: string[] }
export const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
export const isTestFile = (file: string) => /(?:^|\/)__tests__\/|(?:^|\/)(?:test|tests)\/|\.(?:test|spec)\.[^/]+$/i.test(file.replace(/\\/g, '/'));
const inside = (file: string) => file !== '..' && !file.startsWith('../') && !path.isAbsolute(file);

export async function buildBlastRadius(root: string, touched: string[], options: {
  maxFiles?: number; maxDependents?: number;
  deadlineMs?: number;
  testFiles?: string[];
  codegraph?: { root: string; runner: CommandRunner; symbols: Map<string, ApiExport[]>; provider?: CodeGraphContextProvider };
} = {}): Promise<BlastRadius> {
  const result: BlastRadius = { dependents: [], withoutTests: [], notes: [],
    nonSource: touched.filter(file => !sourceExtensions.includes(path.extname(file))) };
  const isTest = (file: string) => isTestFile(file) || options.testFiles?.includes(file) === true;
  const files = new Map<string, string>(); let scanned = 0; let capped = false;
  async function walk(directory: string, relative = ''): Promise<void> {
    if (capped) return;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', '.quorum'].includes(entry.name)) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), file); if (capped) return; continue; }
      if (!entry.isFile() || !sourceExtensions.includes(path.extname(file)) && !options.testFiles?.includes(file)) continue;
      if (scanned >= (options.maxFiles ?? 3000)) { capped = true; result.incomplete = true; result.notes.push('Blast radius: 3000 files scanned cap reached; coverage is incomplete.'); return; }
      scanned++;
      const full = path.join(directory, entry.name); const stat = await lstat(full);
      if (stat.size > 64 * 1024) { result.incomplete = true; result.notes.push(`${file}: blast radius skipped file over 64 KiB.`); continue; }
      const content = await readFile(full, 'utf8');
      if (!content.includes('\0')) files.set(file, content);
      else { result.incomplete = true; result.notes.push(`${file}: binary source skipped in blast radius.`); }
    }
  }
  await walk(root);
  const known = new Set([...files.keys(), ...touched]);
  const reverse = new Map<string, Set<string>>();
  for (const [file, content] of files) {
    for (const spec of importSpecifiers(content)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\/$/, '');
      if (!inside(target)) continue;
      const ext = path.posix.extname(target);
      const candidates = ext ? [target, ...(ext === '.js' ? [target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx'] : ext === '.jsx' ? [target.slice(0, -4) + '.tsx'] : [])]
        : [...sourceExtensions.map(extension => target + extension), ...sourceExtensions.map(extension => `${target === '.' ? '' : target + '/'}index${extension}`)];
      const dependency = candidates.find(candidate => known.has(candidate));
      if (dependency) { const list = reverse.get(dependency) ?? new Set<string>(); list.add(file); reverse.set(dependency, list); }
    }
  }
  const tested = new Set<string>();
  const seen = new Set<string>();
  let listCapped = false;
  const add = (item: Dependent) => {
    if (item.file === item.touchedFile) return;
    if (item.isTest) tested.add(item.touchedFile);
    const key = `${item.touchedFile}\0${item.file}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (result.dependents.length >= (options.maxDependents ?? 200)) {
      if (!listCapped) result.notes.push('Blast radius: 200 dependents list cap reached.');
      listCapped = true; result.incomplete = true; return;
    }
    result.dependents.push(item);
  };
  for (const target of touched) {
    for (const first of reverse.get(target) ?? []) {
      add({ file: first, touchedFile: target, hop: 1, isTest: isTest(first), source: 'imports' });
      for (const second of reverse.get(first) ?? []) add({ file: second, touchedFile: target, hop: 2, isTest: isTest(second), source: 'imports' });
    }
  }
  if (options.codegraph) {
    const { root: indexRoot, runner, symbols } = options.codegraph;
    const provider = options.codegraph.provider ?? new CodeGraphContextProvider();
    if (await provider.available(indexRoot)) {
      result.notes.push('CodeGraph callers are untrusted context and may be stale; test coverage uses scanned imports only.');
      let calls = 0; let bytes = 0;
      const end = Date.now() + (options.deadlineMs ?? 60_000);
      for (const [file, exports] of symbols) {
        let fileBytes = 0;
        for (const symbol of exports.slice(0, 5)) {
          if (calls >= 30 || bytes >= 16 * 1024 || Date.now() >= end) { result.notes.push('CodeGraph callers: call, byte or deadline cap reached.'); break; }
          if (fileBytes >= 4096) { result.notes.push(`${file}: CodeGraph 4 KiB file cap reached.`); break; }
          try {
            calls++;
            const invocation = provider.resolveInvocation(['callers', symbol.name, '-f', file, '-l', '5', '-j', '-p', indexRoot], indexRoot);
            const output = await runner(invocation.file, invocation.args, { cwd: indexRoot, timeoutMs: Math.max(1, Math.min(10_000, end - Date.now())), windowsVerbatimArguments: invocation.windowsVerbatimArguments });
            if (Date.now() >= end || output.exitCode !== 0 || Buffer.byteLength(output.stdout) > Math.min(4096 - fileBytes, 16 * 1024 - bytes)) throw new Error('unavailable or oversized output');
            bytes += Buffer.byteLength(output.stdout);
            fileBytes += Buffer.byteLength(output.stdout);
            const parsed = parseCallers(output.stdout);
            for (const caller of parsed.callers.slice(0, 5)) {
              if (!caller.filePath) continue;
              const candidate = caller.filePath.replace(/\\/g, '/');
              const relative = path.isAbsolute(candidate) ? path.relative(indexRoot, candidate).replace(/\\/g, '/') : candidate.replace(/^\.\//, '');
              if (!inside(relative) || !files.has(relative)) continue;
              const wasTested = tested.has(file);
              add({ file: relative, touchedFile: file, hop: 1, isTest: isTest(relative), source: 'codegraph' });
              if (!wasTested) tested.delete(file);
            }
            if (parsed.truncated || parsed.callers.length > 5) result.notes.push(`${file}: CodeGraph callers truncated.`);
          } catch { result.notes.push(`${file}: CodeGraph callers unavailable.`); }
        }
      }
    } else result.notes.push('CodeGraph callers unavailable; using scanned relative imports.');
  }
  const untested = touched.filter(file => sourceExtensions.includes(path.extname(file)) && !isTest(file) && !tested.has(file));
  result.withoutTests = result.incomplete ? [] : untested;
  result.testsUnknown = result.incomplete ? untested : [];
  return result;
}
