import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import { createReviewWorktree } from '../../src/worktree/index.js';
import type { CommandRunner } from '../../src/types/index.js';
import type { Observation } from '../../src/runtime/report.js';

vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: vi.fn() }));
vi.mock('../../src/checks/resolver.js', () => ({ resolveCommand: (file: string, args: string[]) => ({ file, args }) }));
let root: string; let trees: number;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'quorum-runtime-cli-r3-')); trees = 0;
  vi.mocked(createReviewWorktree).mockReset().mockImplementation(async () => {
    const directory = path.join(root, `tree-${trees++}`); await mkdir(directory);
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ packageManager: 'npm@11.0.0' }));
    await writeFile(path.join(directory, 'package-lock.json'), '{}');
    return { path: directory, cleanup: async () => { await rm(directory, { recursive: true, force: true }); } };
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function execute(behavior: string, flags: string[] = []) {
  let out = ''; let err = ''; let runs = 0;
  const forbidden = vi.fn(async () => { throw new Error('must not run'); });
  const gitRunner: CommandRunner = async (_file, args) => {
    expect(args).not.toContain('worktree');
    let stdout = '';
    if (args.includes('rev-parse') || args.includes('merge-base')) stdout = args.includes('--show-toplevel') ? root : 'a'.repeat(40);
    if (args.includes('show') && args.some(arg => arg.endsWith(':quorum.config.json'))) stdout = JSON.stringify({ checks: [], runtime: {
      start: ['node', 'server.cjs'], readyUrl: 'http://localhost:4173/',
      flows: [{ name: 'home', steps: [{ goto: '/' }, { fill: 'input', value: 'PRIVATE_VALUE' }] }],
    } });
    return { stdout, stderr: '', exitCode: 0 };
  };
  const containerRunner: CommandRunner = async (_file, args) => {
    const result = { stdout: '', stderr: '', exitCode: 0 };
    if (!args.includes('/quorum/bin/runner.cjs')) return result;
    const mode = runs++ === 0 ? 'good' : behavior;
    const observations: Observation[] = mode === 'console-error' ? [{ kind: 'console', message: 'boom PRIVATE_VALUE', path: '/' }]
      : mode === 'http500' ? [{ kind: 'http', message: '500', status: 500, resourceType: 'fetch', path: '/api/data' }]
      : mode === 'blank' ? [{ kind: 'blank', step: 0, message: 'blank' }]
      : mode === 'broken' ? [{ kind: 'flow-failure', step: 1, message: 'selector missing', errorClass: 'selector' }] : [];
    const payload = mode === 'not-ready' ? { error: 'not-ready', stderrTail: 'PRIVATE_VALUE' }
      : { version: 1, runs: [1, 2].map(run => ({ flow: 'home', run, completed: mode !== 'broken', observations,
        blockedExternal: mode === 'external' ? { 'example.test': 2 } : {}, notes: [],
      })) };
    return { ...result, stdout: args.at(-2)! + JSON.stringify(payload) };
  };
  const code = await main(['review', '--mode', 'runtime', '--diff', 'main...HEAD', '--out', 'runtime.md', '--sarif', 'runtime.sarif', ...flags], {
    out: text => { out += text; }, err: text => { err += text; },
  }, { repoRoot: root, gitRunner, containerRunner, checkRunner: forbidden, contextRunner: forbidden, fetch: forbidden,
    appendLedger: forbidden, appendFindings: forbidden, providers: new Map() });
  expect(forbidden).not.toHaveBeenCalled();
  expect(out + err).not.toContain('PRIVATE_VALUE');
  return { code, out, err };
}
it.each([
  ['good', 0, 'NO NEW RUNTIME PROBLEMS FOUND'], ['console-error', 1, 'NEW RUNTIME PROBLEMS'],
  ['http500', 1, 'NEW RUNTIME PROBLEMS'], ['blank', 1, 'NEW RUNTIME PROBLEMS'],
  ['external', 0, 'NO NEW RUNTIME PROBLEMS FOUND'], ['not-ready', 2, 'UNKNOWN'],
] as const)('compares good base to %s through main with fake containers', async (behavior, code, verdict) => {
  const result = await execute(behavior, ['--format', 'json']);
  expect(result.code, result.err).toBe(code);
  const json = JSON.parse(result.out); expect(json.runtime.verdict).toBe(verdict); expect(json.exitCode).toBe(code);
  const markdown = await readFile(path.join(root, 'runtime.md'), 'utf8'); expect(markdown).toContain(verdict);
  const sarif = await readFile(path.join(root, 'runtime.sarif'), 'utf8'); expect(sarif).not.toContain('PRIVATE_VALUE');
  expect(JSON.parse(sarif).runs[0].properties.runtime).toEqual(json.runtime);
  if (behavior === 'external') { expect(markdown).toContain('example.test: 4'); expect(json.runtime.comparison.newAtHead).toEqual([]); }
  expect(result.err).not.toContain('comparison and verdict arrive');
});
it('prints Markdown and changes broken-flow verdict with strict-flows', async () => {
  expect(await execute('broken')).toMatchObject({ code: 0, out: expect.stringContaining('SUSPECT') });
  expect(await execute('broken', ['--strict-flows', '--json'])).toMatchObject({ code: 1, out: expect.stringContaining('NEW RUNTIME PROBLEMS') });
});
it.each([['review', '--mode', 'feature'], ['review', '--mode', 'refactor'], ['doctor']])('rejects strict-flows outside runtime: %j', async (...args) => {
  let err = '';
  expect(await main([...args, '--strict-flows'], { out: () => {}, err: text => { err += text; } }, {
    runDoctor: async () => { throw new Error('must not call doctor'); },
  })).toBe(2);
  expect(err).toContain('--strict-flows requires runtime mode.');
});
