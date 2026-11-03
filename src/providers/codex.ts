import { canonicalPath } from '../paths.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReviewContext } from '../types/index.js';
import { createReviewWorktree, isClean } from '../worktree/index.js';
import { ProviderCommands, quotaLanguage, remaining, cleanupPreservingError, codexDiagnostics } from './commands.js';
import { ProviderError, type ProviderAdapter, type Quota, type RawProviderResult, type ReviewOptions } from './types.js';

export class CodexProvider extends ProviderCommands implements ProviderAdapter {
  readonly name = 'codex';
  readonly defaultFamily = 'openai';
  async probe(_modelId: string) {
    try { return { available: (await this.command('codex', ['--version'])).exitCode === 0 }; }
    catch (error) { return { available: false, error: String(error) }; }
  }
  async getQuota(_modelId: string): Promise<Quota> { return 'unknown'; }
  async executeReview(context: ReviewContext, _modelId: string, prompt: string, options: ReviewOptions): Promise<RawProviderResult> {
    const started = this.now();
    remaining(options, started, this.now);
    const worktree = await createReviewWorktree(context.worktreeRoot, context.headCommit, this.run, options.warn);
    let directory: string | undefined;
    let failure: unknown;
    try {
      directory = await mkdtemp(path.join(canonicalPath(tmpdir()), 'quorum-codex-'));
      const outfile = path.join(directory, 'response.txt');
      for (let attempt = 0; attempt < 2; attempt++) {
        const timeoutMs = remaining(options, started, this.now);
        const result = await this.command('codex', ['exec', '-C', worktree.path, '-s', 'read-only', '-o', outfile, '-'], worktree.path, timeoutMs, prompt)
          .finally(() => options.assertCheckoutUnchanged?.());
        let output = '';
        try { output = await readFile(outfile, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (result.exitCode !== 0 && quotaLanguage(codexDiagnostics(result.stderr, prompt))) throw new ProviderError('quota', 'codex quota exhausted or rate limited');
        const clean = await isClean(worktree.path, this.run);
        if (!clean) return { rawOutput: output, durationMs: this.now() - started, worktreeClean: false };
        if (result.exitCode === 0 && output.trim()) return { rawOutput: output, durationMs: this.now() - started, worktreeClean: true };
        if (attempt === 0 && result.exitCode !== 0 && !output.trim()) {
          remaining(options, started, this.now);
          if (options.reserveRetry && !options.reserveRetry()) throw new ProviderError('unavailable', 'Codex retry denied: review budget ceiling reached');
          continue;
        }
        throw new ProviderError('unavailable', `codex failed (${result.exitCode}); final message ${output.trim() ? 'present' : 'missing or empty'}`);
      }
      throw new ProviderError('unavailable', 'codex retry exhausted');
    } catch (error) { failure = error; throw error; }
    finally {
      try { await cleanupPreservingError(async () => { if (directory) await rm(directory, { recursive: true, force: true }); }, failure, options.warn); }
      finally { await cleanupPreservingError(worktree.cleanup, failure, options.warn); }
    }
  }
}
