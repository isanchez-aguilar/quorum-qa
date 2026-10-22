import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { runDoctor } from '../../src/doctor/index.js';
import type { CommandRunner } from '../../src/types/index.js';

// Every tool "exists"; the fake runner below decides what it answers.
vi.mock('../../src/checks/resolver.js', () => ({ resolveCommand: (name: string, args: string[]) => ({ file: name, args }) }));

it('doctor checks the runtime image only when the runtime block exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum-runtime-doctor-'));
  const calls: string[][] = [];
  const runnerWith = (imagePresent: boolean, engine: 'docker' | 'none' = 'docker'): CommandRunner => async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('image')) return { stdout: '', stderr: '', exitCode: imagePresent ? 0 : 1 };
    return { stdout: '', stderr: '', exitCode: file === 'docker' && engine === 'docker' ? 0 : 1 };
  };
  const run = (runtime: boolean, runner: CommandRunner) => runDoctor(validateConfig({ checks: [], ...(runtime ? { runtime: {} } : {}) }),
    { repoRoot: root, homedir: root, env: { PATH: '' }, runner, fetch: async () => { throw new Error('Network forbidden'); } });
  try {
    expect((await run(false, runnerWith(true))).some(check => check.id === 'runtime.image')).toBe(false);
    expect((await run(true, runnerWith(true))).find(check => check.id === 'runtime.image')).toMatchObject({ status: 'PASS' });
    const missing = (await run(true, runnerWith(false))).find(check => check.id === 'runtime.image');
    expect(missing).toMatchObject({ status: 'WARN' });
    expect(missing?.fix).toContain('docker pull mcr.microsoft.com/playwright:v1.64.0-noble@sha256:');
    expect((await run(true, runnerWith(false, 'none'))).find(check => check.id === 'runtime.image')).toMatchObject({ status: 'FAIL' });
    expect(calls.some(call => call[0] === 'docker' && call.slice(1, 3).join(' ') === 'image inspect')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
