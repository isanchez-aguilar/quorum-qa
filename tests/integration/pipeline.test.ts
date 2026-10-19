import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReviewContext, runCascade, validateConfig } from '../../src/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { resolveCommand } from '../../src/checks/resolver.js';
import { runCommand } from '../../src/process/runner.js';
import type { CommandRunner } from '../../src/types/index.js';
import { catalog, FakeClock, finding, source } from '../fixtures/cascade.js';

let gitPath: string | undefined;
try { gitPath = resolveCommand('git', []).file; } catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('Command not found on PATH:')) throw error;
  console.warn('Skipping pipeline integration test: git is not on PATH.');
}

describe.skipIf(!gitPath)('M3 synthetic git pipeline', () => {
  let root: string;
  let base: string;
  let head: string;
  const commands: string[] = [];
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic Author', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Author', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
  const runner: CommandRunner = (command, args, options) => {
    commands.push(command);
    return runCommand(command, args, { ...options, env });
  };
  async function git(...args: string[]): Promise<string> {
    const result = await runner(gitPath!, args, { cwd: root, timeoutMs: 10_000 });
    if (result.exitCode) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum pipeline '));
    await git('init');
    await git('config', 'commit.gpgsign', 'false');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(path.join(root, 'sample.ts'), 'export const value = 1;\n');
    await git('add', '.');
    await git('commit', '-m', 'Synthetic base');
    base = await git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'sample.ts'), source);
    await git('add', '.');
    await git('commit', '-m', 'Synthetic head');
    head = await git('rev-parse', 'HEAD');
  }, 30_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('builds context, parses, verifies, confirms and returns final findings with zero provider processes', async () => {
    const context = await buildReviewContext({ base, head, cwd: root, mode: 'feature', runner });
    const agy = new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([
      finding({ confidence: 0.5, origin: 'pre-existing' }), finding({ file: 'invented.ts' }),
    ])] });
    const codex = new FakeProvider('codex', 'openai', runner, { codex: [JSON.stringify({
      decision: 'confirm', evidence_quote: finding().evidence_quote, fix: 'Validate input before compute',
    })] });
    const config = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
    const result = await runCascade(context, config, new Map([['agy', agy], ['codex', codex]]), { gitRunner: runner, catalog, clock: new FakeClock() });
    expect(context.diff).toContain('+export const value = compute(input);');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'sample.ts', line: 1, origin: 'introduced', verified: true,
      fix: 'Validate input before compute', confidence: 0.5 });
    expect(result.unconfirmed).toEqual([]);
    expect(result.ledgerDraft[0]).toMatchObject({ rawFindingsCount: 2, verifiedFindingsCount: 1, rejectedFindingsCount: 1 });
    expect(result.calls.map(call => call.tier)).toEqual(['triage', 'confirm']);
    expect(commands.every(command => path.resolve(command) === path.resolve(gitPath!))).toBe(true);
    expect(await git('status', '--porcelain')).toBe('');
  }, 30_000);
});
