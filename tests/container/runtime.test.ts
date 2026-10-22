import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveCommand } from '../../src/checks/resolver.js';
import { validateConfig } from '../../src/config/schema.js';
import { runCommand } from '../../src/process/runner.js';
import { DEFAULT_RUNTIME_IMAGE } from '../../src/runtime/image.js';
import { runRuntimeEvidence } from '../../src/runtime/run.js';
import { compareRuntime } from '../../src/runtime/compare.js';
import { evaluateRuntimeVerdict } from '../../src/cli/runtime.js';
import { createHash } from 'node:crypto';

it('runtime container: good, console-error, http500, external and blank on disposable base/head', async test => {
  if (process.env.QUORUM_CONTAINER_TESTS !== '1') { test.skip('Set QUORUM_CONTAINER_TESTS=1 explicitly'); return; }
  try {
    for (const args of [['info'], ['image', 'inspect', DEFAULT_RUNTIME_IMAGE]]) {
      const docker = resolveCommand('docker', args);
      if ((await runCommand(docker.file, docker.args, { timeoutMs: 5000 })).exitCode !== 0) {
        test.skip('Docker and the pinned Playwright image must already be present'); return;
      }
    }
  } catch { test.skip('Docker and the pinned Playwright image must already be present'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'quorum-runtime-container-'));
  // All git writes belong to this synthetic temporary repository, never Quorum's checkout.
  async function git(args: string[]) {
    const resolved = resolveCommand('git', ['-C', root, ...args]);
    const result = await runCommand(resolved.file, resolved.args, { timeoutMs: 15000 });
    expect(result.exitCode, result.stderr).toBe(0); return result.stdout.trim();
  }
  try {
    await git(['init', '--initial-branch=runtime-fixture']);
    await git(['config', 'user.name', 'Synthetic Fixture']); await git(['config', 'user.email', 'fixture@example.test']);
    await writeFile(path.join(root, '.gitignore'), '.quorum/\nnode_modules/\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', packageManager: 'npm@11.6.2' }));
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'runtime-fixture', version: '1.0.0' } } }));
    const source = await readFile('tests/fixtures/runtime-app/server.cjs', 'utf8');
    await writeFile(path.join(root, 'server.cjs'), source);
    await git(['add', '.']); await git(['commit', '--signoff', '-m', 'Add synthetic runtime base']);
    const baseCommit = await git(['rev-parse', 'HEAD']);
    const config = validateConfig({ checks: [], budget: { maxMinutes: 10 }, runtime: {
      start: ['node', 'server.cjs'], readyUrl: 'http://127.0.0.1:4173/', readyTimeoutSeconds: 10,
      flows: [{ name: 'home', steps: [{ goto: '/' }] }],
    } });
    for (const behavior of ['good', 'console-error', 'http500', 'external', 'blank']) {
      await writeFile(path.join(root, 'server.cjs'), source.replace("|| 'good'", `|| ${JSON.stringify(behavior)}`));
      await git(['add', 'server.cjs']); await git(['commit', '--signoff', '-m', `Select ${behavior}`]);
      const headCommit = await git(['rev-parse', 'HEAD']);
      config.runtime!.flows![0]!.steps = behavior === 'good'
        ? [{ goto: '/' }, { click: 'a' }, { waitForUrl: '/about' }, { waitForSelector: 'h1' }, { press: 'body', key: 'Tab' }]
        : [{ goto: '/' }];
      const evidence = await runRuntimeEvidence({ mode: 'runtime', diff: '', baseCommit, mergeBaseCommit: baseCommit,
        headCommit, worktreeRoot: root, touchedFiles: ['server.cjs'] }, config, { root, gitRunner: runCommand, containerRunner: runCommand });
      expect(evidence.reasons, behavior).toEqual([]); expect(evidence.available, behavior).toBe(true);
      expect(evidence.base?.stable.flows.home?.size, behavior).toBe(0);
      expect(evidence.head?.report.runs.every(run => run.completed), behavior).toBe(true);
      const signatures = [...evidence.head!.stable.flows.home!];
      const comparison = compareRuntime(evidence.base!, evidence.head!, config.runtime!);
      const verdict = evaluateRuntimeVerdict(evidence, comparison, { strictFlows: false });
      const problem = ['console-error', 'http500', 'blank'].includes(behavior);
      expect(verdict.verdict, behavior).toBe(problem ? 'NEW RUNTIME PROBLEMS' : 'NO NEW RUNTIME PROBLEMS FOUND');
      expect(verdict.exitCode, behavior).toBe(problem ? 1 : 0);
      if (behavior === 'good') {
        expect(signatures).toEqual([]);
        const captured = await runRuntimeEvidence({ mode: 'runtime', diff: '', baseCommit, mergeBaseCommit: baseCommit,
          headCommit, worktreeRoot: root, touchedFiles: ['server.cjs'] }, { ...config, runtime: { ...config.runtime!, screenshots: true } },
        { root, runId: 'qrm-container-shots', gitRunner: runCommand, containerRunner: runCommand });
        expect(captured.available).toBe(true); expect(captured.reasons).toEqual([]); expect(captured.notes).toEqual([]);
        for (const side of ['base', 'head'] as const) {
          expect(captured[side]!.report).toEqual(evidence[side]!.report);
          expect(captured[side]!.stable).toEqual(evidence[side]!.stable);
          const inspected = config.runtime!.flows!.flatMap(flow => flow.steps.flatMap((step, index) =>
            ['goto', 'click', 'press', 'waitForUrl', 'waitForSelector'].some(action => Object.hasOwn(step, action)) ? [{ flow: flow.name, step: index }] : []));
          expect(captured[side]!.shots.map(({ flow, step }) => ({ flow, step }))).toEqual(inspected);
          for (const shot of captured[side]!.shots) {
            const bytes = await readFile(path.join(root, shot.path));
            expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
            expect(bytes.length).toBe(shot.bytes); expect(shot.mime).toBe('image/jpeg');
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(shot.sha256);
          }
        }
      }
      if (behavior === 'console-error') expect(signatures).toContain('console|home|boom');
      if (behavior === 'http500') expect(signatures).toContain('http|home|500 /api/data');
      if (behavior === 'blank') expect(signatures).toContain('blank|home|0|blank');
      if (behavior === 'external') for (const run of evidence.head!.report.runs) {
        expect(run.blockedExternal['example.test']).toBeGreaterThan(0);
        expect(run.observations.some(observation => observation.kind === 'requestfailed')).toBe(false);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 600000);
