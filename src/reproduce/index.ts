import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import { resolveCommand } from '../checks/resolver.js';
import { fileExistsAtCommit } from '../context/git.js';
import { CommandTimeoutError, runCommand } from '../process/runner.js';
import type { CommandRunner, Finding, QuorumConfig, ReproductionProposal, ReviewContext } from '../types/index.js';
import { createReviewWorktree } from '../worktree/index.js';
import { evaluateReproduction, infrastructureFailure, parseTestReport, passedAtBase } from './evaluate.js';
import { runIsolatedTest } from './isolation.js';
import { writeProposedTest } from './write.js';

export interface ReproductionOptions {
  gitRunner?: CommandRunner;
  isolationOptions?: Parameters<typeof runIsolatedTest>[4];
  deadlineMs?: number;
  now?: () => number;
  warn?: (message: string) => void;
  isTTY?: boolean;
  // This flag suppresses the interactive fallback; it never grants host execution.
  noHostPrompt?: boolean;
  confirm?: (proposal: ReproductionProposal, revision: string) => Promise<boolean>;
  display?: (text: string) => void;
}

export type ReproductionOutcome = {
  status: 'reproduced' | 'not-reproduced' | 'rejected' | 'unproven'; reason?: string;
};

export function sanitizeHostDisplay(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function hostEnvironment(platform = process.platform, source = process.env): NodeJS.ProcessEnv {
  const allowed = platform === 'win32' ? ['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'] : ['PATH', 'HOME', 'TMPDIR', 'LANG'];
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.includes(platform === 'win32' ? key.toUpperCase() : key)));
}

async function confirmOnStdin(display: (text: string) => void, timeoutMs: number): Promise<boolean> {
  display('Run this test on the host without container isolation? [y/N] ');
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await input.question('', { signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) })).trim()); }
  catch { return false; }
  finally { input.close(); }
}

