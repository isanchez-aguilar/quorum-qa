import { canonicalPath } from '../paths.js';
import { rawOutputWriter } from '../storage/raw.js';
import { checkEvidence } from '../checks/output.js';
import { completionTiming } from '../cascade/timing.js';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CATALOG, parseModelRef, withQwenModel } from '../catalog/index.js';
import type { QuotaSnapshot } from '../catalog/groups.js';
import { createExecutionPlan, formatDryRun, runCascade, type CascadeResult } from '../cascade/index.js';
import { runDeterministicChecks } from '../checks/index.js';
import { resolveAuthorFamily, validateConfig } from '../config/index.js';
import { buildReviewContext } from '../context/index.js';
import { assertNoLinks, buildContractContext, loadCopy } from '../context/contract.js';
import { buildBughuntContext } from '../context/bughunt.js';
import { selectContextProvider, type ContextProvider } from '../context/providers.js';
import { CodeGraphContextProvider } from '../context/codegraph.js';
import { CONCURRENT_CHECKS_CONTEXT, reviewChunks } from '../cascade/prompts.js';
import { callBudgetMetadata, resolveBudget, RunBudget, systemClock } from '../cascade/budget.js';
import { git, mergeBase, revParse, validateRef } from '../context/git.js';
import { acceptanceCriteria, contractClauses, inventoryFeatures } from '../modes/index.js';
import { runCommand } from '../process/runner.js';
import { AgyProvider } from '../providers/agy.js';
import { CodexProvider } from '../providers/codex.js';
import { ClaudeProvider } from '../providers/claude.js';
import { QwenProvider } from '../providers/qwen.js';
import { reproduceBlocker, type ReproductionOptions } from '../reproduce/index.js';
import type { ProviderAdapter } from '../providers/types.js';
import { generateMarkdownReport, generateSarifReport, type ReviewResult } from '../reporters/index.js';
import { appendLedger, atomicWrite, diskCache, readQuota } from '../storage/index.js';
import { appendFindings, historyEntries } from '../storage/findings.js';
import { loadRulesAt, runRules } from '../rules/index.js';
import { applySuppressions, loadSuppressionsAt, suppressionChanges } from '../suppressions/index.js';
import type { CatalogEntry, CommandRunner, QuorumConfig } from '../types/index.js';
import { checkoutDifference, checkoutSnapshot } from '../worktree/checkout.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';
import type { CliIo } from './index.js';
import { UsageError, type ParsedFlags } from './args.js';
import { runRefactorEvidence, resolveRefactorTestCommand } from '../refactor/index.js';
import { evaluateRefactorVerdict } from './refactor.js';
import { runtimeReview } from './runtime.js';
import { runRuntimeEvidence } from '../runtime/run.js';
import { buildRuntimeReport } from '../reporters/runtime.js';
import { createVisualImages, emptyVisualReview, runVisualReview, visualCandidates, visualMaxCalls, type VisualReview } from '../runtime/visual.js';
import { runtimeText } from '../runtime/run.js';

export interface ReviewDependencies {
  cacheHome?: string;
  contextRunner?: CommandRunner;
  contextProvider?: ContextProvider;
  fetch?: typeof globalThis.fetch;
  repoRoot?: string;
  providers?: ReadonlyMap<string, ProviderAdapter>;
  catalog?: readonly CatalogEntry[];
  gitRunner?: CommandRunner;
  checkRunner?: CommandRunner;
  containerRunner?: CommandRunner;
  reproductionOptions?: Omit<ReproductionOptions, 'gitRunner' | 'deadlineMs' | 'noHostPrompt' | 'warn'>;
  appendLedger?: typeof appendLedger;
  appendFindings?: typeof appendFindings;
  now?: () => number;
}

function reviewProviders(config: QuorumConfig, dependencies: ReviewDependencies): ReadonlyMap<string, ProviderAdapter> {
  return dependencies.providers ?? new Map<string, ProviderAdapter>([['agy', new AgyProvider()], ['codex', new CodexProvider()], ['claude', new ClaudeProvider()], ['qwen', new QwenProvider({ ...config.qwen, fetch: dependencies.fetch })]]);
}

