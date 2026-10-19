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
  mode: 'feature' | 'redesign';
  diff: string;
  baseCommit: string;
  requestedBaseCommit?: string;
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
  // Required, no default. Each check is an argv array, never a shell string.
  checks: string[][];
  // An alias ("claude", "codex", "gemini", "qwen") or a Family; see resolveAuthorFamily().
  author?: string;
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
  runner: 'vitest' | 'jest';
  tests: Array<{
    // Path relative to the worktree root.
    file: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    failureKind?: 'assertion' | 'error' | 'import' | 'syntax' | 'timeout';
    // First line of the failure message, compared with `expect`.
    message?: string;
  }>;
  // Load or compile errors that prevented tests from running.
  suiteErrors: string[];
}

export type { ProviderAdapter } from '../providers/types.js';
