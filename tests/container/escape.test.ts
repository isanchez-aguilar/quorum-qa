import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveCommand } from '../../src/checks/resolver.js';
import { defaultConfig } from '../../src/config/schema.js';
import { runCommand } from '../../src/process/runner.js';
import { runIsolatedTest } from '../../src/reproduce/isolation.js';

it('slow container escape test (requires QUORUM_CONTAINER_TESTS=1 and a responding Docker daemon)', async context => {
  if (process.env.QUORUM_CONTAINER_TESTS !== '1') {
    context.skip('Slow container test disabled: set QUORUM_CONTAINER_TESTS=1 explicitly');
    return;
  }
  try {
    const docker = resolveCommand('docker', ['info']);
    const probe = await runCommand(docker.file, docker.args, { timeoutMs: 5000 });
    if (probe.exitCode !== 0) {
      context.skip('Slow container test skipped: Docker daemon did not answer');
      return;
    }
  } catch {
    context.skip('Slow container test skipped: Docker runtime unavailable');
    return;
  }
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'quorum-container-escape-'));
  try {
    await cp('tests/fixtures/repro-repo', worktree, { recursive: true });
    const result = await runIsolatedTest(worktree, 'escape.test.js', {
      ...defaultConfig().reproduce, timeoutSeconds: 120,
    }, runCommand);
    expect(result.reason).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.report?.tests).toHaveLength(2);
    expect(result.report?.tests.every(test => test.status === 'passed')).toBe(true);
    expect(result.report?.suiteErrors).toEqual([]);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}, 300000);