async function refreshQuota(providers: ReadonlyMap<string, ProviderAdapter>, catalog: readonly CatalogEntry[], snapshot: QuotaSnapshot,
  refs: string[], now: () => number): Promise<QuotaSnapshot> {
  const readings: Record<string, QuotaSnapshot[string]> = { ...snapshot };
  const groups = new Set<string>();
  for (const ref of refs) {
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
  return readings;
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
  const mode = flags.mode ?? (flags.spec ? 'feature' : 'general');
  if (flags.visual && mode !== 'runtime') throw new UsageError('--visual requires runtime mode.');
  if (flags.strictFlows && mode !== 'runtime') throw new UsageError('--strict-flows requires runtime mode.');
  if (flags.format && mode !== 'runtime') throw new UsageError('--format requires runtime mode.');
  if (mode === 'runtime') {
    for (const [key, flag] of Object.entries({ reproduce: 'reproduce', allowUnproven: 'allow-unproven',
      noHostPrompt: 'no-host-prompt', author: 'author', noCache: 'no-cache', probe: 'probe' })) {
      if (flags[key as keyof ParsedFlags] !== undefined) throw new UsageError(`--${flag} is not supported: ${flags.visual ? 'this option is not used by runtime review' : 'runtime is deterministic and makes no provider calls'}.`);
    }
    if (flags.noChecks) throw new UsageError('runtime mode must run the app; --no-checks is not supported.');
    for (const flag of ['spec', 'inventory', 'images', 'rules'] as const) {
      if (flags[flag] !== undefined) throw new UsageError(`--${flag} is not supported in runtime mode.`);
    }
  }
  const deterministicOnly = mode === 'refactor' && flags.deterministicOnly === true;
  if (mode === 'refactor' && flags.noChecks) throw new UsageError('Refactor mode cannot work without running tests; --no-checks is not supported.');
  if (mode !== 'refactor' && (flags.deterministicOnly || flags.allowApiChange || flags.mutation)) throw new UsageError('--deterministic-only, --allow-api-change and --mutation require refactor mode.');
  if (mode === 'refactor' && (flags.spec || flags.inventory)) throw new UsageError('--spec and --inventory are not supported in refactor mode.');
  if (mode === 'contract' && !flags.rules) throw new UsageError('--rules is required for contract mode.');
  if (mode !== 'contract' && flags.copy) throw new UsageError('--copy requires contract mode.');
  if (mode === 'contract' && (flags.spec || flags.inventory)) throw new UsageError('--spec and --inventory are not supported in contract mode.');
  if (mode === 'bughunt' && (flags.spec || flags.inventory)) throw new UsageError('--spec and --inventory are not supported in bughunt mode.');
  if (mode !== 'bughunt' && flags.radius !== undefined) throw new UsageError('--radius requires bughunt mode.');
  if (mode === 'feature' && !flags.spec) throw new UsageError('--spec is required for feature mode.');
  if (flags.since && flags.diff) throw new UsageError('--since and --diff cannot be combined.');
  if (mode !== 'redesign' && flags.images) throw new UsageError('--images requires redesign mode.');
  const root = canonicalPath(dependencies.repoRoot ?? process.cwd());
  const runner = dependencies.gitRunner ?? runCommand;
  const now = dependencies.now ?? Date.now;
  const reviewStarted = now();
  let baseline = await checkoutSnapshot(root, runner);
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
  if (flags.since) {
    try { validateRef(flags.since, false); }
    catch { throw new UsageError('--since takes one commit (for example HEAD~1), not a range; use --diff for ranges.'); }
  }
  let range = flags.since ? `${flags.since}..HEAD` : flags.diff;
  if (!range) {
    const bootstrap = await bootstrapConfig();
    range = `${bootstrap.base}...HEAD`;
  }
  const parts = /^(.+?)(\.{2,3})([^.].*)$/.exec(range);
  if (!parts) throw new UsageError('Invalid range; expected <base>..HEAD or <base>...HEAD.');
  if (await revParse(parts[3]!, root, runner) !== head) throw new UsageError('The review range must end at HEAD.');
  if (mode === 'runtime') {
    const base = flags.since && !headConfig ? (await bootstrapConfig()).base : parts[1]!;
    const trusted = headConfig ?? await configAt(await mergeBase(await revParse(base, root, runner), head, root, runner), root, runner);
    trusted.budget = resolveBudget(trusted.budget);
    if (flags.visual && trusted.runtime) trusted.runtime = { ...trusted.runtime, screenshots: true };
    const planned = runtimeReview(trusted.runtime, flags.dryRun === true, io);
    let visualDeps: Parameters<typeof runVisualReview>[2] | undefined;
    let visual: VisualReview | undefined;
    if (flags.visual) {
      visual = emptyVisualReview(trusted.runtime!);
      let names = 'none';
      try {
        const catalog = withQwenModel(dependencies.catalog ?? DEFAULT_CATALOG, trusted.qwen?.model);
        const providers = reviewProviders(trusted, dependencies);
        let quotaSnapshot = await readQuota(path.join(root, '.quorum', 'quota.json'));
        const budget = new RunBudget(trusted.budget, { ...systemClock, now });
        visualDeps = { catalog, providers, quotaSnapshot, budget, createImages: pairs => createVisualImages(root, pairs) };
        if (!flags.dryRun) {
          const refs = visualCandidates(trusted, visualDeps, budget).models.map(entry => `${entry.provider}:${entry.id}`);
          quotaSnapshot = await refreshQuota(providers, catalog, quotaSnapshot, refs, now);
          visualDeps.quotaSnapshot = quotaSnapshot;
        }
        const recipients = visualCandidates(trusted, visualDeps, budget).models;
        names = recipients.map(entry => `${entry.provider}:${entry.id} (${entry.family})`).join(', ') || 'none';
        if (!flags.dryRun) io.err(`quorum: --visual sends app screenshots (test data only) to: ${runtimeText(names, trusted.runtime!)}\n`);
      } catch {
        visualDeps = undefined;
        visual.notes.push('visual review unavailable: provider initialization failed');
        visual.incompleteFlows = trusted.runtime!.flows!.map(flow => runtimeText(flow.name, trusted.runtime!));
        visual.notes.push('visual coverage incomplete: provider unavailable');
        io.err('quorum: visual review unavailable: provider initialization failed\n');
      }
      if (flags.dryRun) {
        const families = trusted.runtime!.visual?.allowedFamilies ?? ['anthropic', 'google', 'openai', 'local'];
        const maxCalls = Math.min(visualMaxCalls(trusted.runtime!), trusted.budget.maxCalls);
        const imagesPerCall = Math.max(0, ...trusted.runtime!.flows!.map(flow => Math.min(10, flow.steps.filter(step =>
          ['goto', 'click', 'press', 'waitForUrl', 'waitForSelector'].some(action => action in step)).length) * 2));
        // Retries also transmit images and consume calls; never understate the consent ceiling.
        io.out(`Visual review plan (no commands run):\n  Maximum model calls: ${maxCalls}\n  Maximum images: ${maxCalls * imagesPerCall} (upper bound including corroboration and retries)\n  Allowed families: ${families.join(', ') || 'none'}\n  Screenshot recipients: ${runtimeText(names, trusted.runtime!)}\n`);
      }
    }
    if (flags.dryRun) return planned;
    const context = await buildReviewContext({ base: parts[1]!, head, cwd: root, mode, runner });
    const runId = `qrm-${randomUUID()}`;
    const evidence = await runRuntimeEvidence(context, trusted, { root, runId, gitRunner: runner,
      containerRunner: dependencies.containerRunner ?? runCommand, now,
      warn: message => io.err(`quorum: ${message}\n`), announce: message => io.err(message) });
    if (visualDeps) visual = await runVisualReview(evidence, trusted, visualDeps);
    const runtime = buildRuntimeReport(evidence, trusted.runtime!, { strictFlows: flags.strictFlows === true, visual });
    const result: ReviewResult = {
      runtime, callBudget: callBudgetMetadata(trusted.budget), runId, timestamp: new Date(now()).toISOString(), mode, range,
      headSha: head, baseSha: context.mergeBaseCommit ?? context.baseCommit, checks: null,
      criteria: [], inventory: [], families: [], reviewedFamilies: [], cacheHits: 0,
      findings: [], unconfirmed: [], related: [], warnings: [], errors: [], calls: [], ledgerDraft: [], exitCode: runtime.exitCode,
      coverage: { reviewedFiles: [], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [],
        complete: evidence.available && !!runtime.comparison && !runtime.comparison.incomplete.length && !runtime.comparison.uncoveredFlows.length },
    };
    return outputReview(result, flags, root, io);
  }
  const context = await buildReviewContext({ base: parts[1]!, head, cwd: root, mode, runner, exactBase: mode !== 'refactor' && parts[2] === '..' });
  if (mode === 'bughunt') context.radius = flags.radius ?? 40;
  if (!context.touchedFiles.length) throw new UsageError('nothing to review: the selected range touches no files.');
  const trustBase = flags.since && !headConfig
    ? await mergeBase(await revParse((await bootstrapConfig()).base, root, runner), head, root, runner)
    : context.mergeBaseCommit ?? context.baseCommit;
  const config = headConfig ?? await configAt(trustBase, root, runner);
  const rulesCommit = flags.trustHeadConfig ? head : trustBase;
  const deterministicRules = await loadRulesAt(rulesCommit, root, runner);
  const suppressions = await loadSuppressionsAt(rulesCommit, root, runner);
  const suppressionNotes = flags.trustHeadConfig ? [] : await suppressionChanges(trustBase, head, root, runner);
  if (flags.author) config.author = flags.author;
  if (config.author) context.authorFamily = resolveAuthorFamily(config.author);
  for (const [flag, property] of [['spec', 'specContent'], ['inventory', 'inventoryContent'], ['rules', 'rulesContent']] as const) {
    if (flags[flag] && !(mode === 'general' && flag === 'spec')) {
      const file = path.resolve(root, flags[flag]);
      if (mode === 'contract') await assertNoLinks(file);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new UsageError(`--${flag} must be a regular file, not a symlink.`);
      if (stat.size > 256 * 1024) throw new UsageError(`--${flag} must be at most 256 KiB.`);
      context[property] = await readFile(file, 'utf8');
    }
  }
  if (mode === 'contract') {
    if (!/\.md$/i.test(flags.rules!)) throw new UsageError('--rules must be a Markdown (.md) file.');
    context.rulesFile = path.relative(root, path.resolve(root, flags.rules!)).replace(/\\/g, '/');
    if (!contractClauses(context.rulesContent ?? '').length) throw new UsageError('No rule clauses detected. Use Markdown list items or paragraphs under a heading.');
  }
  if (mode === 'feature' && !acceptanceCriteria(context.specContent ?? '').length) {
    throw new UsageError('No acceptance criteria detected. Use Markdown checkboxes (- [ ] criterion), or a list under a heading containing "acceptance".');
  }
  const catalog = withQwenModel(dependencies.catalog ?? DEFAULT_CATALOG, config.qwen?.model);
  const selected = await selectContextProvider(deterministicOnly ? 'git' : config.context?.provider ?? 'git', root,
    dependencies.contextProvider ?? new CodeGraphContextProvider({ now }));
  context.contextProvider = { requested: config.context?.provider ?? 'git', available: selected.available, effective: selected.provider.name };
  context.contextNotes = selected.notes;
  if (mode === 'bughunt' || mode === 'contract') {
    const tree = await createReviewWorktree(root, head, runner, message => context.contextNotes!.push(message));
    try {
      if (mode === 'bughunt') context.bughunt = await buildBughuntContext(context, tree.path);
      else context.contract = await buildContractContext(context, tree.path);
      if (!await isClean(tree.path, runner)) throw new Error(`${mode} context worktree changed; run aborted.`);
    } finally { await tree.cleanup(); }
    const changed = checkoutDifference(baseline, await checkoutSnapshot(root, runner));
    if (changed) throw new Error(changed);
  }
  if (mode === 'bughunt' && !context.bughunt?.windows.length) {
    for (const note of context.bughunt?.notes ?? []) io.err(`${note}\n`);
    io.err('nothing to review in bughunt mode (no unchanged lines near the change)\n');
    // Added lines still need deterministic rules even when there is no bughunt window.
    if (!deterministicRules.length || flags.noChecks) return 2;
  }
  if (mode === 'contract' && flags.copy) {
    const copy = await loadCopy(path.resolve(root, flags.copy), root, path.resolve(root, flags.rules!));
    if (copy.files.some(file => file.file === context.rulesFile)) throw new UsageError('--copy must not include the rules document.');
    context.contract!.copy = copy.files;
    for (const note of copy.notes) context.contract!.notes.push(note);
  }
  const plan = deterministicOnly ? undefined : createExecutionPlan(context, config, catalog);
  const quotaFile = path.join(root, '.quorum', 'quota.json');
  let snapshot = await readQuota(quotaFile);
  if (flags.dryRun) {
    const clock = { now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
    const plannedConfig = flags.noChecks ? { ...config, checks: [], setup: [] }
      : mode === 'refactor' ? { ...config, checks: [resolveRefactorTestCommand(config)] } : config;
    if (!deterministicOnly) io.out(formatDryRun(createExecutionPlan(context, plannedConfig, catalog, snapshot, { clock })) + '\n');
    if (mode === 'refactor') {
      io.out('Refactor evidence plan (no commands run):\n'
        + `  Disposable worktree at merge-base: ${context.mergeBaseCommit ?? context.baseCommit}\n`
        + `  Disposable worktree at HEAD: ${head}\n`
        + `  Setup in each worktree: ${JSON.stringify(config.setup ?? [])}\n`
        + `  Test command in each worktree: ${JSON.stringify(resolveRefactorTestCommand(config))}\n`
        + `  Mutation sampling: ${flags.mutation ? 'on' : 'off (use --mutation)'}; max mutants: ${config.refactor?.mutation?.maxMutants ?? 8}; budget: ${config.refactor?.mutation?.budgetSeconds ?? 300} seconds (up to ${config.refactor?.mutation?.maxMutants ?? 8} extra suite runs)\n`
        + `  Test timeout: ${config.refactor?.timeoutSeconds ?? 600} seconds\n`
        + `  Model review: ${deterministicOnly ? 'off (--deterministic-only)' : 'on (normal cascade)'}\n`);
    }
    if (flags.noChecks) io.out('Deterministic checks: skipped (--no-checks).\n');
    io.out(`Deterministic rules: ${flags.noChecks ? 0 : deterministicRules.length} (from ${rulesCommit}${flags.noChecks ? '; skipped --no-checks' : ''}).\n`);
    return 0;
  }
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  if (baseline.status.trim()) {
    const message = mode === 'contract' && flags.copy ? 'Checkout has uncommitted changes; code is reviewed at committed HEAD, alongside explicitly supplied copy.' : 'Checkout has uncommitted changes; only committed HEAD was reviewed.';
    warn(message); io.err(`quorum: ${message}\n`);
  }
  plan?.warnings.filter(message => message.startsWith('Independence')).forEach(warn);
  let checks: ReviewResult['checks'] = null;
  let checksMs = 0;
  const parallelChecks = !flags.noChecks && mode !== 'refactor' && !flags.sequentialChecks && !config.budget.sequentialChecks;
  const runChecks = async () => {
    const started = now();
    try {
      if (!flags.noChecks && mode !== 'refactor') {
        if (config.checks.length || config.setup?.length) io.err(`quorum: running ${config.setup?.length ?? 0} setup commands and ${config.checks.length} configured checks from the reviewed change in a disposable worktree; this executes the change's code and install scripts unless the setup command disables them (use --no-checks for untrusted changes)\n`);
        const checksTree = await createReviewWorktree(root, head, runner, warn, { checks: true });
        try {
          const options = { timeoutMs: (config.budget.checkTimeoutSeconds ?? 120) * 1000 };
          const setup = await runDeterministicChecks(config.setup ?? [], checksTree.path, dependencies.checkRunner ?? runCommand, options);
          if (!setup.passed) checks = setup;
          else {
            const checked = await runDeterministicChecks(config.checks, checksTree.path, dependencies.checkRunner ?? runCommand, options);
            checks = { passed: checked.passed, results: [...setup.results, ...checked.results] };
          }
        }
        finally { try { await checksTree.cleanup(); } catch (error) { warn(`Checks worktree cleanup failed: ${String(error)}`); } }
      }
    } finally { checksMs = Math.max(0, now() - started); }
  };
  // Observe rejection immediately, including failures before the cascade is entered.
  const startChecks = () => runChecks().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  let checksPending = parallelChecks ? startChecks() : undefined;
  const joinChecks = async () => {
    const settled = await checksPending!;
    if (!settled.ok) throw settled.error;
    context.checksContext = flags.noChecks ? 'Checks skipped (--no-checks).' : checkEvidence(checks?.results ?? []);
    if (parallelChecks && checks?.results.some(check => !check.timedOut && check.exitCode !== 0)) warn('Deterministic checks failed after triage had started; triage ran without that context.');
  };
  try {
    const ruleChecks = flags.noChecks ? null : await runRules(deterministicRules, context);
    ruleChecks?.notes.forEach(warn);
    const evidence = mode === 'refactor' ? await runRefactorEvidence(context, config, {
      root, mutation: flags.mutation === true, gitRunner: runner, checkRunner: dependencies.checkRunner ?? runCommand, warn,
      announce: message => io.err(message.endsWith('\n') ? message : message + '\n'),
      ...(deterministicOnly ? { skipCodegraph: true } : { contextRunner: dependencies.contextRunner ?? runCommand }),
    }) : undefined;
    if (evidence) context.refactorSummary = evidence.summary;
    const providers = reviewProviders(config, dependencies);
    snapshot = await refreshQuota(providers, catalog, snapshot,
      deterministicOnly ? [] : [...Object.values(config.tiers).flat(), ...Object.values(config.escalate.routes ?? {}).flat()], now);
    checksPending ??= startChecks();
    if (parallelChecks) context.checksContext = CONCURRENT_CHECKS_CONTEXT;
    else await joinChecks();
    const budget = new RunBudget(config.budget, { ...systemClock, now });
    // Refactor already queried bounded callers for its blast radius; do not spend that cap twice.
    const enrichment = mode === 'refactor' ? { perFile: new Map<string, string>(), notes: [] } : await selected.provider.enrich(context, reviewChunks(context).chunks, {
      runner: dependencies.contextRunner ?? runCommand, deadlineMs: budget.remainingMs,
    });
    context.providerContext = enrichment.perFile;
    for (const note of enrichment.notes) context.contextNotes.push(note);
    const chunkCount = deterministicOnly ? 0 : reviewChunks(context).chunks.length;
    config.budget = resolveBudget(config.budget, chunkCount);
    Object.assign(budget.limits, config.budget);
    if (config.budget.maxCallsExplicit === false && config.budget.maxCalls > 12) {
      io.err(`quorum: call budget ${config.budget.maxCalls} (auto-scaled from ${chunkCount} chunks; set budget.maxCalls to pin it)\n`);
    }
    // Establish the review baseline after context, while retaining the earlier write check.
    const afterContext = await checkoutSnapshot(root, runner);
    const contextChange = checkoutDifference(baseline, afterContext);
    if (contextChange) throw new Error(contextChange);
    baseline = afterContext;
    const runId = `qrm-${randomUUID()}`;
    const timestamp = new Date(now()).toISOString();
    const verificationTree = deterministicOnly ? undefined : await createReviewWorktree(root, head, runner, warn);
    const attachmentRoot = verificationTree?.path ?? path.join(root, '.quorum', runId);
    const imageDirectory = `${attachmentRoot}-images`;
    const copyDirectory = `${attachmentRoot}-copy`;
    const cache = flags.noCache || deterministicOnly ? undefined : diskCache(path.join(root, '.quorum', 'cache'), warn, root, dependencies.cacheHome);
    let result: ReviewResult;
    try {
      if (!deterministicOnly) try { await atomicWrite(quotaFile, JSON.stringify(snapshot), root); } catch (error) { warn(`Quota write failed: ${String(error)}`); }
      for (const file of context.contract?.copy ?? []) {
        const destination = path.join(copyDirectory, file.file);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content);
      }
      if (flags.images) context.images = await copyImages(path.resolve(root, flags.images), imageDirectory);
      const changedBefore = checkoutDifference(baseline, await checkoutSnapshot(root, runner));
      if (changedBefore) throw new Error(changedBefore);
      if (flags.reproduce && config.reproduce.allowInstallScripts) warn('Reproduction preparation: install scripts are enabled (allowInstallScripts=true); preparation has network access to fetch packages.');
      const cascade: CascadeResult = deterministicOnly ? {
        callBudget: callBudgetMetadata(config.budget),
        reviewedFamilies: [], cacheHits: 0, findings: [], unconfirmed: [], related: [], warnings: [], errors: [], calls: [], ledgerDraft: [],
        coverage: { reviewedFiles: [...context.touchedFiles], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: evidence?.available === true },
      } : await runCascade(context, config, providers, { saveDroppedOutput: rawOutputWriter(root, runId), ...(parallelChecks ? { beforeConfirmation: joinChecks } : {}), budget, catalog, quotaSnapshot: snapshot, gitRunner: runner, verificationRoot: verificationTree?.path, copyVerificationRoot: copyDirectory, cache,
        ...(flags.reproduce ? { reproduce: (finding, proposal, remainingMs) => reproduceBlocker(finding, proposal, context, config,
          dependencies.containerRunner ?? runCommand, { ...dependencies.reproductionOptions, gitRunner: runner, deadlineMs: remainingMs,
            noHostPrompt: flags.noHostPrompt, warn, display: text => io.err(text) }) } : {}) });
      const changed = checkoutDifference(baseline, await checkoutSnapshot(root, runner));
      if (changed) { cascade.errors.push(changed); cascade.findings = []; cascade.unconfirmed = []; cascade.pointsAtChange = []; cascade.rejectedOnConfirmation = []; cascade.coverage.complete = false; }
      const clean = !verificationTree || await isClean(verificationTree.path, runner);
      if (!clean) { cascade.errors.push('Verification worktree changed; run aborted.'); cascade.findings = []; cascade.unconfirmed = []; cascade.pointsAtChange = []; cascade.rejectedOnConfirmation = []; cascade.coverage.complete = false; }
      const families = [...cascade.reviewedFamilies];
      // Cached reviews are still independent reviews by the original model family.
      // Confirming families count too: a finding confirmed by another family was reviewed by it.
      for (const f of [...cascade.findings, ...cascade.unconfirmed]) {
        for (const family of [f.family, ...(f.confirmationFamilies ?? [])]) if (!families.includes(family)) families.push(family);
      }
      if (context.authorFamily && families.length === 1 && families[0] === context.authorFamily) warn('Independence warning: the author family was the only reviewer available.');
      const today = new Date(now()).toISOString().slice(0, 10);
      const confirmed = applySuppressions(cascade.findings, suppressions, today);
      const unconfirmed = applySuppressions(cascade.unconfirmed, suppressions, today);
      const points = applySuppressions(cascade.pointsAtChange ?? [], suppressions, today);
      cascade.findings = confirmed.active; cascade.unconfirmed = unconfirmed.active;
      if (cascade.pointsAtChange) cascade.pointsAtChange = points.active;
      const suppressed = [...confirmed.suppressed, ...unconfirmed.suppressed, ...points.suppressed];
      for (const note of new Set([...suppressionNotes, ...confirmed.warnings, ...unconfirmed.warnings, ...points.warnings])) warn(note);
      const failingBlocker = [...cascade.findings, ...cascade.unconfirmed.filter(f => f.family !== 'local' || (f.confirmationFamilies?.length ?? 0) >= 2)]
        .some(f => f.severity === 'BLOCKER' && (!flags.allowUnproven || (f.confirmationFamilies?.length ?? 0) >= 2));
      const verdict = evidence ? evaluateRefactorVerdict(evidence, cascade, flags.allowApiChange === true, ruleChecks) : undefined;
      if (evidence && !evidence.available) cascade.coverage.complete = false;
      // The awaited checks callback assigns this value; TypeScript cannot follow that assignment.
      const completedChecks = checks as ReviewResult['checks'];
      for (const check of completedChecks?.results ?? []) if (check.timedOut) {
        cascade.coverage.complete = false;
        const message = `check "${check.argv.join(' ')}" timed out after ${check.timeoutMs / 1000}s; raise budget.checkTimeoutSeconds`;
        warn(message); io.err(`quorum: ${message}\n`);
      }
      // A check that exits non-zero is evidence shown in the report; it does not decide the exit code (the
      // repository's own CI does). Only a timeout acts: it makes coverage incomplete above.
      const exitCode = verdict ? verdict.exitCode : failingBlocker || ruleChecks?.passed === false ? 1 : cascade.errors.length || !cascade.coverage.complete ? 2 : 0;
      result = { ...cascade, suppressed, runId, timestamp, mode, range, headSha: head, baseSha: context.baseCommit, checks, ruleChecks,
        ...(evidence && verdict ? { refactor: { ...evidence, ...verdict, allowApiChange: flags.allowApiChange === true, modelReview: !deterministicOnly } } : {}),
        ...(mode === 'contract' ? { clauses: contractClauses(context.rulesContent ?? ''), contractFiles: context.contract!.groups.map(group => ({ file: group.file.file, imports: group.imports.map(file => file.file) })), copyFiles: context.contract!.copy.map(file => file.file) } : {}),
        criteria: mode === 'feature' ? acceptanceCriteria(context.specContent ?? '') : [], inventory: inventoryFeatures(context.inventoryContent ?? ''), families, exitCode };
      if (cache && !baseline.status.trim() && clean && !cascade.errors.length && !cascade.calls.some(call => call.status === 'dirty')) await cache.flush();
      const entries = cascade.ledgerDraft.flatMap(draft => Array.from({ length: draft.callsUsed }, (_, index) => ({ ...draft,
        ...(index < draft.callsUsed - 1 ? { rawFindingsCount: 0, verifiedFindingsCount: 0, rejectedFindingsCount: 0, tokensReported: undefined, durationMs: 0, timedOutCalls: 0, rejectionReasons: {} } : {}),
        callsUsed: 1, runId, timestamp, coverageComplete: cascade.coverage.complete })));
      try { await (dependencies.appendLedger ?? appendLedger)(entries, path.join(root, '.quorum', 'ledger.jsonl'), root); }
      catch (error) { warn(`Ledger write failed: ${String(error)}`); }
      try {
        await (dependencies.appendFindings ?? appendFindings)(
          [...historyEntries([...result.findings, ...result.unconfirmed, ...(result.pointsAtChange ?? [])], { runId, timestamp, mode }),
            ...historyEntries(suppressed, { runId, timestamp, mode }).map(entry => ({ ...entry, suppressed: true }))],
          path.join(root, '.quorum', 'findings.jsonl'), root);
      } catch (error) { warn(`Findings history write failed: ${String(error)}`); }
    } finally {
      try { await rm(copyDirectory, { recursive: true, force: true }); } catch (error) { warn(`Copy cleanup failed: ${String(error)}`); }
      try { await rm(imageDirectory, { recursive: true, force: true }); } catch (error) { warn(`Image cleanup failed: ${String(error)}`); }
      try { await verificationTree?.cleanup(); } catch (error) { warn(`Review worktree cleanup failed: ${String(error)}`); }
    }
    for (const warning of warnings) if (!result.warnings.includes(warning)) result.warnings.push(warning);
    result.durations = { checks: checksMs, triage: result.durations?.triage ?? 0, escalation: result.durations?.escalation ?? 0, confirmation: result.durations?.confirmation ?? 0, total: Math.max(0, now() - reviewStarted) };
    result.checksParallel = parallelChecks;
    const code = await outputReview(result, flags, root, io);
    if (io.isTTY || flags.verbose) io.err(completionTiming(result.durations, parallelChecks) + '\n');
    return code;
  } catch (error) {
    const settled = await checksPending;
    if (settled && !settled.ok && settled.error !== error) {
      throw new AggregateError([error, settled.error], `Review failed: ${String(error)}; deterministic checks failed: ${String(settled.error)}`);
    }
    throw error;
  } finally { await checksPending; }
}

async function outputReview(result: ReviewResult, flags: ParsedFlags, root: string, io: CliIo): Promise<number> {
  result.suppressed ??= [];
  result.dropped ??= [];
  async function save(file: string, render: () => string, label: string): Promise<void> {
    try { await atomicWrite(path.resolve(root, file), render(), root); }
    catch (error) {
      const message = `${label} write failed: ${String(error)}`;
      result.warnings.push(message); io.err(`quorum: ${message}\n`);
    }
  }
  await save(flags.out ?? `.quorum/reports/${result.runId}.md`, () => generateMarkdownReport(result), 'Report');
  if (flags.sarif) await save(flags.sarif, () => generateSarifReport([...result.findings, ...result.unconfirmed.filter(f => f.family !== 'local')], result), 'SARIF');
  if (flags.json || flags.format === 'json') io.out(JSON.stringify(result, null, 2) + '\n');
  else io.out(generateMarkdownReport(result));
  return result.exitCode;
}
