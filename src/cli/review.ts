import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CATALOG, parseModelRef } from '../catalog/index.js';
import type { QuotaSnapshot } from '../catalog/groups.js';
import { createExecutionPlan, formatDryRun, runCascade } from '../cascade/index.js';
import { runDeterministicChecks } from '../checks/index.js';
import { resolveAuthorFamily, validateConfig } from '../config/index.js';
import { buildReviewContext } from '../context/index.js';
import { git, mergeBase, revParse } from '../context/git.js';
import { acceptanceCriteria, inventoryFeatures } from '../modes/index.js';
import { runCommand } from '../process/runner.js';
import { AgyProvider } from '../providers/agy.js';
import { CodexProvider } from '../providers/codex.js';
import { ClaudeProvider } from '../providers/claude.js';
import { QwenProvider } from '../providers/qwen.js';
import { reproduceBlocker, type ReproductionOptions } from '../reproduce/index.js';
import type { ProviderAdapter } from '../providers/types.js';
import { generateMarkdownReport, generateSarifReport, type ReviewResult } from '../reporters/index.js';
import { appendLedger, atomicWrite, diskCache, readQuota } from '../storage/index.js';
import type { CatalogEntry, CommandRunner, QuorumConfig } from '../types/index.js';
import { checkoutDifference, checkoutSnapshot } from '../worktree/checkout.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';
import type { CliIo } from './index.js';
import { UsageError, type ParsedFlags } from './args.js';

export interface ReviewDependencies {
  repoRoot?: string;
  providers?: ReadonlyMap<string, ProviderAdapter>;
  catalog?: readonly CatalogEntry[];
  gitRunner?: CommandRunner;
  checkRunner?: CommandRunner;
  containerRunner?: CommandRunner;
  reproductionOptions?: Omit<ReproductionOptions, 'gitRunner' | 'deadlineMs' | 'noHostPrompt' | 'warn'>;
  appendLedger?: typeof appendLedger;
  now?: () => number;
}

async function configAt(commit: string, root: string, runner: CommandRunner): Promise<QuorumConfig> {
  const result = await git(['show', `${commit}:quorum.config.json`], root, runner);
  if (result.exitCode !== 0) throw new Error('quorum.config.json is missing at the trusted base. Commit it to the base branch, or pass --trust-head-config for your own repo. Use --diff <base>...HEAD to choose the base explicitly.');
  return validateConfig(JSON.parse(result.stdout.replace(/^\uFEFF/, '')));
}

