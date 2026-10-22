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
  // Computed by the cascade from verified sources, never accepted from provider JSON.
  confirmationFamilies?: Family[];
  confirmed?: boolean;
  singleSource?: boolean;
  clause?: string;
  clauseNote?: string;
  verification_note?: string;
  reproduction?: ReproductionProposal;
  // Set by dedupe: other findings at the same place whose text overlaps but was not strong enough
  // to merge. A pointer for a human, never a reason to change severity or confidence.
  possibly_related?: Array<{ provider: string; model: string; line: number; similarity: number }>;
}

export interface CatalogEntry {
  id: string;
  provider: string;
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
    maxOutputBytes?: number;
    // Set by the cmd.exe resolver so Node does not re-quote the command line.
    windowsVerbatimArguments?: boolean;
  },
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
  refactorSummary?: string;
  contract?: import('../context/contract.js').ContractContext;
  rulesFile?: string;
  radius?: number;
  bughunt?: import('../context/bughunt.js').BughuntContext;
  providerContext?: Map<string, string>;
  contextProvider?: { requested: 'git' | 'codegraph'; available: boolean; effective: string };
  contextNotes?: string[];
  diffTruncated?: boolean;
  mode: 'feature' | 'redesign' | 'bughunt' | 'contract' | 'refactor' | 'runtime';
  diff: string;
  baseCommit: string;
  mergeBaseCommit?: string;
  requestedBaseCommit?: string;
  headCommit: string;
  worktreeRoot: string;
  touchedFiles: string[];
  specContent?: string;
  checksContext?: string;
  inventoryContent?: string;
  images?: string[];
  rulesContent?: string;
  authorFamily?: Family;
}

export interface QuorumConfig {
  runtime?: import('../runtime/config.js').RuntimeConfig;
  refactor?: { testCommand?: string[]; timeoutSeconds?: number; mutation?: { maxMutants?: number; budgetSeconds?: number } };
  context?: { provider: 'git' | 'codegraph' };
  base: string;
  // Required, no default. Each check is an argv array, never a shell string.
  checks: string[][];
  setup?: string[][];
  // An alias ("claude", "codex", "gemini", "qwen") or a Family; see resolveAuthorFamily().
  author?: string;
  tiers: Record<Tier, string[]>;
  escalate: {
    confirmImportant?: boolean;
    routes?: Record<string, string[]>;
    focus: string[];
    belowConfidence: number;
  };
  budget: {
    concurrency?: number;
    sequentialChecks?: boolean;
    maxCalls: number;
    // Set by validation from trusted config presence; absent for programmatic budgets.
    maxCallsExplicit?: boolean;
    maxMinutes: number;
    maxCallSeconds?: number;
    quotaFloorPercent: number;
  };
  reproduce: {
    allowInstallScripts?: boolean;
    isolation: 'container' | 'interactive';
    // Default node:22-bookworm-slim, pinned by digest at M6.
    image?: string;
    // Hard limit per test run. Default 120.
    timeoutSeconds?: number;
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
    model?: string;
  };
}

export interface LedgerEntry {
  runId: string;
  timestamp: string;
  mode: ReviewContext['mode'];
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
  // Calls killed at the deadline.
  timedOutCalls: number;
  // Subscription CLIs have no per-call price, so Quorum never estimates dollars.
  // Tokens are recorded only when the CLI itself reports them.
  tokensReported?: number;
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
  infrastructureError?: string;
  runner: 'vitest' | 'jest';
  // Includes suites that failed to load before producing assertions.
  suiteFiles?: string[];
  tests: Array<{
    // Path relative to the worktree root.
    file: string;
    name: string;
    ancestorTitles?: string[];
    title?: string;
    status: 'passed' | 'failed' | 'skipped';
    failureKind?: 'assertion' | 'error' | 'import' | 'syntax' | 'timeout' | 'unknown';
    failures?: Array<{ message: string; kind: 'assertion' | 'error' | 'import' | 'syntax' | 'timeout' | 'unknown' }>;
    // First line of the failure message, compared with `expect`.
    message?: string;
  }>;
  // Load or compile errors that prevented tests from running.
  suiteErrors: string[];
}

export type { ProviderAdapter } from '../providers/types.js';
