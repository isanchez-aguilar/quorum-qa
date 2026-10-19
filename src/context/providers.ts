import type { ReviewChunk } from '../cascade/prompts.js';
import type { CommandRunner, ReviewContext } from '../types/index.js';
import { CodeGraphContextProvider } from './codegraph.js';

export interface ContextEnrichment {
  perFile: Map<string, string>;
  notes: string[];
}

export interface ContextProvider {
  name: string;
  available(repoRoot: string): Promise<boolean>;
  enrich(context: ReviewContext, chunks: ReviewChunk[], options: {
    runner: CommandRunner;
    // Remaining duration, not an absolute timestamp.
    deadlineMs: number;
  }): Promise<ContextEnrichment>;
}

export class GitContextProvider implements ContextProvider {
  readonly name = 'git';
  async available(_repoRoot: string): Promise<boolean> { return true; }
  async enrich(): Promise<ContextEnrichment> { return { perFile: new Map(), notes: [] }; }
}

export async function selectContextProvider(
  name: 'git' | 'codegraph', repoRoot: string,
  codegraph: ContextProvider = new CodeGraphContextProvider(),
): Promise<{ provider: ContextProvider; available: boolean; notes: string[] }> {
  if (name === 'git') return { provider: new GitContextProvider(), available: true, notes: [] };
  if (await codegraph.available(repoRoot)) return { provider: codegraph, available: true, notes: [] };
  return { provider: new GitContextProvider(), available: false,
    notes: ['CodeGraph context unavailable (no .codegraph index, or codegraph not on PATH); falling back to git.'] };
}