// Explicit host consent is needed for every revision execution. The report is read
// from a fresh temporary file, never from a stale checkout artifact or stdout prose.
async function runHostTest(worktree: string, testFile: string, config: QuorumConfig['reproduce'], runner: CommandRunner, timeoutMs: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quorum-host-report-'));
  const reportFile = path.join(directory, 'report.json');
  try {
    const jest = config.testCommand.some(arg => /(?:^|[/\\])jest(?:\.[cm]?js)?$/.test(arg));
    const argv = [...config.testCommand.slice(1), `./${testFile}`, ...(jest ? ['--json', `--outputFile=${reportFile}`] : ['--reporter=json', `--outputFile=${reportFile}`])];
    const env = hostEnvironment();
    const command = resolveCommand(config.testCommand[0]!, argv, { cwd: worktree, env });
    const result = await runner(command.file, command.args, { cwd: worktree, timeoutMs, windowsVerbatimArguments: command.windowsVerbatimArguments,
      env });
    const report = await readFile(reportFile, 'utf8').then(raw => parseTestReport(raw, worktree)).catch(() => null);
    return { timedOut: false, report, exitCode: result.exitCode, reason: infrastructureFailure(report, result.stderr) };
  } catch (error) {
    return { timedOut: error instanceof CommandTimeoutError, report: null, exitCode: -1, reason: error instanceof CommandTimeoutError ? 'host test timeout' : `host infrastructure: ${String(error)}` };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function reproduceBlocker(finding: Finding, proposal: ReproductionProposal, context: ReviewContext,
  config: QuorumConfig, runner: CommandRunner = runCommand, options: ReproductionOptions = {}): Promise<ReproductionOutcome> {
  const now = options.now ?? Date.now;
  const expires = now() + (options.deadlineMs ?? config.budget.maxMinutes * 60_000);
  const remaining = () => Math.max(0, expires - now());
  const gitRunner = options.gitRunner ?? runCommand;
  const boundedGit: CommandRunner = (command, args, opts) => {
    const cleanup = args.includes('worktree') && (args.includes('remove') || args.includes('prune'));
    if (!remaining() && !cleanup) throw new Error('run deadline');
    return gitRunner(command, args, { ...opts, timeoutMs: cleanup ? opts?.timeoutMs ?? 30_000 : Math.min(opts?.timeoutMs ?? 30_000, remaining()) });
  };
  const unproven = (reason: string): ReproductionOutcome => ({ status: 'unproven', reason });
  async function atRevision(commit: string) {
    const tree = await createReviewWorktree(context.worktreeRoot, commit, boundedGit, options.warn);
    try {
      let written;
      try { written = await writeProposedTest(tree.path, proposal.path, proposal.content, config.reproduce.testGlobs); }
      catch (error) { return { rejected: String(error) } as const; }
      if (!remaining()) return { result: { timedOut: true, report: null, exitCode: -1, reason: 'run deadline' } };
      let result = config.reproduce.isolation === 'interactive'
        ? { timedOut: false, report: null, exitCode: -1, reason: 'interactive confirmation required' }
        : await runIsolatedTest(tree.path, written.relative, config.reproduce, runner,
          { ...options.isolationOptions, warn: options.warn, deadlineMs: remaining(), now });
      if (result.reason === 'no container runtime' || config.reproduce.isolation === 'interactive') {
        if (!(options.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)) || options.noHostPrompt) return { result };
        const display = options.display ?? (text => { process.stderr.write(text); });
        display(sanitizeHostDisplay(`Proposed untrusted test at ${commit}: ${proposal.path}\n${proposal.content}\n`)
          + `testCommand argv: ${JSON.stringify(config.reproduce.testCommand.map(sanitizeHostDisplay))}\n`
          + 'The reviewed revision\'s package.json scripts, test config, setup files and dependencies also run on the host.\n');
        let approved: boolean;
        if (options.confirm) {
          approved = await options.confirm(proposal, commit);
        } else approved = await confirmOnStdin(display, remaining());
        if (!approved || !remaining()) return { result: { ...result, reason: approved ? 'run deadline' : 'host execution declined' } };
        result = await runHostTest(tree.path, written.relative, config.reproduce, runner,
          Math.min(remaining(), (config.reproduce.timeoutSeconds ?? 120) * 1000));
      }
      return { result };
    } finally {
      // Cleanup must still work after the run deadline.
      try { await tree.cleanup(); } catch (error) { options.warn?.(`Reproduction worktree cleanup failed: ${String(error)}`); }
    }
  }
  try {
    // New code cannot establish the head/base comparison even with a matching assertion.
    if (finding.origin === 'introduced' && !await fileExistsAtCommit(context.baseCommit, finding.file, context.worktreeRoot, boundedGit)) {
      return unproven('new code: nothing to compare against');
    }
    const head = await atRevision(context.headCommit);
    if (head.rejected) return { status: 'rejected', reason: head.rejected };
    const headRun = head.result!;
    const headInfra = headRun.reason ?? (headRun.timedOut ? 'container timeout' : infrastructureFailure(headRun.report, '', proposal.path));
    if (headInfra) return unproven(headInfra);
    const evaluation = evaluateReproduction(headRun.report!, proposal.path, proposal.expect);
    if (evaluation !== 'assertion-failure-matching') return { status: 'not-reproduced', reason: evaluation };
    if (finding.origin === 'introduced') {
      const base = await atRevision(context.baseCommit);
      if (base.rejected) return { status: 'rejected', reason: base.rejected };
      const baseRun = base.result!;
      const baseInfra = baseRun.reason ?? (baseRun.timedOut ? 'container timeout' : infrastructureFailure(baseRun.report, '', proposal.path));
      if (baseInfra) return unproven(baseInfra);
      if (!passedAtBase(baseRun.report!, proposal.path)) return { status: 'not-reproduced', reason: 'test did not pass at base' };
    }
    return { status: 'reproduced', reason: finding.origin === 'pre-existing' ? 'matching assertion at head; pre-existing, base skipped' : 'matching assertion at head; passed at base' };
  } catch (error) { return unproven(`reproduction infrastructure: ${String(error)}`); }
}
