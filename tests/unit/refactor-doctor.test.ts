import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { runDoctor } from '../../src/doctor/index.js';
import type { CommandRunner } from '../../src/types/index.js';

it('doctor warns when neither test command was explicitly configured', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'quorum-refactor-doctor-'));
  const runner: CommandRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });
  try {
    for (const explicit of [false, true]) {
      const config = validateConfig({ checks: [], ...(explicit ? { refactor: { testCommand: ['node', 'run.cjs'] } } : {}) });
      const checks = await runDoctor(config, { repoRoot: root, homedir: root, env: { PATH: '' }, runner,
        fetch: async () => { throw new Error('Network forbidden'); } });
      const warning = checks.find(check => check.id === 'refactor.testCommand');
      if (explicit) expect(warning).toBeUndefined();
      else expect(warning).toMatchObject({ status: 'WARN', message: 'Refactor mode cannot find a test command.' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
