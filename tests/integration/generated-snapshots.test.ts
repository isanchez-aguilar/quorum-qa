import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDependencies } from '../../src/cli/index.js';
import { runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CommandRunner } from '../../src/types/index.js';
import type { ReviewResult } from '../../src/reporters/index.js';
import { catalog, source } from '../fixtures/cascade.js';

let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const runner: CommandRunner = (command, args, options) => runCommand(command, args, { ...options, env });
async function git(...args: string[]) {
  const result = await runner('git', args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode) throw new Error(result.stderr);
  return result.stdout.trim();
}
const SNAPSHOT = 'src/__snapshots__/screen.test.tsx.snap';
const snapshotBody = 'exports[`renders`] = `<View testID="secret-snapshot-marker" />`;\n';
const config = (extra: Record<string, unknown> = {}) => ({ base: 'base', checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] },
  escalate: { focus: [], belowConfidence: 0.6 }, ...extra });

async function setup(extra: Record<string, unknown> = {}) {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'quorum-snap-')));
  await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
  await writeFile(path.join(root, 'sample.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(config(extra)));
  await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
  await git('update-ref', 'refs/remotes/origin/main', await git('rev-parse', 'HEAD'));
  await mkdir(path.join(root, 'src/__snapshots__'), { recursive: true });
  await writeFile(path.join(root, SNAPSHOT), snapshotBody);
}
beforeEach(() => { root = ''; });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function review(provider: FakeProvider, dependencies: CliDependencies = {}) {
  let out = ''; let err = '';
  const code = await main(['review', '--diff', 'base...HEAD', '--out', '.quorum/report.md', '--sarif', '.quorum/report.sarif', '--no-cache', '--json'],
    { out: text => { out += text; }, err: text => { err += text; } },
    { repoRoot: root, cacheHome: path.join(root, 'synthetic-home'), gitRunner: runner, providers: new Map([['agy', provider]]), catalog, ...dependencies });
  return { code, err, result: JSON.parse(out) as ReviewResult };
}
const fake = () => new FakeProvider('agy', 'google', runner, { flash: ['[]'], pro: ['[]'] });

describe('generated snapshots through the CLI', () => {
  it('exits 0 and stays complete for a snapshot-only diff, listing the exclusion everywhere', async () => {
    await setup();
    await git('add', '.'); await git('commit', '-m', 'snapshot only');
    const provider = fake();
    const { code, err, result } = await review(provider);
    expect(code, err).toBe(0);
    expect(provider.calls).toEqual([]);
    expect(result.coverage).toMatchObject({ complete: true, reviewedFiles: [], generatedFiles: [SNAPSHOT], truncatedHunks: [], skippedFiles: [] });
    expect(result.warnings).toContain(`${SNAPSHOT}: generated snapshot excluded from text review.`);
    expect(await readFile(path.join(root, '.quorum/report.md'), 'utf8')).toContain(`- Generated snapshots: ${SNAPSHOT} (excluded from text review)`);
    const sarif = JSON.parse(await readFile(path.join(root, '.quorum/report.sarif'), 'utf8'));
    expect(sarif.runs[0].invocations[0]).toMatchObject({ executionSuccessful: true,
      toolExecutionNotifications: [{ level: 'note', message: { text: `${SNAPSHOT}: generated snapshot excluded from text review.` } }] });
    expect(sarif.runs[0].properties.coverage.generatedFiles).toEqual([SNAPSHOT]);
  });

  it('exits 0 and stays complete for a mixed diff while sending only the code', async () => {
    await setup();
    await writeFile(path.join(root, 'sample.ts'), source);
    await git('add', '.'); await git('commit', '-m', 'code and snapshot');
    const provider = fake();
    const { code, err, result } = await review(provider);
    expect(code, err).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.prompt).not.toContain('secret-snapshot-marker');
    expect(result.coverage).toMatchObject({ complete: true, reviewedFiles: ['sample.ts'], generatedFiles: [SNAPSHOT] });
  });

  it('reviews snapshots when the trusted config sets includeSnapshots', async () => {
    await setup({ includeSnapshots: true });
    await git('add', '.'); await git('commit', '-m', 'snapshot only');
    const provider = fake();
    const { code, err, result } = await review(provider);
    expect(code, err).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.prompt).toContain('secret-snapshot-marker');
    expect(result.coverage.reviewedFiles).toEqual([SNAPSHOT]);
    expect(result.coverage.generatedFiles ?? []).toEqual([]);
  });
});
