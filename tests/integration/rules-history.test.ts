import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/process/runner.js';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CommandRunner } from '../../src/types/index.js';
import { catalog, finding } from '../fixtures/cascade.js';

let root: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
  GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
const runner: CommandRunner = (command, args, options) => {
  if (!/^git(?:\.exe)?$/i.test(path.basename(command))) throw new Error('Only synthetic Git operations allowed');
  return runCommand(command, args, { ...options, env });
};
async function git(...args: string[]) {
  const result = await runner('git', args, { cwd: root, timeoutMs: 10000 });
  if (result.exitCode) throw new Error(result.stderr);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-rules-history-'));
  await git('init'); await git('config', 'commit.gpgsign', 'false'); await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.quorum/\n');
  await writeFile(path.join(root, 'sample.ts'), 'export const value = compute(input);\nexport const other = 0;\n');
  await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify({ base: 'base', checks: [],
    tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] },
    escalate: { focus: [], belowConfidence: 0.6, confirmImportant: false } }));
  await git('add', '.'); await git('commit', '-m', 'base'); await git('branch', 'base');
  await writeFile(path.join(root, 'sample.ts'), 'export const value = compute(input);\nexport const other = 1;\n');
  await git('add', '.'); await git('commit', '-m', 'head');
}, 20000);
afterEach(async () => {
  if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-rules-history-'))) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});

it.each(['local', 'points-at-change'])('persists verified %s findings visible in the final report', async kind => {
  const local = kind === 'local';
  if (local) {
    const config = JSON.parse(await readFile(path.join(root, 'quorum.config.json'), 'utf8'));
    config.tiers.triage = ['qwen'];
    await writeFile(path.join(root, 'quorum.config.json'), JSON.stringify(config));
    await git('add', '.'); await git('commit', '-m', 'local config');
  }
  const item = local ? finding({ severity: 'BLOCKER' }) : finding({ line: 2, evidence_quote: 'export const other = 1;' });
  const provider = local
    ? new FakeProvider('qwen', 'local', runner, { qwen: [JSON.stringify([item])] })
    : new FakeProvider('agy', 'google', runner, { flash: [JSON.stringify([item])] });
  let out = ''; let err = '';
  const code = await main(['review', '--mode', 'bughunt', '--diff', 'base...HEAD', '--trust-head-config', '--no-checks', '--json'],
    { out: text => { out += text; }, err: text => { err += text; } },
    { repoRoot: root, cacheHome: path.join(root, 'synthetic-home'), gitRunner: runner, catalog, providers: new Map([[provider.name, provider]]) });
  expect(code, err).toBe(local ? 2 : 0);
  const result = JSON.parse(out);
  expect(local ? result.unconfirmed : result.pointsAtChange).toMatchObject([{ verified: true }]);
  const rows = (await readFile(path.join(root, '.quorum/findings.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ runId: result.runId, family: local ? 'local' : 'google', evidence_quote: item.evidence_quote });
}, 20000);
