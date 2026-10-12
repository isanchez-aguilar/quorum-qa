# Implementation Plan: Quorum (v1)

> **Document purpose:** Build-ready implementation plan for Quorum milestones M0 to M6, expanding [PLAN.md](PLAN.md) into concrete tasks, types, algorithms, test fixtures, and interfaces. PLAN.md wins on any conflict.
>
> **Provenance:** drafted by Gemini 3.1 Pro (High) through `agy`, read-only, on 2026-10-12. Claude then checked it against PLAN.md, the installed CLIs and a live probe, and corrected it. The corrections are listed in [Review corrections](#review-corrections) at the end; everything else is Gemini's draft.

---

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
  callsUsed: number;              // subscription CLIs have no per-call price; Quorum never estimates dollars
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
  status?: 'pending' | 'reproduced' | 'failed' | 'rejected' | 'unproven';
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
  3. Implement `src/cli/args.ts` to parse CLI flags (`--help`, `--version`, `--mode`, `--diff`, `--spec`, `--inventory`, `--images`, `--rules`, `--author`, `--since`, `--dry-run`, `--reproduce`) without external libraries.
  4. Implement `src/config/schema.ts` and `src/config/index.ts` loading and validating `quorum.config.json` with fallback defaults.
  5. Implement `bin/quorum.js` and `src/cli/index.ts` binding `--help` and subcommands.
  6. Add unit tests for configuration parsing and argument tokenization.
- **Files Touched:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `bin/quorum.js`, `src/types/index.ts`, `src/cli/args.ts`, `src/cli/index.ts`, `src/config/index.ts`, `src/config/schema.ts`, `tests/unit/config.test.ts`.
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
  - `writeProposedTest(worktreePath: string, relPath: string, content: string, testGlobs: string[]): Promise<string>` (returns the absolute path written)
  - `runIsolatedTest(worktreePath: string, testFile: string, config: QuorumConfig['reproduce'], runner: CommandRunner): Promise<{ timedOut: boolean; report: TestReport | null; exitCode: number }>` (runs **only** `testFile`)
  - `evaluateReproduction(report: TestReport, testFile: string, expect: string): 'assertion-failure-matching' | 'assertion-failure-other-message' | 'non-assertion-failure' | 'passed' | 'other-test-failed'`
- **Writing the proposed test safely (`writeProposedTest`), the same at head and at base:**
  1. Reject the path if it is absolute, contains `..` segments, NUL or `:` (Windows streams), or doesn't match `testGlobs`.
  2. Walk the parent directories from the worktree root down. Each one that exists must be a real directory, not a symlink or junction (`lstat`), and its `realpath` must stay inside the worktree's `realpath`. Missing ones are created one at a time with `mkdir` (not recursive), and checked again after creation.
  3. Create the file with flag `wx` (exclusive), so an existing file is never overwritten. If the file exists, the proposal is **rejected**.
  4. All of this happens before the container starts. Nothing is written outside `.quorum/worktrees/<id>/`.
- **Container contract (`isolation: "container"`):**
  - **Image:** `reproduce.image` (default `node:22-bookworm-slim`, pinned by digest at M6). Dependencies are installed in a **preparation step** that runs once per lockfile hash: same image, network **on**, only the worktree mounted, and the lockfile's own command (`pnpm install --frozen-lockfile`, `npm ci` or `yarn install --immutable`, picked by which lockfile exists). The result is cached as a volume keyed by the lockfile hash.
  - **Test step:** network **off** (`--network none`), non-root user (`--user 1000:1000`), `--read-only` root filesystem with a tmpfs `/tmp`, the worktree mounted read-write at `/work`, the dependency volume mounted read-only, `--memory` and `--pids-limit` caps, and a hard timeout (`reproduce.timeoutSeconds`, default 120) enforced by killing the container.
  - **Missing infrastructure:** no container runtime, or a failed preparation step -> status `unproven` with the reason. The severity is not changed. An infrastructure failure is never read as "not reproduced".
- **Evaluation:** `reproduced` requires `assertion-failure-matching` at head, **in `testFile` only**. For `origin: introduced`, the same file must also give `passed` at base. For `pre-existing`, the base run is skipped. Any other result -> `not-reproduced`, and the finding is downgraded to IMPORTANT with the reason.
- **Synthetic infrastructure for tests:** `tests/fixtures/repro-repo/` (a tiny vitest project with a lockfile) and a fake container runner that replays recorded `TestReport` JSON. The real-container tests run only when a runtime is present, and are skipped otherwise (never in CI without one).
- **Test Cases:**
  - `testReproduction_RealAssertionFailureKeepsBlocker`: Test fails with assertion error on head; passes on base -> Retained as BLOCKER.
  - `testReproduction_SyntaxErrorDowngrades`: Test fails with `SyntaxError: Unexpected token` -> Downgraded to IMPORTANT.
  - `testReproduction_InvalidPathRejected`: Test proposal specifies `../../foo.test.ts` or non-test file -> Rejected.
  - `testReproduction_SymlinkParentRejected`: `tests/` is a symlink (or junction) to a directory outside the worktree -> Rejected before anything is written.
  - `testReproduction_ExistingFileNotOverwritten`: The proposed path already exists at head or base -> Rejected; the file is unchanged.
  - `testReproduction_PreexistingSkipsBase`: An `origin: pre-existing` BLOCKER whose test fails at head (and also at base) -> Reproduced; base is not required to pass.
  - `testReproduction_WrongMessageDowngrades`: An assertion fails with a message that doesn't match `expect` -> Downgraded.
  - `testReproduction_OtherTestFailureIgnored`: Only an unrelated test fails -> Not reproduced (the command ran `testFile` only).
  - `testReproduction_NoRuntimeUnproven`: No container runtime -> `unproven`, severity unchanged.
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
   - **Tie-breaks, in order:** an exact match beats a fuzzy one; a local match beats a global one; a higher sim wins; then the smallest $|L_{match} - L|$; then the lower line number.
4. **Global Search (Drift Correction):**
   - If local search fails (e.g. Gemini cites line 5200 in a 600-line file), scan the entire file for the exact normalized quote.
   - If exact match is found at line $L_{global}$, correct `finding.line = L_{global}` and mark verified.
   - If no exact match, scan file for best fuzzy match with similarity $\ge 0.85$.
   - If found, correct `finding.line = L_{global}`.
   - Otherwise (best global similarity $< 0.85$), reject the finding as hallucinated.

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
| 11 | `src/pay.ts` | 15 | `total = price * (1 + TAX_RATE)` | Line 15: `total = price * (1 + TAX_RATIO)` | **VERIFIED** | 15 | Minor typo in quote (character sim ≈ 0.94 $\ge 0.85$). |
| 12 | `src/pay.ts` | 15 | `chargeCreditCard(customer, amount)` | Line 15: `let total = price * quantity;` | **REJECTED** | - | Hallucinated code (similarity $< 0.30$). |
| 13 | `src/pay.ts` | 15 | `   ` | Line 15: `let total = 0;` | **REJECTED** | - | Empty or whitespace-only quote rejected. |
| 14 | `src/ui.tsx` | 20 | `<div>\n  <span>Hello</span>\n</div>` | Line 20: `<div>\n    <span>Hello</span>\n  </div>` | **VERIFIED** | 20 | Multiline block with indentation drift normalized. |
| 15 | `src/dup.ts` | 10 | `return null;` | Lines 5, 12, 85: `return null;` | **CORRECTED** | 12 | Ambiguous quote; closest line within radius selected. |
| 16 | `src/empty.ts` | 1 | `const x = 1;` | Empty file (0 lines) | **REJECTED** | - | Cited line exceeds file bounds, quote not present. |
| 17 | `src\win\path.ts` | 5 | `export const WIN = true;` | Line 5: `export const WIN = true;` | **VERIFIED** | 5 | Windows backslash path converted to forward slash. |
| 18 | `src/t.ts` | 10 | a quote whose best match has sim 0.849 | — | **REJECTED** | - | Just below the single 0.85 threshold. |
| 19 | `src/t.ts` | 10 | a quote whose best match has sim exactly 0.85 | — | **VERIFIED** | match line | Threshold is inclusive. |
| 20 | `src/dup.ts` | 10 | `return null;` | Lines 8 and 12: `return null;` | **VERIFIED** | 8 | Equal distance; the lower line number wins. |
| 21 | `src/t.ts` | 10 | `foo();` | Line 30 exact, line 12 fuzzy 0.9 | **CORRECTED** | 12 | Local beats global, even when global is exact. |

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

| # | Finding A | Finding B | Similarity | Result | Final Sev | Final Conf | Rationale |
|---|---|---|---|---|---|---|---|
| 1 | L40, `google`, Sev: `BLOCKER`, Conf: 0.70, "Unchecked integer overflow in balance" | L42, `openai`, Sev: `IMPORTANT`, Conf: 0.65, "Integer overflow vulnerability on balance math" | 0.82 | **MERGED** | `BLOCKER` | 0.95 | Line $\Delta = 2 \le 5$, similarity $\ge 0.70$. Two families boost confidence (+0.25). Blocker priority. |
| 2 | L100, `anthropic`, Sev: `IMPORTANT`, Conf: 0.80, "Missing CSRF header check" | L101, `anthropic`, Sev: `IMPORTANT`, Conf: 0.75, "CSRF token validation omitted" | 0.78 | **MERGED** | `IMPORTANT` | 0.80 | Same family via two tools (`claude` and `agy`). Merged, but NO cross-family boost. |
| 3 | L20, `google`, Sev: `IMPORTANT`, Conf: 0.80, "SQL injection in search query" | L32, `openai`, Sev: `IMPORTANT`, Conf: 0.80, "SQL injection in search query" | 0.90 | **SEPARATE** | - | - | Line $\Delta = 12 > 5$. Proximity window exceeded; kept separate. |
| 4 | L50, `google`, Sev: `OPTIONAL`, Conf: 0.60, "Variable name typo `usre`" | L50, `openai`, Sev: `BLOCKER`, Conf: 0.90, "Null pointer dereference on user session" | 0.15 | **SEPARATE** | - | - | Identical line, but semantic similarity $< 0.70$. Distinct defects. |
| 5 | L12, `google`, Sev: `IMPORTANT`, Conf: 0.70, "Missing rate limit on login" | L14, `local`, Sev: `OPTIONAL`, Conf: 0.50, "Brute force possible without rate limit" | 0.75 | **MERGED** | `IMPORTANT` | 0.95 | Proximity and text match across `google` and `local`. Highest severity wins; boosted. |
| 6 | L80, `anthropic`, Sev: `BLOCKER`, Conf: 0.75, "Payment captured twice on retry" | L81, `google`, Sev: `BLOCKER`, Conf: 0.80, "Idempotency key missing, double charge" (Plus L82, `openai`, Sev: `BLOCKER`, Conf: 0.85) | 0.74, 0.77 | **MERGED** | `BLOCKER` | 1.00 | Three distinct families agree. Maximum consensus achieves confidence 1.00. |
| 7 | `src/a.ts` L10, `google`, "Unused variable `x`" | `src/b.ts` L10, `google`, "Unused variable `x`" | 1.00 | **SEPARATE** | - | - | Different files are partitioned into separate clusters. |
| 8 | L60, `openai`, Sev: `OPTIONAL`, Conf: 0.50, "Missing JSDoc comment on public method" | L63, `google`, Sev: `OPTIONAL`, Conf: 0.50, "Public export lacks documentation comments" | 0.71 | **MERGED** | `OPTIONAL` | 0.75 | Line $\Delta = 3 \le 5$, similarity $\ge 0.70$. Merged and boosted to 0.75. |
| 9 | L90, `google`, Sev: `IMPORTANT`, Conf: 0.70, Origin: `introduced` | L92, `anthropic`, Sev: `IMPORTANT`, Conf: 0.75, Origin: `pre-existing` | 0.85 | **MERGED** | `IMPORTANT` | 1.00 | Line within diff hunk; origin resolves to `introduced` based on git blame confirmation. |
| 10 | L15, `google`, Sev: `IMPORTANT`, Conf: 0.80, "Unclosed database client leak" | L17, `openai`, Sev: `IMPORTANT`, Conf: 0.80, "Memory leak in query cache buffer" | 0.42 | **SEPARATE** | - | - | Proximity matches ($\Delta = 2$), but text similarity (0.42) is below threshold 0.70. |

---

## 6. Cascade and Budget

### 6.1 Review Routing and Escalation Rules
1. **Pass 1: Triage Pass (Cheap & Broad)**
   - The entire diff and touched symbol context are sent to the primary model in the `triage` tier (default: `agy:gemini-3.8-flash-medium` or local `qwen`).
   - If the author family is known (e.g. `--author claude`), Quorum selects an independent triage model (`google` or `local`).
2. **Escalation Triggers (Escalate to Confirm Tier):**
   A finding escalates to the `confirm` tier (default: `codex` or `agy:claude-opus-5-5-high`) if:
   - **Rule 1 (Focus Keyword):** The finding `file`, `trigger`, or `impact` contains any keyword in `config.escalate.focus` (default: `["money", "auth", "permissions", "crypto", "billing"]`).
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
- `budget.maxCalls` (default: 12 calls per review run).
- `budget.maxMinutes` (default: 20 minutes elapsed runtime).
- If either ceiling is reached:
  1. Abort any unstarted escalation calls.
  2. Every call gets a deadline equal to the run's remaining time (retries share it). The runner kills the process tree at the deadline, and agy also gets `--print-timeout <remaining>s`. A cancelled call yields no findings and is logged as `timeout` in the ledger.
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
{"runId":"qrm-20261012-0481","timestamp":"2026-10-12T00:30:15.120Z","mode":"feature","headSha":"f4e5d6c8b9a0","baseSha":"a1b2c3d4e5f6","provider":"agy","model":"gemini-3.8-flash-medium","family":"google","rawFindingsCount":6,"verifiedFindingsCount":4,"rejectedFindingsCount":2,"durationMs":3420,"callsUsed":1,"reproducedBlockersCount":1}
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
- **`zod`** (pinned at M0): Minimal, robust TypeScript-first runtime schema validator for `quorum.config.json` parsing and LLM JSON-schema validation.

### Development Dependencies
- **`typescript`** (pinned at M0): Strict TypeScript compiler targeting modern ES2024 / Node 22 ESM.
- **`vitest`** (pinned at M0): Fast, ESM-native unit and integration test runner.
- **`@types/node`** (pinned at M0): Complete Node 22 engine type definitions.

*(No external CLI frameworks like yargs/commander; no third-party HTTP clients like axios; all process spawning, path normalization, hashing, and file I/O use Node 22 built-ins).*

---

## 11. Unknowns Requiring a Probe (ASSUMPTIONS)

Each assumption listed below represents an unverified CLI behavior or interface contract requiring an explicit probe:

1. **`[ASSUMPTION 1]` agy write and shell deny rule names:**
   - *Known:* permissions live in `~/.gemini/antigravity-cli/settings.json` under `permissions.allow` / `permissions.deny`, with entries like `read_file(<path>)`.
   - *Unknown:* the tool names for writing files and running commands in deny rules.
   - *Cheapest Probe:* read agy's own docs on permissions; no inference needed.
2. **`[ASSUMPTION 2]` claude CLI Headless Mode Flags:**
   - *Settled:* Codex's review confirmed `claude -p` and `--model` exist in the installed CLI. Use the aliases `sonnet` / `opus`, never a dated model id.
   - *Still open:* the exact flag set that keeps it read-only (allowed tools only). Check with `claude --help`; no inference needed.
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
7. **`[ASSUMPTION 7]` agy `--json-schema` and `--output-format json` shape:** record one real output during the M4 probes, and save it (scrubbed) as the golden fixture.
5. **`[ASSUMPTION 5]` Windows CMD Shim Argument Escaping:**
   - *Assumption:* Spawning `cmd.exe /d /s /c` with individual quoted arguments completely suppresses command injection when characters `& | < > ^ % !` are rejected upfront.
   - *Cheapest Probe:* Run Vitest unit tests in `tests/unit/resolver.test.ts` executing synthetic scripts with spaces, quotes, and escaped characters on Windows.

---

## 12. Questions for Isaac

1. **CLI / Package Naming:** [docs/NAMING.md](docs/NAMING.md) notes candidate names (`Quorum`, `Tribunal`, `Crosscheck`, `Veredicto`). Should we commit to package name `quorum-qa` and binary name `quorum` for the M0 `package.json` setup?
2. **Jules Exception Timing:** Jules writes to its cloud VM and cannot pin commits reliably from the installed CLI. Does Isaac agree to keep Jules completely disabled throughout v1 (as specified in M6), deferring the cloud VM AGENTS.md exception to v1.x?
3. **Default Triage Model Selection:** When local `qwen` is offline and `agy:gemini-3.8-flash-medium` is present, should Quorum default to Gemini Flash without prompting the user?
4. **CI Behavior When Container Isolation is Missing:** In non-interactive CI environments where neither Docker nor Podman is installed, PLAN.md states reproduction is skipped and labeled "unproven". Should Quorum exit with code 0 in that case, or emit an exit code 1 if unproven BLOCKERs remain?
5. **Storage Location for `.quorum`:** The plan places `.quorum/ledger.jsonl` and `.quorum/cache/` at the workspace repository root. Should `.quorum` be added to `.gitignore` automatically during M0?
6. **Settings Verification vs Auto-Config:** If `quorum doctor` finds that `agy` write-deny rules are not set, should it provide copy-paste instructions only (as stated in PLAN.md), or provide an interactive opt-in prompt to apply them?

---

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