async function copyImages(directory: string, destination: string): Promise<string[]> {
  const files = (await readdir(directory, { withFileTypes: true })).filter(item => /\.(png|jpe?g|webp)$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > 20) throw new UsageError('--images accepts at most 20 images.');
  for (const file of files) {
    const stat = await lstat(path.join(directory, file.name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) throw new UsageError('Images must be regular PNG, JPG or WebP files of at most 5 MB each.');
  }
  await mkdir(destination);
  for (const file of files) await copyFile(path.join(directory, file.name), path.join(destination, file.name));
  return files.map(file => path.join(destination, file.name));
}

export async function review(flags: ParsedFlags, io: CliIo, dependencies: ReviewDependencies): Promise<number> {
  const mode = flags.mode ?? 'feature';
  if (mode === 'feature' && !flags.spec) throw new UsageError('--spec is required for feature mode.');
  if (flags.since && flags.diff) throw new UsageError('--since and --diff cannot be combined.');
  if (mode !== 'redesign' && flags.images) throw new UsageError('--images requires redesign mode.');
  const root = path.resolve(dependencies.repoRoot ?? process.cwd());
  const runner = dependencies.gitRunner ?? runCommand;
  const now = dependencies.now ?? Date.now;
  const baseline = await checkoutSnapshot(root, runner);
  const head = await revParse('HEAD', root, runner);
  let headConfig: QuorumConfig | undefined;
  if (flags.trustHeadConfig) headConfig = await configAt(head, root, runner);
  async function bootstrapConfig(): Promise<QuorumConfig> {
    if (headConfig) return headConfig;
    let defaultBase: string;
    try { defaultBase = await revParse('origin/main', root, runner); }
    catch { throw new UsageError('Cannot discover the trusted base origin/main. Use --diff <base>...HEAD or --trust-head-config for your own repo.'); }
    return configAt(defaultBase, root, runner);
  }
  let range = flags.since ? `${flags.since}..HEAD` : flags.diff;
  if (!range) {
    const bootstrap = await bootstrapConfig();
    range = `${bootstrap.base}...HEAD`;
  }
  const parts = /^(.+?)(\.{2,3})([^.].*)$/.exec(range);
  if (!parts) throw new UsageError('Invalid range; expected <base>..HEAD or <base>...HEAD.');
  if (await revParse(parts[3]!, root, runner) !== head) throw new UsageError('The review range must end at HEAD.');
  const context = await buildReviewContext({ base: parts[1]!, head, cwd: root, mode, runner, exactBase: parts[2] === '..' });
  if (!context.touchedFiles.length) throw new UsageError('nothing to review: the selected range touches no files.');
  const trustBase = flags.since && !headConfig
    ? await mergeBase(await revParse((await bootstrapConfig()).base, root, runner), head, root, runner)
    : context.mergeBaseCommit ?? context.baseCommit;
  const config = headConfig ?? await configAt(trustBase, root, runner);
  if (flags.author) config.author = flags.author;
  if (config.author) context.authorFamily = resolveAuthorFamily(config.author);
  for (const [flag, property] of [['spec', 'specContent'], ['inventory', 'inventoryContent'], ['rules', 'rulesContent']] as const) {
    if (flags[flag]) {
      const file = path.resolve(root, flags[flag]);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new UsageError(`--${flag} must be a regular file, not a symlink.`);
      if (stat.size > 256 * 1024) throw new UsageError(`--${flag} must be at most 256 KiB.`);
      context[property] = await readFile(file, 'utf8');
    }
  }
  if (mode === 'feature' && !acceptanceCriteria(context.specContent ?? '').length) {
    throw new UsageError('No acceptance criteria detected. Use Markdown checkboxes (- [ ] criterion), or a list under a heading containing "acceptance".');
  }
  const catalog = dependencies.catalog ?? DEFAULT_CATALOG;
  const plan = createExecutionPlan(context, config, catalog);
  const quotaFile = path.join(root, '.quorum', 'quota.json');
  let snapshot = await readQuota(quotaFile);
  if (flags.dryRun) {
    const clock = { now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
    io.out(formatDryRun(createExecutionPlan(context, flags.noChecks ? { ...config, checks: [] } : config, catalog, snapshot, { clock })) + '\n');
    if (flags.noChecks) io.out('Deterministic checks: skipped (--no-checks).\n');
    return 0;
  }
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  if (baseline.status.trim()) {
    const message = 'Checkout has uncommitted changes; only committed HEAD was reviewed.';
    warn(message); io.err(`quorum: ${message}\n`);
  }
  plan.warnings.filter(message => message.startsWith('Independence')).forEach(warn);
  const providers = dependencies.providers ?? new Map<string, ProviderAdapter>([['agy', new AgyProvider()], ['codex', new CodexProvider()], ['claude', new ClaudeProvider()], ['qwen', new QwenProvider()]]);
  const readings: Record<string, QuotaSnapshot[string]> = { ...snapshot };
  const groups = new Set<string>();
  for (const ref of Object.values(config.tiers).flat()) {
    const model = parseModelRef(ref, catalog);
    const entry = catalog.find(item => item.provider === model.provider && item.id === model.model)!;
    if (groups.has(entry.quotaGroup)) continue;
    groups.add(entry.quotaGroup);
    const provider = providers.get(entry.provider);
    if (!provider) continue;
    try {
      const quota = await provider.getQuota(entry.id);
      readings[entry.quotaGroup] = { remainingPercent: quota === 'unknown' ? 'unknown' : quota.remainingPercent, timestamp: new Date(now()).toISOString() };
    } catch { readings[entry.quotaGroup] = { remainingPercent: 'unknown', timestamp: new Date(now()).toISOString() }; }
  }
  snapshot = readings;
  let checks: ReviewResult['checks'] = null;
  if (!flags.noChecks) {
    if (config.checks.length) io.err(`quorum: running ${config.checks.length} configured checks from the reviewed change in a disposable worktree; this executes the change's code (use --no-checks for untrusted changes)\n`);
    const checksTree = await createReviewWorktree(root, head, runner, warn);
    try { checks = await runDeterministicChecks(config.checks, checksTree.path, dependencies.checkRunner ?? runCommand); }
    finally { try { await checksTree.cleanup(); } catch (error) { warn(`Checks worktree cleanup failed: ${String(error)}`); } }
  }
  context.checksContext = flags.noChecks ? 'Checks skipped (--no-checks).' : JSON.stringify(checks?.results.filter(check => check.exitCode !== 0 || check.timedOut)
    .map(check => ({ name: check.argv.join(' '), stdout: check.stdoutTail, stderr: check.stderrTail }))).slice(0, 8192);
  const runId = `qrm-${randomUUID()}`;
  const timestamp = new Date(now()).toISOString();
  const verificationTree = await createReviewWorktree(root, head, runner, warn);
  const imageDirectory = `${verificationTree.path}-images`;
  const cache = flags.noCache ? undefined : diskCache(path.join(root, '.quorum', 'cache'), warn, root);
  let result: ReviewResult;
  try {
    try { await atomicWrite(quotaFile, JSON.stringify(snapshot), root); } catch (error) { warn(`Quota write failed: ${String(error)}`); }
    if (flags.images) context.images = await copyImages(path.resolve(root, flags.images), imageDirectory);
    const changedBefore = checkoutDifference(baseline, await checkoutSnapshot(root, runner));
    if (changedBefore) throw new Error(changedBefore);
    if (flags.reproduce && config.reproduce.allowInstallScripts) warn('Reproduction preparation: install scripts are enabled (allowInstallScripts=true); preparation has network access to fetch packages.');
    const cascade = await runCascade(context, config, providers, { catalog, quotaSnapshot: snapshot, gitRunner: runner, verificationRoot: verificationTree.path, cache,
      ...(flags.reproduce ? { reproduce: (finding, proposal, remainingMs) => reproduceBlocker(finding, proposal, context, config,
        dependencies.containerRunner ?? runCommand, { ...dependencies.reproductionOptions, gitRunner: runner, deadlineMs: remainingMs,
          noHostPrompt: flags.noHostPrompt, warn, display: text => io.err(text) }) } : {}) });
    const changed = checkoutDifference(baseline, await checkoutSnapshot(root, runner));
    if (changed) { cascade.errors.push(changed); cascade.findings = []; cascade.unconfirmed = []; cascade.coverage.complete = false; }
    const clean = await isClean(verificationTree.path, runner);
    if (!clean) { cascade.errors.push('Verification worktree changed; run aborted.'); cascade.findings = []; cascade.unconfirmed = []; cascade.coverage.complete = false; }
    const families = [...cascade.reviewedFamilies];
    // Cached reviews are still independent reviews by the original model family.
    for (const f of [...cascade.findings, ...cascade.unconfirmed]) if (!families.includes(f.family)) families.push(f.family);
    if (context.authorFamily && families.length === 1 && families[0] === context.authorFamily) warn('Independence warning: the author family was the only reviewer available.');
    const failingBlocker = [...cascade.findings, ...cascade.unconfirmed.filter(f => f.family !== 'local' || (f.confirmationFamilies?.length ?? 0) >= 2)]
      .some(f => f.severity === 'BLOCKER' && (!flags.allowUnproven || (f.confirmationFamilies?.length ?? 0) >= 2));
    const exitCode = failingBlocker ? 1 : cascade.errors.length || !cascade.coverage.complete ? 2 : 0;
    result = { ...cascade, runId, timestamp, mode, range, headSha: head, baseSha: context.baseCommit, checks,
      criteria: acceptanceCriteria(context.specContent ?? ''), inventory: inventoryFeatures(context.inventoryContent ?? ''), families, exitCode };
    if (cache && !baseline.status.trim() && clean && !cascade.errors.length && !cascade.calls.some(call => call.status === 'dirty')) await cache.flush();
    const entries = cascade.ledgerDraft.flatMap(draft => Array.from({ length: draft.callsUsed }, (_, index) => ({ ...draft,
      ...(index < draft.callsUsed - 1 ? { rawFindingsCount: 0, verifiedFindingsCount: 0, rejectedFindingsCount: 0, tokensReported: undefined, durationMs: 0, timedOutCalls: 0, rejectionReasons: {} } : {}),
      callsUsed: 1, runId, timestamp, coverageComplete: cascade.coverage.complete })));
    try { await (dependencies.appendLedger ?? appendLedger)(entries, path.join(root, '.quorum', 'ledger.jsonl'), root); }
    catch (error) { warn(`Ledger write failed: ${String(error)}`); }
  } finally {
    try { await rm(imageDirectory, { recursive: true, force: true }); } catch (error) { warn(`Image cleanup failed: ${String(error)}`); }
    try { await verificationTree.cleanup(); } catch (error) { warn(`Review worktree cleanup failed: ${String(error)}`); }
  }
  result.warnings.push(...warnings.filter(w => !result.warnings.includes(w)));
  async function save(file: string, render: () => string, label: string): Promise<void> {
    try { await atomicWrite(path.resolve(root, file), render(), root); }
    catch (error) {
      const message = `${label} write failed: ${String(error)}`;
      result.warnings.push(message); io.err(`quorum: ${message}\n`);
    }
  }
  await save(flags.out ?? `.quorum/reports/${runId}.md`, () => generateMarkdownReport(result), 'Report');
  if (flags.sarif) await save(flags.sarif, () => generateSarifReport([...result.findings, ...result.unconfirmed.filter(f => f.family !== 'local')], result), 'SARIF');
  if (flags.json) io.out(JSON.stringify(result, null, 2) + '\n');
  else io.out(generateMarkdownReport(result));
  return result.exitCode;
}
