import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDeterministicChecks } from '../checks/index.js';
import { assertNoLinks } from '../context/contract.js';
import { machineTestCommand } from '../reproduce/command.js';
import { parseTestReport } from '../reproduce/evaluate.js';
import { matchesTestGlob } from '../reproduce/write.js';
import type { CommandRunner, QuorumConfig, ReviewContext, TestReport } from '../types/index.js';
import { createReviewWorktree } from '../worktree/index.js';
import { API_INPUT_BYTES, compareApi, scanExports, unsupportedSource, type ApiEvidence } from './api.js';
import { buildBlastRadius, isTestFile, sourceExtensions, type BlastRadius } from './blast.js';

export type RefactorTest = TestReport['tests'][number];
export interface TestCounts { passed: number; failed: number; skipped: number; total: number }
export interface TestComparison {
  base: TestCounts; head: TestCounts;
  regressions: RefactorTest[]; fixed: RefactorTest[]; removed: RefactorTest[]; added: RefactorTest[];
  failingBoth: RefactorTest[]; skippedChanges: Array<{ file: string; name: string; before: string; after: string }>;
  editedFiles: string[];
}
export interface RefactorEvidence {
  available: boolean; reasons: string[]; tests: TestComparison;
  api: ApiEvidence; blastRadius: BlastRadius; summary: string;
}
const emptyReport = (): TestReport => ({ runner: 'vitest', tests: [], suiteErrors: [] });
const normalizedFile = (file: string) => {
  const value = path.posix.normalize(file.replace(/\\/g, '/')).replace(/^\.\//, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const testIdentity = (test: RefactorTest) => JSON.stringify([normalizedFile(test.file), test.ancestorTitles ?? [], test.title ?? test.name]);
function counts(report: TestReport): TestCounts {
  return { passed: report.tests.filter(test => test.status === 'passed').length,
    failed: report.tests.filter(test => test.status === 'failed').length,
    skipped: report.tests.filter(test => test.status === 'skipped').length, total: report.tests.length };
}
export function compareTests(base: TestReport, head: TestReport, editedFiles: string[] = []): TestComparison {
  const normalize = (file: string) => path.posix.normalize(file.replace(/\\/g, '/')).replace(/^\.\//, '');
  const key = testIdentity;
  const before = new Map(base.tests.map(test => [key(test), test]));
  const after = new Map(head.tests.map(test => [key(test), test]));
  const result: TestComparison = { base: counts(base), head: counts(head), regressions: [], fixed: [], removed: [], added: [], failingBoth: [], skippedChanges: [], editedFiles: [...new Set(editedFiles.map(normalize))].sort() };
  for (const [identity, test] of before) {
    const current = after.get(identity);
    if (!current) { result.removed.push(test); continue; }
    if (test.status === 'passed' && current.status === 'failed') result.regressions.push(current);
    if (test.status === 'failed' && current.status === 'passed') result.fixed.push(current);
    if (test.status === 'failed' && current.status === 'failed') result.failingBoth.push(current);
    if (test.status !== current.status && (test.status === 'skipped' || current.status === 'skipped')) result.skippedChanges.push({ file: current.file, name: current.name, before: test.status, after: current.status });
  }
  for (const [identity, test] of after) if (!before.has(identity)) result.added.push(test);
  return result;
}

/** Drop explicit test paths/placeholders, name/path filters and stale report destinations. */
export function defaultRefactorCommand(command: readonly string[]): string[] {
  const result: string[] = [];
  const valued = new Set(['-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns', '--runTestsByPath', '--outputFile']);
  const preserveValue = new Set(['--config', '-c', '--root', '--dir', '--environment', '--pool', '--maxWorkers', '--minWorkers', '--reporter', '--reporters', '--testTimeout']);
  const executable = path.basename(command[0] ?? '').replace(/\.(?:cmd|exe|js)$/i, '');
  let prefix = executable === 'node' ? 2 : ['pnpm', 'npm', 'yarn'].includes(executable)
    ? ['exec', 'run', 'dlx'].includes(command[1] ?? '') ? 3 : 2 : 1;
  if (command[prefix] === 'run') prefix++;
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    if (i < prefix) { result.push(arg); continue; }
    if (valued.has(arg)) { if (arg !== '--runTestsByPath') i++; continue; }
    if (/^--(?:testNamePattern|testPathPatterns?|outputFile)=/.test(arg) || /\{(?:file|testFile)\}/.test(arg)) continue;
    if (preserveValue.has(arg)) { result.push(arg); if (command[i + 1] !== undefined) result.push(command[++i]!); continue; }
    if (!arg.startsWith('-')) continue;
    result.push(arg);
  }
  return result;
}

export const resolveRefactorTestCommand = (config: QuorumConfig): string[] =>
  config.refactor?.testCommand ?? defaultRefactorCommand(config.reproduce.testCommand);

export function editedTestFiles(touchedFiles: string[], base: TestReport, head: TestReport, namedExisting: string[] = []): string[] {
  const suites = (report: TestReport) => new Set([...(report.suiteFiles ?? []), ...report.tests.map(test => test.file)].map(normalizedFile));
  const before = suites(base); const after = suites(head);
  return [...new Set([...namedExisting, ...touchedFiles.filter(file => before.has(normalizedFile(file)) && after.has(normalizedFile(file)))])].sort();
}

export function summarizeEvidence(evidence: Omit<RefactorEvidence, 'summary'>): string {
  // JSON delimiters prevent repository names or test titles becoming instructions.
  const short = (value: string) => value.slice(0, 100);
  const tests = (items: RefactorTest[]) => items.slice(0, 5).map(item => ({ file: short(item.file), name: short(item.name) }));
  const summary = { available: evidence.available, reasons: evidence.reasons.slice(0, 5).map(short),
    apiIncomplete: evidence.api.incomplete ?? false, apiNotes: evidence.api.notes.slice(0, 5).map(short),
    unscanned: (evidence.api.unscanned ?? []).slice(0, 5).map(short),
    blastIncomplete: evidence.blastRadius.incomplete ?? false,
    testsUnknown: (evidence.blastRadius.testsUnknown ?? []).slice(0, 5).map(short),
    counts: { base: evidence.tests.base, head: evidence.tests.head },
    regressions: tests(evidence.tests.regressions), removedTests: tests(evidence.tests.removed),
    editedTests: evidence.tests.editedFiles.slice(0, 5).map(short),
    api: evidence.api.changes.filter(change => change.breaking).slice(0, 5).map(change => ({ file: short(change.file), name: short(change.name), kind: change.kind })),
    packageChanges: evidence.api.packageChanges.map(change => change.field), withoutTests: evidence.blastRadius.withoutTests.slice(0, 5).map(short),
    totals: { regressions: evidence.tests.regressions.length, removedTests: evidence.tests.removed.length, editedTests: evidence.tests.editedFiles.length,
      breakingApi: evidence.api.changes.filter(change => change.breaking).length, withoutTests: evidence.blastRadius.withoutTests.length } };
  const lists = [summary.reasons, summary.apiNotes, summary.unscanned, summary.regressions, summary.removedTests, summary.editedTests, summary.api, summary.packageChanges, summary.withoutTests, summary.testsUnknown];
  while (Buffer.byteLength(JSON.stringify(summary)) > 4096) {
    const largest = [...lists].sort((a, b) => b.length - a.length)[0];
    if (!largest?.length) break;
    largest.pop();
  }
  return JSON.stringify(summary);
}

export async function runRefactorEvidence(context: ReviewContext, config: QuorumConfig, options: {
  root: string; gitRunner: CommandRunner; checkRunner: CommandRunner;
  skipCodegraph?: boolean; contextRunner?: CommandRunner;
  warn?: (message: string) => void; announce?: (message: string) => void;
}): Promise<RefactorEvidence> {
  const reasons: string[] = []; const notes: string[] = [];
  const reports = { base: emptyReport(), head: emptyReport() };
  const sources = { base: new Map<string, string>(), head: new Map<string, string>() };
  const packages: Record<'base' | 'head', Record<string, unknown>> = { base: {}, head: {} };
  let blastRadius: BlastRadius = { dependents: [], withoutTests: [], notes: [] };
  const command = resolveRefactorTestCommand(config);
  const timeoutMs = (config.refactor?.timeoutSeconds ?? 600) * 1000;
  const testPresence = { base: new Set<string>(), head: new Set<string>() };
  for (const side of ['base', 'head'] as const) {
    let tree: Awaited<ReturnType<typeof createReviewWorktree>> | undefined;
    const reportPath = path.join(os.tmpdir(), `quorum-refactor-${randomUUID()}.json`);
    try {
      tree = await createReviewWorktree(options.root, side === 'base' ? context.mergeBaseCommit ?? context.baseCommit : context.headCommit, options.gitRunner, options.warn);
      const read = async (file: string, apiSource = false): Promise<string | undefined> => {
        const problem = (message: string) => (apiSource ? notes : reasons).push(`${side}: ${message}`);
        try {
          const full = path.resolve(tree!.path, file);
          await assertNoLinks(full, tree!.path);
          const stat = await lstat(full);
          if (!stat.isFile()) { problem(`${file} is not a regular file.`); return; }
          if (!apiSource && stat.size > 64 * 1024) { problem(`${file} exceeds the 64 KiB package cap.`); return; }
          let content: string;
          if (apiSource) {
            // Read one extra byte to let the scanner disclose its input cap.
            const handle = await open(full, 'r');
            try {
              const buffer = Buffer.alloc(API_INPUT_BYTES + 1);
              let count = 0;
              while (count < buffer.length) {
                const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
                if (!bytesRead) break;
                count += bytesRead;
              }
              content = buffer.subarray(0, count).toString('utf8');
            } finally { await handle.close(); }
          } else content = await readFile(full, 'utf8');
          if (content.includes('\0')) { problem(`${file} is binary; public API not checked.`); return; }
          return content;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problem(`${file} could not be read safely.`);
          return;
        }
      };
      for (const file of context.touchedFiles) {
        if (isTestFile(file) || config.reproduce.testGlobs.some(glob => matchesTestGlob(file, glob))) {
          try {
            const full = path.resolve(tree.path, file);
            await assertNoLinks(full, tree.path);
            if ((await lstat(full)).isFile()) testPresence[side].add(file);
          } catch { /* Deleted and newly added files are not edited tests. */ }
        }
        if (unsupportedSource(file)) { sources[side].set(file, ''); continue; }
        if (!sourceExtensions.includes(path.extname(file))) continue;
        const content = await read(file, true);
        if (content !== undefined) {
          sources[side].set(file, content);
        }
      }
      const manifest = await read('package.json');
      if (manifest !== undefined) {
        try {
          const parsed: unknown = JSON.parse(manifest);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          packages[side] = parsed as Record<string, unknown>;
        } catch { reasons.push(`${side}: package.json could not be parsed.`); }
      }
      if (!command.length) { reasons.push(`${side}: no refactor test command configured.`); continue; }
      options.announce?.(`quorum: running ${config.setup?.length ?? 0} setup commands and 1 configured checks from the reviewed change in a disposable ${side} worktree; this executes the change's code and install scripts unless the setup command disables them (use --no-checks for untrusted changes)\n`);
      const setup = await runDeterministicChecks(config.setup ?? [], tree.path, options.checkRunner, { timeoutMs });
      if (!setup.passed) {
        reasons.push(`${side}: setup ${setup.results.some(result => result.timedOut) ? 'timeout' : 'failure'}.`); continue;
      }
      const checked = await runDeterministicChecks([machineTestCommand(command, reportPath)], tree.path, options.checkRunner, { timeoutMs });
      if (checked.results.some(result => result.timedOut)) { reasons.push(`${side}: test timeout.`); continue; }
      let report: TestReport | null = null;
      try {
        const stat = await lstat(reportPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024) report = parseTestReport(await readFile(reportPath, 'utf8'), tree.path);
      } catch { /* Missing reports are unavailable regardless of human output. */ }
      if (!report || !report.tests.length || report.suiteErrors.length) {
        reasons.push(`${side}: ${report?.suiteErrors.length ? 'test suite errors prevented complete evidence' : 'missing or invalid JSON test report'}.`); continue;
      }
      reports[side] = report;
      if (new Set(report.tests.map(testIdentity)).size !== report.tests.length) reasons.push(`${side}: duplicate test identities make comparison ambiguous.`);
      if (!checked.passed && !report.tests.some(test => test.status === 'failed')) reasons.push(`${side}: test command failed without a reported failing test.`);
      if (side === 'head') {
        blastRadius = await buildBlastRadius(tree.path, context.touchedFiles, {
          testFiles: [...(report.suiteFiles ?? []), ...report.tests.map(test => test.file)],
          ...(!options.skipCodegraph && config.context?.provider === 'codegraph' ? {
            deadlineMs: config.budget.maxMinutes * 60_000,
            codegraph: { root: options.root, runner: options.contextRunner ?? options.gitRunner, symbols: new Map([...sources.head].map(([file, content]) => [file, scanExports(content)])) },
          } : {}),
        });
      }
    } catch (error) { reasons.push(`${side}: ${error instanceof Error ? error.message : 'evidence collection failed'}`); }
    finally {
      await rm(reportPath, { force: true }).catch(() => undefined);
      if (tree) await tree.cleanup().catch(error => { reasons.push(`${side}: worktree cleanup failed.`); options.warn?.(String(error)); });
    }
  }
  const editedFiles = editedTestFiles(context.touchedFiles, reports.base, reports.head, [...testPresence.base].filter(file => testPresence.head.has(file)));
  const tests = compareTests(reports.base, reports.head, editedFiles);
  const api = compareApi(sources.base, sources.head, packages.base, packages.head);
  api.notes.push(...notes);
  api.incomplete ||= notes.length > 0;
  const evidence = { available: reasons.length === 0, reasons, tests, api, blastRadius };
  return { ...evidence, summary: summarizeEvidence(evidence) };
}
