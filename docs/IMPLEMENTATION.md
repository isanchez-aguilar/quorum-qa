# Implementation Plan: Quorum (v1)

> **Document purpose:** Build-ready implementation plan for Quorum milestones M0 to M6, expanding [PLAN.md](PLAN.md) into concrete tasks, types, algorithms, test fixtures, and interfaces. PLAN.md wins on any conflict.
>
> **Provenance:** drafted by Gemini 3.1 Pro (High) through `agy`, read-only, on 2026-10-12. Claude then checked it against PLAN.md, the installed CLIs and a live probe, and corrected it. The corrections are listed in [Review corrections](#review-corrections) at the end; everything else is Gemini's draft.

---

## Deterministic check timeouts

`budget.checkTimeoutSeconds` is an integer from 30 to 3600 (default 120), applied
per setup/check command in sequential and concurrent review paths. Each result
records `timeoutMs` alongside `timedOut`. Markdown counts timeouts separately and
prints `TIMED OUT after <N>s`; SARIF carries check results and timeout notifications.
Timeouts make coverage INCOMPLETE (exit 2) and warn
`check "<argv>" timed out after <N>s; raise budget.checkTimeoutSeconds`.
Confirmation context says `timed out`. A check that exits non-zero is shown in the
report but never changes the exit code; BLOCKERs and
error-severity rules take precedence with exit 1. Setup timeouts skip later checks.
Refactor/runtime timeout policies are unchanged; this repo uses 600 seconds.
The existing runner kills Windows trees with `taskkill /T /F /PID` and POSIX
process groups with SIGKILL; fake-spawn regressions verify both paths.

## Review fixes batch A

- **C1 diff-marker recall fix:** verification removes quote-side hunk and numbered prompt prefixes (`123: `, `123 | ` and `file:123: `), and first-column added/context markers only when the resulting line matches HEAD. Existing leading unary plus is preserved. Removed-only quotes report `quote is removed code from the diff`; mixed quotes must retain at least 60% of their original non-space characters. Successful normalization records `stripped diff markers from the quote`, preserving the original evidence and C1 semantic checks. Regression tests cover the five benchmark snippets and a fake-provider cascade.

- **C1:** semantic verification retains grouping brackets and operators, including ternary punctuation; ordinary quote style and trailing separators remain tolerated, while template literals retain their meaning.
- **C2:** negation tokens are retained and trigger negation parity gates strong merges. Shared absence alone does not establish a possibly-related annotation.
- **C3:** disk cache entries carry HMAC-SHA256 over `[version, key, model, rawOutput]`, checked with `timingSafeEqual`. A lazily created, exclusive 32-byte user key lives at `~/.quorum/cache.key` (0600 where supported); unavailable keys disable caching with a warning. Unsigned or forged entries miss. Cache home is injectable for synthetic tests.
- **C4:** verifier read errors are distinguished from absent evidence and retained in `coverage.lostFindings` as `verifier read error`, with file warnings and incomplete coverage.
- **P1:** interrupted or inconsistent reports carry an infrastructure marker; a passing base additionally requires exit 0, otherwise reproduction remains unproven.
- **P2:** failure details are paired with messages by index. Mismatched detail counts produce unknown failures, never assertion proof.
- **P3:** infrastructure detection scans each line a constant number of times, including worker, cache-permission and missing-command patterns. Regressions cover 256 KiB/1 MiB inputs and best-of-five 64/256 KiB scaling below 8.
- **K2:** reproduction fences use an iterative maximum. Unbounded confidence/quota reductions and review-note/finding appends avoid function-argument spreads; runtime maxima remain bounded by 20 flows and 50 steps per flow.
- **K3:** untrusted Markdown prose escapes brackets, backslashes, pipes, newlines and HTML openers throughout review/refactor output, including rule notes and independence warnings. Runtime output already encodes Markdown delimiters; regression tests cover it too. Proposed code inside fences is preserved.

Regression probes are named by item ID in `tests/unit/review-batch-a*.test.ts`; reporter-specific cases also cover refactor output. Historical token expectations and passing-report fixtures were updated to the corrected semantics, rather than preserving discarded grouping/negation or contradictory `success: false` evidence.

## 1. Repository Layout

Every directory and source file for v1, with a one-line summary of its responsibility:

```
quorum/
├── .gitignore                          # Ignores node_modules, build artifacts, test worktrees, and local caches.
├── package.json                        # Project manifest, CLI bin registration, scripts, and pinned dependencies.
├── tsconfig.json                       # Strict TypeScript compiler options targeting Node 22 ESM.
├── vitest.config.ts                    # Vitest runner configuration for unit and synthetic integration tests.
├── LICENSE                             # Apache-2.0 legal license text.
├── NOTICE                              # Attribution and copyright notice.
├── AGENTS.md                           # Operational contract and coding constraints for AI contributors.
├── bin/
│   └── quorum.js                       # Executable CLI entrypoint shim with #!/usr/bin/env node.
├── src/
│   ├── index.ts                        # Main library barrel exporting core programmatic APIs.
│   ├── types/
│   │   └── index.ts                    # Central TypeScript definitions, interfaces, enums, and domain models.
│   ├── cli/
│   │   ├── index.ts                    # Main command router parsing argv and dispatching subcommands.
│   │   └── args.ts                     # Strict zero-dependency CLI argument tokenizer and flag validator.
│   ├── config/
│   │   ├── index.ts                    # Configuration loader reading and resolving quorum.config.json.
│   │   └── schema.ts                   # Runtime schema validator and default value applicator for config.
│   ├── verifier/
│   │   ├── index.ts                    # Pipeline coordinator validating findings against target filesystem.
│   │   ├── path.ts                     # Worktree path canonicalization, root-confinement, and traversal rejection.
│   │   ├── lines.ts                    # File boundary verification, line index bounds checking, and line drift detection.
│   │   └── quote.ts                    # CRLF/whitespace normalization, window search, and fuzzy quote matching.
│   ├── dedupe/
│   │   ├── index.ts                    # Finding deduplication coordinator clustering and merging reports.
│   │   ├── cluster.ts                  # Proximity clustering by file and line distance window.
│   │   └── similarity.ts               # Token-level Jaccard and Levenshtein similarity metric calculations.
│   ├── context/
│   │   ├── index.ts                    # Context assembly extracting diff hunks, symbols, and spec text.
│   │   ├── git.ts                      # Safe git spawn operations (diff, rev-parse, status, show).
│   │   └── blame.ts                    # Git blame inspector determining finding origin (introduced vs pre-existing).
│   ├── checks/
│   │   ├── index.ts                    # Deterministic pre-flight runner executing repo lint, tsc, and test checks.
│   │   └── resolver.ts                 # Windows (.cmd/.bat) and POSIX binary resolver rejecting metacharacters.
│   ├── catalog/
│   │   ├── index.ts                    # Model catalog registry mapping models to tiers and families.
│   │   ├── tiers.ts                    # Tier fallback resolution and model tier selector.
│   │   └── groups.ts                   # Quota group tracker ensuring shared quotas are not spent twice.
│   ├── providers/
│   │   ├── index.ts                    # Provider factory and adapter registry.
│   │   ├── types.ts                    # Adapter contract and injected CommandRunner type definitions.
│   │   ├── fake.ts                     # Deterministic in-memory fake provider adapter for zero-quota testing.
│   │   ├── agy.ts                      # Antigravity (agy) adapter running read-only plan models in worktrees.
│   │   ├── codex.ts                    # OpenAI Codex CLI adapter executing read-only headless exec commands.
│   │   ├── claude.ts                   # Claude Code CLI adapter stub executing read-only headless prompts.
│   │   └── qwen.ts                     # Local OpenAI-compatible HTTP adapter stub for local inference endpoints.
│   ├── cascade/
│   │   ├── index.ts                    # Cascade orchestrator driving triage pass and conditional escalation.
│   │   ├── budget.ts                   # Per-run call and time budget tracker enforcing hard ceilings.
│   │   └── planner.ts                  # Review execution plan builder for live execution and --dry-run output.
│   ├── modes/
│   │   ├── index.ts                    # Review mode dispatcher routing to feature or redesign workflows.
│   │   ├── feature.ts                  # Feature mode handler validating diff against spec acceptance criteria.
│   │   └── redesign.ts                 # Redesign mode handler auditing feature parity inventory and visual assets.
│   ├── prompts/
│   │   ├── index.ts                    # Prompt assembler combining stable prefixes, context, and mode suffixes.
│   │   └── templates.ts                # Structured prompt templates enforcing read-only constraints and JSON schema.
│   ├── doctor/
│   │   ├── index.ts                    # Pre-flight diagnostic runner verifying PATH, logins, models, quota, and sandbox rules.
│   │   └── checks.ts                   # Discrete diagnostic check functions for agy, codex, git, and runtimes.
│   ├── reporters/
│   │   ├── index.ts                    # Reporter dispatcher writing formatted results to stdout and disk.
│   │   ├── markdown.ts                 # Markdown report generator rendering summary tables and finding cards.
│   │   └── sarif.ts                    # OASIS SARIF 2.1.0 JSON generator for static analysis tooling.
│   ├── storage/
│   │   ├── ledger.ts                   # Append-only JSONL run ledger tracking historical performance and metrics.
│   │   └── cache.ts                    # Content-addressed disk cache keyed by hash of file, prompt, and model.
│   └── reproduce/
│       ├── index.ts                    # Opt-in BLOCKER reproduction coordinator managing test life cycles.
│       ├── worktree.ts                 # Disposable git worktree lifecycle manager creating throwaway checkouts.
│       ├── isolation.ts                # Container sandbox runner (Docker/Podman) executing untrusted proposed tests.
│       └── evaluator.ts                # Test execution reporter verifying assertion failure, compile state, and base pass.
└── tests/
    ├── fixtures/
    │   ├── diffs/                      # Synthetic unified diff files for context builder testing.
    │   ├── specs/                      # Synthetic Markdown feature specs and inventory documents.
    │   ├── sources/                    # Synthetic source files for verifier line/quote testing.
    │   └── responses/                  # Golden mock CLI outputs for agy, codex, and quota endpoints.
    ├── unit/
    │   ├── verifier.test.ts            # Unit tests for path normalization, line checking, and fuzzy quote matching.
    │   ├── dedupe.test.ts              # Unit tests for finding clustering, distance, similarity, and conflict resolution.
    │   ├── resolver.test.ts            # Unit tests for Windows CMD shim resolution and shell metacharacter rejection.
    │   ├── budget.test.ts              # Unit tests for call, time, and quota-floor budgeting logic.
    │   ├── adapters.test.ts            # Adapter tests on recorded golden CLI outputs (agy, codex).
    │   └── config.test.ts              # Unit tests for config loading, validation, and defaults.
    └── integration/
        ├── pipeline.test.ts            # End-to-end pipeline integration tests running against the FakeProvider.
        ├── context.test.ts             # Context builder and git blame tests on temporary synthetic repos.
        ├── modes.test.ts               # Feature and redesign mode tests against the FakeProvider.
        ├── doctor.test.ts              # Synthetic doctor diagnostic suite testing pass/fail message output.
        └── reproduce.test.ts           # Reproduction lane integration tests verifying container execution and isolation.
```

---

## 2. Core Types as TypeScript Interfaces

```typescript
// src/types/index.ts

export type Severity = 'BLOCKER' | 'IMPORTANT' | 'OPTIONAL';

export type Origin = 'introduced' | 'pre-existing' | 'improvement';

export type Family = 'google' | 'anthropic' | 'openai' | 'local';

export type Tier = 'triage' | 'review' | 'confirm' | 'visual';

export interface Finding {
  severity: Severity;
  origin: Origin;
  file: string;
  line: number;
  trigger: string;
  impact: string;
  evidence_quote: string;
  fix: string;
  provider: string;
  model: string;
  family: Family;
  confidence: number;
  verified?: boolean;
  verification_note?: string;
  reproduction?: ReproductionProposal;
  // Set by dedupe (M1 fixes): findings at the same place whose text overlaps but is not strong
  // enough to merge. A pointer for a human; never changes severity or confidence.
  possibly_related?: Array<{ provider: string; model: string; line: number; similarity: number }>;
}

export interface CatalogEntry {
  id: string;
  family: Family;
  defaultTier: Tier;
  quotaGroup: string;
  supportsImages?: boolean;
  contextWindow?: number;
  notes?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    stdin?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    windowsVerbatimArguments?: boolean;   // set by the cmd.exe resolver so Node doesn't re-quote
  }
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface ProviderResult {
  rawOutput: string;
  findings: Finding[];
  reproductionProposals?: ReproductionProposal[];
  durationMs: number;
  tokensUsed?: {
    prompt: number;
    completion: number;
  };
  worktreeClean: boolean;
  error?: string;
}

export interface ReviewContext {
  mode: 'feature' | 'redesign';
  diff: string;
  baseCommit: string;
  headCommit: string;
  worktreeRoot: string;
  touchedFiles: string[];
  specContent?: string;
  inventoryContent?: string;
  images?: string[];
  rulesContent?: string;
  authorFamily?: Family;
}

export interface QuorumConfig {
  base: string;
  checks: string[][];              // required: no default
  author?: string;                 // alias ("claude", "codex", "gemini", "qwen") or a Family; resolved by resolveAuthorFamily()
  tiers: Record<Tier, string[]>;
  escalate: {
    focus: string[];
    belowConfidence: number;
  };
  budget: {
    maxCalls: number;
    maxMinutes: number;
    quotaFloorPercent: number;
  };
  reproduce: {
    isolation: 'container' | 'interactive';
    image?: string;               // default node:22-bookworm-slim, pinned by digest at M6
    timeoutSeconds?: number;      // hard limit per test run, default 120
    testGlobs: string[];
    testCommand: string[];
  };
  jules?: {
    enabled: boolean;
    repo: string;
    maxSessionsPerRun: number;
  };
  qwen?: {
    endpoint: string;
  };
}

export interface LedgerEntry {
  runId: string;
  timestamp: string;
  mode: 'feature' | 'redesign';
  headSha: string;
  baseSha: string;
  provider: string;
  model: string;
  family: Family;
  rawFindingsCount: number;
  verifiedFindingsCount: number;
  rejectedFindingsCount: number;
  durationMs: number;
  callsUsed: number;
  timedOutCalls: number;          // calls killed at the deadline              // subscription CLIs have no per-call price; Quorum never estimates dollars
  tokensReported?: number;        // only when the CLI itself reports tokens
  reproducedBlockersCount: number;
}

export interface CacheKey {
  fileHash: string;
  promptHash: string;
  model: string;
  serializedKey: string;
}

export interface ReproductionProposal {
  path: string;
  content: string;
  expect: string;
  status?: 'pending' | 'reproduced' | 'not-reproduced' | 'rejected' | 'unproven';
  failureReason?: string;
}

// Parsed from the test runner's JSON reporter (vitest or jest). Quorum never parses human-readable output.
export interface TestReport {
  runner: 'vitest' | 'jest';
  tests: Array<{
    file: string;                 // path relative to the worktree root
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    failureKind?: 'assertion' | 'error' | 'import' | 'syntax' | 'timeout';
    message?: string;             // first line of the failure message, compared with `expect`
  }>;
  suiteErrors: string[];          // load or compile errors that prevented tests from running
}

export interface ProviderAdapter {
  readonly name: string;
  readonly defaultFamily: Family;
  readonly run: CommandRunner;

  probe(modelId: string): Promise<{ available: boolean; error?: string }>;

  getQuota(modelId: string): Promise<{
    group: string;
    remainingPercent: number;
    resetTime?: string;
  }>;

  executeReview(
    context: ReviewContext,
    modelId: string,
    prompt: string
  ): Promise<ProviderResult>;
}
```

---

## 3. Milestones (M0 to M6)

### Milestone M0: Skeleton & Configuration
- **Scope:** Node 22 + TypeScript (strict) ESM repository setup, `bin/quorum.js`, zero-dependency CLI router, configuration loader with schema validation.
- **Tasks (Ordered):**
  1. Initialize package structure: ESM `"type": "module"`, pinned dependencies, strict `tsconfig.json`, `vitest.config.ts`.
  2. Implement `src/types/index.ts` defining all domain interfaces.
  3. Implement `src/cli/args.ts` to parse CLI flags (`--help`, `--version`, `--mode`, `--diff`, `--spec`, `--inventory`, `--images`, `--rules`, `--author`, `--since`, `--dry-run`, `--reproduce`, `--allow-unproven`) without external libraries. Unknown flags and a value flag followed by another flag are usage errors (exit 2).
  4. Implement `src/config/schema.ts` and `src/config/index.ts` loading and validating `quorum.config.json` with fallback defaults.
  5. Implement `bin/quorum.js` and `src/cli/index.ts` binding `--help` and subcommands.
  6. Add unit tests for configuration parsing and argument tokenization.
- **Files Touched:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `bin/quorum.js`, `src/types/index.ts`, `src/cli/args.ts`, `src/cli/index.ts`, `src/config/index.ts`, `src/config/schema.ts`, `tsconfig.build.json` (`pnpm build` emits only `src/` into `dist/`), `tests/unit/config.test.ts`, `tests/unit/args.test.ts`, `tests/integration/cli.test.ts`. The library barrel `src/index.ts` is created in M3, when there is a public API to export.
- **Public Functions & Signatures:**
  - `parseArgs(argv: string[]): { command: string; flags: Record<string, any>; positionals: string[] }`
  - `loadConfig(configPath?: string): Promise<QuorumConfig>`
  - `validateConfig(raw: unknown): QuorumConfig`
  - `resolveAuthorFamily(author: string): Family` (claude→anthropic, codex→openai, gemini→google, qwen→local; a Family passes through; anything else is an error)
- **Test Cases:**
  - `testArgs_HelpFlag`: Input `["--help"]` -> Expected `{ flags: { help: true }, command: "help" }`.
  - `testArgs_ReviewFlags`: Input `["review", "--mode", "feature", "--diff", "origin/main...HEAD"]` -> Expected `{ command: "review", flags: { mode: "feature", diff: "origin/main...HEAD" } }`.
  - `testConfig_ChecksRequired`: Input `{}` -> Expected validation error: `checks is required`.
  - `testConfig_PlanExample`: Input the full example config from PLAN.md -> Expected it loads unchanged, and `author: "claude"` resolves to `anthropic`.
  - `testConfig_UnknownAuthor`: Input `{ checks: [["npm","test"]], author: "bard" }` -> Expected validation error naming the allowed aliases.
  - `testArgs_AuthorAndRules`: Input `["review", "--mode", "redesign", "--rules", "r.md", "--author", "claude"]` -> Expected both flags parsed.
  - `testConfig_InvalidChecks`: Input `{ checks: "pnpm lint" }` -> Expected validation error: `checks must be an array of string arrays`.
  - `testConfig_MissingBaseFallback`: Input `{ checks: [["npm", "test"]] }` -> Expected `base` defaults to `"origin/main"`.
- **Acceptance Criteria:** `quorum --help` exits with code 0 and prints usage; `loadConfig` passes 100% of schema tests.
- **Dependencies:** None.
- **Parallel Tasks:** Tasks 2, 3, and 4 can run in parallel.
- **Suggested Assignment:** Implementer: `claude:sonnet` (Anthropic). Reviewer: `agy:gemini-3.1-pro-high` (Google).

---

### Milestone M1: Verifier & Dedupe Core
- **Scope:** Implementation of finding verification against code and cross-provider deduplication algorithm.
- **Tasks (Ordered):**
  1. Implement `src/verifier/path.ts` ensuring path normalization, root-confinement, and path traversal rejection.
  2. Implement `src/verifier/lines.ts` checking line bounds and detecting line drift.
  3. Implement `src/verifier/quote.ts` with CRLF/whitespace normalization, 10-line search radius, and fuzzy line matching.
  4. Implement `src/verifier/index.ts` wiring the complete verification pipeline.
  5. Implement `src/dedupe/similarity.ts` providing token Jaccard and Levenshtein metrics.
  6. Implement `src/dedupe/cluster.ts` providing proximity grouping, family confidence boosting, and severity resolution.
  7. Implement `src/dedupe/index.ts` integrating deduplication.
  8. Build synthetic fixtures and run test tables.
- **Files Touched:** `src/verifier/path.ts`, `src/verifier/lines.ts`, `src/verifier/quote.ts`, `src/verifier/index.ts`, `src/dedupe/similarity.ts`, `src/dedupe/cluster.ts`, `src/dedupe/index.ts`, `tests/unit/verifier.test.ts`, `tests/unit/dedupe.test.ts`, `tests/fixtures/sources/*`.
- **Public Functions & Signatures:**
  - `verifyFinding(worktreeRoot: string, finding: Finding): Promise<{ verified: boolean; correctedFinding?: Finding; reason?: string }>`
  - `normalizePath(root: string, relativePath: string): string | null`
  - `normalizeQuote(raw: string): string`
  - `calculateSimilarity(a: string, b: string): number`
  - `dedupeFindings(findings: Finding[]): Finding[]`
- **Test Cases:**
  - (Covered in detail in Sections 4 & 5 tables: 15+ verifier test cases and 10+ dedupe test cases).
- **Acceptance Criteria:** Table tests over synthetic fixtures pass 100%, specifically handling non-existent files, off-by-5000 lines with real quotes, and cross-family deduplication confidence boosts.
- **Dependencies:** M0 (`src/types/index.ts`).
- **Parallel Tasks:** Verifier (`src/verifier/*`) and Dedupe (`src/dedupe/*`) can be developed concurrently.
- **Suggested Assignment:** Implementer: `agy:gemini-3.1-pro-high` (Google). Reviewer: `claude:opus` (Anthropic).

---

### Milestone M2: Context Builder, Git Blame & Windows Resolver
- **Scope:** Git diff extraction, origin tagging via `git blame`, deterministic checks runner, and spawn-safe Windows command resolver.
- **Tasks (Ordered):**
  1. Implement `src/checks/resolver.ts` resolving executables via `PATH`/`PATHEXT`, escaping `.cmd`/`.bat` arguments for `cmd.exe /d /s /c`, and rejecting shell metacharacters (`& | < > ^ % ! ; \r \n "`). For `.cmd`/`.bat` the command line passed to `cmd.exe` always starts with the **absolute, quoted path** that PATH resolution returned, never the bare name, so a same-named shim in the working directory can't win. The spawn uses `windowsVerbatimArguments: true` so Node doesn't re-quote it.
  2. Implement `src/checks/index.ts` running deterministic checks via safe `child_process.spawn`.
  3. Implement `src/context/git.ts` extracting unified diffs, changed files, and AST symbol context headers without shells.
  4. Implement `src/context/blame.ts` inspecting commit history at base commit to set `origin: introduced | pre-existing | improvement`.
  5. Implement `src/context/index.ts` building the complete `ReviewContext`.
  6. Add unit tests with synthetic git repositories generated in temporary directories (`git init`).
- **Files Touched:** `src/checks/resolver.ts`, `src/checks/index.ts`, `src/context/git.ts`, `src/context/blame.ts`, `src/context/index.ts`, `tests/unit/resolver.test.ts`, `tests/integration/context.test.ts`.
- **Public Functions & Signatures:**
  - `resolveCommand(command: string, args: string[]): { file: string; args: string[] }`
  - `runDeterministicChecks(checks: string[][], cwd: string, runner: CommandRunner): Promise<{ passed: boolean; failures: string[] }>`
  - `buildReviewContext(options: { base: string; head: string; cwd: string; mode: string }): Promise<ReviewContext>`
  - `determineOrigin(file: string, line: number, baseCommit: string, cwd: string, runner: CommandRunner): Promise<Origin>`
- **Test Cases:**
  - `testResolver_PosixDirect`: Input `("git", ["status"])` on POSIX -> Expected `{ file: "/usr/bin/git", args: ["status"] }`.
  - `testResolver_WindowsCmdShim`: Input `("pnpm", ["lint"])` on Windows, with PATH containing `C:\\Program Files\\nodejs` -> Expected `{ file: "<ComSpec, default C:\\Windows\\System32\\cmd.exe>", args: ["/d", "/s", "/c", "\"\"C:\\Program Files\\nodejs\\pnpm.cmd\" \"lint\"\""] }` (the outer quotes are the ones `/s` strips).
  - `testResolver_ShimInCwdIgnored`: A `pnpm.cmd` in the cwd and another on PATH -> Expected the PATH one's absolute path; the cwd is never searched.
  - `testResolver_PathWithSpaces`: An executable under a directory with spaces -> Expected it runs with the arguments intact.
  - `testResolver_MetacharacterInjection`: Input `("pnpm", ["lint; rm -rf /"])` -> Expected Error `Disallowed command metacharacter: ;`.
  - `testBlame_IntroducedLine`: Line touched in diff after base -> Expected `origin: "introduced"`.
  - `testBlame_PreexistingLine`: Line unchanged in diff and committed prior to base commit -> Expected `origin: "pre-existing"`.
- **Acceptance Criteria:** Resolver executes `.cmd` safely on Windows and rejects injection; context builder correctly classifies line origins against a synthetic git history.
- **Dependencies:** M0.
- **Parallel Tasks:** `src/checks/*` and `src/context/*` can run in parallel.
- **Suggested Assignment:** Implementer: `codex` (OpenAI). Reviewer: `claude:sonnet` (Anthropic).

---

### Milestone M3: Provider Abstraction, Catalog, Cascade & Dry-Run
- **Scope:** ProviderAdapter interface, zero-quota `FakeProvider`, model catalog, tier fallback, cascade routing, budget enforcement, and `--dry-run` display.
- **Tasks (Ordered):**
  1. Implement `src/providers/types.ts` and `src/providers/fake.ts` allowing programmatic canned responses.
  2. Implement `src/catalog/tiers.ts` and `src/catalog/groups.ts` managing model capabilities, quota groups, and independence constraints.
  3. Implement `src/cascade/budget.ts` tracking time and calls, checking quota floors.
  4. Implement `src/cascade/planner.ts` calculating execution paths and formatting `--dry-run`.
  5. Implement `src/cascade/index.ts` executing the cascade loop (Triage -> Escalate -> Verify -> Dedupe).
  6. Test the complete pipeline end-to-end against `FakeProvider`.
- **Files Touched:** `src/providers/types.ts`, `src/providers/fake.ts`, `src/catalog/index.ts`, `src/catalog/tiers.ts`, `src/catalog/groups.ts`, `src/cascade/budget.ts`, `src/cascade/planner.ts`, `src/cascade/index.ts`, `tests/unit/budget.test.ts`, `tests/integration/pipeline.test.ts`.
- **Public Functions & Signatures:**
  - `createExecutionPlan(context: ReviewContext, config: QuorumConfig, catalog: CatalogEntry[]): ExecutionPlan`
  - `executeCascade(context: ReviewContext, config: QuorumConfig, providers: Map<string, ProviderAdapter>): Promise<Finding[]>`
  - `formatDryRun(plan: ExecutionPlan): string`
  - `checkBudget(budget: QuorumConfig['budget'], currentCalls: number, startTimeMs: number): { allowed: boolean; reason?: string }`
- **Test Cases:**
  - `testDryRun_OutputsPlan`: Input synthetic context with `--dry-run` -> Expected formatted plan with 0 real calls and 0 quota spent.
  - `testCascade_EscalatesMoney`: Triage finding with trigger "currency rounding error" in focus list -> Escapes to confirm tier.
  - `testCascade_BelowConfidenceEscalation`: Triage finding with confidence 0.50 (< 0.70) -> Escapes to confirm tier.
  - `testBudget_CallCapExceeded`: Maximum calls 12 reached -> Further calls aborted; existing findings returned.
- **Acceptance Criteria:** Entire review pipeline executes from diff to final finding list against `FakeProvider` with zero real quota.
- **Dependencies:** M0, M1, M2.
- **Parallel Tasks:** `src/catalog/*` and `src/cascade/budget.ts` can run in parallel.
- **Suggested Assignment:** Implementer: `claude:sonnet` (Anthropic). Reviewer: `agy:gemini-3.1-pro-high` (Google).

---

### Milestone M4: Real Adapters (agy & codex) & Quorum Doctor
- **Scope:** Antigravity and Codex CLI adapters with disposable worktree write checks; `quorum doctor` pre-flight diagnostics.
- **Tasks (Ordered):**
  1. Implement `src/providers/agy.ts` wrapping `agy --model <id> --sandbox --output-format json --print=<prompt>` (no `--mode plan`; see Review corrections), with write-tree dirty validation. The prompt is an argument, so the adapter enforces the Windows ~32K command-line limit and sends surgical context.
  2. Implement `src/providers/codex.ts` wrapping `codex exec -C <dir> -s read-only -o <out> -` with stdin piping and retry logic.
  3. Implement `src/doctor/checks.ts` and `src/doctor/index.ts` verifying PATH, auth, models, quota, and sandbox rules.
  4. Test adapters with recorded golden CLI outputs.
  5. Conduct live probe validation (at most 3 approved calls with Isaac's sign-off).
- **Files Touched:** `src/providers/agy.ts`, `src/providers/codex.ts`, `src/doctor/checks.ts`, `src/doctor/index.ts`, `tests/unit/adapters.test.ts`, `tests/integration/doctor.test.ts`.
- **Public Functions & Signatures:**
  - `runAgyReview(context: ReviewContext, model: string, prompt: string, runner: CommandRunner): Promise<ProviderResult>`
  - `runCodexReview(context: ReviewContext, model: string, prompt: string, runner: CommandRunner): Promise<ProviderResult>`
  - `runDoctorDiagnostics(config: QuorumConfig, runner: CommandRunner): Promise<{ allPassed: boolean; results: DiagnosticResult[] }>`
- **Test Cases:**
  - `testAgy_DirtyWorktreeDiscard`: Adapter runs; untrusted model modifies `src/foo.ts` in worktree -> Findings discarded with warning.
  - `testCodex_RetryOnFirstFolderFailure`: First probe returns read error; retry succeeds -> Returns valid findings.
  - `testDoctor_MissingAgyWriteDenyRule`: Settings do not deny write tools -> `doctor` fails with configuration instructions.
- **Acceptance Criteria:** Adapters pass all golden output tests; `quorum doctor` runs and passes on the maintainer's machine.
- **Dependencies:** M3.
- **Parallel Tasks:** `src/providers/agy.ts` and `src/providers/codex.ts` can run in parallel.
- **Suggested Assignment:** Implementer: `agy:gemini-3.1-pro-high` (Google). Reviewer: `codex` (OpenAI).

---

### Milestone M5: Modes, Reporters, Ledger & Cache
- **Scope:** Feature and redesign review modes; Markdown and SARIF 2.1.0 reporters; append-only JSONL ledger; content-addressed disk cache.
- **Tasks (Ordered):**
  1. Implement `src/prompts/templates.ts` and `src/prompts/index.ts` generating stable prefixes and mode-specific suffixes.
  2. Implement `src/modes/feature.ts` auditing spec acceptance criteria and missing test proposals.
  3. Implement `src/modes/redesign.ts` auditing feature parity inventories and visual screenshot assets.
  4. Implement `src/storage/ledger.ts` logging runs to `.quorum/ledger.jsonl`.
  5. Implement `src/storage/cache.ts` managing content-addressed caches in `.quorum/cache/`.
  6. Implement `src/reporters/markdown.ts` and `src/reporters/sarif.ts`.
  7. End-to-end integration test with fake providers and report verification.
- **Files Touched:** `src/prompts/templates.ts`, `src/prompts/index.ts`, `src/modes/feature.ts`, `src/modes/redesign.ts`, `src/storage/ledger.ts`, `src/storage/cache.ts`, `src/reporters/markdown.ts`, `src/reporters/sarif.ts`, `tests/integration/modes.test.ts`.
- **Public Functions & Signatures:**
  - `runFeatureMode(context: ReviewContext, config: QuorumConfig): Promise<Finding[]>`
  - `runRedesignMode(context: ReviewContext, config: QuorumConfig): Promise<Finding[]>`
  - `generateMarkdownReport(findings: Finding[], context: ReviewContext): string`
  - `generateSarifReport(findings: Finding[]): string`
  - `appendLedger(entry: LedgerEntry, ledgerPath: string): Promise<void>`
  - `readCache(key: CacheKey, cacheDir: string): Promise<Finding[] | null>`
- **Test Cases:**
  - `testFeatureMode_UncoveredCriteria`: Spec lists 3 criteria; diff implements 2 -> Reports missing acceptance criteria finding.
  - `testRedesignMode_MissingOldFeature`: Inventory lists "Export CSV"; diff omits it -> Reports parity gap finding.
  - `testSarif_ValidOASISSchema`: Generated SARIF JSON parses and matches SARIF 2.1.0 schema specification.
  - `testCache_HitAvoidsProviderCall`: Same prompt and diff hash -> Cache hit returns cached findings without provider call.
- **Acceptance Criteria:** Mode audits report correct domain findings; SARIF output passes schema validator; ledger and cache record operations faithfully.
- **Dependencies:** M3, M4.
- **Parallel Tasks:** Reporters (`src/reporters/*`) and Storage (`src/storage/*`) can run in parallel.
- **Suggested Assignment:** Implementer: `claude:sonnet` (Anthropic). Reviewer: `agy:gemini-3.1-pro-high` (Google).

---

### Milestone M6: Reproduction Lane & Stubs
- **Scope:** Opt-in reproduction lane (`--reproduce`) in throwaway worktrees under container isolation; sandbox escape tests; `claude` and `qwen` adapter stubs; approved v1 smoke run.
- **Tasks (Ordered):**
  1. Implement `src/reproduce/worktree.ts` creating disposable git worktrees at head and base revisions.
  2. Implement `src/reproduce/isolation.ts` configuring container runners (Docker/Podman) with `--network none` and read-only mounts.
  3. Implement `src/reproduce/evaluator.ts` verifying test failure status, assertion vs syntax errors, and base commit passing.
  4. Implement `src/reproduce/index.ts` orchestrating the reproduction verification flow.
  5. Implement `src/providers/claude.ts` and `src/providers/qwen.ts` adapter stubs.
  6. Implement synthetic sandbox escape test verifying container security.
  7. Conduct Isaac-approved smoke test (at most 6 calls on real diff).
- **Files Touched:** `src/reproduce/worktree.ts`, `src/reproduce/isolation.ts`, `src/reproduce/evaluator.ts`, `src/reproduce/index.ts`, `src/providers/claude.ts`, `src/providers/qwen.ts`, `tests/integration/reproduce.test.ts`.
- **Public Functions & Signatures:**
  - `reproduceBlocker(finding: Finding, proposal: ReproductionProposal, context: ReviewContext, config: QuorumConfig, runner: CommandRunner): Promise<{ status: 'reproduced' | 'not-reproduced' | 'rejected' | 'unproven'; reason?: string }>` (receives the finding, so `origin` decides whether the base check runs)
  - `createDisposableWorktree(repoPath: string, commit: string): Promise<{ worktreePath: string; cleanup: () => Promise<void> }>` (always under `<repo>/.quorum/worktrees/`)
  - `writeProposedTest(worktreePath: string, relPath: string, content: string, testGlobs: string[]): Promise<{ absolute: string; relative: string }>` (the host path for writing and checking, and the path relative to the worktree root, which is what the container sees under `/work`)
  - `runIsolatedTest(worktreePath: string, testFile: string, config: QuorumConfig['reproduce'], runner: CommandRunner): Promise<{ timedOut: boolean; report: TestReport | null; exitCode: number }>` (runs **only** `testFile`)
  - `evaluateReproduction(report: TestReport, testFile: string, expect: string): 'assertion-failure-matching' | 'assertion-failure-other-message' | 'non-assertion-failure' | 'passed' | 'other-test-failed'` (head only)
  - `passedAtBase(report: TestReport, testFile: string): boolean`
- **Writing the proposed test safely (`writeProposedTest`), the same at head and at base:**
  1. Reject the path if it is absolute, contains `..` segments, NUL or `:` (Windows streams), or doesn't match `testGlobs`.
  2. Walk the parent directories from the worktree root down. Each one that exists must be a real directory, not a symlink or junction (`lstat`), and its `realpath` must stay inside the worktree's `realpath`. Missing ones are created one at a time with `mkdir` (not recursive), and checked again after creation.
  3. Create the file with flag `wx` (exclusive), so an existing file is never overwritten. If the file exists, the proposal is **rejected**.
  4. All of this happens before the container starts. Nothing is written outside `.quorum/worktrees/<id>/`.
- **Container contract (`isolation: "container"`):**
  - **Image:** `reproduce.image` (default `node:22-bookworm-slim`, pinned by digest at M6). Dependencies are installed in a **preparation step** that runs once per dependency-input hash (see M6 as built): same image, network **on**, the worktree mounted at `/work` read-only except for a named volume `quorum-deps-<dependency-input hash>` mounted at `/work/node_modules`, and the lockfile's own command picked by which lockfile exists. The preparation first **builds a derived image** `quorum-prep:<dependency-input hash>` from the base image, with network on, which installs the package manager the repo pins (the `packageManager` field of `package.json`, version included) with `npm install -g <manager>@<version>` into `/usr/local`, so it is available to any user and works offline. Then it runs the lockfile's own command in that image: `pnpm install --frozen-lockfile --ignore-scripts`, `npm ci --ignore-scripts` or `yarn install --immutable --mode=skip-build` (decision 13 governs the explicit opt-in). pnpm keeps its virtual store inside `node_modules`, so the volume is self-contained. The test step runs from the **derived image** and mounts the volume **read-only** at `/work/node_modules`, so nothing the test does can change it.
  - **Test step:** network **off** (`--network none`), non-root user (`--user 1000:1000`), `--read-only` root filesystem with a tmpfs `/tmp`, the worktree mounted read-write at `/work`, the dependency volume mounted read-only, `--memory` and `--pids-limit` caps, and a hard timeout (`reproduce.timeoutSeconds`, default 120) enforced by killing the container.
  - **Caches:** the test step sets `XDG_CACHE_HOME`, `npm_config_cache` and `TMPDIR` to the tmpfs `/tmp`. A runner that insists on writing inside the read-only `node_modules` (for example a `.vite` or `.cache` directory) fails with `EROFS` or `EACCES`. That is classified as infrastructure, not as a test result. The cache directory flag for the repo's runner is an ASSUMPTION to settle with the synthetic repo in M6.
  - **Missing or failing infrastructure:** no container runtime, a failed preparation step, `EROFS`/`EACCES` writing a cache, a missing manager, or a timeout of the container itself -> status `unproven` with the reason. The severity is not changed. An infrastructure failure is never read as "not reproduced".
- **Evaluation:** `reproduced` requires `assertion-failure-matching` at head, **in `testFile` only**. For `origin: introduced`, the same file must also give `passed` at base, with one exception: if the finding's file does not exist at the base SHA (new code), the test can't import it at base and there is no valid comparison. The status is then `unproven` ("new code: nothing to compare against"), the severity is **not** changed, and the report lists the proposed test for a human to run. It is never `reproduced`, because a test like `expect(1).toBe(2)` would fail by assertion with the right message without running the cited code. For `pre-existing`, the base run is skipped. The base run is judged only by `passedAtBase(report, testFile)`: `expect` plays no part there. Any other result -> `not-reproduced`, and the finding is downgraded to IMPORTANT with the reason.
- **Synthetic infrastructure for tests:** `tests/fixtures/repro-repo/` (a tiny vitest project with a lockfile) and a fake container runner that replays recorded `TestReport` JSON. The real-container tests run only when a runtime is present, and are skipped otherwise (never in CI without one).
- **Test Cases:**
  - `testReproduction_RealAssertionFailureKeepsBlocker`: Test fails with assertion error on head; passes on base -> Retained as BLOCKER.
  - `testReproduction_SyntaxErrorDowngrades`: Test fails with `SyntaxError: Unexpected token` -> Downgraded to IMPORTANT.
  - `testReproduction_InvalidPathRejected`: Test proposal specifies `../../foo.test.ts` or non-test file -> Rejected.
  - `testReproduction_SymlinkParentRejected`: `tests/` is a symlink (or junction) to a directory outside the worktree -> Rejected before anything is written.
  - `testReproduction_ExistingFileNotOverwritten`: The proposed path already exists at head or base -> Rejected; the file is unchanged.
  - `testReproduction_PreexistingSkipsBase`: An `origin: pre-existing` BLOCKER whose test fails at head (and also at base) -> Reproduced; base is not required to pass.
  - `testReproduction_NewCodeIsUnproven`: An `introduced` BLOCKER in a file that doesn't exist at base; the test fails by assertion at head -> `unproven`, severity unchanged, test listed.
  - `testReproduction_TrivialAssertionNotReproduced`: The test is `expect(1).toBe(2)` with a matching `expect` message, for a finding in a file that exists at base -> it fails at base too, so `not-reproduced`.
  - `testReproduction_WrongMessageDowngrades`: An assertion fails with a message that doesn't match `expect` -> Downgraded.
  - `testReproduction_OtherTestFailureIgnored`: Only an unrelated test fails -> Not reproduced (the command ran `testFile` only).
  - `testReproduction_NoRuntimeUnproven`: No container runtime -> `unproven`, severity unchanged.
  - `testReproduction_CacheWriteIsInfra`: A fake runner whose output is an `EROFS` error writing `node_modules/.vite` -> `unproven`, not `not-reproduced`.
  - `testReproduction_ManagerOffline`: The derived image already contains the manager; the test step has no network and still runs -> no `command not found`.
  - `testReproduction_SandboxEscapeRejected`: Test attempts network socket connection or writing to parent directory -> Fails in sandbox, rejected.
- **Acceptance Criteria:** Malicious or malformed reproduction tests are safely caught or rejected; approved smoke test runs on real diff and outputs verified findings.
- **Dependencies:** M4, M5.
- **Parallel Tasks:** Provider stubs (`src/providers/claude.ts`, `src/providers/qwen.ts`) and reproduction core can run in parallel.
- **Suggested Assignment:** Implementer: `codex` (OpenAI). Reviewer: `claude:opus` (Anthropic).

---

## 4. Verifier Algorithm in Detail

The verifier eliminates AI hallucinations before findings reach deduplication or reports.

```
                              ┌────────────────────────┐
                              │    Incoming Finding    │
                              └───────────┬────────────┘
                                          │
                            [1. Path Normalization & Root Confinement]
                                          │
                            Is path valid and inside repo?
                                         ├─── NO ───► [REJECT: Invalid Path / Traversal]
                                         │
                                        YES
                                         │
                                [2. File Existence Check]
                                         │
                             Does file exist on disk?
                                         ├─── NO ───► [REJECT: File Not Found]
                                         │
                                        YES
                                         │
                              [3. Line & Quote Extraction]
                                         │
                             Is quote empty or invalid?
                                         ├─── YES ──► [REJECT: Empty Quote]
                                         │
                                         NO
                                         │
                       [4. Exact Search in Radius W = ±10 Lines]
                                         │
                               Exact match in radius?
                                         ├─── YES ──► [VERIFY: Correct Line to Exact Match]
                                         │
                                         NO
                                         │
                        [5. Fuzzy Search in Radius W = ±10 Lines]
                                         │
                             Similarity >= 0.85?
                                         ├─── YES ──► [VERIFY: Correct Line, Flag Fuzzy]
                                         │
                                         NO
                                         │
                     [6. Global File Search (Exact & Fuzzy >= 0.85)]
                                         │
                              Global Match Found?
                                         ├─── YES ──► [VERIFY: Correct Line from Far Drift]
                                         │
                                         NO
                                         │
                                         ▼
                            [REJECT: Hallucinated Quote]
```

### 4.1 Path Normalization and Traversal Rejection
1. **Input Normalization:** Convert backslashes (`\`) to forward slashes (`/`). Strip leading and trailing whitespace and control characters.
2. **Root Confinement:** Reject absolute paths (POSIX `/x`, Windows `C:\x`, UNC `\\host\x`) instead of stripping them. Resolve the relative path against `worktreeRoot` using `node:path.resolve(worktreeRoot, sanitizedRelative)`, then `fs.realpath` both sides so a symlink can't point outside.
3. **Traversal Detection:** Validate that the real path starts with the real `worktreeRoot + path.sep` (compared case-insensitively on Windows). Reject any path containing:
   - Null bytes (`\0`).
   - Relative parent segments that escape the root (`..`).
   - URL protocols (`file://`, `http://`).
   - Windows Alternate Data Streams (`filename:stream`).
4. **Existence Verification:** Check with `node:fs/promises.stat(resolvedPath)`. If the target does not exist or is a directory, reject finding immediately.

### 4.2 Quote Normalization
1. **Newline Conversion:** Convert all CRLF (`\r\n`) and CR (`\r`) sequences to standard LF (`\n`).
2. **Whitespace Collapsing:**
   - On each line, trim trailing whitespace.
   - Replace horizontal tab characters (`\t`) with 2 spaces.
   - Collapse interior sequences of multiple spaces (`[ ]{2,}`) into a single space.
3. **Indentation Stripping:** Compute the minimum leading indentation across non-empty lines and strip it uniformly from the quote block.

### 4.3 Search Window and Fuzzy Matching
1. **File Loading:** Read file contents into an array of normalized lines (1-indexed).
2. **Window Radius ($W = 10$):**
   - Let cited line be $L$. Compute window range: $[L_{start}, L_{end}] = [\max(1, L - 10), \min(N, L + 10)]$, where $N$ is total lines.
3. **Local Search:**
   - Attempt exact match of normalized quote against slices of lines within the window.
   - If an exact match is found at line $L_{match}$, set `finding.line = L_{match}` and verify.
   - If no exact match, compute **one** similarity against every candidate slice with the same number of lines as the quote: $\text{sim} = 1 - \frac{\text{levenshtein}(q, c)}{\max(|q|, |c|)}$ on the normalized text (characters, not tokens). There is one threshold everywhere: $\text{FUZZY} = 0.85$.
   - If the best $\text{sim} \ge 0.85$, set `finding.line = L_{match}`, flag as verified with a fuzzy note.
   - **Tie-breaks, in order:** (1) a **local** match (inside the window) beats a global one, even when the global one is exact; (2) inside the same scope, an exact match beats a fuzzy one; (3) a higher sim wins; (4) then the smallest $|L_{match} - L|$; (5) then the lower line number. This is the same order as the flow diagram: local exact, local fuzzy, then global.
4. **Global Search (Drift Correction):**
   - If local search fails (e.g. Gemini cites line 5200 in a 600-line file), scan the entire file for the exact normalized quote.
   - If exact match is found at line $L_{global}$, correct `finding.line = L_{global}` and mark verified, **only if the quote occurs exactly once in the file** (several occurrences: reject as "ambiguous: matches N places"; never resolve it by distance outside the window).
   - If no exact match, scan file for the best fuzzy match with similarity $\ge 0.85$, accepted **only if no other candidate is within 0.05 of it**.
   - If found, correct `finding.line = L_{global}`.
   - Otherwise (best global similarity $< 0.85$), reject the finding as hallucinated.
5. **Meaning check (M1 fixes).** A fuzzy match only *locates* a candidate. It is verified only when the quote and the matched text have the same sequence of semantic tokens: operators and negation, the words true, false, null, undefined, nil, none, not, and, or, return, throw, raise, if, else, break, continue, await, and every numeric and string literal. Identifier spelling may differ. A fuzzy match that flips one of them is rejected, and the reason names the token.
6. **Triviality and cost (M1 fixes).** A quote with fewer than 4 letters or digits is rejected (`}`, `);`). A raw quote over 64 KiB is rejected before it is normalized, a file line over 16 KiB is skipped by the search, and one call spends at most 20 million edit-distance cells (then: "search budget exceeded").

> **Superseded in M1 fixes:** the "global exact, then global fuzzy" resolution above now requires uniqueness (item 4) and a meaning check (item 5). See "M1 fixes (Codex review)" at the end of this document.

---

### 4.4 Verifier Test Cases Table

| # | Cited File | Cited Line | Cited Quote | Actual File Content at Location | Decision | Final Line | Reason |
|---|---|---|---|---|---|---|---|
| 1 | `src/auth.ts` | 42 | `if (!user.token) return false;` | Line 42: `if (!user.token) return false;` | **VERIFIED** | 42 | Exact line and quote match. |
| 2 | `src/auth.ts` | 42 | `if (!user.token) return false;\r\n` | Line 42: `if (!user.token) return false;\n` | **VERIFIED** | 42 | CRLF vs LF quote normalized. |
| 3 | `src/auth.ts` | 42 | `  if (!user.token)   return false;` | Line 42: `if (!user.token) return false;` | **VERIFIED** | 42 | Indentation and interior whitespace collapsed. |
| 4 | `src/auth.ts` | 40 | `if (!user.token) return false;` | Line 41: `if (!user.token) return false;` | **CORRECTED** | 41 | Off-by-one line corrected via radius $W=10$. |
| 5 | `src/auth.ts` | 35 | `if (!user.token) return false;` | Line 42: `if (!user.token) return false;` | **CORRECTED** | 42 | Drift within radius window ($|42 - 35| \le 10$). |
| 6 | `src/auth.ts` | 5200 | `if (!user.token) return false;` | Line 42: `if (!user.token) return false;` (File length: 300) | **CORRECTED** | 42 | Gemini line hallucination corrected via global file scan. |
| 7 | `src/missing.ts` | 10 | `const x = 1;` | File does not exist | **REJECTED** | - | File does not exist in worktree. |
| 8 | `../secret.env` | 1 | `DB_PASS=secret` | File exists outside root | **REJECTED** | - | Directory traversal attempt rejected. |
| 9 | `src/%2e%2e/etc/passwd` | 1 | `root:x:0:0` | Literal `%2e%2e` directory, which doesn't exist | **REJECTED** | - | Paths are never URL-decoded, so this is just a missing file. |
| 10 | `C:\Windows\System32\cmd.exe` | 1 | `binary` | Absolute Windows system path | **REJECTED** | - | Path escapes repository confinement. |
| 11 | `src/pay.ts` | 15 | `total = price * (1 + TAX_RATE)` | Line 15: `total = price * (1 + TAX_RATIO)` | **VERIFIED** | 15 | Minor typo in quote (character sim ≈ 0.94 $\ge 0.85$) and the same semantic tokens (`=`, `*`, `1`, `+`); only an identifier differs. The note carries the text found in the code. |
| 12 | `src/pay.ts` | 15 | `chargeCreditCard(customer, amount)` | Line 15: `let total = price * quantity;` | **REJECTED** | - | Hallucinated code (similarity $< 0.30$). |
| 13 | `src/pay.ts` | 15 | `   ` | Line 15: `let total = 0;` | **REJECTED** | - | Empty or whitespace-only quote rejected. |
| 14 | `src/ui.tsx` | 20 | `<div>\n  <span>Hello</span>\n</div>` | Line 20: `<div>\n    <span>Hello</span>\n  </div>` | **VERIFIED** | 20 | Multiline block with indentation drift normalized. |
| 15 | `src/dup.ts` | 10 | `return null;` | Lines 5, 12, 85: `return null;` | **CORRECTED** | 12 | Ambiguous quote; closest line within radius selected. |
| 16 | `src/empty.ts` | 1 | `const x = 1;` | Empty file (0 lines) | **REJECTED** | - | Cited line exceeds file bounds, quote not present. |
| 17 | `src\win\path.ts` | 5 | `export const WIN = true;` | Line 5: `export const WIN = true;` | **VERIFIED** | 5 | Windows backslash path converted to forward slash. |
| 18 | `src/t.ts` | 10 | a quote whose best match has sim 0.849 | — | **REJECTED** | - | Just below the single 0.85 threshold. |
| 19 | `src/t.ts` | 10 | a quote whose best match has sim exactly 0.85 | — | **VERIFIED** | match line | Threshold is inclusive. |
| 20 | `src/dup.ts` | 10 | `return null;` | Lines 8 and 12: `return null;` | **CORRECTED** | 8 | Equal distance; the lower line number wins. |
| 21 | `src/t.ts` | 10 | `compute();` | Line 30 exact, line 12 `computeX();` fuzzy 0.91 | **CORRECTED** | 12 | Local beats global, even when global is exact. (The quote was `foo();`; it has 3 letters and is now too short, see row 25.) |
| 22 | `src/auth.ts` | 42 | `if (user.token) return false;` | Line 42: `if (!user.token) return false;` | **REJECTED** | - | Fuzzy 0.97, but the code has `!` that the quote does not: the meaning is flipped. |
| 23 | `src/auth.ts` | 42 | `if (!user.token) return true;` | Line 42: `if (!user.token) return false;` | **REJECTED** | - | Fuzzy 0.87, `true` against `false`. |
| 24 | `src/t.ts` | 20 | `const retries = 5;` | Line 20: `const retries = 3;` | **REJECTED** | - | A changed number or string literal is a changed meaning. |
| 25 | `src/auth.ts` | 42 | `}` | Line 42: `  }` | **REJECTED** | - | Fewer than 4 letters or digits proves nothing. |
| 26 | `src/two.ts` | 5000 | `return false;` | Lines 11 and 31: `return false;` (two functions) | **REJECTED** | - | Outside the window the line is corrected only when the quote occurs once: "ambiguous: matches 2 places". |
| 27 | `src/auth.ts` | 5000 | an 8192-character quote | 255 lines of 8191 `a` and a `b` | **REJECTED** | - | The work budget (20 million cells) ends the search: "search budget exceeded". |

Rows 22 to 27 were added by the M1 fixes. Rows 6, 15 and 20 are unchanged: a unique match far away is still corrected (6), and inside the window the nearest match still wins (15, 20).

---

## 5. Dedupe Algorithm in Detail

Deduplication groups findings reporting the same defect across independent models and reviewers.

```
                  ┌──────────────────────────────────────────────┐
                  │       Verified Findings from Providers       │
                  └──────────────────────┬───────────────────────┘
                                         │
                    [1. Partition by Canonical File Path]
                                         │
             ┌───────────────────────────┴───────────────────────────┐
             │ File: src/payment.ts                                  │ File: src/auth.ts
             ▼                                                       ▼
  [2. Proximity Sorting]                                   [2. Proximity Sorting]
    Sort findings by line number                             Sort findings by line number
             │                                                       │
  [3. Cluster Grouping]                                    [3. Cluster Grouping]
    Line distance <= 5 lines?                                Line distance <= 5 lines?
             │                                                       │
  [4. Semantic Similarity Check]                           [4. Semantic Similarity Check]
    Trigger/Impact Jaccard >= 0.70?                          Trigger/Impact Jaccard >= 0.70?
             │                                                       │
             ├───────── YES: Merge Cluster ─────────┐                │
             │                                      │                │
             │  • Severity: MAX(BLOCKER, IMPORTANT) │                │
             │  • Distinct Families >= 2?           │                │
             │      -> BOOST Confidence (+0.25)     │                │
             │  • Distinct Families >= 3?           │                │
             │      -> BOOST Confidence (1.00)      │                │
             │                                      │                │
             ▼                                      ▼                ▼
  [Single Merged Finding]                       [Separate Unmerged Findings]
```

### 5.1 Clustering Key and Proximity Window
1. **Partition:** Partition all verified findings by normalized file path (`finding.file`).
2. **Sort:** Sort findings within each file bucket by ascending `finding.line`.
3. **Proximity Window:** Two findings $F_1, F_2$ belong to candidate cluster if:
   $$|F_1.\text{line} - F_2.\text{line}| \le 5$$

### 5.2 Text Similarity Metric and Threshold

> **Superseded in M1 fixes:** lexical similarity cannot decide that two findings are the same defect, so it only gates automatic merging at a STRONG match (token Jaccard of trigger + impact >= 0.85, same file, within 5 lines, at least 2 shared words). Weaker overlap (overlap coefficient >= 0.15) is annotated as `possibly_related`, never merged. See 5.5 and "M1 fixes (Codex review)".
1. **Tokenization:** Extract words from `trigger`, `impact`, and `fix` using regex `\w+`, lowercasing all tokens and removing standard stop words.
2. **Jaccard Similarity:**
   $$J(A, B) = \frac{|A \cap B|}{|A \cup B|}$$
3. **Threshold:** If $J(\text{tokens}_1, \text{tokens}_2) \ge 0.70$, the findings represent the same underlying issue and are merged.

### 5.3 Cross-Family Agreement and Confidence Boost
1. **Family Independence Check:** Count the number of *distinct model families* in the cluster (`google`, `anthropic`, `openai`, `local`). Multiple models from the same family (e.g. `claude-sonnet` via Claude Code and `claude-opus` via Antigravity) count as **one** family.
2. **Confidence Adjustment:**
   - Single family: Retain maximum individual confidence score: $\max(F_i.\text{confidence})$.
   - Two distinct families agreeing: Boost confidence:
     $$\text{confidence} = \min(1.0, \max(F_i.\text{confidence}) + 0.25)$$
   - Three or more distinct families agreeing: Set confidence to $1.00$.

### 5.4 Severity and Field Conflict Resolution
1. **Severity Hierarchy:** `BLOCKER` > `IMPORTANT` > `OPTIONAL`. Merged finding inherits the highest severity in the cluster.
2. **Trigger and Impact:** Retain the description from the finding with the highest individual confidence score. Append notes documenting consensus from other reviewers.
3. **Fix Proposal:** Select the fix from the highest tier provider (`confirm` > `review` > `triage`).
4. **Origin Resolution:** If any reviewer tags `introduced` and `git blame` confirms lines are modified in the diff, the resolved origin is `introduced`.

---

### 5.5 Dedupe Test Cases Table

> **Correction:** the Similarity column is illustrative. It is **not** what token Jaccard gives. Rows 2 and 6 are paraphrases with almost no shared words ("Payment captured twice on retry" vs "Idempotency key missing, double charge" scores close to 0). Lexical similarity alone can't merge them. **M1 must calibrate the metric** against this table, comparing (a) token Jaccard on trigger + impact, (b) character-trigram similarity, and (c) location-first merging: the same verified line ± 2 with a low lexical floor. Pick the one that passes. If none does, paraphrase pairs stay separate, and the report groups them as "possibly related" rather than inflating confidence. **The confidence column is not illustrative:** it is exact arithmetic from 5.3, and M1 tests it separately from the similarity calibration.

> **Rewritten in the M1 fixes.** Rows 1, 2, 5, 6, 8 and 9 used to merge. They do not any more: automatic merging needs a STRONG match (same file, within 5 lines, token Jaccard of trigger + impact >= 0.85), and paraphrases of one defect score 0.12 to 0.21. Two different defects can look as alike as two paraphrases ("Missing authorization when deleting users" against "Missing audit when deleting users" shares 3 of 11 words and is two defects), so a lexical metric cannot tell them apart and the cost of a wrong merge is a hidden defect. Below the merge threshold, findings within 5 lines with an overlap coefficient >= 0.15 and at least 2 shared words are annotated with `possibly_related` on both. Annotation never changes severity or confidence, and the cross-family boost applies only inside a strong merge. Whether a related pair is one defect is a question for the confirm tier (M3), not for a metric. The Similarity column below holds the real numbers: J is the token Jaccard, O the overlap coefficient, over stemmed word tokens without stop words. The arithmetic of 5.3 is unchanged and tested with identical wording (the "With the same wording" sentences).

| # | Finding A | Finding B | Similarity | Result | Final Sev | Final Conf | Rationale |
|---|---|---|---|---|---|---|---|
| 1 | L40, `google`, Sev: `BLOCKER`, Conf: 0.70, "Unchecked integer overflow in balance" | L42, `openai`, Sev: `IMPORTANT`, Conf: 0.65, "Integer overflow vulnerability on balance math" | J 0.182, O 0.333 (4 shared words) | **SEPARATE**, possibly related | `BLOCKER`, `IMPORTANT` (unchanged) | 0.70, 0.65 (unchanged) | Line $\Delta = 2 \le 5$ and the overlap is above 0.15, but the wording is a paraphrase (Jaccard < 0.85). Both stay, each annotated with the other. With the same wording they would merge to `BLOCKER`, 0.95. |
| 2 | L100, `anthropic`, Sev: `IMPORTANT`, Conf: 0.80, "Missing CSRF header check" | L101, `anthropic`, Sev: `IMPORTANT`, Conf: 0.75, "CSRF token validation omitted" | J 0.125, O 0.231 (3 shared words) | **SEPARATE**, possibly related | `IMPORTANT`, `IMPORTANT` | 0.80, 0.75 | Same family via two tools (`claude` and `agy`). Paraphrased, so not merged. With the same wording they would merge to `IMPORTANT`, 0.80, with NO cross-family boost. |
| 3 | L20, `google`, Sev: `IMPORTANT`, Conf: 0.80, "SQL injection in search query" | L32, `openai`, Sev: `IMPORTANT`, Conf: 0.80, "SQL injection in search query" | J 0.316, O 0.500 | **SEPARATE** | - | - | Line $\Delta = 12 > 5$. Proximity window exceeded; kept separate and not annotated (the annotation also needs 5 lines). |
| 4 | L50, `google`, Sev: `OPTIONAL`, Conf: 0.60, "Variable name typo `usre`" | L50, `openai`, Sev: `BLOCKER`, Conf: 0.90, "Null pointer dereference on user session" | J 0.000, O 0.000 | **SEPARATE** | - | - | Identical line, no shared word. Distinct defects, not even annotated. |
| 5 | L12, `google`, Sev: `IMPORTANT`, Conf: 0.70, "Missing rate limit on login" | L14, `local`, Sev: `OPTIONAL`, Conf: 0.50, "Brute force possible without rate limit" | J 0.211, O 0.364 (4 shared words) | **SEPARATE**, possibly related | `IMPORTANT`, `OPTIONAL` | 0.70, 0.50 | Paraphrase across `google` and `local`: annotated, not merged, no boost. With the same wording they would merge to `IMPORTANT`, 0.95. |
| 6 | L80, `anthropic`, Sev: `BLOCKER`, Conf: 0.75, "Payment captured twice on retry" | L81, `google`, Sev: `BLOCKER`, Conf: 0.80, "Idempotency key missing, double charge" (Plus L82, `openai`, Sev: `BLOCKER`, Conf: 0.85) | A-B J 0.167, O 0.300; B-C J 0.130, O 0.300; A-C J 0.174, O 0.364 | **SEPARATE**, possibly related | `BLOCKER` x3 | 0.75, 0.80, 0.85 | Three paraphrases of one defect, all within 5 lines. None merges, each is annotated with the other two. With the same wording three distinct families agree: `BLOCKER`, 1.00. |
| 7 | `src/a.ts` L10, `google`, "Unused variable `x`" | `src/b.ts` L10, `google`, "Unused variable `x`" | J 1.000 | **SEPARATE** | - | - | Different files are partitioned into separate clusters. |
| 8 | L60, `openai`, Sev: `OPTIONAL`, Conf: 0.50, "Missing JSDoc comment on public method" | L63, `google`, Sev: `OPTIONAL`, Conf: 0.50, "Public export lacks documentation comments" | J 0.176, O 0.300 (3 shared words) | **SEPARATE**, possibly related | `OPTIONAL`, `OPTIONAL` | 0.50, 0.50 | Line $\Delta = 3 \le 5$, paraphrased. Annotated, not merged. With the same wording they would merge to `OPTIONAL`, 0.75. |
| 9 | L90, `google`, Sev: `IMPORTANT`, Conf: 0.70, Origin: `introduced` | L92, `anthropic`, Sev: `IMPORTANT`, Conf: 0.75, Origin: `pre-existing` | J 0.190, O 0.364 (4 shared words) | **SEPARATE**, possibly related | `IMPORTANT`, `IMPORTANT` | 0.70, 0.75 | Paraphrased, so each keeps its own origin (`introduced`, `pre-existing`). With the same wording they would merge to `IMPORTANT`, 1.00, origin `introduced`. |
| 10 | L15, `google`, Sev: `IMPORTANT`, Conf: 0.80, "Unclosed database client leak" | L17, `openai`, Sev: `IMPORTANT`, Conf: 0.80, "Memory leak in query cache buffer" | J 0.045, O 0.091 (1 shared word, counted as 0) | **SEPARATE** | - | - | Proximity matches ($\Delta = 2$), but the overlap is below 0.15 and fewer than two words are shared. Not annotated. |

---

## 6. Cascade and Budget

### 6.1 Review Routing and Escalation Rules
1. **Pass 1: Triage Pass (Cheap & Broad)**
   - The entire diff and touched symbol context are sent to the primary model in the `triage` tier (default: `agy:gemini-3.8-flash-medium` or local `qwen`).
   - If the author family is known (e.g. `--author claude`), Quorum selects an independent triage model (`google` or `local`).
2. **Escalation Triggers (Escalate to Confirm Tier):**
   A finding escalates to the `confirm` tier (default: `codex` or `agy:claude-opus-5-5-high`) if:
   - **Rule 1 (Focus Keyword):** The finding `file`, `trigger`, or `impact` contains any keyword in `config.escalate.focus` (default: `["money", "auth", "permissions"]`, as in PLAN.md).
   - **Rule 2 (Uncertainty):** The triage model confidence score is strictly below `config.escalate.belowConfidence` (default: `0.70`).
   - **Rule 3 (Severe Finding):** The triage model classifies the finding as `BLOCKER`.
   - **Rule 3b (Local-only):** Every finding whose only sources are `local` (Qwen) escalates to the `review` tier, whatever its confidence. If no non-local reviewer is available, it is reported under "Unconfirmed (local model only)", never as a verified IMPORTANT or BLOCKER. Test: `testCascade_QwenOnlyNeverFinal` — Qwen returns IMPORTANT at 0.90 with no focus word -> it escalates; with the review tier unavailable, it is listed as unconfirmed.
   - **Rule 4 (Syntax/Parse Failure):** The triage model returns unparseable JSON or times out; the affected hunk escalates to the `review` tier.
3. **Confirm Evaluation:**
   - The confirm model reviews the specific hunk and escalated finding.
   - If the confirm model rejects the issue, it is dropped.
   - If the confirm model confirms the issue, it is tagged verified with the confirm model's evidence quote.

### 6.2 Quota Floor Handling and Tier Fallbacks
1. **Pre-flight Quota Read:**
   - Before executing review calls, Quorum queries the provider's quota endpoint (e.g. `agy` `/usage`).
   - If a quota group's remaining capacity is $\le \text{budget.quotaFloorPercent}$ (default 15%), the entire quota group is marked `UNAVAILABLE`.
2. **Fallback Order Inside a Tier:**
   - Quorum iterates through the models defined in `config.tiers[tier]`.
   - **Filter 1:** Skip models in `UNAVAILABLE` quota groups.
   - **Filter 2:** Skip models belonging to the author family if an independent alternative is available in the tier.
   - **Filter 3:** If all models in a tier are exhausted:
     - For `triage`: Fall back to local `qwen` or escalate directly to `review`.
     - For `confirm`: Fall back to another independent confirm model (e.g. `codex` falls back to `agy:claude-opus-5-5-high`).
     - If no confirm models remain, retain triage finding but mark `unconfirmed` in report.

### 6.3 Budget Ceilings
- **Every call has a deadline**, whether or not a ceiling has been reached: the run's remaining time, shared with its retries. The runner kills the process tree at the deadline, and agy also gets `--print-timeout <remaining>s` (a real flag in `agy --help`; its default of 0 waits forever). A killed call returns no findings, and the ledger counts it in `timedOutCalls`.
- `budget.maxCalls` (default: `clamp(3 x review chunks, 12, 40)`; explicit values pin the limit).
- `budget.maxMinutes` (default: 20 minutes elapsed runtime).
- If either ceiling is reached:
  1. Abort any unstarted escalation calls.
  2. A call still running at the deadline is killed, as described above.
     Test: `testBudget_DeadlineKillsInFlight` — fake clock and a fake runner that never returns -> it is killed at `maxMinutes`, and the run reports what it has.
  3. Run verifier and dedupe on all gathered findings.
  4. Emit report with warning: `"Run terminated early: review budget ceiling reached."`

### 6.4 What `--dry-run` Prints
`quorum review ... --dry-run` spends zero quota and starts no child process other than local git. Quota comes only from the last reading saved in the ledger, with its time, or shows `unknown`. Unknown quota never silently drops the floor: the provider stays eligible, but the plan and the report say "floor unchecked", and a 429 during the run marks its group unavailable. Its output looks like this:

```
=== Quorum Review Plan (Dry Run) ===

Configuration & Context:
  Base Commit:         origin/main (a1b2c3d)
  Head Commit:         HEAD (f4e5d6c)
  Review Mode:         feature
  Spec Path:           docs/spec-issue-42.md
  Author Family:       anthropic (Detected via --author)
  Files Changed:       4 files (+124, -32 lines)
  Independence Rule:   Enforced (Anthropic models disqualified from single-reviewer quorum)

Deterministic Pre-flight Checks (Phase 1):
  [1] pnpm lint
  [2] pnpm typecheck
  [3] pnpm test

Provider Quota Status:
  agy (google group):      84% at 2026-10-12 09:40 from the ledger (stale after 15 min) [ELIGIBLE]
  agy (anthropic group):   unknown (no reading in the ledger) [ELIGIBLE, floor unchecked]
  codex (openai group):    unknown [ELIGIBLE, floor unchecked]
  qwen (local):            not checked in dry-run

Execution Cascade:
  [Phase 2: Triage]
    Provider / Model:  agy:gemini-3.8-flash-medium
    Family:            google (Independent of author: anthropic)
    Payload:           Surgical diff (156 lines) + Spec Acceptance Criteria
    Payload size:      ~5.8 KB (Quorum counts characters, not tokens)

  [Phase 3: Conditional Escalation Paths]
    Triggers:          Findings matching [money, auth, permissions] OR confidence < 0.70
    Target Tier:       confirm
    Primary Confirm:   codex (openai)
    Fallback Confirm:  agy:claude-opus-5-5-high (anthropic)

  [Phase 4: Reproduction Lane]
    Enabled:           No (Specify --reproduce to enable containerized proof tests)

Budget Ceilings:
    Max API Calls:     12
    Max Run Time:      20m 00s
    Quota Floor:       15%

Nothing was called: dry-run spends no quota.
```

---

## 7. Reviewer Prompt Templates

### 7.1 Stable Prefix (Vendor Prompt-Cache Optimized)
```markdown
You are a strict, read-only code reviewer in the Quorum QA pipeline.
CRITICAL OPERATIONAL RULES:
1. You must use ONLY file-read tools. Never invoke terminal, bash, git-write, or filesystem modification tools.
2. Every finding MUST cite an exact file path, exact line number, and exact code quote found in the target files.
3. Findings with hallucinated quotes, missing files, or out-of-bounds line numbers will be discarded.
4. Output MUST be valid JSON only matching the schema below. Do not wrap in markdown fences. Do not output conversational prose.

JSON OUTPUT SCHEMA:
[
  {
    "severity": "BLOCKER" | "IMPORTANT" | "OPTIONAL",
    "origin": "introduced" | "pre-existing" | "improvement",
    "file": "string (relative path)",
    "line": number (1-indexed start line),
    "trigger": "string (input or condition triggering defect)",
    "impact": "string (consequence for user or system)",
    "evidence_quote": "string (exact text at or near the cited line)",
    "fix": "string (concise code modification to resolve issue)",
    "confidence": number (float between 0.0 and 1.0)
  }
]
```

### 7.2 Per-Mode Suffixes

#### Feature Mode Suffix
```markdown
MODE: FEATURE AUDIT
SPECIFICATION:
{{SPEC_CONTENT}}

DIFF TO REVIEW:
{{DIFF_CONTENT}}

INSTRUCTIONS:
1. Compare the diff against the specification acceptance criteria.
2. For any acceptance criterion that is not implemented or incorrectly implemented, report a BLOCKER or IMPORTANT finding.
3. Identify edge cases missing automated tests.
4. Verify that no regressions or unintended side effects are introduced in existing functionality.
```

#### Redesign Mode Suffix
```markdown
MODE: REDESIGN & FEATURE PARITY AUDIT
EXISTING FEATURE INVENTORY:
{{INVENTORY_CONTENT}}

DESIGN & ACCESSIBILITY RULES:
{{RULES_CONTENT}}

ATTACHED SCREENSHOTS:
{{IMAGE_REFERENCES}}

INSTRUCTIONS:
1. Verify feature parity: Ensure every feature listed in the inventory exists in the new UI. Missing features are BLOCKERS.
2. Visual Review: Audit screenshots for text truncation, overlapping elements, broken alignment, and insufficient contrast.
3. Accessibility: Check touch targets (minimum 44x44px), semantic HTML tags, and accessible naming.
4. Enforce design rules: Ensure only one primary action button per screen and adherence to the product glossary.
```

### 7.3 Reproduction-Test Request Prompt
```markdown
TASK: PROPOSE REPRODUCTION TEST FOR VERIFIED BLOCKER
FINDING DETAILS:
- File: {{FILE}}
- Line: {{LINE}}
- Defect: {{TRIGGER}} -> {{IMPACT}}
- Evidence: {{EVIDENCE_QUOTE}}

INSTRUCTIONS:
Provide a standalone, automated reproduction test proving this BLOCKER defect.
RULES:
1. The test must fail at the current commit due to an assertion failure demonstrating the bug.
2. The test must NOT fail due to syntax errors, unresolved imports, or missing dependencies.
3. The test must be completely contained in a new file matching: {{TEST_GLOBS}}.

OUTPUT JSON FORMAT:
{
  "path": "src/reproduce.test.ts",
  "content": "import { ... } from '...';\ntest('...', () => { ... });",
  "expect": "Exact expected assertion failure message substring"
}
```

---

## 8. Formats

### 8.1 Ledger JSONL Line Format
Stored at `.quorum/ledger.jsonl`. Each run appends a single serialized line:

```json
{"runId":"qrm-20261012-0481","timestamp":"2026-10-12T00:30:15.120Z","mode":"feature","headSha":"f4e5d6c8b9a0","baseSha":"a1b2c3d4e5f6","provider":"agy","model":"gemini-3.8-flash-medium","family":"google","rawFindingsCount":6,"verifiedFindingsCount":4,"rejectedFindingsCount":2,"durationMs":3420,"callsUsed":1,"timedOutCalls":0,"reproducedBlockersCount":1}
```

### 8.2 Cache Key and Storage Layout
- **Hash Formula:**
  $$\text{Key} = \text{SHA256}(\text{fileContentSha256} + \text{"::"} + \text{SHA256}(\text{prompt}) + \text{"::"} + \text{modelId})$$
- **Directory Layout:**
  ```
  .quorum/
  └── cache/
      └── v1/
          ├── 3f/
          │   └── 3f8a9d12...c4e.json
          └── a7/
              └── a7b42e91...f01.json
  ```
- **Cache Entry Payload:**
  ```json
  {
    "version": 1,
    "createdAt": "2026-10-12T00:15:00.000Z",
    "key": "3f8a9d12...c4e",
    "model": "gemini-3.8-flash-medium",
    "findings": [ /* array of Finding objects */ ],
    "rawOutput": "..."
  }
  ```

### 8.3 SARIF 2.1.0 Mapping of a Finding

```json
{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "Quorum",
          "version": "1.0.0",
          "informationUri": "https://github.com/isanchez-aguilar/quorum-qa",
          "rules": [
            {
              "id": "QRM001",
              "name": "Blocker",
              "shortDescription": { "text": "Blocker defect" },
              "defaultConfiguration": { "level": "error" }
            },
            {
              "id": "QRM002",
              "name": "ImportantDefect",
              "shortDescription": { "text": "Important Logic or Security Defect" },
              "defaultConfiguration": { "level": "warning" }
            },
            {
              "id": "QRM003",
              "name": "OptionalImprovement",
              "shortDescription": { "text": "Optional Improvement or Code Smell" },
              "defaultConfiguration": { "level": "note" }
            }
          ]
        }
      },
      "results": [
        {
          "ruleId": "QRM001",
          "level": "error",
          "message": {
            "text": "Unchecked integer overflow in balance transfer. Trigger: Transferring INT_MAX + 1 credits. Impact: Ledger corruption."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "src/ledger.ts",
                  "uriBaseId": "%SRCROOT%"
                },
                "region": {
                  "startLine": 42,
                  "snippet": {
                    "text": "balance += depositAmount;"
                  }
                }
              }
            }
          ],
          "properties": {
            "origin": "introduced",
            "confidence": 0.95,
            "family": "google",
            "provider": "agy",
            "model": "gemini-3.1-pro-high",
            "fix": "balance = safeAdd(balance, depositAmount);"
          }
        }
      ]
    }
  ]
}
```

### 8.4 Markdown Report Layout

````markdown
# Quorum QA Review Report

**Run ID:** `qrm-20261012-0481` · **Mode:** `feature` · **Diff:** `origin/main...HEAD` · **Time:** 4.2s  
**Status:** ⚠️ 2 Blockers Found · 1 Important · 1 Optional

---

## Executive Summary

| Category | Introduced | Pre-existing | Improvement | Total |
|---|---|---|---|---|
| **BLOCKER** | 2 | 0 | 0 | **2** |
| **IMPORTANT** | 1 | 1 | 0 | **2** |
| **OPTIONAL** | 0 | 0 | 1 | **1** |
| **Total** | **3** | **1** | **1** | **5** |

Deterministic Checks: ✅ `pnpm lint` passed · ✅ `pnpm typecheck` passed · ✅ `pnpm test` passed

---

## Blockers

### 1. Unchecked Integer Overflow on Balance
- **Location:** [`src/ledger.ts:42`](src/ledger.ts#L42) (`introduced`)
- **Confidence:** `0.95` (Consensus: `google`, `openai`)
- **Trigger:** Transferring an amount that causes `balance + amount > Number.MAX_SAFE_INTEGER`.
- **Impact:** Financial ledger records negative balances on overflow.
- **Evidence Quote:**
  ```typescript
  balance += depositAmount;
  ```
- **Proposed Fix:**
  ```typescript
  balance = checkedAdd(balance, depositAmount);
  ```
- **Reproduction Proof:** ✅ Verified via containerized test `src/ledger.reproduce.test.ts`.

---

## Important Findings

### 2. Missing CSRF Validation on Session Invalidation
- **Location:** [`src/auth.ts:108`](src/auth.ts#L108) (`pre-existing`)
- **Confidence:** `0.80` (Provider: `codex`)
- **Trigger:** Submitting cross-origin POST to `/auth/logout`.
- **Impact:** Attacker can force unintended user logout.
- **Evidence Quote:**
  ```typescript
  app.post('/auth/logout', (req, res) => { session.destroy(); });
  ```
- **Proposed Fix:** Add `csrfProtection` middleware before handler.

---

## Review Metadata
- **Quorum Composition:** `agy:gemini-3.8-flash-medium` (triage), `codex` (confirm).
- **Independence:** Author family (`anthropic`) excluded from single-model verification.
- **Calls used:** 2 of a budget of 12.
````

---

## 9. Quorum Doctor

`quorum doctor` verifies all local dependencies, CLI logins, models, quota, and sandbox safeguards before a run begins.

| Check | Exact Command Run | Failure Message Shown to User |
|---|---|---|
| 1. Git Installed & Working Copy | `git rev-parse --is-inside-work-tree` | `[FAIL] Git repository not detected. Run quorum from the root of a valid git workspace.` |
| 2. Deterministic Checks Available | Resolved binaries from `config.checks` (e.g. `pnpm --version`) | `[FAIL] Configured check executable '%CMD%' not found on PATH. Install it or update quorum.config.json.` |
| 3. agy CLI on PATH | Resolve `agy` through PATH/PATHEXT, then `agy --help` (agy's help lists no `--version`; the version is reported as unknown, which is not a failure) | `[FAIL] Antigravity CLI (agy) is not on PATH.` |
| 4. agy Models List Accessible | `agy models` | `[FAIL] 'agy models' failed. Open agy interactively once and sign in with your Google account.` (agy has no `auth` subcommand.) |
| 5. agy Configured Models Validated | Inspect output of `agy models` against configured model IDs | `[FAIL] Configured model '%MODEL%' is not in 'agy models'. Update quorum.config.json to an available model id.` |
| 6. agy Quota Read Accessible [ASSUMPTION 3] | The `/usage` slash command, spawned without a shell (so no MSYS path conversion applies) | `[WARN] Could not read agy quota. agy stays eligible, marked "floor unchecked"; a 429 will take its group out of the run.` |
| 7. agy Read Probe (1 call, counts against the M4 probe budget) | `agy --model <triage id> --sandbox --output-format json --print="Using only file-read tools, return the first line of README.md"`, run in a disposable worktree | `[FAIL] agy could not read the worktree. Add read_file(<worktree parent>) to permissions.allow in ~/.gemini/antigravity-cli/settings.json.` |
| 8. agy Permissions Present [ASSUMPTION 1] | Read `~/.gemini/antigravity-cli/settings.json` (`permissions.allow` / `permissions.deny`, entries like `read_file(<path>)`). Never write it. | `[FAIL] agy permissions don't allow reading <worktree parent> or don't deny write and shell tools. Add these entries yourself: <printed rules>` |
| 9. codex CLI on PATH | `codex --version` | `[FAIL] Codex CLI not found on PATH. Install codex or remove it from quorum.config.json tiers.` |
| 10. codex Read-Only Sandbox Probe (1 call, counts against the M4 probe budget) | `codex exec -C <worktree> -s read-only -o <tempout> -` (probe prompt on stdin), retried once on a read failure | `[FAIL] Codex read-only probe failed. Run 'codex login' and try again.` |
| 11. claude CLI on PATH (Optional) [ASSUMPTION 2] | `claude --version` | `[WARN] Claude Code CLI not found on PATH. Claude models will only be accessible via agy if configured.` |
| 12. qwen Local Endpoint (Optional) | HTTP `GET http://127.0.0.1:8080/v1/models` | `[WARN] Local Qwen endpoint not responding at http://127.0.0.1:8080. Local triage tier will be skipped.` |
| 13. Container Runtime for Reproduction | `docker --version` or `podman --version` | `[WARN] Neither Docker nor Podman was found. Reproduction lane will fall back to interactive prompt confirmation.` |

---

## 10. Dependencies

Minimal pinned dependency list. Strict adherence to exact versions, favoring Node 22 standard libraries (`node:fs/promises`, `node:child_process`, `node:crypto`, `node:path`, `node:os`).

### Production Dependencies
- **None.** M0 hand-writes the config validator (about 250 lines, with an issue list per key), which keeps the runtime dependency list at zero as AGENTS.md asks. Revisit a schema library at M4 only if validating provider JSON by hand gets worse than the dependency.

### Development Dependencies
- **`typescript`** (pinned at M0): Strict TypeScript compiler targeting modern ES2024 / Node 22 ESM.
- **`vitest`** (pinned at M0): Fast, ESM-native unit and integration test runner.
- **`@types/node`** (pinned at M0): Complete Node 22 engine type definitions.

*(No external CLI frameworks like yargs/commander; no third-party HTTP clients like axios; all process spawning, path normalization, hashing, and file I/O use Node 22 built-ins).*

---

## 11. Unknowns Requiring a Probe (ASSUMPTIONS)

Each assumption listed below represents an unverified CLI behavior or interface contract requiring an explicit probe:

10. **`[ASSUMPTION 10]` Claude JSON result envelope — envelope settled, live review not yet.**
    - **Recorded on 2026-10-19** (claude 2.1.285, two real calls): `{ "type": "result", "subtype": "success", "is_error": true, "terminal_reason": "api_error", "result": "Failed to authenticate: OAuth session expired and could not be refreshed", "usage": {...}, ... }`, with exit code 1. **`subtype` can be "success" while `is_error` is true**, so failure must be read from `is_error`, as the adapter does.
    - The CLI login on Isaac's machine had expired, and clearing the inherited `CLAUDE_CODE_*` variables made no difference. The adapter and doctor now report this as "claude login expired or missing: run `claude` and sign in", with a regression test on the recorded shape.
    - **Still unverified:** a successful Claude review, until the CLI login is renewed.
    - Original note: The v1.x adapter accepts a string `result` with `subtype: "success"` and no `is_error: true`; usage token counts are optional. Explicit failures use `is_error`/`subtype`, while unknown shapes become parse failures and escalate under rule 4. Quota detection reads only stderr and error fields on failed calls, never answer text. Tests use synthetic envelopes. Settle this with one explicitly authorized `doctor --probe` call and a scrubbed recording; no such call was made during implementation.

9. **`[ASSUMPTION 9]` default reproduction image digest — partly settled.** On 2026-10-19 Claude read the index digest from the registry with `docker buildx imagetools inspect node:22-bookworm-slim` (`sha256:c3de60bf…978392`). The constant in `src/reproduce/isolation.ts` now uses it; the digest Codex had pinned did not match the registry. Still open: actual container behaviour (volume seeding, the report wrapper, vitest under `--read-only`), because the Docker daemon was not running. Run `QUORUM_CONTAINER_TESTS=1 pnpm vitest run tests/container` with Docker Desktop started to settle it.

1. **`[ASSUMPTION 1]` agy write and shell deny rule names:**
   - *Known:* permissions live in `~/.gemini/antigravity-cli/settings.json` under `permissions.allow` / `permissions.deny`, with entries like `read_file(<path>)`.
   - *Unknown:* the tool names for writing files and running commands in deny rules.
   - *Cheapest Probe:* read agy's own docs on permissions; no inference needed.
2. **`[ASSUMPTION 2]` claude CLI Headless Mode Flags:**
   - *Settled:* Codex's review confirmed `claude -p` and `--model` exist in the installed CLI. Use the aliases `sonnet` / `opus`, never a dated model id.
   - *Settled for v1.x by Isaac's 2026-10-19 CLI facts:* Claude Code 2.1.285 supports `--restricted --strict-mcp-config --tools Read,Grep,Glob --permission-mode dontAsk`. Restricted mode ignores user/project/local settings and excludes command/code tools; strict MCP config skips MCP servers. Do not use `--bare`: it requires an API key instead of the user's OAuth login. Live behavior and the result envelope remain unverified by this implementation (see ASSUMPTION 10).
3. **`[ASSUMPTION 3]` agy `/usage` Output Format:**
   - *Assumption:* `agy /usage` returns machine-readable text or JSON containing quota group percentages that can be parsed without inference cost.
   - *Cheapest Probe:* Run `agy /usage` in Git Bash with `MSYS_NO_PATHCONV=1` and record the stdout format.
4. **`[ASSUMPTION 4]` Codex First-Run Sandbox Directory Access:**
   - *Assumption:* When `codex exec -C <dir> -s read-only` runs in a freshly created disposable worktree, it occasionally fails with a directory-access error on the first attempt and succeeds on an immediate retry.
   - *Cheapest Probe:* Run a 2-step test script creating a temporary directory and running `codex exec -C <dir> -s read-only -o out.json -` to observe exit codes.
6. **`[ASSUMPTION 6]` agy can read the disposable worktrees:**
   - *Known:* headless agy reads only folders allowed in its settings, and Quorum's worktrees get new paths on every run.
   - *Plan:* put every worktree under one fixed parent, `<repo>/.quorum/worktrees/` (gitignored), so one `read_file` rule covers them all. `doctor` check 8 verifies it.
   - *Cheapest Probe:* doctor check 7, inside the M4 probe budget.
8. **`[ASSUMPTION 8]` test-runner cache directory under a read-only `node_modules`:**
   - *Assumption:* the repo's runner (vitest, jest) can be told to write its cache to `/tmp`, through an environment variable or a flag in `reproduce.testCommand`.
   - *Cheapest probe:* run the synthetic `repro-repo` in M6 against a real container runtime, with no model calls.
7. **`[ASSUMPTION 7]` agy `--json-schema` and `--output-format json` shape:** record one real output during the M4 probes, and save it (scrubbed) as the golden fixture.
5. **`[ASSUMPTION 5]` Windows CMD Shim Argument Escaping:**
   - *Assumption:* Spawning `cmd.exe /d /s /c` with individual quoted arguments completely suppresses command injection when characters `& | < > ^ % !` are rejected upfront.
   - *Cheapest Probe:* Run Vitest unit tests in `tests/unit/resolver.test.ts` executing synthetic scripts with spaces, quotes, and escaped characters on Windows.

---

## 12. Decisions (Isaac, 2026-10-12)

Gemini's six questions were settled with the recommendations below. Isaac said "hazlo todo" after they were listed, so they stand until he changes them. Renaming is cheap before the first publish.

1. **Name:** keep the package `quorum-qa` and the binary `quorum`. Nothing is published, and [NAMING.md](NAMING.md) still has to be settled before the first npm publish.
2. **Jules:** disabled for all of v1 (`jules.enabled: false`). The AGENTS.md exception comes in v1.x, after commit pinning is solved.
3. **Default triage:** `agy:gemini-3.8-flash-medium`, with Qwen as the first fallback when it is running. No prompt to the user.
4. **CI exit codes:** `0` when no BLOCKER remains. `1` when any BLOCKER remains, **including unproven ones**, because an unproven BLOCKER keeps its severity. `2` for a tool or configuration error. A `--allow-unproven` flag makes unproven BLOCKERs not fail the run.
5. **`.quorum/`:** M0 adds it to `.gitignore`, and Quorum never commits it.
6. **`doctor` and agy settings:** it only prints the rules to add. It never writes the user's settings, and it has no interactive "apply" prompt.

**Added 2026-10-19 (Isaac asked Claude to take the decisions):**

7. **Checks of a reviewed repo:** Quorum reads `quorum.config.json` from the **merge-base commit** (`git show <mergeBase>:quorum.config.json`), never from the head of the change, so an untrusted PR can't add commands to run. `--trust-head-config` uses the head's config, for the user's own repos. M5 implements it.
8. **Budget bounds:** `maxCalls` <= 200 and `maxMinutes` <= 240. The `triage` and `review` tiers must be non-empty (implemented in M3).
9. **Jules for building Quorum:** skipped while session creation keeps failing (a 400, then a hang, on 2026-10-19). The provider order goes on to Codex.
10. **Local CI barrier:** `relaykit ci-local` always runs `node --test`, so it can't run this vitest suite. Until Relaykit runs the repo's own test script, the barrier before a push is `pnpm typecheck` + `pnpm test`. Linux and macOS are reported as not verified.
11. **Packaging:** Quorum stays a CLI. In v1.x a thin `/quorum` skill calls it, and the two ship together as a Claude Code plugin (see ROADMAP).
12. **M5 review corrections (2026-10-19, Claude decisions for Isaac):** In M5, a verifier-accepted BLOCKER confirmed by another family always exits 1, including with `--allow-unproven`. The waiver applies only to unconfirmed non-local BLOCKERs; M6 will also handle reproduction explicitly labelled `unproven`. Empty ranges exit 2 with "nothing to review". Touched files with no reviewed files, or binaries without visual coverage, make coverage incomplete; successful redesign image review covers only PNG/JPG/WebP binaries, never arbitrary binary files. Zero feature criteria is a usage error explaining checkbox/acceptance-heading formats. Announce configured checks before execution and recommend `--no-checks` for untrusted changes. Spec, inventory and rules must be non-symlink regular files of at most 256 KiB. Storage parent validation stops at the repo root (external selected outputs and linked repo ancestors are allowed); report/SARIF write failures warn, preserve stdout and keep the review exit code. Status includes failed checks, dirty checkouts warn that only committed HEAD was reviewed, and SARIF records execution success, coverage counts and unconfirmed count. Criteria are untrusted JSON data; visual calls are never cached; ledger locks expire after ten minutes. The chosen diff range determines the trusted config merge-base. These corrections supersede the broader waiver wording in decision 4.

13. **M6 install scripts and preparation:** install scripts default off: `pnpm install --frozen-lockfile --ignore-scripts`, `npm ci --ignore-scripts`, or `yarn install --immutable --mode=skip-build`. Validated `reproduce.allowInstallScripts: true` explicitly enables them and is disclosed in the report. Preparation has network access to fetch packages, runs as UID/GID 1000 with no-new-privileges, all capabilities dropped, 2 GiB memory, 512 PIDs, 2 CPUs, a read-only root and tmpfs `/tmp`. The worktree bind is read-only; the dependency volume is the only writable persistent mount.
14. **M6 BLOCKER waiver:** `--allow-unproven` waives only BLOCKERs with fewer than two distinct model families among their independent sources plus confirmer, identically with or without `--reproduce`. A cross-family-confirmed BLOCKER stays exit 1 for every unproven reason (cap, budget, missing proposal/runtime, new code or infrastructure). Limits never relax this gate. `not-reproduced` downgrades to IMPORTANT; `reproduced` retains BLOCKER. This supersedes the broader waiver wording in decisions 4 and 12.
15. **M6 informed host consent:** rename `--yes-run-untrusted` to `--no-host-prompt`; it automatically answers no (unproven), never authorizes execution. Before each revision's consent, show sanitized source, path and exact configured `testCommand` argv, explaining that the reviewed revision's package.json scripts, test config, setup files and dependencies also execute on the host. Strip ANSI, C0/C1 controls except newline/tab, and bidi controls. Pass only PATH plus SystemRoot/ComSpec/PATHEXT/TEMP/TMP on Windows, or HOME/TMPDIR/LANG on POSIX, never the full parent environment.
16. **M6 installer hooks (for Isaac):** `--ignore-scripts` does not disable pnpm's `.pnpmfile.cjs`, or Yarn Berry's repository releases and plugins. Unless `reproduce.allowInstallScripts` is true, pnpm also receives `--ignore-pnpmfile`, and a Yarn `.yarnrc.yml` with top-level `yarnPath:` or `plugins:` is unproven with reason `yarn configuration runs repository code (set reproduce.allowInstallScripts to allow it)`. A minimal line scanner recognizes plain or quoted keys without a YAML dependency. Both cache keys include `.pnpmfile.cjs`, `.yarn/releases/**` and `.yarn/plugins/**`, using the same skip rules and a shared 500-file dependency metadata cap. The explicit opt-in allows these hooks as well as install scripts.
17. **v1.x local-only coverage (2026-10-19, extended):** After triage, every chunk reviewed successfully only by a local-family model gets one escalation to the `review` tier, excluding local models and using its normal fallbacks. The full chunk is reviewed within the shared budget and confirmation reserve. A successful non-local review restores that chunk's coverage and its findings follow the normal flow; the original local findings still require rule 3b. If budget, quota or availability prevents this review, `coverage.complete` remains false with `reviewed only by a local model: <files>`, and a run without BLOCKERs exits 2. Finding-level confirmation never replaces a full review of the chunk, and recovering one chunk does not recover other chunks of the same file.
18. **v1.x per-focus confirmation routes (2026-10-19):** Optional `escalate.routes` maps non-empty focus keywords to non-empty ordered model-ref lists. Keys are additional focus triggers, including keys absent from `escalate.focus`. Every ref is validated against the catalog before any call, like tier refs. Match case-insensitively using the existing substring rule; select the keyword with the earliest position in `file + '\n' + trigger + '\n' + impact`, breaking ties by configured key order. Its list replaces `confirm` for finding confirmation; no match uses `confirm`. Author-family filtering, preference for another source family, same-family independence warnings and exclusion of local confirmers still apply. Exhausted routes fall back to `confirm` with an explicit warning. Routes share quota groups, call/time budgets and the confirmation reserve with tiers. Rule 3b still requires `review`; adjudication and reproduction continue to use the `confirm` tier.

19. **v1.x CodeGraph context (2026-10-19):** `context.provider` defaults to `git`; `codegraph` is opt-in, read-only and never indexes. It requires an existing `.codegraph/` directory and `codegraph` on PATH; on Windows the npm `.cmd` shim runs through the same safe resolver path as the deterministic checks (absolute cmd.exe and shim path, cmd metacharacters rejected per argument). Missing availability falls back to git with one warning. Queries use only `node --symbols-only` and `callers`, with `-p` and cwd pinned to the user's root; Quorum never runs `init`, `index` or `sync`. Index-derived context is explicitly untrusted and may be stale. The diff always has priority over optional context within the existing prompt cap.

20. **Fresh-worktree setup (2026-10-19):** Optional `setup` contains argv arrays validated and executed with the same resolver and runner as `checks`. Setup runs first in the disposable HEAD worktree; a failed or timed-out setup fails the checks phase and skips checks, while provider review still runs and receives the failure output. `--no-checks` skips both setup and checks, including in the dry-run plan. The stderr warning announces both and explains that setup executes the change's install scripts unless its command disables them. Doctor warns when checks are configured and `package.json` exists without setup: `checks run in a fresh worktree without node_modules`. This repository uses `[["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]]`. Setup obeys the existing trusted-base configuration policy; it does not copy dependencies from the user's checkout.

21. **Second real self-review fixes (2026-10-19):** Every agy inference purpose gets the adapter-level first line: "Do not call any tools: no file reads and no commands. Everything you need is in this prompt; answer only with the JSON." The shared review prefix instead says "If you can read files, read only what you need to check a line you cite." An empty agy response with stderr containing `required the "command" permission` or `auto-denied` raises `ProviderError('unavailable', 'agy tried to run a command in headless mode and returned nothing')`; the run warns once across models and does not disable the quota group. Default triage is [`agy:gemini-3.8-flash-low`, `qwen`, `agy:gpt-oss-120b-medium`]; this repo uses the first two. Effort is encoded in agy's model id. Qwen sends a strict purpose-specific JSON schema through `response_format`, using the shared schemas. HTTP 400 mentioning `response_format` or `json_schema` permits exactly one retry without that field, within the remaining time and call budget, with the run-deduplicated warning "qwen server does not support response_format". Severity parsing accepts case variants of BLOCKER, IMPORTANT and OPTIONAL only; it still rejects synonyms such as high and critical. This supersedes decision 3's Flash medium default.

22. **v2 precision (2026-10-19):** `escalate.confirmImportant` defaults to `true`; `false` retains the earlier call policy. After mandatory rules 1–4/3b, routes, adjudication and opt-in reproduction, remaining budget (including unused M3 reserve) can confirm verified IMPORTANT findings sourced exclusively from triage calls of one non-local family, with no mandatory escalation. Group by resolved route and source family, up to five per `confirm-batch` call; prefer another family and warn if only the source family remains. Qwen never confirms. Match the object-root `decisions` answer by opaque `c1`–`c5` ids only; ignore unknown ids and every occurrence of duplicated ids. Reject invalid batch envelopes instead of extracting nested JSON. Confirmation preserves confidence (decision B), records confirmation families and enforces same-file, ten-line relocation with unchanged code in bughunt. Rejection removes the finding, records `rejected by confirmation` in the ledger and lists both reviewers in `Rejected on confirmation`. Missing/invalid answers or exhausted resources retain the IMPORTANT with `singleSource: true`, the report tag `single model, not confirmed`, and its SARIF property. Confirmation does not change coverage or IMPORTANT exit semantics. Dry-run discloses the setting and grouping/batch size.

23. **v2 contract (2026-10-19):** `--mode contract --rules <business-rules.md> [--copy <file-or-dir>]` compares numbered Markdown clauses (600 characters each) against committed HEAD touched files and direct relative imports. Import scanning uses a regex, six source extensions, 64 KiB files and 20-per-file/60-per-run caps. Explicit copy accepts 50 supported text files at 64 KiB each without symlinks. Stable untrusted clause prefixes and full rules/copy hashes isolate cached chunks. Only contradictions with code or copy evidence survive verification; missing/unknown clause citations remain tagged. Rules status is `contradicted` or `no finding`, never inferred satisfaction. Existing escalation, routes, optional IMPORTANT confirmation, budgets, ledger and exit semantics apply.

---

24. **v2 rule mining (2026-10-19):** Final reported verified findings, including unconfirmed and bughunt change-point sections but excluding confirmation rejections, append to local `.quorum/findings.jsonl` under the ledger's atomic lock. Quotes are capped at 400 characters; exceeding 5 MiB retains the newest complete records within 2.5 MiB. `quorum rules propose` clusters single-line evidence shapes with 3–40 tokens, defaults to three occurrences in 90 days, and requires two distinct runs and files. OPTIONAL/improvement findings never qualify. Proposals self-verify and measure noise on bounded tracked HEAD text without models. Humans accept rules into `quorum.rules.json`; it is never generated automatically. Review reads that file from the same trusted commit as config (merge-base, or committed HEAD with `--trust-head-config`) and checks added lines before models. Each regex runs in a worker with a one-second deadline; lines over 2000 characters are skipped with a note, and timeouts warn. Matches stay outside model findings, cache, verification, dedupe and cascade. Error matches exit 1 even with incomplete coverage; warnings preserve existing coverage/BLOCKER exit semantics. `--no-checks` skips rules; dry-run and doctor disclose them.

25. **v2 refactor, part 1 (2026-10-19):** `--mode refactor` collects deterministic evidence in disposable merge-base and HEAD worktrees, running trusted setup and the suite test command through the checks resolver/runner. Shared machine-readable reporter arguments and `parseTestReport` supply test identities; human output is never evidence. Optional `refactor.testCommand` overrides the reproduction-derived suite command; `timeoutSeconds` defaults to 600 (30–3600). Tests compare regression/fixed/removed/added/failing-both/skipped changes and disclose edited test files. A bounded lexical TS/JS export scanner, package-field diff and two-hop reverse relative imports report API breakage and blast radius. The normal cascade receives an untrusted deterministic summary in its stable, cache-keyed prefix; `--deterministic-only` skips provider calls. Verdicts are NOT EQUIVALENT (1), SUSPECT (0), NO BEHAVIOUR CHANGE FOUND (0), and UNKNOWN (2); unavailable evidence stays UNKNOWN unless a verified BLOCKER forces 1. `--allow-api-change` makes API breakage a note; `--no-checks` exits 2. Part 2 mutation sampling is described in decision 26.
26. **v2 refactor, mutation sampling (2026-10-20):** Only `--mutation` enables deterministic lexical mutation sampling of added/modified source lines. `refactor.mutation` optionally configures maxMutants (1–25, default 8) and budgetSeconds (30–3600, default 300). Mutants run sequentially in the disposable HEAD worktree after a clean head suite, with fresh machine reports and verified restoration in finally. SHA-1 ordering within operators and operator round-robin make selection repeatable. Survivors yield SUSPECT: an undetected artificial bug exposes weak test evidence, not a regression in the actual refactor, so survivors never independently yield NOT EQUIVALENT. Invalid mutants, skipped work and budget exhaustion are report notes only; restoration failure makes evidence unavailable. No new dependencies or provider calls.


27. **Auto-scaled call budget (2026-10-22):** Two real self-reviews showed that a fixed 12-call default left too little room for confirmation on seven chunks; a 40-call run let Codex reject false findings. When the trusted config omits `budget.maxCalls`, resolve `clamp(3 x payload.chunks.length, 12, 40)` after context construction and before the cascade. `AUTO_MAX_CALLS_CEILING` fixes the automatic ceiling at 40. Validation records raw property presence as `maxCallsExplicit`; an explicit 12 or 50 stays exactly that value (validator range 1–200), while `budget: { maxMinutes: 5 }` remains automatic. The planner, triage limit, shared `RunBudget` and report metadata use the resolved value. Runtime and refactor `--deterministic-only` retain 12 without chunks; visual review still takes the minimum of its own cap and the global budget. Time limits, confirmation reserve, quota-floor skipping and cache flags do not change. Dry-run prints the number and its source; real runs announce automatic values above 12 once on stderr, with instructions to pin the budget. Markdown and JSON expose `callBudget.maxCalls` and `callBudget.auto`. This leaves room for independent confirmation without silently raising an explicit user limit or allowing unbounded automatic spending.

## Review corrections

Claude checked Gemini's draft on 2026-10-12. Each item below changed the draft:

1. **agy invocation.** In a live probe, `-p` followed by `--model` took `--model` as the prompt. agy doesn't read the prompt from stdin. And `--mode plan` turned the model into a planning assistant that asked what to plan instead of answering. The adapter uses `--print=<prompt>` and no `--mode plan`. PLAN.md's adapter row was updated to match.
2. **Invented commands removed.** `agy auth login`, `agy config get/set` and the path `~/.gemini/antigravity/settings.json` don't exist. The real file is `~/.gemini/antigravity-cli/settings.json`. Quorum reads it and never writes it.
3. **Worktree readability** (new ASSUMPTION 6). The disposable worktrees live under a fixed `.quorum/worktrees/`, so agy's `read_file` allow rule can cover them.
4. **No dollar estimates.** Providers run on subscriptions, so the ledger records calls and duration, plus tokens only when a CLI reports them.
5. **Verifier paths.** It rejects absolute paths instead of stripping them, resolves symlinks with `realpath`, compares case-insensitively on Windows, and never URL-decodes.
6. **Dedupe table.** The similarity numbers don't follow the stated Jaccard metric, so M1 calibrates the metric (see 5.5).
7. **Probe budget.** The doctor probes that call a model (checks 7 and 10) count against M4's limit of 3 approved calls.
8. Small fixes: the SARIF `informationUri`, rule names by severity, relative links in the markdown report, and the missing test files in the layout.

### Codex review of this document (2026-10-12)

Codex reviewed commit 1172f8d read-only and found 1 BLOCKER and 10 IMPORTANT. All of them were fixed in the sections above:

- **BLOCKER:** no safe algorithm for writing a *new* test file. Added `writeProposedTest`: parent walk with `lstat` and `realpath`, exclusive create, no symlinks or junctions.
- The resolver keeps the absolute path that PATH resolution returned.
- The reproduction lane receives the finding (so `origin` decides the base check) and runs only the test file.
- A container contract: preparation step, test step, and `unproven` when the infrastructure is missing.
- The verifier has one similarity, one threshold (0.85) and explicit tie-breaks.
- The arithmetic of dedupe row 9 is fixed.
- Qwen-only findings are never final.
- Deadlines kill in-flight calls.
- Doctor doesn't call the nonexistent `agy --version`.
- M0 requires `checks`, resolves author aliases, and parses `--author` and `--rules`.
- Dry-run shows ledger-based or unknown quota, and never drops the floor silently.

### Gemini review of the fixes (2026-10-12)

Gemini 3.1 Pro reviewed eb7345d read-only and returned 3 BLOCKER and 4 IMPORTANT. Claude checked each one. One was false and six were real:

- **False:** it called `--print-timeout` an invented flag. It is listed in `agy --help`. No change, and the deadline rule now says so.
- **Fixed:** `reproduce.image` and `timeoutSeconds` were missing from `QuorumConfig`.
- **Fixed:** the container preparation step contradicted itself (only the worktree mounted, but cached in a volume). The volume is now mounted at `/work/node_modules`, and the test step mounts it read-only.
- **Fixed:** the default image has no pnpm. The preparation step runs `corepack enable`.
- **Fixed:** the tie-break order contradicted table row 21. Local beats global first, then exact beats fuzzy. Row 20 now says CORRECTED.
- **Fixed:** `'failed'` vs `'not-reproduced'` in the status union.
- **Fixed:** `CommandRunner` options now carry `windowsVerbatimArguments`.
- **Fixed:** the deadline rule is a general rule for every call, and the ledger has `timedOutCalls`.
- **New, from its analysis:** an `introduced` BLOCKER in brand-new code can't pass at base, because the symbol doesn't exist there. The base check can't run for files that are new at base. Codex then showed that treating that case as "reproduced" is gameable, so it became `unproven` (see the next section).

### Codex re-review of the Gemini fixes (2026-10-12)

Codex reviewed c7f9a00 read-only. It confirmed 6 of 8 corrections and found 1 BLOCKER and 2 IMPORTANT, all real, fixed in the commit after it:

- **BLOCKER (introduced by my own fix):** skipping the base check for new code let a trivial test (`expect(1).toBe(2)`) become a "reproduced" BLOCKER. New code is now `unproven`, never `reproduced`.
- **IMPORTANT:** `corepack enable` in the preparation container didn't carry over to the test container, which has no network. The manager is installed in a derived image instead.
- **IMPORTANT:** a read-only `node_modules` breaks runners that write caches. Caches go to `/tmp`, and `EROFS`/`EACCES` count as infrastructure (`unproven`).

### M0 as built (2026-10-12)

- Config loader: an empty `checks: []` is accepted. It is the explicit way to say "this repo has no deterministic checks". `checks` omitted is still an error. Inherited (non-plain-object) configs are rejected.
- Any unexpected error exits with 2, never 1: exit 1 means "BLOCKERs found" (decision 4).
- `pnpm test` builds first, and the built-CLI tests fail instead of skipping when `dist/` is missing.
- Gemini reviewed the code read-only. Of 8 findings, 4 were fixed, 1 was a documented decision (empty checks), 1 was wrong (it asked for `zod`, which this plan dropped), and 2 were optional (empty tiers, budget upper bounds) and left for M3 where the cascade uses them.

### M1 as built (2026-10-12)

**Verifier** (`src/verifier/`). Implemented as in 4.1 to 4.4. Choices where the text left room:

- `normalizePath` is synchronous and rejects every `:` in a path (drive letters, URL schemes, alternate data streams). A POSIX file with a colon in its name is therefore never verified. A segment made only of dots and spaces other than `.` and `..` is rejected too, because Windows drops trailing dots and spaces. A `..` that stays inside the root is allowed. A missing file is confined through the real path of its deepest existing parent, so a symlinked directory cannot be used to name a file that does not exist yet.
- `normalizeQuote` also drops leading and trailing blank lines. Row 2 needs it (a trailing `\r\n` must not add a second line to the quote).
- "Exact" means the normalized quote appears verbatim inside the normalized slice of lines, so a quote that is a fragment of a line (`!user.token`) is exact. The table has no such row and 4.3 says "exact match against slices of lines"; a whole-line comparison would reject many real quotes. Fuzzy compares the whole slice (same number of lines as the quote) with the quote. Very short quotes (`}`, `;`) are weak evidence, so the M1 fixes reject a quote with fewer than 4 letters or digits.
- The +-10 window bounds the **start line** of a slice. An unusable cited line (NaN, 0, negative, fractional, infinite) has no window, so the search goes straight to the whole file. Outside the window a duplicate is never resolved by distance or by line number (M1 fixes: "ambiguous: matches N places"); this replaces the old "ties resolve to the lowest line".
- Limits: quote at most 40 lines and 8192 characters after normalization (and 64 KiB raw, checked first), file at most 2 MiB, a file line at most 16 KiB (longer lines are skipped by the search). All are rejected or skipped with a reason, never truncated. One call spends at most 20 million edit-distance cells; then it is rejected as "search budget exceeded". Measured on generated code: in a 3,625-line 150 KB file a typo'd 20-line quote is found in about 10 ms and an absent 10-line quote is "not found" in about 10 ms, while an absent 40-line quote runs out of budget in about 80 ms; in a 48,681-line 2 MB file a typo'd 20-line quote is found in 20 to 70 ms and an absent quote of 10 or more lines is "search budget exceeded" in about 100 ms.
- `verifyFinding` returns `correctedFinding` for every verified finding (`verified: true`); `verification_note` is set only when the line moved or the match was fuzzy. `evidence_quote` stays the original quote and a fuzzy note carries the text actually found (`found in code: "..."`).
- Confinement (M1 fixes): `normalizePath` returns the real path, `verifyFinding` opens it once, `fstat`s the same descriptor (regular file, size) and reads at most that many bytes from it. It never stats and then reads by path. The check is meant for a worktree the provider process has already stopped writing to; it is not a defence against a concurrent attacker who swaps path components between the confinement check and the open.

**Dedupe** (`src/dedupe/`). *Superseded by "M1 fixes (Codex review)" below: the overlap coefficient described here no longer merges, it only annotates `possibly_related`; merging needs a Jaccard of 0.85.* The Jaccard threshold of 0.70 in 5.2 does not reproduce table 5.5, as the correction in 5.5 predicted. The chosen metric is the **token overlap coefficient** `|A n B| / min(|A|, |B|)` over lowercase, stemmed word tokens without stop words, compared on trigger + impact, with a threshold of **0.15** and a rule that fewer than two shared tokens never merges. The stop list includes absence words (missing, never, without, no, not, omitted, lacks): without them row 10 rises to 0.17 and the gap to the rows that must merge (0.20) nearly closes.

Similarity per linked pair of 5.5 (fixture texts in `tests/fixtures/dedupe/rows.ts`, written for this repo):

| Pair | Must | Token Jaccard | Trigram Dice | Overlap (chosen) | Levenshtein |
|---|---|---|---|---|---|
| row 1 | merge | 0.182 | 0.387 | 0.333 | 0.300 |
| row 2 | merge | 0.125 | 0.224 | 0.231 | 0.340 |
| row 4 | apart | 0.000 | 0.072 | 0.000 | 0.234 |
| row 5 | merge | 0.211 | 0.364 | 0.364 | 0.321 |
| row 6, A-B | merge | 0.167 | 0.300 | 0.300 | 0.248 |
| row 6, B-C | merge | 0.130 | 0.261 | 0.300 | 0.260 |
| row 8 | merge | 0.176 | 0.394 | 0.300 | 0.221 |
| row 9 | merge | 0.190 | 0.324 | 0.364 | 0.293 |
| row 10 | apart | 0.045 | 0.104 | 0.091 | 0.167 |

Rows 3 (line distance 12) and 7 (different files) are kept apart by the line and file rules; the text of row 7 is identical and row 3 shares its trigger. Windows (largest score of a pair that must stay apart, smallest of a pair that must merge): Jaccard 0.045 to 0.125, Dice 0.104 to 0.224, overlap 0.091 to 0.231. Levenshtein over words has no window (row 4 scores 0.234, above row 8 at 0.221), so it cannot satisfy the table. All ten rows pass with the chosen metric. The absolute numbers are low because the texts are long and paraphrased: the Similarity column of 5.5 is not reproduced and should not be used as a target.

Caveats: the paraphrase wording is synthetic and was written before the metrics were run, but it is still one author's idea of how reviewers write. Twelve extra control pairs (`CONTROLS` in the fixture) show no false merge, and two real paraphrases with no shared words (hardcoded key vs committed secret; file handle vs stream left open) stay separate. Re-calibrate on recorded provider output after M4.

Other decisions:

- Clustering visits findings by ascending line and joins a finding to a cluster when it is within 5 lines of **every** member and strongly similar (Jaccard >= 0.85 after the M1 fixes) to **at least one**; the best-scoring cluster wins. A pairwise-only rule would let findings 5 lines apart chain across 20 lines.
- 5.2 lists `fix` among the compared text; 5.5 says trigger + impact. Fix is not compared (different fixes for one defect are common).
- `Finding` has no tier, so `dedupeFindings(findings, { tierOf })` takes an optional callback. Without it, or when it returns undefined, the fix of the most confident finding is used. `visual` ranks with `review`.
- Origin: dedupe has no git blame. It takes the origin tags as given and resolves introduced > pre-existing > improvement. M3 must run `determineOrigin` before dedupe (or on the merged line afterwards), because a model's `introduced` tag alone flips the merged origin.
- Consensus is appended to `verification_note` (`also reported by codex:gpt-5 (openai)`); the text, line, provider and model stay those of the most confident finding.
- The "possibly related" grouping of 5.5 was first left out for lack of a field on `Finding`; the M1 fixes added `possibly_related`.

### M1 fixes (Codex review)

Codex reviewed commit 8cf39b2 read-only and found seven real problems in the verifier and the dedupe. All seven are fixed in the worktree, with tests. Where a fix contradicts a row of table 4.4 or 5.5, the table gave way and its rows are rewritten above (4.3 items 4 to 6, 4.4 rows 11, 21 and 22 to 27, the note and rows 1 to 10 of 5.5, and the Finding type in section 2).

1. **A fuzzy match must not flip the meaning (BLOCKER).** Against `if (!user.token) return false;`, `if (user.token) return false;` verified at 0.97 and `if (!user.token) return true;` at 0.87. A fuzzy match (>= 0.85) now only locates a candidate. It is verified only if the quote and the matched text have the same sequence of semantic tokens (`src/verifier/semantic.ts`): the operators and negation of the contract (`!`, `!=`, `!==`, `==`, `===`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `??`, `+`, `-`, `*`, `/`, `%`, `=>`), plus assignment, compound assignment, `++`, `--`, `**`, shifts and bitwise operators so `+=` cannot pass for `-=`; the words true, false, null, undefined, nil, none, not, and, or, return, throw, raise, if, else, break, continue, await (case-insensitive); and every number and string literal. Identifier spelling is free (row 11 still verifies). A mismatch is rejected with a reason that names the token and shows the code found; a verified fuzzy match keeps the ORIGINAL `evidence_quote` and puts the code found in `verification_note`. The check applies to the one candidate the search located: a local fuzzy match that flips the meaning rejects the finding even when an exact copy exists far away, and is not replaced by it.
2. **Trivial or out-of-context evidence (BLOCKER).** A quote with fewer than `MIN_ALNUM = 4` letters or digits (after normalization) is rejected. A match outside the +-10 window corrects the line only if the quote occurs exactly once in the file: one exact occurrence (several on one line count as several), or one fuzzy candidate with no other candidate within 0.05 of it (shifted slices of one multi-line match count as one place). Otherwise "ambiguous: matches N places". Inside the window the nearest match still wins (rows 15 and 20), and a local fuzzy match still beats a global exact one (row 21).
3. **Dedupe must never hide a different defect (BLOCKER).** Automatic merge happens only on a STRONG match: same file, line distance <= 5, and Jaccard of the trigger + impact content tokens >= `MERGE_JACCARD = 0.85` with at least 2 shared words. Below that, findings stay separate. Separate findings within 5 lines with an overlap coefficient >= `RELATED_OVERLAP = 0.15` and at least 2 shared words are annotated with the new `Finding.possibly_related` on both, never with a change of severity or confidence. The cross-family boost applies only inside a strong merge. A finding joins a cluster only if it strongly matches at least one member and is within 5 lines of every member. The adversarial pair ("Missing authorization when deleting users" at line 10 and "Missing audit when deleting users" at line 12, two families, confidence 0.70) is a test: both stay at 0.70 and each points at the other (J 0.27, O 0.43). Same text twice from one provider still merges, without a boost. A cheap same-defect adjudication of related pairs by the confirm tier belongs to M3 (cascade), not to a lexical metric.
4. **Confinement holds for the read (IMPORTANT).** `normalizePath` returns the real path; `verifyFinding` opens it once, `fstat`s that descriptor for regular-file and size, and reads from it with a bounded read (size + 1 bytes; a file that grew is reported). It never stats and then reads by path. The open uses `O_NONBLOCK` where it exists so a FIFO cannot block. This is meant for a worktree the provider process has already stopped writing to, not a defence against a concurrent attacker.
5. **Linear-time normalization (IMPORTANT).** A raw quote over `MAX_RAW_QUOTE = 64 KiB` is rejected before it is normalized; normalization uses `trimEnd()` and `/ {2,}/g`; a file line over `MAX_LINE = 16 KiB` is skipped by the search (and reported in the "not found" reason). `'a' + ' '.repeat(40000) + 'b'` normalizes in well under 1 ms (it took 1.2 s).
6. **Bounded Levenshtein and a work budget (IMPORTANT).** The edit distance is banded with `maxDistance = floor(0.15 * max(len))` and exits when a whole band row exceeds it; the band starts narrow (or at twice a known lower bound) and doubles, so near-identical long strings cost O(length * distance). Before any distance is computed, the length and the multiset of non-space characters give a lower bound (computed for every start with a sliding window, O(file)); slices that cannot reach 0.85 are never compared, and the rest are compared closest first, with the bound tightened to 0.05 below the best once one candidate is known. All exact scans run before any fuzzy one and are not charged. Each call has a budget of `WORK_BUDGET = 20,000,000` cells (plus the sliding-window steps); beyond it: "search budget exceeded", never a hang. The adversarial test (an 8192-character quote of `a` against 255 lines of 8191 `a` and a `b`, cited at line 5000) returns "search budget exceeded" in about 80 ms and the same result when repeated; cited at a line inside the file it verifies the nearest line at once.
7. **Exact-size test (OPTIONAL).** The "file at the limit" test now builds exactly `MAX_FILE_BYTES` bytes (asserted with `Buffer.byteLength` first) and adds the +1 byte case, which is rejected.

New constants: `MERGE_JACCARD = 0.85` and `RELATED_OVERLAP = 0.15` (`src/dedupe/similarity.ts`, with `MIN_SHARED_TOKENS = 2`); `MIN_ALNUM = 4`, `MAX_RAW_QUOTE = 64 KiB`, `MAX_LINE = 16 KiB`, `WORK_BUDGET = 20,000,000` and `AMBIGUITY_MARGIN = 0.05` (`src/verifier/quote.ts`).

Rewritten table rows: 4.4 rows 11 (note) and 21 (the quote is `compute();`, because `foo();` is now too short), new rows 22 to 27; 5.5 rows 1 to 10 (rows 1, 2, 5, 6, 8 and 9 changed from merged to separate and possibly related; rows 3, 4, 7 and 10 stay separate). The paraphrase pairs of the fixtures score J 0.125 to 0.211 and O 0.231 to 0.364; the unrelated pairs of rows 4 and 10 score O 0.000 and 0.091 (below 0.15 and, for row 10, under 2 shared words).

Known limits left on purpose: the meaning check is lexical, so a flip that is not an operator, a listed word or a literal (swapping two identifiers) still verifies; a quote of more than a few lines that is absent from a large file can end as "search budget exceeded" instead of "not found" (both are rejections); related pairs are only pointed at, and deciding if they are one defect is M3's confirm tier.

### M1 final round

An independent reviewer reproduced four problems in commit 361fa4b. All four are fixed, each with regression tests that reproduce the reviewer's case. Where a fix changes what "M1 fixes (Codex review)" above says, this section wins.

1. **Swapped operands verified (BLOCKER).** `if (b < a) return false;` verified against `if (a < b) return false;` because identifiers were not compared. A fuzzy match is now trusted only when the FULL token sequence is the same (`src/verifier/semantic.ts`): identifiers, operators, keywords (the same list as before), numbers and strings, in order. Operators, keywords, numbers and strings must be identical. An identifier must be identical too, except for a typo, which is tolerated only when all of these hold: both names have at least `IDENTIFIER_MIN_LENGTH = 4` characters; they do not differ only in their digits (`item1`, `item2`) or by a final `s` (`user`, `users`), which are different variables of one scope, not typos; and their edit distance is at most 23% of the longer one (`IDENTIFIER_SIMILARITY = 0.77`), counting a swap of two neighbouring characters (`total`, `totla`) as one edit. So `TAX_RATE` and `TAX_RATIO` verify; `a` and `b`, `id` and `ip`, `user` and `users`, `data` and `date` do not. The rejection names the token: `the quote has the identifier "b" where the code has the identifier "a"`. Punctuation that only groups or separates (parentheses, brackets, braces, commas, semicolons, dots) is not a token.
2. **A template literal verified as a plain string (BLOCKER).** `"Hello ${user.name}"` verified against `` `Hello ${user.name}` ``. The delimiter (double, single, backtick) is now part of a string token, so every swap of delimiters is rejected (six combinations are tested). A template literal is tokenized as its text chunks plus the code inside each `${...}`, with braces and nested templates counted, so a changed operator or name inside `${...}` is caught, and a typo in a long name there is tolerated like anywhere else. The scan is a single linear pass; an unterminated string ends at the end of its line and an unterminated template ends at the end of the text.
3. **Dedupe merged two different defects that share a long impact (BLOCKER).** The Jaccard was computed on trigger and impact as one bag of words, so a long impact in common drowned the three words that differ (combined 0.895, trigger alone 0.5). An automatic merge now needs the token Jaccard of the trigger AND, separately, the token Jaccard of the impact to be at least `MERGE_JACCARD = 0.85`, plus the line distance rule (and at least two shared words in total, as before). `findingJaccard` is now the lower of the two. The `possibly_related` annotation still uses the overlap of the combined text, so such a pair stays separate and is annotated. The reviewer's pair (lines 10 and 12, two families, confidence 0.70) is a test: it stays at 0.70 on both and each points at the other. A field with no content words on either side counts as equal, so a finding with an empty impact still merges with its twin.
4. **The triviality filter rejected real evidence (IMPORTANT).** `x++;`, `a=b;`, `foo();` and `<div>` were rejected for having fewer than `MIN_ALNUM = 4` letters or digits. A short quote (at least one letter or digit, fewer than `MIN_ALNUM`) is now accepted ONLY when it appears exactly on the cited line (distance 0). It is never relocated, never fuzzy-matched and never searched for in the rest of the file: `x++;` cited at another line is rejected, also when the line is inside the old +-10 window, and also when the cited line is not usable. It must not start or end inside an identifier (`x++;` is not found in `max++;`). A quote with no letter or digit at all (`}`, `)`, `});`, `];`, `{`, `;`, `=> {}`) is still rejected outright, also at the right line: it carries no information. The reviewer asked only for closing punctuation here; the rule is wider because those quotes were rejected before and nothing in the request argued for accepting them. A short verified quote carries no `verification_note`.

Test expectations that these fixes legitimately changed (nothing else was touched): the message of "a changed string literal is rejected" now shows the string with its own delimiters (`the string 'script'`, not `the string "script"`); the three `semantic tokens` tests now list identifiers and the delimiter of a string, and the check that `'same'` and `"same"` are equal became the check that they differ. The trivial-quote table is unchanged: `abc` is still rejected with "too short", now because it is not on the cited line, and the other entries have no letter or digit.

Where this round departs from the request: the brief asked for an identifier similarity of 0.8, but `TAX_RATE` and `TAX_RATIO`, its own example and table 4.4 row 11, are two edits in nine characters (0.778) and fall under it, so the bound is 0.77, which still keeps a four-character name exact. The treatment of `user`/`users` and of identifiers that differ in digits, and the neighbouring-swap edit, are decisions the brief left open.

**Known limits of the verifier.** It is a lexical check of the quote against the code. It does not know semantics: it cannot tell that two different identifiers are interchangeable, nor that two spellings of one expression mean the same, it ignores punctuation (so `(a + b) * c` and `a + (b * c)` have the same tokens), it cannot judge whether the finding's explanation is true, and a short exact quote at the right line is weak evidence that a model may produce without having understood the code. A typo-sized difference in a name is tolerated on purpose, so `token` and `taken` count as one name. Dedupe is conservative and cannot decide that two differently worded findings are the same defect; it keeps them apart and points at them with `possibly_related`, and deciding is a job for the confirm tier in M3.

## M2 as built

M2 adds `src/checks/{resolver,index}.ts`, `src/context/{git,blame,index}.ts`,
`src/process/runner.ts`, and four test files (`resolver`, `checks`, `context`,
`runner`). The current M2 brief supersedes the older signatures in section 3.
M0/M1 behavior, tests, dependencies, PLAN.md and AGENTS.md are unchanged.
The only shared type addition is optional `ReviewContext.requestedBaseCommit`.

Decisions and deviations:

- Checks return per-command argv, exit code, duration, timeout and UTF-8 byte
  tails (4 KiB), continue after failures, and default to 120 seconds per check.
  Git commands default to 30 seconds. The existing `CommandRunner` type is
  unchanged: `CommandTimeoutError` carries captured output; checks report
  `timedOut: true` and exit code 1. An ordinary exit code 124 is not a timeout.
- Resolution ignores empty, relative and cwd PATH entries, including an explicit
  cwd entry. Explicit absolute executable paths are allowed. Windows environment
  keys are case-insensitive. Shim paths, as well as arguments, reject expansion
  characters; NUL is rejected in addition to the specified metacharacters.
- `buildReviewContext` resolves both refs, computes their merge base, and uses
  `<mergeBase>..<head>` for both the diff and touched files. `baseCommit` is that
  merge-base SHA; optional `requestedBaseCommit` preserves the original base SHA
  without breaking existing M0/M1 consumers. The diff helper also accepts `a...b`.
  Diff truncation includes its marker within 512 KiB. No AST
  extraction was added: it is outside the current brief and ReviewContext type.
- Changed files use NUL-delimited status/path pairs with rename detection disabled;
  a rename is represented as deletion plus addition. Refs use a conservative plain
  ASCII ref grammar; revision operators such as `HEAD~1` are intentionally rejected.
  Missing commits and blame errors fail explicitly. Blame validates the head line
  before treating a file absent at base as introduced; invalid lines do not receive
  an origin. This layer never emits improvement.
- Context building, diff, changed-files, file existence and blame require `cwd`
  to be the repository root, validated with `rev-parse --show-toplevel` and real
  paths. Subdirectory callers receive an explicit error.
- Capture retains at most 1 MiB each for the prefix and tail of each stream (up to
  4 MiB total retained bytes). `CommandOutputLimitError` exposes bounded output and
  the exit code. Checks use its tails; diffs use its marked prefix. Other Git
  helpers fail on overflow instead of accepting an incomplete file list or SHA.
- The runner spawns without a shell, uses a POSIX process group and SIGKILL, and
  invokes absolute System32 taskkill with /T /F on Windows. If taskkill fails, it
  attempts direct termination and reports an explicit unverified-tree diagnostic
  in the timeout error. In this restricted Windows environment taskkill returns
  Access denied. The real timeout tests verify parent and child PIDs disappear,
  but successful taskkill execution and the POSIX process-group branch remain
  unverified here. Direct termination alone is not a general tree-kill guarantee.
  After the timeout deadline, the runner allows at most one second for exit and
  pipe closure, then destroys stdout/stderr and rejects even if an orphan retains
  the pipes. A taskkill spawn error also remains a `CommandTimeoutError`, so checks
  retain `timedOut: true`; the termination diagnostic is included in stderr.
- Tests create only synthetic temporary repositories with fixed identity/dates;
  Git integration skips only when git cannot be resolved on PATH. Windows shim
  quoting is tested both with injected win32 resolution and a real .cmd file.
  Every Git helper pins `color.ui=false` and `core.quotePath=false`. Both diff
  operations explicitly set `--no-color --src-prefix=a/ --dst-prefix=b/`, disable
  renames, external diff and text conversion, including under hostile global config.
- Windows shims use `ComSpec` only when it is an absolute path to an existing
  file. Otherwise they use `System32/cmd.exe` under an absolute `SystemRoot`, or
  `C:\Windows` when `SystemRoot` is absent or relative.
- Same-family read-only QA found and reproduced a UTF-8 prefix boundary overflow;
  it was fixed with a regression test. Cross-family review remains pending under
  this task's no-network restriction; no provider CLI was invoked.

Known limits:

- A renamed but unchanged file is classified `introduced`.
- A line changed and then reverted inside the range is `introduced`.
- A relative command containing a separator (for example `./gradlew`) reports
  "not found on PATH".
- User paths containing `& ! % ^` make a shim unusable (fail-closed).
- Before M5, decide whether a reviewed repository's own `quorum.config.json` may
  define checks: doing so would run commands from an untrusted PR.

## M3 as built

M3 adds the provider contract and scripted FakeProvider, catalog and quota groups,
budget, parser, planner, cascade and library barrel. Tests use synthetic data and
FakeProvider only; the integration pipeline creates its own Git repository. No
provider CLI, network request, ledger write or check command is started by M3.
M0-M2 implementations and tests are unchanged except the requested config bounds
and non-empty triage/review validation (and the matching config tests).

Decisions and ambiguities:

- The current brief supersedes the older section 3 signatures: `runCascade`
  returns findings, unconfirmed findings, related pairs, warnings, call records
  and per-call ledger drafts. M5 supplies run IDs/timestamps and persistence.
  Drafts retain counted parse, verification, dirty-worktree and confirmation
  rejection reasons. No reproduction is run or claimed in this milestone.
- `src/providers/types.ts` owns the raw adapter contract; the shared types module
  re-exports it. The older `ProviderResult` shape remains available for source
  compatibility but is not an adapter result. Catalog entries now require a
  provider. Bare `codex` and `qwen` use those strings as their model IDs; bare
  `claude` aliases `claude:sonnet`. Unknown catalog models fail explicitly.
- The catalog is the PLAN table's seed, including older Flash variants. M4 can
  replace it with discovery. Routing follows configured tier order, never adds
  Fable implicitly, and shares quota by group. Both planning and execution use
  only the supplied snapshot; missing/invalid readings remain eligible with
  `floor unchecked`. No quota/probe endpoint is called. M4 owns live preflight.
- Every inference, fallback and adjudication shares the call/time budget. An
  injected clock makes deadline tests deterministic. Adapters receive remaining
  milliseconds and an optional AbortSignal; the deadline aborts even a pending
  FakeProvider. Real process-tree termination remains the M2 runner/M4 adapter's
  responsibility. A timeout before the overall deadline escalates triage to
  review; confirmation can try another model within the remaining budget.
- JSON extraction scans balanced candidates in one pass (including bracketed
  prose), understands escaped strings, and caps raw text at 1 MiB characters.
  Arrays of objects and `{ "findings": [...] }` envelopes are accepted.
  Invalid entries are dropped individually. Model verification flags, identity,
  related annotations and reproduction status are never trusted. An incomplete
  outer JSON candidate is a parse failure, rather than a salvaged inner finding.
- Confirmation JSON is `{ "decision": "confirm" | "reject", "evidence_quote":
  "..." }`; confirm requires real evidence and may correct line, confidence,
  trigger, impact, fix and reproduction proposal. It cannot change the target
  file or severity. Same-defect adjudication uses `{ "same": true | false }`.
  Both include only the relevant hunk and finding(s); review receives the diff
  and supplied context. Missing hunks fall back to the verified quote.
- Verification and origin run before dedupe, including confirmation evidence.
  Final confirmed evidence comes from the confirming reviewer. Original source
  findings remain available internally when deduping/adjudicating, so a merged
  representative never loses family provenance or gets its boost added twice.
  Unavailable confirmation puts the original verified finding in `unconfirmed`;
  local-only sources can never enter final findings. Unresolved related pairs
  remain separate and annotated without any additional confidence boost.
- Dry-run is a pure plan formatter, with configured checks, eligible/fallback
  tier paths, quota reading times, payload character count and budget. Context
  carries spec content rather than a spec path, so it says content was supplied;
  it prints the resolved head SHA rather than inventing a ref name. Quota times
  are shown with a six-hour expiry; older readings are unknown, not refreshed.
  CLI wiring, full mode prompts, reproduction and ledger persistence remain in
  their later milestones.

Cross-family external review remains unavailable under the task's no-network
and no-provider-CLI restriction; the available independent review is read-only
within the same model family.


### M3 independent-review fixes (f19c474)

These decisions supersede the original M3 notes above:

- **Decision A:** rule 3b is a minimum. A local finding must pass review, and
  rules 1/2/3 additionally require confirm. A missing required confirmation
  leaves it unconfirmed; rejection discards it.
- **Decision B:** a prompted confirmation is not independent corroboration.
  Its confidence contributes only to the maximum source confidence. The family
  boost is computed exclusively from independent triage/review sources merged
  by strong dedupe or a positive same-defect adjudication. Confirmations never
  create an independent source, including confirmations issued by review.
- All four tiers and the author alias are validated before the first call.
- Parsing skips balanced prose such as [1] and {} until an object-array or
  findings envelope appears. Empty arrays are valid; a nonempty payload with
  no valid entries triggers rule 4. Single bare findings are no longer payloads;
  confirmation candidates are wrapped in arrays internally.
- MAX_FINDINGS_PER_RESPONSE is 100. Entries after that position are dropped as
  "too many findings". At most 20 related pairs are adjudicated per run.
  Verification checks the call/time budget between entries, so a response that
  consumes the last call is parsed but no new verification starts. Adjudication
  checks budget/deadline in its loops. Previously verified findings are retained.
- Confirmation evidence must verify in the same file within ten lines of the
  original verified line. A distant real quote is invalid confirmation.
- Deadline expiration has its own flag; an adapter timeout does not set it.
  The budget warning is emitted for a skipped call or a deadline-killed call,
  not merely because a normally completed run used its final permitted call.
- Origin uses the separately injected gitRunner, defaulting to Quorum's
  runCommand, never the adapter runner. Quota older than six hours (or with an
  invalid timestamp) is unknown and cannot block a group. Untimestamped numeric
  readings retain the existing behavior for callers without ledger timestamps.
- Adjudicated merges retain the absorbed trigger and impact in verification_note.
  Confirm and adjudication prompts explicitly label findings and hunks untrusted.
  Every prompt is capped at 24,000 serialized characters. Review prompts use the
  coverage-aware chunking described below. Confirm/adjudication prompts shrink
  hunks first, then long fields, with a visible marker; reproduction proposals
  are omitted. Their last-resort omitted-payload envelope retains the hard cap.
  Planner tests mock child_process at module level and assert that neither spawn
  nor execFile runs.

Regression verification: the single completed old-source run had 24 failures and
45 passes across parser, cascade, limits and pipeline tests. New failing cases:
[1]/{} prefixes; all-invalid entries; 100-entry cap; local money BLOCKER with and
without confirm; invalid review/confirm/visual refs before calls; no spurious
budget warning; distant confirmation; 500-entry Git work bound (the old version
hit the test's then-default five-second timeout); deadline between verifications;
20-pair cap; absorbed descriptions; explicit timeout flag; stale quota; review
prompt cap; actual confirm/adjudication prompt cap and reproduction omission.
Updated confidence and call-budget expectations also failed on the old sources.
Invalid triage and author tests already passed on the old version.

Validation workflow deviation: git stash was attempted once but could not create
index.lock in the parent worktree metadata directory (outside the writable root).
Instead, modified source bytes were saved in memory, replaced with git show HEAD
versions for the baseline, and restored in finally. The first subprocess attempt
stopped before tests because Windows PowerShell rejected pnpm.ps1; explicit
pnpm.cmd ran the one completed baseline. No index, branch, commit or push changed.
The full final typecheck/test results are reported at delivery. External review
remains unperformed under the explicit no-provider-CLI/no-network restriction;
Linux and macOS are not verified. No dependencies were added.

### M3 re-review fixes, round 2

Review payloads are packed by complete file diff in diff order, measuring the
serialized prompt (including JSON escapes and instructions) against 24,000
characters. Only an oversized file is split at hunk boundaries, retaining its
file header. Only an oversized individual hunk is cut, with a visible marker
and a one-based hunk index. Supplied spec, inventory and rules are preserved;
if they leave no room for diff content, the file is skipped without a model call.
Missing diff sections are also skipped. Each chunk gets its own triage call and
review fallback, sharing the run budget with retries, confirmation and adjudication.

CascadeResult.coverage contains:

- reviewedFiles: unique files with at least one successfully parsed review chunk.
- skippedFiles: unique files with any missing, unsendable or unsuccessful chunk,
  including budget/deadline skips. A partially reviewed file can be in both lists.
- truncatedHunks: { file, hunk } entries for cuts made by the prompt builder.
- complete: false if any file was skipped or any hunk was cut. This describes
  diff review coverage; verification and confirmation outcomes remain in the
  ledger, unconfirmed list and warnings.

Each skipped file and each cut hunk generates a warning naming the file. The
planner uses the same chunk builder, reports chunk count and total serialized
characters, and estimates whether maxCalls covers initial triage. Retries and
escalation need extra calls; provider latency determines time feasibility.
Quota freshness and tier resolution both use the planner's injected clock.

Local verification never consumes provider-call slots: it continues after the
last allowed call. Findings left when time runs out are counted as rejections
with reason "run deadline", and emit the budget warning. Relocated confirmation
rejections no longer also count as verified. The 20-pair adjudication cap reports
the exact number of remaining eligible pairs. Confirmation and adjudication
JSON extraction skips unrelated JSON values such as prose [1].

Regression evidence: running the three updated unit-test files against HEAD's
original cascade sources produced 18 failures and 33 passes. Failures covered
last-slot verification, deadline rejection/accounting and warning, confirmation
and adjudication [1] prefixes, relocated-confirmation ledger counts, 100,000+
characters across files, insufficient call budget, 3,000 files, oversized hunk
cuts, no-room payloads, hunk-boundary splitting with full/partial budgets,
missing/unsuccessful chunks, planner clock/chunk estimate, and the 25-pair
unadjudicated warning. One direct builder test fails because the old sources lack
the new builder; the cascade no-room test separately proves the behavioral bug.
The no-process guard was mutation-tested by temporarily inserting a spawn call:
the mocked call made the planner test fail, without starting a process. Original
source bytes were restored in finally after both experiments.

Validation: pnpm typecheck and pnpm test pass (455 passed, 1 skipped across
17 test files). No provider CLI, network, dependency installation, branch switch,
commit or push was used. Independent provider review was not run because this
round explicitly forbids provider CLIs and network.

### M3 re-review fixes, round 3 (f241a27)

- Coverage is complete only when all touched text files were fully sent and no
  findings were lost to limits. Binary sections without hunks are the explicit
  exception: listed in coverage.binaryFiles, never reviewedFiles, with a note
  that visual review belongs to M5 redesign mode.
- M2 sets optional ReviewContext.diffTruncated for either its 512 KiB cap or
  command-output truncation. M3 strips both markers before creating prompts,
  records the last section's cut hunk and warns; the flag also prevents complete
  coverage even when a caller has already removed the marker.
- coverage.lostFindings groups reason, optional file and count for run-deadline
  losses, the 100-findings response limit and invalid responses after exhausted
  review retries. Each group emits a warning and prevents complete coverage.
  For unparseable output the unknown finding count is represented by the number
  of discarded responses, not an invented count of findings. A successful
  replacement review recovers an invalid response; verification rejections and
  explicit confirmation rejections remain deliberate filtering.
- Review chunks and confirmation hunks share the Git path parser. It reads
  diff headers, handles the trailing tab on path lines, and decodes C escapes
  and octal UTF-8 bytes. Tests include real Git paths with spaces and Unicode.
- Initial review calls (including retries) preserve max(1, floor(maxCalls / 3))
  calls once findings require escalation. With no escalation candidates the
  reserve is released. Unsent files are skipped and coverage is incomplete.
  Dry-run shows the reserve and evaluates chunk capacity after reserving it.
- Round 3 validation uses only synthetic Git repositories and FakeProvider;
  external cross-family review was not run under the explicit no-provider and
  no-network instructions. No dependency, commit or branch change is needed.

## M4 as built

M4 adds AgyProvider and CodexProvider, disposable detached review worktrees,
and `quorum doctor [--probe] [--json]`. The current M4 brief supersedes the
older signatures and live-probe acceptance criteria in sections 3 and 9.
No dependencies were added. Review remains unimplemented until M5.

- Adapters implement the M3 ProviderAdapter contract, resolve executables with
  the M2 resolver, and use its injected CommandRunner. Each review creates a
  worktree at the context head, checks porcelain status including untracked
  files, and cleans up in finally. M3 discards dirty results. The parent must
  be git-ignored and cannot be a symlink/junction. Cleanup is concurrent-safe,
  idempotent after success, and retries a failed remove/prune on a later call.
  Creation prunes Git metadata first, then removes only real, unlisted child
  directories older than 24 hours; registered worktrees and fresh entries stay.
  Cleanup failures preserve the original ProviderError and attach warnings,
  which the cascade includes in its warnings.
- Before its first provider call, the cascade snapshots the user's repository
  `git status --porcelain --untracked-files=all` and HEAD. After every call,
  including failures and Codex retry attempts, a difference aborts the entire
  run, records an error with changed paths (or HEAD), and returns no findings.
  Pre-existing dirty status is allowed if unchanged. Failure to check Git also
  aborts. This compares status and HEAD, not file contents: an edit that leaves
  the same porcelain status, ignored files, or writes elsewhere is not detected.
  Until ASSUMPTION 1 (agy deny-rule tool names) is settled, agy's protection
  against writes outside the review worktree is detection after the fact, not
  prevention; it is not a filesystem sandbox guarantee.
- agy uses the recorded SUCCESS envelope, argument prompt, sandbox and explicit
  timeout. Worktree preparation consumes the remaining deadline. On Windows the
  conservative 30,000-character guard also includes the resolved executable and
  quoting/wrapper overhead. The existing resolver intentionally rejects unsafe
  characters in .cmd/.bat arguments: multiline/JSON review prompts require a
  native agy executable on Windows. This fail-closed limitation is not bypassed.
- One catalog table maps model ids and usage descriptions to quota groups.
  Claude and GPT-OSS share the existing internal name `agy:anthropic` (a quota
  identity, not a model-family assignment). Argon is separate. Usage takes the
  minimum active bucket and the earliest valid reset among binding buckets;
  disabled buckets are recognized in JSON or the response text column. Missing,
  malformed and failed readings remain unknown. Codex quota remains unknown.
  Specific Argon model patterns precede generic Gemini patterns. Review quota
  detection runs only on failed calls, using stderr and agy envelope error/status
  fields with bounded quota/429 terms; model output, response text and stdout
  envelopes are never scanned. Timeout diagnostics use stderr only. Successful
  Codex calls with a nonempty output file cannot become quota errors.
- Codex writes its final message under the OS temporary directory, sends the
  prompt on stdin and removes the temporary directory on success or failure.
  Only a nonzero exit with missing/empty output permits one retry. A new optional
  ReviewOptions.reserveRetry hook reserves that inference in the cascade's call
  ceiling and ledger callsUsed. Retry time shares the original deadline and
  escalation reserve. Standalone adapters permit one retry without that hook.
- Doctor resolves configured checks without executing them, diagnoses provider
  availability, model ids, usage, permissions and containers, and checks Qwen
  only when configured. Qwen uses a two-second loopback-only GET with redirects
  refused. Settings are read only; neither contents nor parsing errors are
  printed. Unknown write/shell deny names always produce WARN with explicitly
  unverified suggested rules. No optional Claude diagnostic is included in M4.
  A covering read deny rule overrides an allow rule. Missing quorum.config.json
  is a FAIL with a setup hint, while independent Git/provider/container checks
  still run; invalid configuration continues to fail before diagnostics.
- Doctor probes are opt-in, each makes exactly one inference in a fresh
  worktree and compares the result with README.md's first line. The Codex doctor
  probe deliberately does not retry, following the brief's one-call limit;
  ordinary Codex reviews do retry. Probe failures and dirty worktrees fail the
  diagnostic, and cleanup still runs. CLI JSON is the check array; WARN alone
  exits zero and any FAIL exits two. CLI dependencies are injectable for tests.
  The agy probe selects only configured ids present in `agy models`; without
  such an id it reports FAIL without an agy inference call.
- Fixtures are the two scrubbed recordings supplied in .quorum/fixtures, copied
  to tests/fixtures/providers. Tests use only injected provider runners, mocked
  HTTP responses, synthetic settings and temporary Git repositories. No live
  provider, authentication, permission or endpoint probe was performed.

Remaining assumptions: actual agy write/shell deny tool names (1), live
worktree readability (6), and reproduction of Codex's first-folder failure (4)
remain unverified. Recorded JSON and usage settle the exercised envelope and
quota formats (7 and 3), but do not establish future CLI compatibility or
--json-schema behavior. Claude read-only flags (2) and container runner caches
(8) remain outside M4. The inherited Windows shim/process-tree limitations
remain. Linux and macOS were not executed. Internal read-only review found and
fixed pre-validation directory creation through a junction and incomplete argv
length accounting. Cross-family review was not run because the brief forbids
provider CLIs. No branch switch, commit or push was made.

Validation of the M4 review fixes on Windows: `pnpm.cmd typecheck` passed;
`pnpm.cmd test` rebuilt the CLI and passed 565 tests with one existing skip
across 21 files. `git diff --check` passed.

Before implementation, the focused five-file regression run had 23 failures
and 116 passes. The failures were:

- Adapters: three SUCCESS response/token-count cases, successful Codex prompt
  echo/output, failed agy and Codex model output, word boundaries, both adapters'
  cleanup error preservation, timeout stdout exclusion, and Argon precedence.
- Cascade: checkout status changes, HEAD changes, and changes during a failed
  provider call all failed to abort.
- Doctor: unlisted probe model, four covering deny rules, missing config, and
  the updated existing no-configured-model expectation (FAIL instead of WARN).
- CLI: missing config prevented independent diagnostics.
- Worktree: prune-before-add and stale unlisted directory removal.

The positive failed-envelope RESOURCE_EXHAUSTED case already passed before the
fix, as did the existing stderr failure cases. An additional output-limit test
(exit zero with quota prompt echo) was observed failing before its correction.
Existing synthetic cascade runners now answer the checkout protocol; deadline
tests advance time during origin verification or after inference starts. The
origin-call ceiling remains 800 plus four baseline/post-call checkout queries.

### M4 on a real machine (2026-10-19)

`quorum doctor` and `quorum doctor --probe` were run on Isaac's Windows machine with the real agy 1.2.x and codex 0.160.0. They found three things the fake-runner tests could not:

1. **agy's `settings.json` had a UTF-8 BOM** (written by PowerShell). agy accepts it, but `JSON.parse` doesn't, so the permission check failed silently. Fixed: the BOM is stripped, and there's a regression test.
2. **agy no longer lists `gemini-3.1-pro-*`.** `doctor` flagged the configured id. The review and visual defaults move to `gemini-4-argon-high`, which has its own quota group ("Gemini 4 Argon"). The old ids stay in the catalog so older configs still resolve.
3. **The Codex probe failed because its prompt forbade shell commands.** On Windows, Codex reads files through `pwsh Get-Content`, and its read-only guarantee is `-s read-only`, so its prompt no longer forbids commands. agy keeps "file-read tools only", because a headless run stops at the first denied command. A failed probe now names its reason (exit code, mismatch, dirty), without showing any content.

After the fixes, both probes pass: each provider read README.md inside a disposable worktree under `.quorum/worktrees`, the worktree stayed clean, and it was removed. **ASSUMPTION 6 (agy can read the worktrees) is settled.** ASSUMPTION 1 (agy's deny-rule tool names) is still open.

Real calls spent on M4: agy 3 (one fixture capture, two probes; `/usage` spends no inference), Codex 3 (two doctor probes and one manual reproduction).

The repo now has its own `quorum.config.json` (checks: `pnpm typecheck`, `pnpm test`), so Quorum can review its own changes from M5 on.

## M5 as built

M5 wires `quorum review` to the existing context, cascade, adapters, planner,
worktree and checks implementations. No dependency or provider process was used
in implementation validation. Tests use synthetic repositories, FakeProvider
and injected runners. `--reproduce` prints "not implemented yet" and exits 2;
reproduction remains M6.

- Feature mode requires `--spec`. Markdown checkboxes and list items beneath
  acceptance headings become numbered AC criteria inside the untrusted JSON data block.
  Zero criteria exits 2 with the accepted formats. Spec, inventory and rules must
  each be a regular non-symlink file of at most 256 KiB.
  Verified findings referencing an exact AC number in trigger or impact mark
  it unmet. Silence is `not assessed (no finding)`, never "met". Local-only
  unconfirmed findings cannot mark a criterion unmet or become final findings.
- Redesign accepts an inventory, rules and up to 20 regular PNG/JPG/WebP files,
  each at most 5 MiB. Images are copied beside the verification worktree under
  `.quorum/worktrees/<id>-images`, passed only to image-capable visual-tier
  calls, and removed afterwards. Visual context that cannot fit the prompt
  limit fails closed as incomplete coverage rather than silently losing paths.
- Config comes from the reviewed range's merge base. `--trust-head-config`
  selects the committed HEAD config, not uncommitted working-copy edits.
  Without an explicit range, config discovery starts at `origin/main`, reads
  its `base`, then reads the config at that base's merge base with HEAD. This
  bootstrap is necessary to discover `config.base` without trusting HEAD;
  repositories without `origin/main` must supply `--diff <base>...HEAD` (or
  explicitly trust HEAD). `--since` changes only the reviewed diff to exactly
  `sha..HEAD`; configuration still comes from the configured base's merge base,
  never from an earlier untrusted PR commit. Ranges must end at current HEAD.
- Checks execute before inference in their own disposable HEAD worktree. They
  execute the change's own code, just as CI does: trusting the base command list
  does not make the implementation of those commands trusted. Failure does not
  stop model review. Capped failed-check names and tails enter prompt context;
  the report includes all check results and the Status line counts failed checks.
  Before execution, stderr announces the configured check count and explains
  that checks execute the change's code; use `--no-checks` for untrusted changes.
  A separate clean HEAD worktree verifies findings, including cache hits; dirty
  content in the user's checkout never supplies verification evidence. Uncommitted
  changes produce a warning that only committed HEAD was reviewed.
- Markdown includes summary, findings, AC/inventory tables, full coverage
  categories, local-only and other unconfirmed findings, checks, warnings and
  reviewer families. SARIF 2.1.0 uses three severity rules, provenance properties
  and SHA-256 fingerprints of path plus whitespace-normalized quote. Invocations
  record executionSuccessful (no tool errors and complete coverage, independent
  of findings); run properties include coverage complete/skipped/lost counts and
  unconfirmedCount (including quarantined local findings). `--json`
  prints the complete result. Markdown is always written, by default beneath
  `.quorum/reports`; SARIF is opt-in. Either write can fail without losing stdout
  or changing the review exit code; the failure is warned on stderr and in stdout.
- Exit 1 includes nonlocal unconfirmed BLOCKERs, which remain unproven in M5.
  `--allow-unproven` waives only those blockers in M5. A verifier-accepted BLOCKER
  confirmed by another family always exits 1. M6 will add the explicitly unproven
  reproduction case. The inherited local-only quarantine
  remains: local findings are not final blockers until another family confirms
  them. Tool/config errors and checkout changes exit 2. Incomplete coverage with
  no failing blocker also exits 2 and displays **INCOMPLETE**; it cannot look
  clean. Empty ranges exit 2 with "nothing to review". Touched files with none
  reviewed are incomplete; binaries require successful visual review, which only
  covers PNG/JPG/WebP images in redesign mode. Ordinary check failures are
  reported, not treated as review tool errors. `--diff <sha>...HEAD` trusts config
  at the merge-base of the range the user chose.
- The cache stores only clean, completely parsed review responses under
  `.quorum/cache/v1/<aa>/<hash>.json`. Keys include the serialized chunk prompt
  (which contains its payload) and model reference. Hits bypass calls, budget
  charges and ledger rows but always rerun verification and any confirmation.
  No confirm/adjudication answers or malformed responses are cached. Writes are
  staged until the complete run passes checkout/worktree guards; an initially
  dirty checkout or any dirty provider response prevents all writes. Cache hits
  retain reviewer-family provenance even for empty findings. `--no-cache`
  bypasses reads and writes. Visual prompts contain disposable image paths, so
  visual calls bypass both cache reads and cache writes.
- The ledger appends one line per charged inference with run ID, timestamp,
  coverage and existing M3 counts. Atomic replacement is protected by an
  exclusive short-lived lock to avoid losing concurrent appends; orphaned locks
  expire after ten minutes. Lock or I/O
  failures warn without failing review. The M4 retry interface reports aggregate
  duration/tokens and findings, so retry rows contain zero counts and the final
  attempt carries those aggregate metrics; per-attempt timing is unavailable.
  Quota readings persist with timestamps in `quota.json`; dry-run reads these
  without provider/check calls and prints age and the existing six-hour expiry.
  Internal writes reject symlink/junction parents inside the repo, stopping before
  the repo root, and use temp-file rename. Linked repo roots and ancestors (such
  as macOS /var or /tmp) are allowed. User-selected external output paths are
  outside that internal parent check.
- M4 follow-ups: checkout snapshots now hash `git diff HEAD --binary` and the
  untracked filename list (not untracked contents); Codex failed-call diagnostics
  remove echoed prompts with LF/CRLF normalization before examining ERROR lines
  and the final 20 diagnostic lines; stale sweep EBUSY/EPERM warns and continues;
  cleanup after a successful adapter call warns rather than throwing. Ignored
  files, untracked file contents and writes elsewhere remain outside the guard.

Layout deviation: the small mode, storage and reporter helpers each share one
`index.ts` rather than the multiple modules proposed in section 3. Existing M3
prompt construction remains the single chunking/24,000-character limit path;
mode suffixes extend it rather than introducing a parallel prompt builder.
Cross-family external review and real provider/OS probes were not performed
because the brief forbids provider CLIs. Linux and macOS remain unverified.
No commit, branch switch, push, network call or dependency installation was made.

Initial M5 validation on Windows: `pnpm.cmd typecheck` passed; `pnpm.cmd test`
rebuilt the CLI and passed 613 tests with one existing skip across 23 files;
`git diff --check` passed. Additional QA covers late confirmation coverage loss,
untracked-list changes, staged-cache rejection after a later dirty call, the
20-image boundary, and an explicit shared finding schema in visual prompts.
Read-only same-family review closed with no outstanding BLOCKER or IMPORTANT.

M5 correction validation on Windows (against reviewed commit `7c788b2`):
`pnpm.cmd typecheck` passed; `pnpm.cmd test` rebuilt the CLI and passed
630 tests, with 4 skipped, across 23 files. `git diff --check` passed.
Three skips explicitly report that Windows refused file symlink creation for
spec/inventory/rules; the fourth skip already existed. The repository-directory
junction regression passed. Linux and macOS remain unverified. No provider CLI
was run and no independent provider review was requested, as prohibited by this
fix brief. The branch remains `feat/m5-review`, with no commit or push.

The corrected regression tests were also run against an isolated copy of the
`7c788b2` source under `.quorum/m5-before`, without changing branches:
`pnpm.cmd exec vitest run --root .quorum/m5-before tests/integration/review.test.ts tests/unit/m5.test.ts tests/unit/m3-limits.test.ts`.
That baseline produced 21 expected failures, 49 passes and the 3 file-link skips.
Failures cover confirmed-blocker waiver, empty range, binary-only and visual
coverage, zero criteria, report and SARIF write failures, each oversized input,
linked repo persistence, check announcement/help, dirty-checkout warning, SARIF
metadata, failed-check Status, JSON criteria, expired lock and visual cache
writes. The existing binary-coverage assertion was updated to the new contract.

## M6 as built

Reproduction is opt-in through `--reproduce`. The cascade asks the confirm tier
for a fresh proposal only after verification and cross-family confirmation,
excluding local-only findings. Requests use the existing bounded untrusted-data
prompt, filtered JSON extraction, quota routing, shared call budget, deadline,
checkout guard and ledger. Proposal-supplied status is discarded. Three BLOCKERs
are selected by descending confidence; eligible remainder are `unproven` with
`reproduction cap`. No confirmation/proposal response is cached. Without the
flag there are no proposal calls, test writes or runtime probes.

- `src/reproduce/write.ts` supplies the dependency-free `**`, `*`, `?` matcher
  and exclusive writer. `**` spans whole path components; brackets and braces
  are literal. Paths reject absolute roots, traversal, NUL, colon and Windows
  trailing-dot/space aliases. Parent directories are checked with `lstat` and
  `realpath`, missing parents are created one at a time and checked again, and
  `wx` prevents overwrite. The 64 KiB content limit counts UTF-8 bytes. As with
  existing verifier guards, this does not promise protection against a separate
  hostile host process racing parent replacement.
- `src/reproduce/index.ts` reuses `createReviewWorktree` for isolated head/base
  trees. No separate worktree implementation was added. Introduced findings use
  `fileExistsAtCommit`; new code is unproven before execution. Existing code must
  fail by a matching assertion at head and pass at base. Pre-existing findings
  skip base. Cleanup is attempted even after the deadline. An invalid/existing
  path is `rejected` and retains severity; only `not-reproduced` downgrades to
  IMPORTANT. Missing infrastructure is `unproven`, retaining severity.
- `src/reproduce/evaluate.ts` parses Vitest/Jest JSON into the existing TestReport.
  Assertion matching is a nonempty literal substring of the first failure line,
  never a provider regular expression. Import/compile/other-test failures cannot
  prove a defect. Cache EROFS/EACCES, missing executable/report, preparation
  failure and container timeout are infrastructure failures. Vitest's fixture
  was checked against a real, trusted synthetic assertion using installed Vitest;
  Jest uses a synthetic JSON fixture without installing or invoking Jest.
- `src/reproduce/isolation.ts` resolves Docker then Podman and checks daemon
  availability. The default Node image has an immutable digest constant and
  update instructions. Docker Hub was inaccessible during implementation: the
  published digest reference has not been independently verified against the
  registry or pulled. Explicit `reproduce.image` remains supported.
- **Decision 13:** preparation defaults to disabled install scripts; the validated
  `reproduce.allowInstallScripts: true` opt-in enables them and appears in report
  warnings. Preparation uses the commands and hardening recorded in section 12.
  Network is on (Docker `default`, Podman `private`) to fetch packages.
- **Decision 16:** pnpm also uses `--ignore-pnpmfile` by default. Yarn configuration
  with top-level `yarnPath` or `plugins` keys is unproven before preparation;
  `allowInstallScripts: true` explicitly permits those repository hooks. The
  scanner handles plain and quoted keys, ignoring comments and nested keys.
- Both `quorum-prep:<hash>` and `quorum-deps-<hash>` use SHA-256 over the
  lockfile, every package.json (repository walk skips node_modules and .git,
  maximum 500 selected files total), .npmrc, .yarnrc.yml, .pnpmfile.cjs,
  .yarn/releases/**, .yarn/plugins/**, pnpm-workspace.yaml, every patches/
  directory's contents, manager/version, image digest and scripts mode. Paths
  and raw bytes are hashed in sorted order. Tagged custom images are resolved
  to a digest before deriving the key. Head and base compute their own keys;
  identical input sets share a cache, changed manifests do not. Metadata symlinks,
  oversized files and discovery limits fail unproven rather than using partial keys.
- Infrastructure classification excludes assertion messages. Signals use exact,
  case-sensitive names (SIGKILL, SIGSEGV, SIGTERM, SIGABRT, SIGBUS, SIGILL,
  SIGFPE), or process termination phrases in suite errors and diagnostics.
  Ordinary words such as signature, signed, signal and killed are not evidence.
- Host display sanitization also removes U+200B–200D, U+2060, U+FEFF,
  U+2028 and U+2029, preserving ordinary newlines and tabs.
- The generated Dockerfile-only context installs the pinned manager and initializes
  the volume for UID 1000; no repository data is copied into the image. Image labels
  and .quorum-ready record the full key. An orphan or incompatible marker causes
  one warned volume removal and rebuild, never permanent reuse or endless retries.
  Named auxiliary containers are killed on timeout and removed on exit. Existing
  node_modules files or symlinks/junctions are refused before mounting.
- **Monorepo and Yarn Berry limitations:** only /work/node_modules is a dependency
  volume. Installs requiring nested node_modules or PnP artifacts outside that
  volume cannot complete against the read-only worktree and remain unproven.
  This does not claim support for every workspace layout or Yarn linker.
- Tests run with no network, UID/GID 1000, read-only root, tmpfs `/tmp`, a writable
  worktree and read-only dependencies, cache environment pointing to `/tmp`,
  1 GiB memory, 256 PIDs, 2 CPUs, no-new-privileges and --cap-drop ALL. The configured argv gets a
  reporter output path inside `/tmp` and the proposed filename prefixed by `./`
  so leading dashes cannot become options. A `node -e` argv wrapper spawns the
  command without a shell, reads that report file and prints it after a fresh
  UUID marker. No second shell command or persistent report bind mount is used.
  Container kill and runner deadlines enforce the 120-second default and the
  remaining run deadline. Every named container is force-removed on exit.
- **Decision 15:** no runtime or noninteractive consent leaves execution unproven.
  Each host revision needs its own informed y/N confirmation. Source, path and
  configured argv are sanitized before display, including ANSI and bidi removal;
  the prompt discloses execution of the revision's scripts, configuration, setup
  files and dependencies. `--no-host-prompt` is automatic no, never permission.
  Host processes receive only the platform-specific environment allowlist from
  section 12. Reports use fresh temporary files; Windows worktree prefixes are
  compared case-insensitively.
- Markdown encloses raw proposed source inside a collapsible details block with
  a blank line before a fence longer than every backtick run (minimum three).
  The summary path is HTML-escaped and controls are removed. Blank lines, Markdown
  headings, links, images and closing HTML cannot escape the fence. No pre/code
  HTML wrapper remains. SARIF retains reproduction.status.
- **Decision 14:** independent source/confirmation families determine the waiver
  both with and without reproduction. Cross-family BLOCKERs remain exit 1 even
  when unproven due to cap, budget, missing proposal/runtime, new code or any
  infrastructure failure. Only not-reproduced downgrades severity; reproduced
  retains it. A same-family confirmation can be waived. Coverage/errors still
  retain their existing exit-2 behavior when no failing BLOCKER remains.
- Empty reports, absent target tests, skipped-only targets, worker crashes,
  out-of-memory/ENOSPC/EMFILE, killed processes/signals and exits without reports
  remain unproven with a reason at either revision. Import and compile failures
  in the target suite remain non-assertion failures.
- Claude/Qwen are registered stubs: probe is unavailable, execution throws a
  typed NotImplementedError classified as unavailable, and routing falls back.
  Doctor emits WARN when configured, preserving the loopback Qwen endpoint check.
  `scripts/smoke-review.md` contains a synthetic sample setup and exact manual
  command bounded to six real calls. It was not executed.

Tests cover safe writes/glob cases, report evaluation, exact fake-container argv,
cache reuse/failures, timeout cleanup, cross-family eligibility, ordering/caps,
shared budget, filtered proposals, consent and end-to-end `main()` exit codes.
`tests/container/escape.test.ts` is explicitly slow and skips unless both
`QUORUM_CONTAINER_TESTS=1` and a responding Docker daemon are present. Its
synthetic test fails if an outside-root write or external socket succeeds; fake
tests assert the mounts and network/root constraints. Default tests never start
a container. The synthetic Vitest config redirects Vite cache to `/tmp`.

Remaining verification: no real provider, smoke run, container, Jest invocation,
Linux or macOS run was performed. The cache/volume initialization and Vite cache
behavior in a real container remain assumptions. The root package.json and smoke fixture pin their package manager. External cross-family review
was not run because provider CLIs were prohibited; separate read-only internal
review found and corrected host report paths, deadline units, leading-dash
filenames and preparation-container timeout cleanup. No new dependency, branch
switch, commit or push was made.

Original M6 validation on Windows (before the review fixes below): `pnpm.cmd typecheck` passed;
`pnpm.cmd test` rebuilt the CLI and passed **758 tests**, with **6 skipped**,
across 29 files. Skips are the explicit slow-container gate, four unavailable
Windows file-symlink tests, and one inherited skip. Directory-junction tests
passed. `git diff --check` passed (Git's LF/CRLF notices are not errors).
The trusted standalone Vitest assertion probe exited 1 as expected and its JSON
parsed as `assertion-failure-matching`. Automatic command review rejected
cleanup of the ignored `.quorum/m6-parser-check` scratch with `blocked by policy`;
that scratch remains, outside the delivery diff.

Files changed in M6:

- Runtime: `src/reproduce/{index,write,evaluate,isolation}.ts`,
  `src/cascade/{index,parse,prompts}.ts`, `src/cli/{args,index,review}.ts`,
  `src/providers/{types,claude,qwen}.ts`, `src/doctor/index.ts`,
  `src/reporters/index.ts`.
- Tests: `tests/unit/reproduce-{write,evaluate,isolation,cascade}.test.ts`,
  `tests/unit/providers.test.ts`, `tests/integration/{reproduce,review,doctor}.test.ts`,
  `tests/container/escape.test.ts`.
- Fixtures: `tests/fixtures/reproduce/{vitest,jest}.json` and
  `tests/fixtures/repro-repo/{package.json,pnpm-lock.yaml,vitest.config.ts,escape.test.js}`.
- Documentation: this file and `scripts/smoke-review.md`.

### M6 independent-review fixes (95f0f0d)

The fixes above implement decisions 13–15 on the existing feat/m6-reproduce
worktree. No provider CLI, Docker or Podman was executed; all runtime argv tests
use injected fake runners. No dependencies, commit, push or branch switch were
introduced. The image digest remains ASSUMPTION 9; actual container execution,
Linux/macOS and a new cross-provider review remain unverified because those
executions were outside the authorized scope.

Regression evidence against the original code:

- The first focused isolation/integration run failed 20 cases: orphan recovery,
  both preparation script modes/hardening, changed package.json identity,
  node_modules file rejection, same-family waiver without reproduction,
  cross-family cap and missing-runtime gates, ten empty/missing/skipped/resource
  failure/no-report cases, Markdown containment, and informed host display.
- Configuration default/validation and CLI help checks added two original-code
  failures. Two additional checks against a temporary copy of HEAD's evaluator
  failed for case-insensitive Windows prefixes and missing/skipped targets with
  unrelated suite errors. Both temporary baseline files were removed.
- Further coverage checks manifest/config/patch inputs, manager/version/digest/
  script-mode keys, discovery caps, ignored dependency directories, junction
  rejection, head/base isolation, all three managers' argv, script-mode reporting,
  platform environment allowlists, and independent sources with a local primary.

Files changed for these fixes:

- Runtime: src/cascade/index.ts; src/cli/{args,index,review}.ts;
  src/config/schema.ts; src/reporters/index.ts;
  src/reproduce/{evaluate,index,isolation}.ts; src/types/index.ts.
- Tests: tests/integration/{cli,reproduce,review}.test.ts;
  tests/unit/{args,config,reproduce-evaluate,reproduce-host,reproduce-isolation}.test.ts.
- Documentation: docs/IMPLEMENTATION.md and docs/PLAN.md.

Final review-fix validation on Windows: `pnpm typecheck` passed; `pnpm test`
rebuilt the CLI and passed **798 tests**, with **6 skipped**, across **30 files**.
`QUORUM_CONTAINER_TESTS=0` was set for the run; the slow container test still
skips by default without an explicit opt-in. `git diff --check` passed.
No log files were written to the repository root.

### v1 smoke run (2026-10-19)

The approved smoke run from `scripts/smoke-review.md` was run once on Isaac's Windows machine. It used a synthetic repo under `.quorum/smoke-m6` with a removed zero-divisor guard, `--reproduce`, and a 6-call budget. Docker Desktop was not running.

- **Result: exit 1, one BLOCKER, 4 calls, 75 s.**
  - Gemini 4 Argon (the review tier) reported the regression at `divide.js:1`, tied to AC1. The verifier accepted the quote, and blame set it to `introduced`.
  - **Codex (another family) confirmed it.**
  - Codex then proposed a reproduction test (`divide-zero.test.js`). The reproduction stayed `unproven` ("no container runtime"), and nothing ran on the host.
  - The user's checkout stayed unchanged, and every review worktree was removed.
- **Two defects found only by the real run, fixed in the following commit:**
  1. Gemini Flash's finding was dropped as `parse: invalid origin`: it wrote an origin outside the enum. Since blame decides introduced vs pre-existing anyway, an unknown or missing origin is now kept (as `introduced` until blame runs), with a regression test.
  2. The report's Independence line listed only `google`, although Codex (`openai`) confirmed. Confirming families now count.
- **Still not verified:**
  - a real container run (the reproduction path and the escape test);
  - Linux and macOS;
  - a second smoke run after these two fixes, skipped to save quota.

**v1 "done" check:** a real `quorum review --mode feature` ran on a sample diff with real providers, and the verifier and dedupe tests pass. This is met, with the container path still open.

### Real container run (2026-10-19, later the same day)

With Docker Desktop running (engine 29.8.1, Linux), the opt-in container test and a second smoke run were executed.

- **The first container run failed, which is what it was for.** Two defects that no fake runner could show:
  1. The preparation step mounts the worktree read-only at `/work` and the dependency volume at `/work/node_modules`. Docker can't create that mount point inside a read-only bind mount, so every preparation failed. Fix: create the empty `node_modules` directory in the disposable worktree first; git ignores empty directories.
  2. vite bundles its config into `node_modules/.vite-temp`, and that volume is read-only in the test step. Fix: create the runner cache directories (`.vite-temp`, `.vite`, `.vitest`, `.cache`) during the writable preparation, and cover them with `tmpfs` in the test step. The volume layout is versioned (`layout-2`), so older volumes are detected and rebuilt.

  Both times the outcome was `unproven`, never a false "not reproduced". That is the conservative design working as intended.
- **The escape test passes on real Docker.** A hostile test could neither write outside `/work` nor open a socket to 1.1.1.1:80.
- **Second smoke run** (same synthetic repo, `--reproduce`, Docker running):
  - **Result: exit 1, one BLOCKER, `reproduced`** ("matching assertion at head; passed at base"), coverage COMPLETE.
  - **Cost:** 4 calls, 128 s.
  - **What each provider did:** Gemini Flash's answer had no JSON, so rule 4 escalated it to Gemini 4 Argon, which found the BLOCKER. Codex confirmed it and proposed the reproduction test.
  - **Cleanup:** no container was left behind, and the user's checkout was unchanged.
  - **Independence:** the Independence line now lists `google, openai`.
- **ASSUMPTION 9 is settled:** the pinned digest pulls and runs, and the container path works end to end. Still not verified: Linux and macOS hosts, Podman, npm and Yarn repos, and monorepos.


## v1.x adapters as built

Implemented on 2026-10-19, replacing the M6 Claude/Qwen stubs. The CLI facts
in Isaac's v1.x brief supersede the earlier tentative flags and optional-provider
checks. No new dependencies, API-key configuration or credential storage were added.

- Claude uses the exact recorded argv: claude -p --output-format json --model
  <alias> --no-session-persistence --restricted --strict-mcp-config --tools
  Read,Grep,Glob --permission-mode dontAsk. Prompts are stdin, cwd is a detached
  review worktree, and the user's OAuth login remains available. Neither --bare
  nor bypassPermissions is used. Restricted mode and strict MCP config protect
  against untrusted repository settings/hooks and MCP configuration; live CLI
  enforcement was not re-probed. The required flags are always present.
- Claude shares the original review deadline across worktree preparation and
  at most two attempts. Only nonzero exit plus empty stdout permits a retry,
  and reserveRetry charges the shared M3 budget. The checkout guard runs after
  every attempt, including errors. Dirty worktrees are discarded by the cascade;
  cleanup preserves the primary failure. Quota remains unknown until a failed
  call reports it in stderr, subtype or error/errors fields. Answer text never
  determines quota. Optional finite, nonnegative usage counts become tokensUsed.
- Unknown Claude envelopes return a non-JSON sentinel, so rule 4 escalates;
  no nested answer can accidentally masquerade as an empty successful review.
  Explicit CLI/error envelopes are unavailable (or quota) and tier fallback
  applies. ASSUMPTION 10 remains open until a real result is recorded.
- Qwen uses injected fetch (globalThis.fetch by default), no file tools and no
  process execution. It sends the shared stable review prefix plus an explicit
  diff-only/no-file-access instruction as the system message and the original
  prompt as the user message. Chat requests use temperature 0, max_tokens 4096
  and stream false. The optional config.qwen.model is a nonempty string; without
  it, the first /models id is cached in the per-run adapter.
- The shared loopback URL helper parses HTTP(S), accepts only 127.0.0.1, ::1
  and localhost, rejects credentials, clears query/fragment and appends the
  route. Redirects are errors. Models and completion bodies are read as streams
  with a 1 MiB byte cap (including error bodies), and an AbortController covers
  fetch plus body consumption and external cancellation. HTTP 429 always means
  quota; other HTTP errors require quota language. Connection failures are
  unavailable. Unknown successful chat envelopes/non-JSON escalate via rule 4.
- Catalog aliases claude:sonnet and claude:opus keep anthropic/claude:anthropic.
  Bare qwen resolves to the configured/discovered model, with local/qwen:local.
  An optional resolveModel adapter hook resolves metadata before cache lookup;
  discovery is bounded to the lesser of two seconds and remaining run time,
  consumes no inference slot, and failure allows tier fallback. Actual model
  identity is used by findings, ledger and cache keys. Dry-run performs no HTTP
  and shows the configured model, or the unresolved qwen alias. Rule 3b still
  keeps local-only findings in unconfirmed until the required review confirms.
- Doctor runs claude --version and reports claude.path. With --probe, configured
  Claude gets exactly one restricted stdin call in a disposable worktree to read
  README.md's first line, without a retry or a prompt that forbids reading.
  qwen.endpoint and qwen.model share one capped /models request; the configured
  model must be listed, otherwise the first model is reported. The opt-in local
  probe sends Reply with OK with a connectivity-specific system prompt, making
  one completion call. Failures are FAIL when the provider appears in tiers,
  otherwise WARN; unconfigured inference probes are skipped with WARN.
- Runtime changes: src/providers/{claude,qwen,loopback,types}.ts;
  src/{catalog,cascade}/index.ts; src/config/schema.ts; src/types/index.ts;
  src/cli/review.ts; src/doctor/{index,checks}.ts. Tests replace stub expectations
  and cover exact flags/stdin/cwd, retries, checkout/deadline handling, quota,
  malformed envelopes, loopback, model selection, byte limits, cancellation,
  cascade fallback/escalation, local quarantine, doctor and CLI/cache wiring.
  docs/ROADMAP.md marks the first v1.x item done.

Deviations/verification limits: external cross-family review and live probes were
not run under the explicit prohibition on provider CLIs and real Qwen requests.
An internal read-only review found no BLOCKER or IMPORTANT; it is the same model
family and does not replace the external review. Linux/macOS and actual Claude
OAuth/restricted-mode behavior remain unverified. All provider calls in tests use
injected runners/fetch and synthetic data. No branch switch, commit, push or
repository log file was made. Existing opt-in container tests remain disabled.

Final Windows validation: pnpm.cmd typecheck passed; pnpm.cmd test rebuilt the CLI
and passed 916 tests, with 6 skipped, across 32 files (65.20 seconds). Skips are
the existing opt-in container gate, four unavailable Windows file-symlink cases
and one inherited skip. git diff --check passed. The branch remains
feat/v1x-claude-qwen, with all changes uncommitted.

## v1.x on a real machine (2026-10-19)

`quorum doctor --probe` was run on Isaac's machine with this branch: `qwen.endpoint` PASS, `qwen.model` PASS (`qwen3-coder-next`), and `qwen.probe` PASS. That probe is one real chat completion to the local server, which answered "OK". `claude.path` PASS. `claude.probe` FAIL, because the CLI login had expired (ASSUMPTION 10 has the recorded envelope). agy and codex probes PASS.

**Not verified:** a full review through the Qwen adapter, and a successful Claude review.

## v1.x routing as built

Implemented on `feat/v1x-routing`, without new dependencies. Decisions 17 and 18
above define the extended coverage rule and optional confirmation routes.

- `escalate.routes` accepts arbitrary non-empty keywords and ordered, non-empty
  lists of refs. Unknown configuration properties still fail with their path.
  Catalog validation includes every route, even an unmatched one, before calls.
- Selection uses the first case-insensitive substring occurrence in file,
  trigger and impact, in that order; equal positions preserve configured key
  order. Route keys themselves trigger escalation. No match uses `confirm`.
  Rule 3b remains a separate required finding review for local sources.
- Routes reuse tier resolution, author-family filtering, preference for another
  finding family, quota groups, call/time limits and retries. Local models cannot
  confirm. Same-family-only confirmation emits the independence warning. An
  exhausted route warns and tries the normal confirm tier without resetting
  attempts, quota or budget. Adjudication and reproduction keep their tier routes.
- Confirmation independence warnings also apply when no route matches or a
  route falls back to the confirm tier; the tier name labels those warnings.
  For a local finding requiring both review and confirmation, the second call
  prefers a family outside **all** existing sources (local and the review
  confirmer). A money route of Argon then Codex therefore selects Codex after
  Argon reviewed the local finding; an Argon-only route warns.
- Ledger locks contain a unique UUID owner token. Expired locks are renamed to
  unique `.stale-<uuid>` paths before deletion, never deleted at the shared path.
  A short-lived `.lock.reclaim` directory serializes stale-lock inspections and
  renames, with a second age check inside it: rename alone cannot prevent a
  delayed reclaimer from moving a newly acquired lock. Release checks the token
  on every attempt and runs even if closing the handle fails. Transient Windows
  inspection/deletion errors retry within ten seconds; atomic replacement still
  retries transient rename errors. The reclaim directory is removed in `finally`.
  Abrupt process termination during reclamation can leave that directory behind;
  reclamation then fails closed at the deadline rather than stealing a lock.
- Acquiring the ledger lock waits for **progress**, not for a fixed time (fixed
  2026-10-21): a writer keeps waiting while the lock's owner token keeps
  changing, and gives up only when one owner has held it for 10 s
  (`LEDGER_LOCK.idleMs`) or after 120 s in all (`LEDGER_LOCK.maxMs`). Giving up
  throws `ELEDGERLOCK` ("nothing was written"). Reclaiming a stale lock gets only
  the idle allowance, so a reclaimed lock Windows will not let go of also ends in
  `ELEDGERLOCK` after about 10 s, not after the absolute limit with a raw
  filesystem error. The tests drive `LEDGER_LOCK.now` with a fake clock, so they
  are deterministic and fail on a fixed-deadline wait. The old fixed 10 s deadline made
  the tail of a long but moving queue fail with `EEXIST` under load (19 of 480
  concurrent writers across 12 processes; no line was ever lost or duplicated);
  with the fix 800 concurrent writers all land.
  Removing such an orphan requires establishing that no reclaimer is active.
- Each successfully parsed local-only chunk gets a full non-local review pass,
  with review-tier fallback. Its findings join the normal verifier/confirmation
  flow while the original local findings retain rule 3b. Only unresolved chunks
  retain the local-only coverage warning; coverage is tracked per chunk even
  when a file spans multiple chunks. Review calls preserve the existing
  confirmation reserve while escalation candidates remain.
- Dry-run displays routes and their quota groups without calls. CLI quota
  preflight and doctor also include models configured only in routes.
- Regression tests use only synthetic fixtures, fake providers, injected
  runners/fetch and clocks. Before implementation, the focused routing suite
  reported 29 failures and 5 passing controls; integration regressions separately
  reproduced the local-only exit-2 behavior and missing route preflight/doctor
  handling. Tests also cover budgets, independence, fallback and rule 3b.

Verification limits: no provider CLI, real Qwen request or cross-provider review
was run under the explicit task prohibition. Internal QA is from the same model
family and does not replace cross-provider review. Linux/macOS and live provider
behavior remain unverified. No branch switch, commit, push or repository log was
created. Container tests remain opt-in and are disabled for this validation.

Final Windows validation: `pnpm.cmd typecheck` passed; `pnpm.cmd test` rebuilt
the CLI and passed **971 tests**, with **6 existing skips**, across 35 files
(62.07 seconds, `QUORUM_CONTAINER_TESTS=0`). `git diff --check` passed.
The first full run exposed two reproduction fixtures that lacked the new full
chunk-review response; adding that response and asserting the three-call flow
kept decision 14's cross-family BLOCKER exit 1 intact. Four additional QA cases
failed on isolated HEAD sources and passed after implementation, covering
multiple chunks in one file and retry accounting against the reserve. Internal
read-only QA reported no remaining findings.

Files changed: `src/cascade/{index,planner}.ts`, `src/catalog/tiers.ts`,
`src/config/schema.ts`, `src/types/index.ts`, `src/cli/review.ts`,
`src/doctor/index.ts`; `tests/unit/{routing,routing-qa,cascade,qwen}.test.ts`,
`tests/integration/{review,doctor,reproduce}.test.ts`; and
`docs/{IMPLEMENTATION,PLAN,ROADMAP}.md`. The planner/doctor quota wiring and
configuration example are supporting changes for routes. No functional
deviation from the brief is intended; cross-provider review was omitted as
required by the prohibition above.

Post-Gemini regression fixes: `tests/unit/storage-lock.test.ts` adds 11 cases
using wrappers around real filesystem functions: two synchronized stale readers
(the second resumes after fresh acquisition), transient open/rename errors,
EPERM/EACCES/EBUSY on stale inspection and deletion, EBUSY on release, failing
close, and replacement ownership. `tests/unit/routing-independence.test.ts`
adds four cases for unmatched routes, route fallback, and the two local money
confirmation routes above. All **15 tests failed against the pre-fix HEAD
sources** and pass with the fixes. The pre-fix sources were restored temporarily
in the same checkout for validation, then the fixes restored in `finally`; no
branch switch, provider call, log file, commit or push was used.

Post-fix Windows validation: `pnpm.cmd typecheck` passed; `pnpm.cmd test`
(`QUORUM_CONTAINER_TESTS=0`) rebuilt the CLI and passed **987 tests**, with
**6 skips**, across **37 files** (66.76 seconds). The focused command was
`pnpm.cmd exec vitest run tests/unit/storage-lock.test.ts tests/unit/routing-independence.test.ts`.
`git diff --check` passed. Changed files for this follow-up are
`src/storage/index.ts`, `src/cascade/index.ts`, the two regression test files
above, and this document. Provider review and Linux/macOS remain unverified.

## v1.x CodeGraph context as built

Implemented on `feat/v1x-codegraph-context`, with no dependencies added.
Decision 19 makes CodeGraph opt-in, read-only, and never responsible for indexing.

- `ContextProvider` supplies `name`, asynchronous availability, and enrichment
  returning a per-file map plus notes. Git returns an empty map. Configuration
  defaults to `context: { provider: "git" }` and rejects other provider values.
- CodeGraph availability checks an existing `.codegraph/` directory and the
  shared command resolver, without a process. Unavailable selection produces one
  warning and uses git. Dry-run shows requested provider and availability without
  executing CodeGraph. Doctor runs only `--version` when selected; failures WARN.
  When unselected, an existing index produces the informational PASS hint.
- Queries run with the user's repository as cwd and explicit `-p`, using only
  `node -f <file> --symbols-only` and `callers <name> -f <file> -l 5 -j`.
  No initialization, indexing, synchronization, status query, or checkout file
  creation is performed. This is a read-only command policy, not an OS sandbox
  against an independently compromised executable.
- The tolerant Markdown parser ignores headers/hints and accepts optional
  signatures. Selection includes the nearest symbol at or before a hunk's first
  new line and symbols starting inside its new-line range, deduplicated across
  hunks. Only text files carried by review chunks are queried. Each file queries
  at most five symbols. Missing caller metadata is tolerated; truncation is
  disclosed in both the context and notes.
- UTF-8 output caps include the untrusted-data markers: 4 KiB per file and
  16 KiB per enrichment. Each run makes at most 30 queries, each bounded to the
  lesser of ten seconds and remaining time. Enrichment and inference share one
  `RunBudget`; graph queries consume time but no model-call slots. Any failed,
  timed-out or unparseable query discards that file's whole block and adds a note,
  without failing the review. Raw command diagnostics are not reported.
- Blocks say "Touched symbols and their callers (from CodeGraph, may be stale)"
  and are untrusted JSON payload data. Prompt packing first builds the existing
  diff-only chunks, then attaches context for the files each chunk carries. A
  block that would exceed 24,000 serialized characters is dropped with a note;
  diff content, chunk boundaries and coverage remain unchanged. Context changes
  naturally change the existing prompt-based cache key.
- The CLI preserves its early checkout snapshot to detect preflight/context
  writes, checks it after enrichment, then takes that verified snapshot as the
  review baseline. The cascade's baseline also remains after context building.
- Tests use synthetic Markdown/JSON, injected runners/resolution/clocks and
  temporary synthetic Git repositories. They cover parser/selection tables,
  partial metadata, all caps, failure isolation, deadlines, unchanged Git status,
  config, doctor, dry-run, and callers reaching triage through `main()` with
  FakeProvider. No real CodeGraph or inference provider is called.

Correction (Claude, same day): Codex first rejected Windows `.cmd` shims, which made the provider
unusable on Windows, where npm installs `codegraph.cmd`. It now uses the resolver's safe
`.cmd` path like the checks do; an argument with a cmd metacharacter skips that one
query with a note. No real CodeGraph run was made: this repository has no index, and
indexing is the owner's decision.
External cross-provider review and live probes were not performed under the
explicit CLI/Qwen prohibition. Internal read-only QA is from the same model
family and does not replace that review. Linux/macOS and real index behavior
remain unverified. No branch switch, commit, push or repository log was created.

Final Windows validation: `pnpm.cmd typecheck` passed; `pnpm.cmd test` with
`QUORUM_CONTAINER_TESTS=0` rebuilt the CLI and passed **1,042 tests**, with
**6 existing skips**, across **38 files** (124.42 seconds). `git diff --check`
passed. The first full run exposed one old exact-object assertion that needed
the new empty `notes` field; its 22-test focused suite passed after correction,
and the complete suite above then passed. The initial CLI fixture assertion
was also corrected to find its target file among all diff files and normalize
Git's Windows path separators. Internal read-only review found no remaining
BLOCKER or IMPORTANT; QA's suggested partial-file-failure and reused-instance
cap-reset regressions were added and pass.

Files changed: `src/context/{providers,codegraph}.ts`,
`src/cascade/{index,planner,prompts}.ts`, `src/cli/review.ts`,
`src/config/schema.ts`, `src/doctor/index.ts`, `src/types/index.ts`,
`src/index.ts`; `tests/unit/{context-providers,config,m3-limits}.test.ts`,
`tests/integration/{review,doctor}.test.ts`; `README.md`,
`docs/IMPLEMENTATION.md` and `docs/ROADMAP.md`.

## v2 bughunt as built

Implemented on `feat/v2-bughunt`, with no new dependencies. The mode accepts
`--mode bughunt` and `--radius` (default 40, integer values clamped to 1-200).
Spec, inventory and images are not accepted; radius belongs only to bughunt.

- Context is read from committed HEAD in a disposable worktree, including dry-run.
  A HEAD cursor walks each unified hunk: context advances it, added lines form
  changed ranges, and pure deletions anchor at the cursor without excluding a
  HEAD line. No-newline markers are ignored. Windows surround these ranges and
  exclude only changed lines, keeping unified context and gaps between edits
  reviewable. Overlapping windows merge; EOF bounds and terminal newlines are
  handled without inventing source lines.
- Windows show minimum-four-digit HEAD line numbers and nearby diff hunks marked
  as orientation only. Prompts target UNCHANGED HEAD code. Oversized payloads
  truncate orientation first, with the truncation marker, then split unchanged
  code into sub-windows at whole-line boundaries. Only a single line exceeding
  the serialized 24,000-character prompt cap is skipped; its HEAD line is stored
  in `truncatedHunks[].hunk` and explained in a note. Optional provider context
  cannot displace review code. Coverage subtracts reviewed sub-ranges from each
  original window, so successful split-window reviews are complete.
- Files deleted at HEAD have the note `deleted at head: nothing to hunt` and
  do not make other coverage incomplete. New files have no unchanged targets
  and receive a corresponding note. Renames under `--no-renames` follow these
  delete/add rules. Binary, unreadable, unsafe, non-regular and oversized text
  files remain excluded with incomplete coverage (the text limit is 2 MiB).
  A run selecting zero windows exits 2 before provider calls, including dry-run,
  with `nothing to review in bughunt mode (no unchanged lines near the change)`.
- Findings from triage, review and confirmation share verification and blame.
  For numbered evidence, the original quote is checked first; if it fails, a
  leading `^\s*\d{4,}: ` is removed from each line and accepted only if the
  resulting quote verifies. Literal source text starting with digits and a colon
  remains valid. Confirmation prompts explicitly request code without prefixes.
  Corrected pre-existing locations outside selected windows are rejected.
- Introduced findings appear separately under `Points at the change (use feature
  mode)`; they do not escalate, merge into bughunt findings or affect exit codes.
  A confirmation relocating onto introduced code is invalid, just like moving
  outside the original location: its verified ledger count is undone and its
  rejection recorded. If no valid confirmation follows, the original finding
  survives as unconfirmed.
- Exit codes use the same BLOCKER rule as other modes: confirmed BLOCKERs exit 1;
  unconfirmed non-local BLOCKERs also exit 1 unless `--allow-unproven` is set.
  Local-only findings never cause exit 1. Incomplete coverage otherwise exits 2;
  complete coverage without a failing BLOCKER exits 0. SARIF contains bughunt
  results only, with pre-existing origin and bughunt mode properties.
- Routes, quotas, reproduction, budgets, cache and ledger retain the existing
  cascade. Prompt cache keys distinguish mode and radius. Dry-run lists window
  ranges, total lines and chunk count. Only non-local review covers a window.

The Argon-review fixes have regression tests for unified context between edits,
a context finding two lines after an edit, pure deletion anchors, minimum radius,
empty selections, confirmation relocation and ledger accounting, unproven exit
semantics, numbered evidence, oversized windows/lines and deleted files. These
failed against the original implementation before their fixes (12 failing cases,
including the two radius values; the empty-selection fixture was corrected and
rerun separately to demonstrate exit 0 instead of 2). Additional controls cover
literal numeric prefixes, multiline review-tier quotes, confirmed and local-only
BLOCKERs, renames, and complete coverage across sub-windows. All provider activity
in tests uses FakeProvider or injected runners; no real provider was called.

External cross-family review and live provider validation were prohibited by the
task. Linux/macOS and opt-in container checks remain unverified. No branch switch,
commit, push or repository log was created for these fixes.

Validation of the Argon-review fixes on Windows: `pnpm.cmd typecheck` passed;
`pnpm.cmd test` rebuilt the CLI and passed **1,098 tests**, with **6 skips**,
across **40 files** (83.09 seconds). The bughunt suites now contain 55 tests.
`git diff --check` passed. No dependencies were added.

## Real self-review run (2026-10-19)

`quorum review --mode bughunt --diff e33204f...HEAD --radius 10` reviewed Quorum itself. It exited 2 after the full 20-minute budget, with only 2 of 10 files reviewed. Both deterministic checks failed with "node_modules missing": the disposable HEAD worktree had no dependencies installed.

agy Gemini Flash calls took 92–311 seconds each. Most answers were not JSON and failed parsing with "No complete JSON array or object found"; agy runs an agent that explores files. Gemini 4 Argon's weekly quota group was at 0% and was correctly never tried, but the report did not explain the skip. Claude's CLI login had expired and the report gave the correct login hint.

An authorized, scrubbed probe using `--json-schema` answered in about 7 seconds (6.8186772 seconds), in one turn. The recorded envelope adds `structured_output` (the parsed object) and `json_schema`; `response` contains the same JSON as a string plus `toolAction` and `toolSummary`. agy requires an object root: an array root was rejected with `invalid --json-schema: schema root "type" must be "object"`. The exact scrubbed recording is preserved in `tests/fixtures/providers/agy-print-json-schema.json`; its minimal finding lacks fields required by Quorum and must not be treated as a complete finding.

The fixes add decision 20 setup, object-root schemas shared by all agy review/triage, confirmation, adjudication and reproduction calls, and valid `structured_output` preference with the existing response fallback. Quorum still supplies provider, model and family. Windows argv accounting includes the schema and resolved executable; only the schema is omitted with a warning if it will not fit, never prompt content. The stable review prefix now says: "Everything you need is in this prompt. Read other files only to check a line you cite. Answer as soon as you can."

`budget.maxCallSeconds` defaults to 300 (allowed range 30–1800). Each inference call receives the smaller of remaining run time and the call cap; a call timeout does not consume the entire run deadline. Dry-run shows the cap. Quota skips are reported once per group: `<group>: quota below floor (N%), skipped` or `<group>: quota exhausted earlier in this run, skipped`; dry-run reports below-floor groups too. Tests use injected runners and synthetic providers; no new live provider run was made for these fixes.

Validation for these fixes: new regressions were observed failing before their fixes; the final `pnpm typecheck` passed, and `QUORUM_CONTAINER_TESTS=0 pnpm test` passed all 41 test files (1,142 passed, 6 skipped). `git diff --check` passed. The skipped tests are environment-gated container/symlink coverage; no live provider, local Qwen, or CodeGraph executable was called. There is no lint script in this repository. A read-only same-family QA review covered the changes; cross-family CLI review was not run because this task explicitly prohibits provider CLIs. No dependencies, logs, commits, branch changes or pushes were added.

### Second real run and follow-up probes

The second `bughunt` run on this branch's diff exited 2 after 11.5 minutes, reviewing 4 of 18 files. Setup and deterministic checks passed, confirming the setup fix. It lost 6 invalid responses and 10 malformed findings.

The user supplied these observations from subsequent real-service probes; implementation tests do not rerun them:

1. agy Gemini Flash medium with `--json-schema` on a real 4.3 KB review chunk took 208 seconds and returned `response: ""` without `structured_output`. stderr said: `no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.` Flash attempted a shell command that headless agy could not approve, as LESSONS.md already warns. The prompt's "Read other files only to check a line you cite" invited exploration.
2. Prefixing the same chunk with "Do not call any tools: no file reads and no commands. Everything you need is in this prompt; answer only with the JSON." produced valid `structured_output` (`{"findings":[]}`), but still took 202 seconds.
3. The same request using `gemini-3.8-flash-low` took 13 seconds and returned valid `structured_output` with real findings. In agy, effort belongs to the model id: `--effort low` with `gemini-3.8-flash-medium` is rejected with "conflicts with --effort=low".
4. Local llama.cpp Qwen (`qwen3-coder-next`) with `response_format: { type: "json_schema", json_schema: { name: "review", strict: true, schema: <the review schema> } }` returned HTTP 200 in 5 seconds, with valid JSON and severity inside the enum. Without structured output, every Qwen finding in the real run was dropped with `parse: invalid severity`.

Decision 21 records the resulting changes. Regression tests use synthetic stderr, injected command runners and mocked HTTP only. No live provider or local Qwen was called; no dependencies or logs were added, and no commit, push or branch switch was performed. Cross-provider review was not run because the task explicitly prohibits the provider CLIs.

Validation for decision 21: the focused regression run failed on 22 tests before the fixes; a separate cascade regression also demonstrated duplicate denied-command warnings before its fix. The focused adapter/parser/config/prompt suite then passed all 203 tests. Final `pnpm typecheck` passed; `pnpm test` passed all 41 files (1,161 passed, 6 environment-gated tests skipped). `git diff --check` passed. Validation ran on Windows; Linux/macOS and live-provider behavior were not rerun.

### Third real self-review (2026-10-19, after decision 21)

The same `bughunt` run on the same branch diff, after the agy/Qwen fixes.

**Result:** exit 0, coverage COMPLETE, nothing skipped or lost, 9 minutes. 12 `gemini-3.8-flash-low` calls, most between 9 and 44 s (one took 177 s).

| | 1st run | 2nd run | 3rd run |
|---|---|---|---|
| Exit | 2 | 2 | 0 |
| Coverage | 2/10 files | 4/18 files | complete |
| Checks | failed (no deps) | pass | pass |
| Lost findings | 4 | 16 | 0 |
| Time | 20 min (cap) | 11.5 min | 9 min |

**Its one finding was a false positive, analysed by Claude.**
- **The finding:** `src/providers/qwen.ts:87`, IMPORTANT, confidence 0.95, from Flash-low. It claimed `this.models![0]` throws when the list is uninitialized.
- **Why it's wrong:** JavaScript evaluates `(await this.listModels()).includes(...)` callee first, so `listModels()` has filled `this.models` before the argument runs.
- **What it says about the design:** the quote was real, so the verifier accepted it, but the verifier can't judge the reasoning (a documented limit). Because the finding was IMPORTANT, high-confidence and outside the focus areas, no rule escalated it, so a single cheap model's claim reached the report unconfirmed.
- **Recorded as a v2 roadmap item:** "confirm single-source IMPORTANT findings from the triage tier when budget allows".
- The code was simplified anyway, to read the returned list.

## v2 precision as built

Implemented on `feat/v2-precision`, without new dependencies. Decision 22 adds
default-on `escalate.confirmImportant`; setting it to false preserves the earlier
provider call sequence. The candidate filter uses actual source call tiers and
families after dedupe/adjudication, never catalog defaults or just the merged
representative. Local-only, review/visual-sourced, multi-family and already
mandatory-escalated findings do not enter this optional lane.

- Mandatory escalation and opt-in reproduction finish first. The optional lane
  uses only remaining calls/time, including unused confirmation reserve. Groups
  share a resolved route and source family, then split into batches of up to five.
  Route keywords already trigger mandatory escalation (decision 18), so ordinary
  optional candidates use the confirm tier. Existing quota, author-family,
  fallback and independence rules apply; local models cannot confirm.
- The new `confirm-batch` purpose has an object-root schema shared with agy and
  Qwen's response-format lookup. Each prompt explicitly labels its candidate
  findings and hunks as untrusted JSON data and retains the 24,000-character cap.
  Responses must be a complete top-level JSON object within the existing 1 MiB
  response limit and match the schema. No nested answer or prose extraction is
  attempted. Only unique known `c1`–`c5` ids count, independent of answer order;
  every occurrence of a duplicate id is ignored.
- Confirmation can omit line/quote to retain the original verified evidence.
  Supplied evidence passes the existing verifier and blame, including numbered
  bughunt quotes, same-file and ten-line relocation limits, and unchanged-window
  checks. Confirmation-only origin failures keep the original finding and do not
  reduce review coverage. Prompted confirmation sources add no confidence boost.
- A rejection removes the final finding, records `rejected by confirmation` in
  its call's ledger and retains the title, file:line, original model(s) and
  confirmer under `Rejected on confirmation`. Related annotations are recomputed
  after removal so a rejected candidate cannot survive indirectly. Checkout and
  verification-worktree guards clear rejected results as well as final findings.
- Unanswered candidates stay in Important Findings with `singleSource: true`,
  the visible `single model, not confirmed` tag, and SARIF's matching property.
  Coverage and IMPORTANT exit semantics are unchanged. Dry-run prints the setting,
  grouping and maximum batch size.

Regression evidence: the initial focused FakeProvider run failed all 18 new
cases (17 unit cases and the `main()` false-positive rejection integration case)
against the unchanged implementation. Read-only QA then identified three invalid
schema-field cases (null line, fractional line on rejection and boolean quote);
all three failed before strict schema validation fixed them. The expanded unit
suite passes 34 tests covering missing/duplicate/unknown/out-of-order ids,
injection, budget/quota/model exhaustion, 5+2 batching, disabled-call snapshot,
mandatory priority and reserve release, reproduction retention, family preference,
local-model exclusion, true source tiers, independent dedupe and relocation.
All fixtures are synthetic, with FakeProvider and injected Git runners.

Validation: `pnpm.cmd typecheck` passed, including a final run after the last test
additions. `pnpm.cmd test` with `QUORUM_CONTAINER_TESTS=0` rebuilt the CLI and
passed all 42 files (**1,191 passed, 6 skipped**, 106.57 seconds). Five additional
QA cases were added after that run had discovered tests; the final focused
`pnpm.cmd exec vitest run tests/unit/precision.test.ts` passed all **34 tests**.
The earlier full run found only two existing config exact-object expectations
missing the new default; both were updated and passed in the final full run.
`git diff --check` passed (only Git's existing LF-to-CRLF notices).

No provider CLI, real Qwen, dependency installation, branch switch, commit, push
or repository log was used. External cross-family review was not run under the
explicit provider prohibition; internal read-only QA is the same family and does
not replace it. Windows is the validated host; Linux/macOS and opt-in container
checks remain unverified. No lint script exists. Grouping also by source family
preserves per-candidate independence; reproduction takes priority as existing
mandatory work. These are the implementation choices within the brief.

### Real check of the batch schema (2026-10-19)

Before merging decision 22, `agy --json-schema` was run once with the real `confirm-batch` schema (Gemini 3.8 Flash-low, a two-candidate prompt, no tools). It was accepted in 9 s and returned `structured_output` with `decisions` for `c1` (confirm: a real division by zero) and `c2` (reject: an unused variable), matching what the parser expects. The full pipeline with real providers has not been run since this feature; Gemini 4 Argon was out of quota.

## v2 contract as built

Decision 23 implements `--mode contract --rules <business-rules.md>` with optional
`--copy <file-or-dir>`, without dependencies. Rules are regular non-symlink
Markdown files up to 256 KiB. Lists (including nested lists and checkboxes) and
paragraphs beneath headings become R1, R2, etc.; each clause is capped at 600
characters. Empty extraction exits 2 with the accepted formats.

- Context comes from committed HEAD in a disposable worktree, including dry-run.
  Each touched file is grouped with its direct relative imports. A forward-only
  linear scanner finds static imports, dynamic imports, require calls and
  `export ... from` declarations. Look-ahead is limited to 4 KiB after a keyword,
  with no cross-line search except within named binding braces (supporting
  multi-line named imports). It does not follow imports
  recursively or resolve package aliases. The six extensions are .ts, .tsx,
  .js, .jsx, .mjs and .cjs, including extensionless index files and emitted .js
  specifiers backed by TypeScript sources. node_modules, paths outside the repo,
  links below the worktree root, non-regular files and files over 64 KiB are
  excluded; linked ancestors of the root are allowed. Root-directory imports
  (`./`, `./.`, or `../` from a nested file) resolve to `index.*` without creating
  slash-rooted candidates. Per-file 20-import
  and per-run 60-unique-import caps add notes and incomplete coverage.
- Explicit copy recursively selects .json, .md, .txt, .ts, .tsx, .js, .jsx,
  .html and .po files, at most 50 and 64 KiB each. Links and directory junctions
  at the input itself or within its directory entries are rejected; ancestors
  of explicit inputs are not checked. The same input-only link check applies
  to rules. NUL-containing binaries are skipped with a note. Copy is read
  once and snapshotted separately for verification, then cleaned up. The rules
  document cannot also be supplied as copy, including external paths.
- Every chunk starts with the same untrusted JSON clause list and hashes of the
  full rules text and selected copy. Code and copy blocks carry file:line labels;
  quotes must omit those labels. Groups split at whole-line boundaries under
  the serialized 24,000-character cap. A line that cannot fit alongside the
  stable prefix is skipped with incomplete coverage. Explicit copy has separate
  blocks/chunks. Without it, touched-file strings supply the copy context.
- Prompts request contradictions only: the trigger names a clause and its claim,
  impact explains contrary behavior, and evidence quotes code or copy. Absence
  alone is not a contradiction unless the implementation claims the behavior.
  BLOCKER means money, permissions or data. Confirmation receives clauses and
  the related code/import group or copy, through the existing bounded prompts.
- The shared verifier accepts evidence only from selected code/copy inputs,
  never from the rules document. Findings retain the usual Git origin check.
  Missing/unknown clause references stay visible as `no clause cited`. Rules
  tables count verified non-local findings as `contradicted`; silence is only
  `no finding`. Coverage lists clauses, touched files, imports and copy. SARIF
  adds contract mode and clause metadata. Dry-run shows these inputs and chunks.
- Existing routes, quota fallback, escalation, optional IMPORTANT batches,
  reproduction, cache, ledger and exit rules remain in use. Mode and full input
  hashes participate in the existing prompt-based cache key for every chunk.

Implementation choices and limits: `--copy`, like `--spec`, `--inventory` and
`--rules`, may point outside the repository because the user names it explicitly.
Selected copy files are still regular, non-symlink, size-capped (64 KiB each)
and count-capped (50 files). Such files
use a synthetic `__quorum_copy__/` label when outside the repository, and copy
absent from HEAD is classified as introduced input with an explanatory
verification note (Git cannot blame an untracked input). Tracked copy uses the
normal origin algorithm. The lexical scanner is deliberately not an AST and does
not resolve computed specifiers. Oversized rules prefixes fail closed instead
of silently omitting clauses. Empty evidence is rejected by the existing parser
before verification; a direct verifier regression also confirms its rejection.

Regression evidence: initial unit tests failed because contract context did not
exist; after adding the context module, seven integration cases failed before
CLI/cascade/report wiring. Additional regressions failed before fixes for .js
specifier resolution to TypeScript and external rules passed as copy. Synthetic
fixtures cover clause extraction, import cycles/missing/outside paths/caps,
copy limits/junctions/binaries, stable bounded prompts and cache isolation,
clause classification, rules/empty-evidence rejection, dry-run and exit codes.
The main() deposit scenario asserts the Rules table, finding, SARIF and a
cross-family-confirmed BLOCKER exit 1 using FakeProvider only.

No provider CLI, real Qwen or CodeGraph call, new dependency, branch switch,
commit, push or repository log was used. Cross-provider review was not run
under the explicit provider prohibition; Linux/macOS and opt-in container
checks remain unverified.

Final Windows validation: `pnpm.cmd typecheck` passed; `pnpm.cmd test` with
`QUORUM_CONTAINER_TESTS=0` rebuilt the CLI and passed **1,221 tests**, with
**6 existing environment-gated skips**, across **44 files** (93.33 seconds).
The contract suites contain 25 tests. The final additional regression first
failed when dirty copy shadowed the same file's committed code; verification
now accepts either selected source, and the full suite above includes that fix.
`git diff --check` passed. No cross-provider review or live inference was run.

Files changed: `src/context/contract.ts`, `src/modes/index.ts`,
`src/cascade/{index,planner,prompts}.ts`, `src/cli/{args,index,review}.ts`,
`src/reporters/index.ts`, `src/types/index.ts`,
`tests/{unit,integration}/contract.test.ts`, `README.md`, and
`docs/{IMPLEMENTATION,PLAN,ROADMAP}.md`.

Contract review fixes: before changing production code, seven new tests failed:
the 64 KiB import-spaces case exceeded the worker watchdog, both re-export forms
were missed, all three root-index forms were missed, and a worktree beneath a
junction could not be read. The watchdog terminates the worker instead of
letting the old cubic regex freeze the suite. All six requested 64 KiB
adversarial shapes now assert completion below 200 ms (including file reads,
excluding worker startup). Clause-extraction expressions were also inspected
and exercised on 64 KiB whitespace, list-prefix, digit and bracket inputs;
no additional superlinear pattern was found. Boundary tests cover explicit
rules/copy through linked ancestors, internal junction rejection, copy-entry
rejection and file-link rejection. A refused OS file-link creation is reported
as a skip with its reason.

Review-fix validation on Windows: `pnpm typecheck` passed;
`pnpm exec vitest run tests/unit/contract.test.ts tests/integration/contract.test.ts`
passed 48 tests with one OS-permission skip; `pnpm test` rebuilt the CLI and
passed 1,244 tests with seven skips across 44 files (93.86 seconds). Six skips
were existing environment gates; the additional skip is the file-symlink test
because this OS refused its creation. Junction tests ran and passed.
`git diff --check` passed. Only `src/context/contract.ts`,
`tests/unit/contract.test.ts` and this document changed for these fixes.
No dependencies, provider calls, commits, pushes, branch switches or log files
were added. Cross-provider review and Linux/macOS execution remain unverified.

## v2 rule mining as built

Decision 24 adds a local findings history, `quorum rules propose`, and accepted
`quorum.rules.json` checks without dependencies or model calls for either rule
operation. The rules command is separate from `review --mode`: it mines past
runs rather than reviewing a diff with an AI prompt.

- History uses the ledger's existing lock, stale-lock handling and atomic rename.
  Final verified entries include visible unconfirmed findings and bughunt points
  at the change; rejected confirmations and dirty-run discarded findings are
  excluded. The `confirmed` boolean records successful confirmation (including
  the same family) or independent multi-family corroboration. Reproduction is
  an explicit status, defaulting to `unproven`. Quotes are limited to 400
  characters. At more than 5 MiB, the append retains newest complete JSONL
  records within 2.5 MiB, under the lock. Write errors warn without changing the
  review result. `.quorum/findings.jsonl` contains code quotes, stays local and
  must remain git-ignored.
- Mining reuses the verifier's linear tokenizer with an opt-in punctuation and
  keyword mode; verification's original token semantics are unchanged. Shapes
  retain operators, keywords and punctuation and abstract identifiers, strings
  and numbers. Only 3–40-token single-line quotes qualify; multiline skips are
  counted. OPTIONAL and improvement findings are excluded. The default three
  findings must span at least two runs and two files within 90 days. CLI bounds
  are 2–50 occurrences and 1–3650 days. Malformed history entries are counted and
  skipped. The most frequent trigger uses lexical ordering to break ties.
- Generated patterns escape literal metacharacters, allow flexible whitespace,
  and are checked against every complete quote in the safe worker before being
  offered. Unsupported templates, escaped-string forms, hexadecimal numbers,
  Unicode identifiers not matched by the specified ASCII identifier pattern,
  and patterns exceeding 500 characters can yield `no safe pattern`. Generated
  entries default to warning severity; a human chooses what to enable.
- Noise reads tracked regular-file blobs from HEAD, not dirty working files or
  symlink targets. Binary files and blobs over 256 KiB are excluded. The scan
  caps at 3000 files and 2000 matching lines, counting known sites within two
  lines in the same file. Zero known sites or more than 50 matches marks a rule
  noisy. Additional defensive limits cap materialized noise input at 100,000
  lines or 16 MiB; these, timeouts and truncated Git listings are disclosed and
  mark the estimate incomplete/noisy. A successful Git output overflow retains
  complete NUL-terminated listing records only. These aggregate memory limits
  are an explicit addition to the brief's caps.
- Rules validate named unknown keys, unique bounded IDs, compilable patterns,
  flags, messages, severity, paths and the 200-rule limit. They load from the
  same trusted commit as config, including `--since`; HEAD deletion/weakening
  does not bypass base rules. `--trust-head-config` reads committed HEAD.
  Doctor checks the local file and reports PASS/count or WARN/first problem.
- Added-line extraction uses the existing Git path decoder and diff parser;
  context and deleted lines never become matches. Paths use the existing
  dependency-free `**`, `*`, `?` glob matcher (brackets/braces are literal).
  A separate worker per rule receives only pattern, flags and eligible lines,
  with a fixed one-second timeout and termination. Lines longer than 2000
  characters are counted and skipped. A timeout discards that rule's partial
  matches and warns. Matching finishes before quota or inference calls.
- `ruleChecks` is separate from model findings. Neither match results nor rule
  messages are appended to model prompts; the underlying source diff remains
  reviewable, including changes to the rules file itself. No match enters the
  cascade, dedupe, verification, history or cache. Markdown adds Rule matches
  after deterministic checks, with 50 results per rule and a remainder count.
  SARIF emits retained results with `quorum-rule/<id>` and
  `properties.deterministic=true`. Error matches take exit 1 precedence;
  warnings/timeouts preserve complete/incomplete coverage exit behavior.
- `--no-checks` skips rules. Dry-run lists the count and source commit. Bughunt
  still runs configured rules on added lines when no unchanged window exists;
  model coverage remains incomplete. Proposals print Markdown or JSON and can
  save a Markdown report using `--out`; output must have a `.md` extension and
  never writes the accepted rules configuration.

Tests use synthetic repositories, injected runners and FakeProvider. Initial
integration tests demonstrated ten failures before CLI/report/history wiring;
module tests first failed on missing implementations. Follow-up failing
regressions cover displayed local/change-point history, same-family confirmation,
empty bughunt windows, partial regex self-matches and bounded Git/noise scanning.
The end-to-end case records three reviews, proposes a rule, accepts it into the
base commit, and reports its match on a new change with zero model calls.

No provider CLI, real Qwen or CodeGraph invocation, dependency installation,
branch switch, commit, push or repository log was used. Internal read-only QA
was from the same model family; external cross-family review was not run under
the task's explicit provider prohibition. Linux/macOS and opt-in container
execution remain unverified.

Files changed: `src/rules/{index,mining}.ts`,
`src/storage/{index,findings}.ts`, `src/verifier/semantic.ts`,
`src/cli/{args,index,review}.ts`, `src/reporters/index.ts`,
`src/doctor/index.ts`, `src/cascade/index.ts`, `src/types/index.ts`,
`tests/integration/{rules,rules-history}.test.ts`,
`tests/unit/{rules,rule-mining,mining-tokenizer,findings-history,history-confirmation,doctor-rules}.test.ts`,
`README.md`, and `docs/{IMPLEMENTATION,PLAN,ROADMAP}.md`.

Final Windows validation: `pnpm.cmd typecheck` passed. With
`QUORUM_CONTAINER_TESTS=0`, `pnpm.cmd test` rebuilt the CLI and passed all
52 test files: **1,328 passed, 7 skipped** (96.72 seconds). The seven skips are
existing environment-gated cases. The first complete run found one help-text
expectation mismatch; preserving its wording while explaining error-severity
rules fixed it. The final full run also includes the added 50-match reporting
cap and CLI history-window cases. `git diff --check` passed. No new logs were
left in the repository; pre-existing `.quorum/` contents were not removed.

## v2 refactor (part 1) as built

Round 5 retains asserted/satisfies array initializers and public class-property literals, resolves referenced namespace-local types with lexical scope, and explains every segment of recognized member changes without false incomplete-coverage notes.

Decision 25 adds `--mode refactor`, `--deterministic-only` and
`--allow-api-change`, without dependencies. Part 2 mutation sampling is described below.

- The review diff and both test revisions use merge-base and committed HEAD.
  Trusted-base configuration (or explicit `--trust-head-config`) supplies setup
  and test argv. Each side gets a disposable worktree and fresh temporary JSON
  report; setup precedes tests through the existing resolver/runner. Setup
  failure, timeout, absent/malformed report or incomplete test-suite execution
  makes evidence unavailable. Cleanup runs for both sides on failure too.
- `refactor.testCommand` is optional. Its fallback starts with
  `reproduce.testCommand`, retaining the runner/launcher and suite options while
  removing positional test selectors, `{file}`/`{testFile}`, test-name/path
  filters and old output destinations. Explicit refactor argv avoids this
  heuristic for custom launchers. The timeout defaults to 600 seconds, bounded
  to 30–3600. The shared `machineTestCommand` adds JSON/output-file arguments
  for both reproduction and refactor; no human-readable output is parsed.
- `parseTestReport` preserves describe segments and title when supplied, with
  the existing full-name fallback. Comparison normalizes path separators and
  dot segments, reports all requested transitions, and separately lists changed
  test files. Duplicate identities make evidence unavailable rather than
  overwriting results. Fixed tests never imply equivalence.
- The hand-written lexical export scan skips comments/quoted text while finding
  balanced declaration headers, including multiline parameters and nested types.
  It handles abstract/default/declare declarations, const enums, export assignment,
  import aliases, namespace exports, lists and re-exports. Type aliases and
  interfaces retain their types; annotated variables retain the annotation.
  Variable and class-property arrow initializers retain parameters, optional
  async/generics and return annotations, excluding the implementation. Ambiguous
  callable return annotations conservatively retain initializer text with a note
  and incomplete coverage. Exported const object initializers followed by `as const`
  or `satisfies` retain their literal text (8000-character cap); plain values remain
  excluded. Class, abstract-class, interface, enum, namespace/module
  and object-type alias declarations compare their header and member skeletons.
  Skeleton comparison keeps up to 8000 characters (other headers keep 2000);
  display keeps 300. Any header or member-signature difference is conservatively breaking,
  including compatible widening or an added optional parameter. Help and reports
  explicitly ask the reviewer to assess compatibility.
  Overloads compare signature multisets per name: order does not matter, duplicate
  counts do, and removed/changed signatures include before/after overload counts.
  A rename compares headers with the declared name replaced by a placeholder,
  preserving the original before/after text for reporting.
  Named lists resolve individual bindings against top-level declarations or import
  statements, including aliases and default identifier exports. Missing bindings
  retain `<unresolved>` and an incompleteness note. Re-exports retain their source
  specifiers; adding a binding does not break unchanged exports.
  Signatures reference top-level local type/interface/enum/class skeletons by
  identifier, transitively to depth 4 with cycle protection and an 8000-character
  dependency budget per export. Skeletons and reference sets are cached. Changed
  dependencies report the exported symbol and `uses Props, which changed` in JSON,
  Markdown and SARIF. Unreferenced locals are ignored. Depth/budget exhaustion
  produces a note and incomplete coverage. Matching is lexical, so shadowed names
  or property names can conservatively produce extra changes.
  `declare global` and quoted `declare module` augmentations retain the entire
  body under the names `global` / `module 'x'`, with the 8000-character cap.
  Their merging/implicit-export semantics remain unresolved and always produce
  an incompleteness note, even when the retained text is unchanged.
  Package fields compare structurally: object key order is ignored, array order
  is retained, including inside conditional `exports`.
- CommonJS scanning covers `module.exports = identifier`, shallow object exports,
  `module.exports.name`/`exports.name` assignments and literal-name
  `Object.defineProperty` exports in JS and TS. Unknown CommonJS forms and
  unsupported export declarations (including destructured bindings and object
  spreads) produce named incompleteness notes instead of silent omissions.
  Class members retain modifiers, optionality and annotations, excluding private
  and `#private` members, method bodies, static initialization blocks and property
  non-arrow initializers. Statement-start regex literals after `;`, `{` and `}`
  remain opaque to brace pairing; division after an operand remains division.
  Interface/object-type members retain type text; enum members retain
  names and initializer text. Namespace/module exports are skeletonized recursively,
  including local export lists. Member comparison uses multisets: order is ignored,
  duplicates count. Markdown and SARIF identify qualified member names and
  added/removed/changed status; removal or change is breaking, addition is not.
  This remains a lexical scanner, not type inference: it does not resolve inherited
  members, inferred variable/property types, computed member names or enum constant
  expressions semantically, or follow imports/re-exports to other files. Decorators,
  dynamic CommonJS and arbitrary TypeScript syntax are not fully modeled.
- API input is bounded to 256 KiB per file, with a bounded worktree read.
  Input truncation, the 2000-export limit, 4096-character export-list limit and
  2000-character header / 8000-character skeleton comparison limits all name the file/cap and set
  `api.incomplete`. The 300-character display limit does not truncate comparison.
  Recursive namespace capture shares the skeleton budget and stops at 32 declaration
  levels with an incompleteness note. Structural bracket pairing and template-string
  scanning are iterative, including deeply nested implementation braces.
  Touched unsupported source languages (`.py .go .rs .java .kt .cs .rb .php
  .swift .c .cc .cpp .h .hpp .m .scala .dart`) populate `api.unscanned` and name
  each unchecked file. These omissions appear in Verdict reasons and make an
  otherwise clean result SUSPECT, including with `--allow-api-change`; they
  do not make passing test evidence unavailable.
- Reverse relative imports include two hops, cycle handling, test markers and
  missing test dependents. Scanning skips links and dependency directories,
  limits source to 64 KiB/file and 3000 files, and lists at most 200 dependents
  with a note. Coverage omissions remain incomplete. Optional CodeGraph callers
  are bounded untrusted supplemental data; stale test callers cannot establish
  test coverage. No index is created.
  Only `.ts .tsx .js .jsx .mjs .cjs` files can lack test dependents.
  Other touched files appear under "Non-source files changed" without adding that
  verdict reason. Blast-radius limits are SUSPECT reasons rather than missing
  test evidence.
- Normal refactor review uses the existing cascade, verification, confirmation,
  routes, budget, cache and ledger. A stable untrusted deterministic summary
  and its hash participate in prompt identity. Findings display as suspected
  behaviour changes, without origin labels. Deterministic-only performs no
  provider quota, login, model or context-provider calls.
- Markdown includes verdict, base/head counts, test transitions, API changes
  and blast radius; long evidence lists are capped with remainder counts.
  SARIF retains structured refactor evidence and deterministic results under
  `quorum-refactor/<kind>`. Allowed API changes are notes. Refactor uses
  decision 25's verdict/exit matrix; deterministic rule matches remain visible
  but do not independently override that matrix.
- Dry-run describes both evidence worktrees, setup, suite argv, timeout and
  model-review state without creating worktrees or executing those commands.
  `--no-checks` is rejected before Git/provider activity. Doctor warns when
  neither test command is configured.

Tests use synthetic JSON, repositories and Node test-runner scripts, plus
FakeProvider and injected command runners. New command/parser, evidence,
reporter and CLI tests were observed failing before their implementation.
Internal read-only QA exercised scanner edge cases and final prompt bounds;
it is the same model family and does not replace external cross-family review.
No provider CLI, real Qwen/CodeGraph call, dependency installation, branch switch,
commit or push was used. Linux/macOS and opt-in container execution remain
unverified.

Files changed for part 1:

- Runtime: `src/refactor/{index,api,blast}.ts`, `src/cli/{args,index,review,refactor}.ts`,
  `src/cascade/{index,prompts}.ts`, `src/config/schema.ts`,
  `src/context/contract.ts`, `src/doctor/index.ts`, `src/modes/index.ts`,
  `src/reporters/{index,refactor}.ts`,
  `src/reproduce/{command,evaluate,index,isolation}.ts`, `src/types/index.ts`.
- Tests: `tests/integration/refactor.test.ts`, `tests/unit/args.test.ts`,
  `tests/unit/test-command.test.ts`, `tests/unit/refactor-api.test.ts`, and
  `tests/unit/refactor{,-blast,-config,-doctor,-prompts,-reporters,-verdict}.test.ts`.
- Documentation: `README.md`, `docs/{IMPLEMENTATION,PLAN,ROADMAP}.md`.

Initial part 1 Windows validation: `pnpm.cmd typecheck` passed. With
`QUORUM_CONTAINER_TESTS=0`, `pnpm.cmd test` rebuilt the CLI and passed all
**61 test files: 1,402 passed, 7 skipped** (100.49 seconds). Skips are existing
environment gates. The first complete run had one old argument test still
expecting `refactor` to be invalid; its unknown-mode fixture now uses `runtime`.
The final run includes all subsequent edge-case tests. `git diff --check`
passed. No new repository logs were left. The branch remains
`feat/v2-refactor`, with all changes uncommitted.

Review-fix regression evidence (same branch/worktree, no provider calls):
the first targeted run against the unchanged implementation had **59 failing
tests and 33 passing tests** across the API, blast-radius and integration files.
Failures covered missing export forms/CommonJS, complete type/multiline signatures,
overload removal and order/multiplicity, comparison beyond the display limit,
every requested cap and unsupported language, documentation wording, and
README-only noise. Seven new integration cases failed initially; overload removal
already returned NOT EQUIVALENT on that implementation, while its unit test
exposed incorrect per-signature reporting. Existing-support and performance
controls also passed initially.
During implementation, three extra annotation-boundary tests exposed function
types with `=>`, object constraints in generic interfaces, and multiline
initializers in multiple declarations; all were fixed. A further failing test
prevented CommonJS arrow implementation bodies from becoming API signatures.
All three requested API changes are covered through `main()` with
`--deterministic-only`, synthetic repositories and no provider activity.
Compiled-scanner probes for the seven 256 KiB adversarial shapes took
3–35 ms each on this Windows machine (limit: 300 ms).

Final review-fix validation: `pnpm.cmd typecheck` passed; `pnpm.cmd test`
rebuilt the CLI and passed **62 test files, 1,477 tests, 7 skipped** in
105.42 seconds. The skips are existing environment gates. `git diff --check`
passed. No dependencies, provider runs, repository logs, commits, pushes or
branch switches were added. External cross-family review was not run because
provider execution was explicitly prohibited for this task.

Round 2 fixes after Gemini's re-review of `bd24be5`:

- Type aliases retain next-line bodies and leading union/intersection members,
  stopping at a shallow semicolon or a non-continuation newline. Continuations
  include `|`, `&`, `?`, `:`, `.`, `=>` and opening groups. The comparison/display
  limits remain 2000/300 characters; truncation names the cap and marks API
  evidence incomplete.
- CommonJS includes literal single/double-quoted bracket assignments on both
  `exports` and `module.exports`, and shallow properties in
  `Object.assign(exports, {...})` / `Object.assign(module.exports, {...})`.
- Default arrows compare their header before `=>`, including `async`,
  parameters and return annotations, excluding block/expression bodies.
  Signature comparison tokenizes before normalizing whitespace, so comments
  (including line comments inside multiline headers) do not hide annotations
  or create signature changes.
- A per-file safety net compares normalized export-looking line sets in base
  and head: leading `export`, leading `exports.` / `exports[`, or lines
  containing `module.exports`. If these differ without a recognized API change
  in that file, the exact note is
  `export-related lines changed but no API change was recognised: <file>`;
  `api.incomplete` is true and `api.unscanned` lists the file. This makes an
  otherwise clean verdict SUSPECT. Comments and whitespace are ignored,
  including line wrapping with identical token content. Recognized function
  implementation bodies are excluded from this fallback so body-only changes
  retain the intended deterministic verdict. Unknown enum/member syntax is
  not excluded. This is a lexical safety net, not a complete parser.
- All three blast caps (200 dependents, 3000 scanned files, 64 KiB/file) mark
  evidence incomplete. Files without a proven test dependent move from
  `withoutTests` to `testsUnknown`; Markdown lists them under
  "Touched files: tests unknown (search truncated)". Verdict reasons include
  `blast radius incomplete`, and the bounded model summary includes the
  incomplete flag and unknown-test list. A positively identified test remains
  evidence even when its dependent entry falls outside the display cap.

Before implementation, the targeted API/blast/CLI run had **19 failing and
101 passing tests**. The failing regressions were: two next-line union cases,
the next-line signature cap, four bracket assignment forms, two Object.assign
targets, two default-arrow variants, the unknown-syntax safety net, comment/
whitespace comparison, all three blast caps, and all three new deterministic
CLI cases. The CLI cases assert NOT EQUIVALENT for union-member and bracket
export removal, and NO BEHAVIOUR CHANGE FOUND for a default-arrow body edit
with unchanged tests. Existing-support and adversarial timing controls passed
on the old code. Additional tables cover existing overload/abstract/const-enum/
export-assignment/dotted-CommonJS/multiline signatures, type continuation
tokens, comment boundaries and semicolon-free declaration boundaries. Three
new 256 KiB adversarial cases exercise union continuation, repeated `exports[`
and Object.assign commas with a 300 ms limit.

Round 2 validation on Windows: `pnpm.cmd typecheck` passed; `pnpm.cmd test`
rebuilt the CLI and passed **62 test files, 1,514 tests, 7 skipped** in
100.38 seconds (existing environment-gated skips). Compiled `compareApi`
probes for the new 256 KiB cases took **122/49/45 ms**, respectively.
`git diff --check` passed. Changes remain uncommitted on `feat/v2-refactor`.
No dependencies, provider commands, quota usage, repository logs, branch
switches, pushes or external review were added; provider execution was
explicitly prohibited. Linux/macOS and opt-in container execution remain
unverified.

Round 3 fixes (declaration skeletons):

- Classes, interfaces, object-type aliases, enums and namespaces/modules now use
  the member comparison described above. Qualified member changes include
  nested names such as `N.Inner.S.stop`; additive members appear as SARIF notes.
  Top-level local declarations (including overloads, `declare`, `abstract` and
  multiple variable declarators) supply signatures for export lists and default
  identifier exports. Imported bindings use their import statement, so a source
  module edit is visible. Namespace export lists use their own scope table.
- A default arrow with an arrow-containing return annotation captures through
  the last shallow arrow on the statement line. This deliberately favors extra
  evidence: an implementation edit in that ambiguous shape can be reported as
  an API change. Ordinary default arrows still exclude their bodies.
- Package comparison covers `main`, `module`, `types`, `typings`, `exports`,
  `imports`, `bin`, `version`, `type`, `engines`, `files`, `sideEffects`, `browser`,
  `typesVersions`, `peerDependencies` and `workspaces`. Every structural change
  is breaking and names the field.
- Safety net v2 compares export-looking line headers, cutting before shallow
  `{`, `=`, `=>` or `;`. Body/value edits on the same line no longer generate
  false incompleteness. Each changed header must contain an identifier explained
  by a recorded change in that file (including the containing declaration for
  member changes). Otherwise the note is
  `<file>: export-related lines changed but no API change was recognised for: <line header>`,
  with `incomplete` and `unscanned` set. A recognized change elsewhere in the
  file cannot suppress this note. Comments and equivalent token wrapping remain
  ignored. This replaces the round 2 whole-line/per-file fallback.

The initial regression run against the unchanged round 2 implementation had
**68 failures and 41 passes** across the new skeleton tests and refactor CLI
integration tests. Failures included all reproduced silent misses and body/value
noise, class/enum member matrices, local/import/unresolved bindings, new package
fields and structural object ordering, member reporting and the skeleton cap.
The four new CLI scenarios failed too: public-method removal, enum-member removal
and package `type` edits must be NOT EQUIVALENT; a class method-body edit must be
NO BEHAVIOUR CHANGE FOUND. Follow-up failing tests covered semicolon-free default
identifier exports, namespace export lists, nested non-exported namespaces,
anonymous default classes, object-type intersection suffixes, namespace aliases
and multiple exported variables. Adversarial fixtures cover 50,000 member-like
tokens, 10,000 brace levels, an unclosed body, repeated aliases that would expand
a declaration beyond 3 MB, commas, and quoted/template braces, each with a
256 KiB input and a 300 ms comparison limit.

Round 3 final Windows validation: `pnpm typecheck` passed; `pnpm test` rebuilt
the CLI and passed **63 test files, 1,615 tests, 7 skipped** in 100.79 seconds.
The skips remain existing environment gates. Compiled `compareApi` probes took
**89.5 / 10.1 / 9.6 / 34.2 / 102.0 / 10.0 ms**, respectively, for the six
adversarial cases above. `git diff --check` passed.

Round 3 changed `src/refactor/api.ts`, `src/reporters/refactor.ts`,
`tests/unit/refactor-skeleton.test.ts` (97 new cases),
`tests/unit/refactor-api.test.ts`, `tests/unit/refactor.test.ts`,
`tests/integration/refactor.test.ts` (four new CLI cases), and this document.
No dependencies, provider commands, quota usage, repository logs, commits,
pushes or branch switches were added. Changes remain uncommitted on
`feat/v2-refactor`. External cross-family review was not run because provider
execution was prohibited. Linux/macOS and opt-in container execution remain
unverified; the lexical limitations listed above still apply.

## v2 refactor (part 2) as built

`src/refactor/mutation.ts` parses head-side diff additions, skips test/non-source
files and applies one lexical replacement per mutant. Candidate text is lazy;
selection is stable SHA-1 order within alphabetically ordered operator buckets,
visited round-robin up to the configured limit. Equality, comparison, boolean,
logical, binary arithmetic, integer, return and balanced if mutations are sampled.
Only sources read from the disposable HEAD tree are eligible. Before every write,
paths are boundary-checked, link-checked, regular-file checked and compared with
the generation snapshot. Mutated UTF-8 content cannot exceed the 256 KiB API cap.
Every attempt restores in finally and verifies restoration. A replaced link or
failed restore aborts the phase and records a verdict reason. Reports use unique
temporary paths and are removed after each attempt. Missing/invalid reports,
suite errors, timeouts, unexplained exit failures and changed test counts are
invalid; failed tests kill mutants; clean matching-count reports survive.

The wall budget includes generation and bounds each suite timeout. Exhaustion
stops subsequent runs. Markdown shows counts, survivors, skipped notes and budget
state; SARIF emits located note-level `quorum-refactor/mutant-survived` results.
JSON includes the evidence object; model summaries include totals and at most five
survivors, sharing the existing 4096-byte shrink loop. Skips and invalid mutants
do not change verdicts. Config alone leaves sampling off.

Limits: this is lexical JavaScript/TypeScript sampling, not parsing, type inference,
coverage instrumentation or exhaustive mutation testing. Generic-looking lines
and type/import/decorator lines are omitted. Compound return/if replacements over 4096 characters
are omitted, while small operators on long lines remain eligible; limits are noted. Slash ambiguities omit the remainder of their line;
interpolated templates conservatively omit the remaining file. Comments and
quoted text are opaque. Equivalent mutants may survive, and a killed mutant does
not establish coverage of every behavior on its line. Existing tests execute
repository code through the existing machine-command runner, not a new sandbox.

Validation uses only synthetic files, temporary Git repositories and fake command
runners. No provider CLI, branch switch, commit or push was performed. External
cross-family review was not run because this task explicitly forbids provider
execution. Linux/macOS execution remains unverified.

Part 2 Windows validation: `pnpm.cmd typecheck` passed; `pnpm.cmd test`
rebuilt the CLI and passed **67 files, 1,754 tests, 7 skipped** in 122.68 seconds.
`git -c core.safecrlf=false diff --check` passed. The first new mutation test
suite was run before implementation and failed collection because
`src/refactor/mutation.ts` did not exist (no individual assertions ran then).
A subsequent CLI flag test failed because its helper duplicated `--mode`;
the fixture was corrected to invoke `main()` directly. The final suite includes
256 KiB adversarial inputs with a 300 ms generation bound, cap enforcement,
deterministic selection, execution/restore failures, budget limits, configuration,
verdicts, report/summary bounds and killed/surviving end-to-end CLI cases.
Changes remain uncommitted on `feat/v2-refactor-mutation`.

## v2 runtime R0 as built

`--mode runtime` validates the optional `runtime` config block using handwritten
types and validation in `src/runtime/config.ts`. Start argv, readiness URL and
flows are required only for this mode. Unknown keys, invalid action companions,
out-of-range limits, non-loopback HTTP URLs, userinfo, traversal and unpinned
images are rejected with field paths; step errors identify the flow and index.
Fill values are never included in validation errors or dry-run output.

The CLI reads config from its existing trusted commit policy and returns before
rules, checks, providers, context enrichment or worktree creation. Dry-run prints
only start argv, readiness URL, flow/step counts, timeouts, image, resource limits
and screenshot state, even for an empty diff. Runtime execution currently exits
2 with the R1-R3 not-built message. `--no-checks` and unrelated mode flags are
usage errors. The collector, container orchestration, comparison and reporters
remain planned; no image is selected or pulled.

The dependency-free CommonJS fixture server binds to `127.0.0.1` with `PORT`
(default 4173), emits `Cache-Control: no-store`, and supports good, console-error,
uncaught, http500, http404, blank, technical and external behaviors. Unit tests
start it in-process on ephemeral loopback ports and inspect HTTP responses;
they never execute the page scripts or request their external references.

Decision (R0 fixture selector): use `QUORUM_FIXTURE` instead of the query flag
in the original milestone row, as requested by the R0 brief. One server instance
keeps one behavior across the page and its sub-resource/API requests.

Before implementation, the new config/CLI suites had 78 failing tests (7 passed);
the nine fixture tests then failed because the server module did not exist.
External cross-family review is not run because this task prohibits provider
execution and network access. No dependencies, logs, commits or pushes are added.

R0 Windows validation: `pnpm typecheck` passed; `pnpm test` rebuilt the CLI and
passed 70 test files, 1,862 tests, with 7 existing skips in 112.61 seconds.
`QUORUM_CONTAINER_TESTS=0` explicitly kept the opt-in Docker test disabled.
`git -c core.safecrlf=false diff --check` passed. Linux/macOS, browser and
container execution remain unverified. Changes are uncommitted on `feat/runtime-r0`.

## v2 runtime R1 as built

`src/runtime/collector.cjs` exports `run({ playwright, plan, now })` and the frozen
`CHROMIUM_ARGS`. The plan uses R0's runtime config fields (`readyUrl`, `flows`,
`flowTimeoutSeconds`, `stepTimeoutSeconds`). Its guarded CommonJS entry reads
the plan from argv[2] and writes one JSON report to argv[3]; only that entry
resolves Playwright. R2 must copy this Quorum-owned script into the container
and transport its report through the fresh-marker wrapper. No CLI execution
or container orchestration is enabled by R1.

Each flow runs twice in fresh contexts. Context routing fulfills non-loopback
requests with an empty 204 and retains host counts only. Service workers are
blocked so they cannot bypass context routing. Events retain URL paths without
queries/fragments. Expected 4xx must belong to a request started within the
current goto/click step and be a main-document or fetch/xhr response. Static
sub-resource errors always retain signatures. Goto/click settle through
domcontentloaded and a networkidle wait capped at two seconds; only the latter's
TimeoutError is ignored. Step and flow deadlines race browser operations, stop
the run, suppress late events and close its context. R2 still needs an outer
process deadline for browser launch/teardown and a hung browser process.

The in-page DOM probe returns only blank state and bounded matched snippets,
never the complete body text. Visible images, SVG, canvas, video and inputs
prevent blank detection. Fixed technical patterns use word boundaries. Limits
are 200 observations per run, 2000 per report, 500 characters per message/path,
200 per technical snippet, 300 per failure message and 2 MiB serialized UTF-8.
Each hit adds a deduplicated `cap:` note. A bounded metadata reserve and an
incremental serialized byte count avoid repeatedly serializing the report;
size exhaustion stops all subsequent observations. Host maps are capped at
200 entries per run, with reserved prototype names omitted and noted.

`report.ts` exports the report types and parses untrusted JSON with an input byte
limit, explicit field/type checks, bounded arrays, known flows, unique run pairs
and prototype-key rejection. It truncates strings again, constructs safe maps,
and fills missing configured runs with incomplete placeholders. It never walks
arbitrary nested data recursively. `signature.ts` normalizes volatile message
details with bounded/token-scoped regex passes, preserving case and HTTP resource
paths. Async signatures omit step indexes; blank, technicalText and flow-failure
include them. `stable.ts` returns `flows` (signature sets), `counts` (run-1/run-2
tuples for every observed signature), `flaky` and `incomplete`. Matching failures
in both runs remain stable failures; missing runs, cap notes or two unfinished
runs without a shared failure retain incomplete coverage. Flows must be idempotent.

Tests use an injected fake Playwright and synthetic DOM objects, including
event timing, exact fields, routing, all step actions, cleanup, deadlines, every
cap, malformed/deep JSON, signature collisions and stable/flaky/incomplete
classification. Timing checks cover a 2 MiB/2000-observation report under 300 ms
and a pathological 500 KB normalization input under 50 ms. Before implementation,
both new suites failed collection because their target modules were missing;
no individual assertions ran at that stage. An intermediate cap test caught an
overlarge metadata reservation; it was corrected before delivery.

R2 real-container verification must confirm: Chromium startup with exactly the
two exported flags; routing/service-worker blocking and external 204 behavior;
request/response identity and ordering around clicks/navigation (including redirects);
DOM innerText/computed visibility in Chromium; load-state timeout behavior;
context closure aborting pending operations; and report-file/marker transport.
Fake tests do not establish any of these real-browser/container behaviors.

No dependencies, network, browser installation, provider execution, logs, commits
or pushes are added. External cross-family review is not run because provider
execution is explicitly forbidden. The clean checkout was already on
`feat/runtime-r1` at the same commit as local `main` (`002281d`), so no branch was
changed. `git pull` was omitted to obey the no-network constraint. Linux/macOS
and real Playwright/container execution remain unverified.

R1 targeted Windows validation: `pnpm typecheck`, `node --check
src/runtime/collector.cjs`, and `git -c core.safecrlf=false diff --check` passed.
`pnpm exec vitest run tests/unit/runtime-evidence.test.ts
tests/unit/runtime-collector.test.ts --maxWorkers 1` passed all 103 new tests.
The first broad run (`QUORUM_CONTAINER_TESTS=0`, `pnpm run test --exclude
tests/unit/runtime-app.test.ts`) passed 1947 tests, skipped 7 existing gates,
and failed one existing refactor-mutation timing assertion (335 ms versus its
300 ms bound). That suite passed when repeated with one worker. The runtime-app
suite is deliberately excluded because it opens real loopback HTTP connections;
the task forbids all network use. An initial `pnpm test --exclude ...` invocation
was rejected by pnpm's option parser; `pnpm run test` correctly forwards flags.

The final broad run, `QUORUM_CONTAINER_TESTS=0` and `pnpm run test --exclude
tests/unit/runtime-app.test.ts --maxWorkers 2`, rebuilt successfully and passed
71 files / 1958 tests, with 7 existing skips, in 417.38 seconds. This is the
repository test script with reduced concurrency and the explicit network-suite
exclusion, not a claim that the unrestricted `pnpm test` ran. Changes remain
uncommitted on `feat/runtime-r1`.

## v2 runtime R2 as built

`src/runtime/run.ts` collects evidence at the merge-base and head in disposable
review worktrees, always attempting their cleanup. Docker/Podman detection uses
the existing command resolver. Missing infrastructure, preparation failures,
timeouts and invalid reports leave evidence unavailable; none implies a pass.
No provider calls or ledger writes occur in this lane.

`image.ts` pins the 3.6 GB Playwright 1.64.0 Noble image by index digest and the
matching `playwright-core` version/integrity. The image supplies browsers, not
the npm package. A named volume keyed by image and integrity holds that package.
Preparation checks its marker, lockfile integrity and installed version. A fresh
volume is chowned offline as root with only CAP_CHOWN, then npm installs as
1001:1001 with scripts disabled and network enabled. Verification and marking
are offline; mismatches remove the volume. Completed volumes are reused.
An image override warns that browser/package compatibility is unverified.

`prepareDependencies` is extracted from reproduction isolation without changing
its default UID or cache names. Runtime supplies its image and UID 1001; a UID
suffix isolates its preparation images and dependency volumes. Existing frozen
lockfile installs, metadata hashes, install-script consent, limits and cache
markers are reused. The generated preparation image adds the pinned package
manager to the runtime image. Image construction and dependency installation
can access the network; setup and collection cannot. Setup argv commands run in
containers with a writable disposable worktree and dependency volume. Collection
then mounts both read-only, with the existing runner-cache tmpfs overlays.

The Quorum-owned `runner.cjs`, collector and bounded plan live in a temporary
read-only `/quorum/bin` mount. The plan contains only readiness URL, timeouts,
screenshot flag and validated flows; start argv is a separate argument. The
runner spawns without a shell in `/work`, in its own process group, with only
PATH, HOME, TMPDIR, XDG_CACHE_HOME, NODE_ENV, optional PORT and CI. It polls the
loopback readiness URL every 250 ms, accepts statuses below 500 without following
redirects, and bounds individual requests. App stdout is discarded; stderr is
retained only as a bounded, control-character-sanitized error tail with fill
values redacted. Teardown signals the whole app group with SIGTERM, waits three
seconds, and signals SIGKILL even if the leader already exited.

Collection uses UID/GID 1001, no network, all capabilities dropped,
no-new-privileges, a read-only root, tmpfs `/tmp` and 512 MiB `/dev/shm`, configured
memory/pids and two CPUs. The Playwright volume is read-only at
`/quorum/playwright`; the collector uses its fixed absolute package path.
The outer timeout is readiness + twice each flow deadline + 30 seconds, capped
by the global remaining budget. Containers have unique names; timeout kills
them by name and cleanup force-removes them. Process capture allows 2 MiB plus
transport overhead while report parsing retains the strict 2 MiB cap. Parsing
uses only the last fresh marker, validates coverage through `parseRuntimeReport`,
redacts fill values from report strings and derives stable observations.

The CLI preserves runtime dry-run and refuses `--no-checks`. Execution prints
per-side flow/completion/stable-signature counts, flaky/incomplete flows and
unavailability reasons. `--format json` and `--json` emit structured summaries.
All executions still exit **2**, with `runtime mode: comparison and verdict
arrive in R3`. Screenshots remain a forwarded plan option; this milestone does
not add screenshot retention or comparison/verdict logic.

New tests cover runner injection, readiness/errors, environment, process groups,
marker transport, redaction, container argv, offline boundaries, integrity/cache,
setup, cleanup, timeouts, volume identity and CLI JSON. Before implementation,
the new runner/orchestration suites failed collection because their modules did
not exist; no individual assertions ran then. The opt-in container test creates
its own temporary Git repository and tests good, console-error, http500,
external and blank behaviors at base/head. Only that synthetic repository gets
Git writes. No dependencies were added to Quorum. Cross-family review is not
run because this task forbids executing the provider CLIs.

The opt-in command was attempted on Windows on 2026-10-21 with
`$env:QUORUM_CONTAINER_TESTS='1'; pnpm exec vitest run tests/container/runtime.test.ts`.
Vitest reported `Test Files 1 passed (1)` and `Tests 1 skipped (1)` (520 ms).
The Docker probe was denied by the execution sandbox:
`permission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine`.
The preflight therefore skipped before creating the temporary Git repository or
installing packages. The five real-browser cases remain **unverified**, despite
the image/daemon being present on the host. No permission changes or alternate
daemon access were attempted.

Final R2 local validation: `pnpm typecheck` passed; `pnpm test` rebuilt and passed
75 files / 2003 tests, with 8 skipped gates, in 161.78 seconds. Both
`node --check src/runtime/runner.cjs` and `node --check src/runtime/collector.cjs`
passed, as did `git -c core.safecrlf=false diff --check`. Changes remain
uncommitted on the existing `feat/runtime-r2` branch. No Git write command was
run against this checkout, and no provider CLI was executed.

## v2 runtime R3 as built

`src/runtime/compare.ts` compares the stable signature sets per configured flow
and in total. Entries retain kind, flow, step for step-bound observations,
display message/path from head (base for fixed entries), and both runs' counts
on each side. Async observations remain independent of step timing. A flow
completed twice at base with the same step failing twice at head goes into
`flowBroke`, never `newAtHead`; matching failures on both sides are pre-existing.
Failing-step stability uses the step even when error messages differ by run.

Comparison retains side-labelled flaky/incomplete flows, missing configured
flows (including the parser's synthetic `missing run` entries), covered flows
and per-side blocked-host totals. Blocked external requests are informational.
`evaluateRuntimeVerdict` checks unknown coverage first: unavailable evidence,
missing sides, incomplete flows and uncovered flows cannot pass. Confirmed new
browser problems override UNKNOWN with exit 1 while retaining coverage reasons.
Newly broken steps yield SUSPECT (exit 0), or NEW RUNTIME PROBLEMS (exit 1) with
runtime-only `--strict-flows`; strict flows alone do not override UNKNOWN.
Flaky flows are SUSPECT. A clean verdict names exactly the covered flows.

`src/reporters/runtime.ts` builds a redacted report with comparison, verdict,
exit code, reasons, notes and a JSON summary bounded to 4096 UTF-8 bytes. The
summary retains category totals while trimming samples; it is exposed for R5
without invoking any model. Markdown uses the refactor cell helper with extra
literal escaping for page-supplied Markdown/HTML and a 300-character message
cap. SARIF emits new problems as errors, newly broken flows as warnings (errors
with strict flows), and pre-existing problems as notes. Locations point only to
`quorum.config.json` with logical flow/step locations, never invented source
lines. Fill values are redacted through `runtimeText` before report serialization.

Runtime execution now uses the existing review output writer, extracted into
`outputReview`, for default/`--out` Markdown, optional `--sarif`, and stdout JSON
(`--json` or runtime-only `--format json`). JSON retains the shared review envelope
with a `runtime` section. No provider, quota, ledger or findings-history calls
are made. Dry-run is unchanged. No dependencies were added.

New tests cover stable set differences, async step drift, stable failures with
changing messages, coverage precedence, expected versus static 4xx, duplicate
counts, blocked hosts, hostile Markdown, redaction, SARIF locations/levels,
JSON round trips and byte-bounded summaries with many flows. Fake-container
tests run through `main()` for good, console-error, http500, blank, external,
not-ready and broken-step behavior, and verify saved Markdown/SARIF alongside
stdout JSON. The opt-in real-container test now asserts each behavior's verdict.

Before implementation, comparison and reporter suites failed collection because
their new modules were absent (no individual assertions ran). The added
`doctor --strict-flows` assertion then failed because the command reached doctor
instead of rejecting the flag; the global usage guard fixed it. Other new
assertions were verified after implementation, not claimed as red-first tests.
Real containers and cross-family provider review remain unverified under this
task's explicit prohibition on Docker and provider CLIs. All Git operations in
this worktree were read-only; changes are left uncommitted on `feat/runtime-r3`.

Final R3 validation: `pnpm typecheck` passed. `pnpm test` rebuilt and passed
78 files / 2041 tests, with 8 skipped gates, in 105.27 seconds. The container
gate was explicitly disabled (`QUORUM_CONTAINER_TESTS=0`); no real container or
provider was run. `git -c core.safecrlf=false diff --check` passed. No logs are
retained; fake-runner report files and synthetic directories are cleaned up.

## Runtime hardening

Runtime coverage treats infrastructure failures and every evidence cap as
incomplete. Page inspection also follows press and both wait-for actions.
Messages retain 2000 characters for comparison (300 for display); serialized
reports remain below 2 MiB with visible cap notes, deduplicated by flow/text.
The shared collector/host scrubber redacts fill values before truncation and
removes URL queries, fragments, userinfo, filesystem directories and long tokens.
The app stderr tail reserves the longest fill value before sanitizing and then
keeps 2000 display characters, including redaction of partial edge values.

Setup uses a private per-side dependency volume copied offline as UID 1001 with
symlinks/modes preserved; only the copy is writable and it is removed in finally.
No setup means no copy and read-only shared dependencies. Shared preparation is
serialized by volume in-process and uses an atomic named-container lease across
processes; a conflict is unavailable ("dependency volume in use"). A stale lease
is not automatically stolen. The hardening pass reserved screenshots; runtime V0 below re-enables local capture.
Runtime rejects provider/cache/reproduction CLI flags that it cannot honor.

Regression tests use fake browser/container implementations, including cleanup,
concurrent preparation, redaction boundaries and 500 KB scrubber timing. Real
Docker and end-to-end CLI validation remain separate checks. Known limit:
`budget.maxMinutes` does not bound Git/worktree preparation.

## Runtime V0 as built

`runtime.screenshots: true` stores local JPEGs and calls no model. Every context
uses the exported frozen 1280x800 viewport. Both runs capture after inspected
steps settle; only run 1 is retained. A separate five-second capture timeout
extends the flow deadline by measured capture time (at most five seconds), and
the container allowance includes capture time within the global budget. Image
caps/failures are visible notes and do not make deterministic coverage incomplete.

The collector attaches a non-enumerable `shots` array to its existing report.
Runner emits bounded IMG lines before the final report marker; app stdout stays
discarded. Host parsing verifies exact fields, canonical base64, JPEG magic,
length, SHA-256, configured flow/step, duplicates, count and fair byte budgets.
Only collection raises the output bound to 10,551,296 bytes; overflow is UNKNOWN.
Images remain separate from the 2 MiB JSON report.

Files persist at `.quorum/runtime-shots/<runId>/<base|head>/<NN>-<flow-slug>-<step>.jpg`,
using the report run ID, validated flow names and exclusive writes. Storage checks
parent links and Git ignore status; it asserts slug uniqueness (punctuation can
otherwise collide). A storage refusal adds a note without affecting the verdict.
Markdown/JSON list paths, sizes, hashes and pairing, without base64 or inline
images. SARIF and the bounded model summary retain their prior structure.
Tests use fake browsers and containers; the extended real Docker test is opt-in.

## Runtime V1 as built

Runtime-only `--visual` implies screenshot capture. The optional `runtime.visual`
block validates `maxCalls` (1–40) and `allowedFamilies`; configuration alone
never enables calls. Dry-run lists call/image ceilings and eligible recipients
without invoking providers or containers. Provider construction and quota refresh
are shared with other review modes; runtime enters them only with `--visual`.
The visual budget starts before deterministic collection, so elapsed collection
time reduces the remaining model deadline. No runtime ledger or cache is written.

`runtime/visual.ts` pairs stored shots by flow and zero-based step (`flow/step`),
lists unpaired shots, and borrows `resolveTier`, `quotaStatus`, `parseFindings` and
`RunBudget` directly. The cascade implementation and its tests are unchanged.
The first eligible family reviews each flow's paired images; only findings trigger
an independent-family call with the same prompt and images. Quota failures mark
the shared group unavailable. Every inference, including an adapter retry, counts
against both ceilings. Counts of images include repeated transmissions.

The attachment factory checks paths, links, JPEG bytes and hashes, copies only
paired images to a fresh OS-temp directory outside the repository, and cleans it
in `finally`, including on failures. The runtime path in the existing agy/Claude
adapters borrows that directory instead of creating a code worktree, permits
reading the named JPEGs, and checks its contents for modifications. Their existing
code-review paths are unchanged. This small adapter bridge was necessary because
the pre-V1 adapters created Git worktrees and agy's text-only prefix forbade image
reads; passing `context.images` alone did not provide image isolation.

Prompts contain quoted flow/step data (actions/selectors, no fill values), paired
image labels and a narrow regression task. They contain no diff, touched files,
source code or environment configuration. Image text is explicitly untrusted.
Unknown finding labels are dropped and counted, malformed output makes visual
coverage incomplete, and BLOCKER is capped to IMPORTANT. At most ten claims per
call reserve space for both families (twenty per flow); displayed claims are
redacted before the 300-character trigger/impact caps. Inline image data is removed.

Corroboration groups by pair label and distinct family, preserving both claims.
Only an otherwise clean verdict becomes SUSPECT (exit 0); existing SUSPECT,
NEW RUNTIME PROBLEMS and UNKNOWN retain their verdicts and exit codes. Visual
failures never affect deterministic coverage. Markdown labels the advisory claims,
links them to deterministic observations at the same step, and lists stored image
paths, reviewed pairs, unpaired images and coverage notes. JSON carries VisualReview;
SARIF uses `quorum-runtime/visual` at the config file with `flow/step` logical
locations, warning/note levels and no source line. The bounded model summary
continues to contain only deterministic evidence, never visual claims or images.

The synthetic fixture's `layout-break` response overlaps two boxes and omits the
primary button with inline CSS and no browser errors. Unit/HTTP tests and `main()`
tests use synthetic data, scripted providers and fake container runners. Real
provider image ingestion, CLI permission enforcement and visual judgement remain
V2 checks; no quota, real provider calls or Docker runs are part of V1 validation.

## First real-provider runs (2026-10-22)

**V2, the visual review (R5).** Synthetic repository with the fixture app: the base serves the
good page, the head serves `layout-break` (two overlapping boxes, the primary button missing,
no console error and no HTTP error). `quorum review --mode runtime --visual` with
`tiers.visual = [agy:gemini-3.8-flash-high, agy:claude-sonnet-5-5-medium]` made **2 model calls
with 4 images**. Both families, independently, reported the missing "Primary action" button and the
truncated, overlapping "Layout box" texts for `home/0`; the pair was corroborated and the
verdict rose from `NO NEW RUNTIME PROBLEMS FOUND` to `SUSPECT` (exit 0), as designed. The
deterministic comparison had found nothing, which is the case this layer exists for.
With `gemini-4-argon-high` as the only visual model (the default) and its quota under the floor
(0.48 %), the run made no call, stored the screenshots, reported `visual coverage incomplete` and
kept the deterministic verdict: the degradation is safe.
Findings from the model arrive as `visual, unverified` and appear in their own section; the
models' claims were accurate for this fixture, which says nothing about false-positive rates on
real apps.

**Self-review of the runtime sources** (`--mode feature` with the plan's commitments as eight
acceptance criteria, range = the 14 runtime source files, 1 495 lines). 12 calls, all within the
default ceiling: 7 triage calls to `agy:gemini-3.8-flash-low`, then 5 confirmation calls (Codex x4,
Claude Opus unavailable because the CLI login had expired). Result: 1 BLOCKER and 7 IMPORTANT + 1
OPTIONAL, all from the single triage model. Each was checked against the code by hand and **none
was a real defect**: `evidence.reasons` holds only failures, per-run volumes are removed in a
`finally`, report strings are redacted before they reach SARIF, the provider's image workspace is
a temporary directory by design, a stable failure at the same step on both sides is pre-existing by
design, and the stderr tail is redacted before it is cut. Codex rejected the findings it was
asked about. The 12-call ceiling was spent before the batch confirmation of the IMPORTANT findings
could run, so they were reported as "single model, not confirmed"; an unconfirmed BLOCKER exits 1
by design. Lessons: (1) a single flash-low triage pass is noisy on code it only sees as a diff of
new files, so the confirmation stage is what makes a report trustworthy; raise `budget.maxCalls`
when a range has many chunks; (2) a criterion that says "any flow that did not complete is
UNKNOWN" contradicts the intended rule for a stable same-step failure, so acceptance criteria
should be written from the verdict table rather than from the summary.
The deterministic `pnpm test` check failed once inside the review's disposable worktree and passed
in six later runs of that worktree; the failing test could not be identified from the stored report.

## Review fixes batch B

- **M1:** Refactor verdicts include deterministic rule IDs and locations. Error matches
  force NOT EQUIVALENT / exit 1; warnings make complete evidence SUSPECT / exit 0.
  This also applies to deterministic-only reviews. Timed-out or partially scanned
  rules cannot produce a clean verdict.
- **M2:** New test failures include added failures and skipped-to-failed transitions.
  Reasons and the bounded context summary list the first few new failures, while
  `regressions` retains passed-to-failed semantics for existing reporters.
  Passed-to-skipped tests and failures at
  both revisions make otherwise complete evidence SUSPECT.
- **M3:** Package `exports`, `imports`, and `typesVersions` preserve object key order
  recursively; other package fields retain order-insensitive object comparison.
- **M4:** Enum skeletons retain implicit values, including offsets after explicit
  numeric initializers. Reordering, inserting, or removing earlier members detects
  changed values; explicitly initialized members remain order-insensitive. Unknown
  initializer expressions retain symbolic offsets and mark implicit values incomplete.
- **M5:** CodeGraph symbols use delimiter scans instead of overlapping regex
  quantifiers. Tests cover 256 KiB and 1 MiB malformed lines and best-of-five
  64-to-256 KiB scaling. The regex audit also reproduced backtracking on Unicode
  line separators in acceptance criteria and contract clauses; those patterns now
  separate whitespace from content. Configurable rule regexes remain worker-bounded.
- **K4:** `doctor --dry-run --probe` fails with an explicit UsageError before any
  diagnostics. Plain doctor and help/version also reject ignored dry-run flags;
  rules propose already rejected them and now uses the common error. Review modes
  retain their existing dry-run plans.
- **T1:** Shared `fastest` and `expectLinear` helpers filter scheduling noise using
  repeated measurements without increasing performance bounds. Eligible refactor,
  contract, and runtime adversarial tests retain their original 50–300 ms limits.
  Tests outside this batch's ownership and bounds above 1000 ms are unchanged.
  A temporary quadratic mutation of the API scanner failed the converted
  50,000-member skeleton test (best of three: 3495 ms against 300 ms); the
  unmodified scanner passed after the temporary probe files were removed.
  With a one-off synthetic 400 ms scheduling delay, the original single-sample
  test failed (518 ms) while the converted test passed at the same 300 ms bound.

## Review fixes follow-up

- **F1:** The semantic lexer skips line and block comments while retaining string,
  template, division, operator, and grouping semantics. A failed textual search
  retries without comments using the same lexer, preserving line numbers and
  source-line size limits; exact substring matches retain their existing behavior.
- **F2:** `unless`, `except`, `instead`, and `otherwise` remain similarity tokens
  and participate in negation parity, keeping opposite conditions separate.
- **F3:** Empty or truncated cache keys recover through a private, exclusive
  temporary file and atomic rename. A cross-process repair lock and recheck avoid
  overwriting an already valid key; every repair caller rereads the stored key.
- **F4:** Unreadable confirmation retries count once per original finding, while
  warnings remain deduplicated per file.
- Regression coverage reproduces all four defects, checks eight concurrent cache
  instances, and times 256 KiB comment inputs with the shared `fastest` helper.

**Second self-review, larger budget (2026-10-22).** Same range and criteria (two criteria reworded:
a stable same-step failure is not UNKNOWN, and the provider's temporary image copy is by design),
run with `budget.maxCalls: 40`, `maxMinutes: 30` on a base commit that carried that config.
It used **13 calls**: 8 triage (`agy:gemini-3.8-flash-low`) and 5 confirmation (Codex x4 including one
batch call, Claude Opus unavailable). Codex **rejected 3 findings** and the report ended with 1 BLOCKER
(`visual.ts:100`, "`fill` values in the prompt"), 1 BLOCKER pending (`compare.ts:70`, infrastructure) and
1 IMPORTANT (`compare.ts:50`, flow moved to another failing step). All three were checked against the
code and are false positives: the prompt lists the *key* `fill` (the selector) but never `value`, and a
test asserts the secret is absent; infrastructure failures make the flow `incomplete` through
`stableObservations` and end UNKNOWN (test in `runtime-hardening`); a failure that moves to another step
is `SUSPECT` by design (the verdict table). Compared with the first run (9 findings, 0 confirmations),
the larger budget let the confirmation stage do its job: the reports are shorter and every surviving
item is a single-model finding that Codex had not yet been asked about. Practical rule: for a range
split into N chunks, set `budget.maxCalls` to at least 3 x N.

## Review speed

**Open acceptance issue:** exact serial/parallel equivalence is not yet met at
retry-budget boundaries. A synthetic three-chunk run with `maxCalls: 4` and one
requested retry per chunk uses four calls and reviews two chunks serially; the
current conservative parallel admission uses three calls and reviews all three
chunks because it denies those speculative retries. Limits remain bounded, but
coverage and ledger are different. Resolving this requires choosing between
serial admission when worst-case retries/fallbacks cannot be funded and accepting
different admitted work at an exhausted budget. Do not treat the feature as
complete until that policy is settled and covered by a regression test.

The two real runs above exposed two serial bottlenecks in a seven-chunk range.
The supplied measurements report 13 model calls and 137 seconds of provider
time: eight `agy:gemini-3.8-flash-low` triage calls took 86 seconds (about 11
seconds each), and four Codex confirmations took 49 seconds, sequentially.
The remaining confirmation attempt was unavailable, as recorded above. The
repository's own `pnpm test` took 120 seconds before any model call. Total
elapsed time was about 4.5 minutes; roughly half was waiting for repository
checks. These are baseline measurements, not a measured post-change speedup.

### Scheduling and compatibility

- `budget.concurrency` is an integer from 1 through 6, default 3. Only the first
  triage attempt for each chunk can overlap. A worker claims a chunk in input
  order, stores its response and diagnostics in that chunk's slot, and claims
  another when it finishes. `Promise.allSettled` observes every worker before
  propagation of an unexpected error. A failed worker stops new claims.
- Verification and merging happen in chunk order, including calls, ledger,
  warnings, coverage, lost findings, local chunks and findings. Triage fallbacks,
  review-tier fallbacks, non-local passes over locally reviewed chunks, visual
  review, escalation, adjudication, reproduction and batch confirmation remain
  sequential. A single chunk and `concurrency: 1` use the original invocation
  path, including its retry behavior.
- The checkout baseline is captured before starting workers. Each provider
  still receives its deadline, abort signal and checkout assertion, and every
  invocation checks the checkout on completion. Checks use a separate worktree;
  their installs never belong to a review worktree or the user's checkout.
- `RunBudget.execute` synchronously reserves a call before provider execution.
  The final admission check, including shared unavailable quota groups, follows
  asynchronous model discovery/cache reads. Adapter retry reservation also has
  no await gap. Speculative first passes and their retries cannot consume the
  confirmation reserve before ordered verification establishes whether it is
  needed. Any deferred chunks continue through the ordered sequential path,
  where unused reserve is released under the existing rule. Calls already in
  flight finish after a quota error; not-yet-started calls see the unavailable
  group. These admitted calls can differ from the calls made by a serial run
  that learns of the same quota error earlier.
- Worktree creation uses a promise-chain mutex keyed by the canonical repository
  root (case-normalized on Windows). It covers validation, stale-directory
  maintenance, prune/list and add, and releases immediately after creation.
  Execution and removal are concurrent. Cleanup's prune acquires the same lock
  so it cannot prune an in-progress creation either. Failures release the lock.

Checks start as an observed promise after validated context exists. Inside that
promise, setup runs first and configured checks retain their order. By default
they overlap triage, whose prompts contain the fixed line:

```text
Deterministic checks: running concurrently; their result is not part of this prompt.
```

Before escalation or confirmation, the cascade joins the checks promise and
builds prompts with the same bounded failed-check summary as before. A failed
check adds `Deterministic checks failed after triage had started; triage ran
without that context.` Final failed-check reporting, exit-code rules and the
Status line are unchanged for the same outcomes. Infrastructure rejection is
propagated; a simultaneous cascade/check failure reports both. All exits after
checks start wait for settlement and cleanup, including context/cascade errors.

`--sequential-checks` or `budget.sequentialChecks: true` restores the original
checks-before-triage ordering and prompt text. Combine it with
`budget.concurrency: 1` for the previous schedule. Refactor still gathers its
evidence first; runtime and `--no-checks` keep their prior check behavior. The
default triage and confirmation prompts change, so the prompt-keyed cache is
cold after upgrading; cache schema and hashing are unchanged.

### Durations and verification

JSON metadata exposes `durations.checks`, `triage`, `escalation`, `confirmation`
and `total` in milliseconds. The injected clock measures elapsed wall time, not
the sum of overlapping calls. Checks include worktree creation, setup, checks
and cleanup; triage includes ordered verification and fallback passes;
escalation includes mandatory confirmation, adjudication and reproduction;
confirmation measures the later IMPORTANT batch stage. Waiting at the checks
barrier is included only in total, not in provider phases. Markdown formats
durations as `1m 12s`. The final stderr line explains the overlap, for example:

```text
quorum: done in 2m 08s (checks 2m 00s ran in parallel with triage 28s)
```

Synthetic-provider tests compare full results at concurrency 1 and 3 with
different completion orders, including invalid-output fallbacks and local
passes; exercise quota, retry/call ceilings, confirmation reserve, dirty checkout
and deadline/abort handling; and verify checks evidence, failures and cleanup.
Clock tests cover phase accounting and report formatting. The scaled benchmark
uses `tests/helpers/timing.ts`: six 50 ms chunks, best of three runs for each
setting, with parallel elapsed time below 60% of serial time. A fake Git runner
checks the mutex without Git writes, and the integration suite also creates and
cleans six real temporary worktrees concurrently.

## Suppressions (decision 27)

`quorum.suppress.json` stores reviewed false positives as `{ "suppressions": [] }`.
Each entry requires a repository-relative `file`, a 1–2000 character `quote`, and
a 10–500 character `reason`. Optional `id`, `created` and `expires` are preserved;
dates must be real ISO calendar dates. Strings reject control characters, keys
are strict, and the list is capped at 400 entries with unique IDs and normalized
file/quote fingerprints. Missing IDs use the first ten hex characters of SHA-256
over `normalizedPath + "\n" + normalizedQuote`. Expiration is inclusive through
the specified UTC date and defaults to none.

Rules and suppressions share the Git-backed trusted JSON reader: regular blobs
only, no symlinks, bounded to 8 MiB. Reviews select the trusted config commit
(merge-base, including the existing `--since` trust policy), or committed HEAD
with `--trust-head-config`. A changed suppression file yields
`quorum.suppress.json changed in this change; its new entries are not applied until merged`
with the added-fingerprint count. Invalid untrusted HEAD content never replaces
trusted entries; the note says when its count is unavailable.

After confirmation/reproduction, partition findings before computing verdicts.
Match normalized paths and whitespace/quote-style-normalized evidence using
shorter-inside-longer containment, minimum 12 characters. Ignore lines. Expired
entries warn and never match. Reproduced BLOCKERs with two distinct confirmation
families remain active with `suppression <id> ignored: reproduced BLOCKER`.
Suppressions do not affect provider prompts or cached raw results. `--no-cache`
continues to bypass cache reads/writes independently.

Markdown includes `## Suppressed (N)`; JSON includes `suppressed` findings with
`suppression: { id, reason }`, preserving the source provider, severity and
location. Active arrays alone feed counts, verdicts and SARIF. History still
receives verified suppressed findings with `suppressed: true`; rule mining
ignores those rows. Deterministic rules, refactor evidence and runtime evidence
are not suppressible code findings.

`suppress add --from <report.json> --finding <n> --reason <text> [--expires YYYY-MM-DD]`
validates a Quorum report, takes the 1-based item in findings then unconfirmed,
and writes its evidence (trimmed, whitespace collapsed, at most 400 characters)
with today's UTC `created` date. `suppress list [--from <report.json>]` reports
active/expired/unused status; `suppress remove <id>` removes an entry. Reads reject
symlinks and oversized files. Writes use atomic replacement, stable key order,
two-space indentation and a trailing newline. Commands never call providers or
commit files; duplicate fingerprints and invalid reasons are errors.

Doctor shares validation and bounded working-file reads with the commands. It
reports validity/count, expiration, and `unused suppression <id>` when the quote
is no longer in the file: changed code stops matching and findings return. It
compares working entries with the configured base's merge-base to report branch
additions. An unavailable base produces an explicit warning rather than a count.

Tests cover schema boundaries, normalized IDs/matching, trusted reads and change
notes, protected BLOCKERs, reports/counts/exit/SARIF, commands, doctor and mining.
A synthetic end-to-end `main()` test uses fake providers and fake Git: review,
add from its real JSON, reject untrusted HEAD additions, then trust the entry and
verify exit zero plus visible suppression and ledger history.

## Repository adoption (decision 28)

General review is the default when neither `--mode` nor `--spec` is supplied.
An implicit mode with `--spec` remains feature, and explicit feature still
requires a specification with detected acceptance criteria. General uses the
ordinary diff chunks and cascade with real-defect instructions, preserving the
untrusted-data boundaries and omitting the specification and criteria payloads.
An explicit general mode ignores a supplied spec. It has no criteria or bughunt
summary table. Verification, dedupe, confirmation, origin labels, rules,
suppressions, budgets, coverage and Markdown/JSON/SARIF retain the same pipeline.

`quorum init [--dry-run] [--force]` requires the repository root. It reads
package.json and lockfiles, preferring packageManager over lockfile detection
(pnpm, npm, Yarn, Bun order). Without either it proposes npm with a missing-lock
note. Yarn major 2+ or a Berry lockfile selects immutable installation. Setup
uses the manager's frozen installation; checks are existing typecheck, lint and
test scripts invoked with `run`. Build is detected but not scheduled. No
package.json produces empty setup/checks and a note. Default tiers come from
`defaultConfig()`; a test script adds `budget.checkTimeoutSeconds: 600` without
pinning the automatic call budget.

Init refuses existing configuration unless forced, appends `.quorum/` to
gitignore idempotently, and preserves its line endings. Reads/writes refuse
symlinks and non-regular files; replacement uses the existing atomic writer.
No home settings are written: the printed agy permission uses doctor's same
path normalization. A successful write runs doctor with `probe: false`, prints
diagnostics and next steps, and returns 2 if any diagnostic fails. Dry-run
prints the proposal even over an existing config, writes nothing and skips
doctor. The next steps require committing configuration and gitignore on the
base branch before reviewing, because config remains trusted at merge-base.

All twelve synthetic benchmarks now select general mode. `bench/run.mjs
--mode feature` keeps spec-based comparisons available; the original specs are
retained. Tests exercise mode selection and prompt boundaries, fake-provider
findings/coverage/SARIF/exit status, init package managers/scripts, forced and
preview runs, gitignore preservation, outside-file containment and diagnostics.
They use temporary repositories and injected diagnostics, without real provider
calls. The adoption guide documents installation, trust, permissions, cost,
reports, suppressions and the limitations of local-only review.


### 29. Sensitive second review and large Windows check trees

The first real-repository trial exposed clean triage on sensitive code, long
Windows dependency paths, slow worktree deletion, and failure names lost behind
install progress. A pure boundary-aware matcher detects sensitivity from chunk
diffs and file paths (never prompt instructions). `escalate.sensitiveSecondPass`
is a validated boolean, default true. Empty surviving triage results receive one
successful review-tier pass with normal fallback, family independence, verifier,
dedupe and prompt-keyed cache. Mandatory escalations run first; optional calls
leave the confirmation reserve intact. Budget omissions warn without making
coverage incomplete. Coverage records sensitive chunk and second-pass counts;
all successful review families are reported even when they return no findings.
When the review tier offers only the triage family (for example review is Gemini
plus Claude and the author is Claude), the pass borrows a confirm-tier model from
another family before falling back to the same family with the independence
warning; a same-family second look adds little. Plurals and the
authorize/authenticate forms count as sensitive; author and authority do not.

Checks alone may use `homedir/.quorum/wt/<8-character id>` on Windows when the
normal worktree root plus 150 exceeds 260 characters. Provider worktrees retain
their existing permission paths. Shared short roots are never swept using one
repository's registry. Directory/link checks and creation/prune serialization
remain mandatory. Cleanup uses recursive force removal, ten retries and a
five-minute deadline before Git removal; prune with `--expire now` runs even on
failure, and a late filesystem completion schedules another serialized prune.
Doctor exposes a `paths.length` warning with a Git long-path fix.

Check evidence is compacted before byte limits: progress redraws collapse,
up to 40 failure identifier lines precede the tail, and passed checks retain a
short summary. Model evidence preserves metadata while shrinking output fields;
Markdown retains exit codes and timeout labels. Dry-run payload wording reflects
the mode and only supplied documents. Tests are synthetic and call no providers.

### 30. Severity synonyms are mapped, never to BLOCKER

Supersedes the last clause of decision 21 ("it still rejects synonyms such as
high and critical"). In a trial run on a pnpm + Turbo monorepo, a Codex second pass returned one finding with a
non-canonical severity. It was dropped as malformed, the run became INCOMPLETE,
and nobody could see what the finding said. Severity parsing now trims the
label, strips one pair of brackets (`[P1]`) and accepts BLOCKER, IMPORTANT and
OPTIONAL in any case. `critical`, `high`, `major`, `medium`, `P0`, `P1` and `P2`
map to IMPORTANT. `low`, `minor`, `info`, `nit`, `trivial` and `P3` map to
OPTIONAL. No synonym maps to BLOCKER, so only an explicit BLOCKER label can make
a run exit 1, and confirmation still decides whether a finding survives. Unknown
labels are still rejected, and the rejection reason now names the value
(`invalid severity: "severe"`). The Qwen JSON schema keeps the three-value enum.

### 31. Preserve dropped model output as untrusted diagnostics

Parser drops retain provider/model, tier, purpose, zero-based chunk index (null
for responses spanning chunks), reason and best-effort file, line, severity,
trigger and impact excerpts. Only string/number fields are retained, with
newlines collapsed and each field capped at 300 characters. Fully unparseable
review responses retain the first 1000 raw characters instead. Reports cap this
separate diagnostic array at 20 entries per run. Markdown escapes it after
Unconfirmed (other reviewers), explicitly marks it NOT verified, and names the
raw file; JSON exposes `dropped`, while SARIF excludes it.

An independent per-run writer saves responses with drops atomically under
`.quorum/raw/<runId>/<n>.txt`, using existing parent symlink/junction protections,
validated run IDs and generated filenames. At most 20 files are saved, each
truncated at a UTF-8 boundary to 256 KiB. Write failures warn without changing
review decisions. This applies with --no-cache and never runs in dry-run.
Diagnostic excerpts never drive verification, dedupe, severity or exit codes.
Retry, fallback, coverage and cache staging remain unchanged: responses with
parser drops are not cached. Tests use only synthetic outputs and fake providers.
