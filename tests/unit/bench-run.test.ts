import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CommandTimeoutError, runCommand } from '../../src/process/runner.js';
import type { CommandRunner } from '../../src/types/index.js';

const modulePath = '../../bench/run.mjs';
const { runBench, parseArgs } = await import(modulePath);
const empty = { findings: [], unconfirmed: [], ledgerDraft: [{ callsUsed: 2 }], errors: [] };

it('builds isolated commits, uses the CLI flags, disables setup and saves summaries', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'bench-test-'));
  let repo = '';
  const runner: CommandRunner = async (command, args, options) => {
    repo = options!.cwd!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([expect.stringMatching(/bin[\\/]quorum.js$/), 'review', '--mode', 'feature', '--spec', 'spec.md',
      '--diff', 'main...HEAD', '--json', '--no-cache', '--out', expect.stringMatching(/report.md$/)]);
    expect(options!.timeoutMs).toBe(5000);
    const config = JSON.parse(await readFile(path.join(repo, 'quorum.config.json'), 'utf8'));
    expect(config).toMatchObject({ checks: [], setup: [], context: { provider: 'git' }, tiers: { triage: ['fake'] } });
    const git = (args: string[]) => runCommand('git', args, { cwd: repo, env: options!.env });
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
    expect((await git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('2');
    expect((await git(['show', 'main:index.mjs'])).stdout).not.toBe(await readFile(path.join(repo, 'index.mjs'), 'utf8'));
    expect((await git(['diff', 'main...HEAD'])).stdout).toContain('end - 1');
    return { stdout: JSON.stringify(empty), stderr: '', exitCode: 0 };
  };
  try {
    const config = path.join(out, 'config.json');
    await writeFile(config, JSON.stringify({ tiers: { triage: ['fake'] }, setup: [['never-run']], checks: [['never-run']] }));
    const result = await runBench({ cases: ['off-by-one-pagination'], out, config, timeoutMs: 5000 }, { runner, print: () => {} });
    expect(result.totals).toMatchObject({ calls: 2, all: { TP: 0, FN: 1 }, failedRuns: 0 });
    expect(JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8')).cases).toHaveLength(1);
    expect(await readFile(path.join(out, 'summary.md'), 'utf8')).toContain('off-by-one-pagination');
    await expect(stat(repo)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(out, { recursive: true, force: true }); }
});

it('continues after crashes, malformed JSON, nonzero exits and timeouts across repeats', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'bench-test-'));
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls++;
    if (calls === 1) throw new Error('Synthetic crash');
    if (calls === 2) throw new CommandTimeoutError('', '');
    if (calls === 3) return { stdout: 'not JSON', stderr: '', exitCode: 2 };
    if (calls === 4) return { stdout: JSON.stringify({ ...empty, findings: [null] }), stderr: '', exitCode: 0 };
    return { stdout: JSON.stringify(empty), stderr: '', exitCode: calls === 5 ? 2 : 0 };
  };
  try {
    const result = await runBench({ cases: ['control-rename'], repeat: 6, out }, { runner, print: () => {} });
    expect(result.cases.map((row: { status: string }) => row.status)).toEqual(['error', 'timeout', 'error', 'error', 'error', 'ok']);
    expect(result.totals).toMatchObject({ failedRuns: 5, unknownCallRuns: 4, calls: 4 });
  } finally { await rm(out, { recursive: true, force: true }); }
});

it('dry-run invokes only the planned command and produces no output files', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'bench-test-'));
  const runner: CommandRunner = async (_command, args) => {
    expect(args).toContain('--dry-run');
    return { stdout: 'Review chunks: 1; call budget covers\nMax API Calls: 12 (auto)\n', stderr: '', exitCode: 0 };
  };
  try {
    const result = await runBench({ cases: ['control-docs'], repeat: 2, dryRun: true, out }, { runner, print: () => {} });
    expect(result.totals).toEqual({ initialCalls: 2, maxCalls: 24 });
    await expect(stat(path.join(out, 'summary.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(out, { recursive: true, force: true }); }
});

it.each([['--repeat', '0'], ['--repeat', '1.5'], ['--cases'], ['--unknown'], ['--timeout-ms', 'NaN']])('rejects bad arguments %j', (...args) => {
  expect(() => parseArgs(args)).toThrow();
});

it('rejects unknown case IDs before running commands', async () => {
  await expect(runBench({ cases: ['../outside'] })).rejects.toThrow(/selection/);
});
