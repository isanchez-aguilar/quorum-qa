import type { CatalogEntry, CommandRunner, Finding, ReviewContext } from '../../src/types/index.js';
import type { Clock } from '../../src/cascade/budget.js';

export const catalog: CatalogEntry[] = [
  { provider: 'agy', id: 'flash', family: 'google', defaultTier: 'triage', quotaGroup: 'agy:google', supportsImages: true },
  { provider: 'agy', id: 'pro', family: 'google', defaultTier: 'review', quotaGroup: 'agy:google', supportsImages: true },
  { provider: 'agy', id: 'sonnet', family: 'anthropic', defaultTier: 'triage', quotaGroup: 'agy:anthropic', supportsImages: true },
  { provider: 'agy', id: 'opus', family: 'anthropic', defaultTier: 'confirm', quotaGroup: 'agy:anthropic', supportsImages: true },
  { provider: 'codex', id: 'codex', family: 'openai', defaultTier: 'confirm', quotaGroup: 'codex:openai', supportsImages: false },
  { provider: 'qwen', id: 'qwen', family: 'local', defaultTier: 'triage', quotaGroup: 'qwen:local', supportsImages: false },
  { provider: 'claude', id: 'sonnet', family: 'anthropic', defaultTier: 'review', quotaGroup: 'claude:anthropic', supportsImages: true },
];

export const source = 'export const value = compute(input);\nexport const other = load(input);\n';

export function finding(overrides: Partial<Finding> = {}): Finding {
  return { severity: 'IMPORTANT', origin: 'introduced', file: 'sample.ts', line: 1,
    trigger: 'Invalid input reaches compute', impact: 'The result is incorrect', evidence_quote: 'export const value = compute(input);',
    fix: 'Validate the input', confidence: 0.9, provider: 'untrusted', model: 'untrusted', family: 'local', ...overrides };
}

export function context(root: string): ReviewContext {
  return { worktreeRoot: root, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), mode: 'feature',
    touchedFiles: ['sample.ts'], diff: 'diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n@@ -1 +1,2 @@\n export const value = compute(input);\n+export const other = load(input);\n' };
}

// Only the Git protocol used by determineOrigin is scripted; no process is started.
export function originRunner(root: string): CommandRunner {
  return async (_command, args) => {
    let stdout = '';
    if (args.includes('--show-toplevel')) stdout = root;
    else if (args.includes('rev-parse')) stdout = 'a'.repeat(40);
    else if (args.includes('blame')) stdout = `${'a'.repeat(40)} 1 1 1\n`;
    return { stdout, stderr: '', exitCode: 0 };
  };
}

export class FakeClock implements Clock {
  time = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  get pending() { return this.timers.size; }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of this.timers) {
      if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
    }
  }
}
