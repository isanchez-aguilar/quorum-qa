import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/index.js';
import { createReviewWorktree } from '../../src/worktree/index.js';
import type { CommandRunner } from '../../src/types/index.js';
import type { Observation } from '../../src/runtime/report.js';
import { createHash } from 'node:crypto';
import { FakeProvider } from '../../src/providers/fake.js';
import type { CatalogEntry } from '../../src/types/index.js';

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

async function execute(behavior: string, flags: string[] = [], screenshots = false, families = 0) {
  let out = ''; let err = ''; let runs = 0;
  const forbidden = vi.fn(async () => { throw new Error('must not run'); });
  const gitRunner: CommandRunner = async (_file, args) => {
    expect(args).not.toContain('worktree');
    let stdout = '';
    if (args.includes('rev-parse') || args.includes('merge-base')) stdout = args.includes('--show-toplevel') ? root : 'a'.repeat(40);
    if (args.includes('show') && args.some(arg => arg.endsWith(':quorum.config.json'))) stdout = JSON.stringify({ checks: [], tiers: { visual: ['agy:gemini-4-argon-high', 'claude:sonnet'] }, runtime: {
      start: ['node', 'server.cjs'], readyUrl: 'http://localhost:4173/', screenshots,
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
    const data = Buffer.from([255, 216, 255, 1]);
    const shot = { flow: 'home', step: 0, mime: 'image/jpeg', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
    return { ...result, stdout: (screenshots || flags.includes('--visual') ? args.at(-2)! + 'IMG ' + JSON.stringify(shot) + '\n' : '') + args.at(-2)! + JSON.stringify(payload) };
  };
  const finding = JSON.stringify([{ file: 'home/0', line: 1, severity: 'IMPORTANT', confidence: 0.9,
    trigger: 'layout-break', impact: 'overlapping boxes and missing primary button', evidence_quote: 'boxes', fix: 'restore layout' }]);
  const providers = new Map([
    ['agy', new FakeProvider('agy', 'google', forbidden, { 'gemini-4-argon-high': [finding] })],
    ['claude', new FakeProvider('claude', 'anthropic', forbidden, { sonnet: [finding] })],
  ].slice(0, families) as Array<[string, FakeProvider]>);
  const catalog: CatalogEntry[] = [{ provider: 'agy', id: 'gemini-4-argon-high', family: 'google', defaultTier: 'visual', quotaGroup: 'google', supportsImages: true },
    { provider: 'claude', id: 'sonnet', family: 'anthropic', defaultTier: 'visual', quotaGroup: 'anthropic', supportsImages: true }];
  for (const provider of providers.values()) {
    vi.spyOn(provider, 'getQuota'); vi.spyOn(provider, 'probe');
  }
  const code = await main(['review', '--mode', 'runtime', '--diff', 'main...HEAD', '--out', 'runtime.md', '--sarif', 'runtime.sarif', ...flags], {
    out: text => { out += text; }, err: text => { err += text; },
  }, { repoRoot: root, gitRunner, containerRunner, checkRunner: forbidden, contextRunner: forbidden, fetch: forbidden,
    appendLedger: forbidden, appendFindings: forbidden, get providers() { if (families === -1) throw new Error('PRIVATE_VALUE'); return providers; }, catalog });
  expect(forbidden).not.toHaveBeenCalled();
  expect(out + err).not.toContain('PRIVATE_VALUE');
  return { code, out, err, providers, runs };
}
it.each([1, 2])('reviews layout-break through main with %i fake families', async families => {
  const result = await execute('layout-break', ['--visual', '--json'], false, families);
  expect(result.code, result.err).toBe(0);
  const json = JSON.parse(result.out);
  expect(json.runtime.verdict).toBe(families === 2 ? 'SUSPECT' : 'NO NEW RUNTIME PROBLEMS FOUND');
  expect(json.runtime.visual.calls).toBe(families); expect(json.runtime.shots).toHaveLength(2);
  expect(await readFile(path.join(root, 'runtime.md'), 'utf8')).toContain('## Visual review (advisory)');
  expect(result.err).toContain('agy'); expect(result.err).toContain('google');
});
it('prints visual maxima and recipients without running anything', async () => {
  const result = await execute('layout-break', ['--visual', '--dry-run'], false, 2);
  expect(result.code, result.err).toBe(0); expect(result.runs).toBe(0);
  expect(result.out).toContain('Maximum model calls: 2'); expect(result.out).toContain('Maximum images:');
  expect(result.out).toContain('Allowed families:'); expect(result.out).toContain('agy');
  for (const provider of result.providers.values()) {
    expect(provider.calls).toHaveLength(0); expect(provider.getQuota).not.toHaveBeenCalled(); expect(provider.probe).not.toHaveBeenCalled();
  }
});
it('degrades to a note without image-capable providers', async () => {
  const result = await execute('good', ['--visual', '--json']);
  expect(result.code, result.err).toBe(0);
  expect(JSON.parse(result.out).runtime.notes.join(' ')).toContain('visual review unavailable');
});
it('keeps deterministic output when provider construction throws', async () => {
  const result = await execute('good', ['--visual', '--json'], false, -1);
  expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out).runtime.visual.notes).toContain('visual review unavailable: provider initialization failed');
});
it('never accesses providers without visual, including when screenshots are enabled', async () => {
  expect((await execute('good', ['--json'], true, -1)).code).toBe(0);
});
it.each([['review', '--mode', 'feature'], ['review', '--mode', 'refactor'], ['doctor']])('rejects visual outside runtime: %j', async (...args) => {
  let err = '';
  expect(await main([...args, '--visual'], { out: () => {}, err: text => { err += text; } })).toBe(2);
  expect(err).toContain('--visual requires runtime mode.');
});
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
  const { shots: _shots, ...deterministic } = json.runtime;
  expect(JSON.parse(sarif).runs[0].properties.runtime).toEqual(deterministic);
  if (behavior === 'external') { expect(markdown).toContain('example.test: 4'); expect(json.runtime.comparison.newAtHead).toEqual([]); }
  expect(result.err).not.toContain('comparison and verdict arrive');
});
it('uses the review run id for screenshots and keeps SARIF and model summary unchanged', async () => {
  const result = await execute('good', ['--json'], true); expect(result.code).toBe(0);
  const json = JSON.parse(result.out);
  expect(json.runtime.shots).toHaveLength(2);
  for (const shot of json.runtime.shots) {
    expect(shot.path).toBe(`.quorum/runtime-shots/${json.runId}/${shot.side}/01-home-0.jpg`);
    expect(await readFile(path.join(root, shot.path))).toEqual(Buffer.from([255, 216, 255, 1]));
  }
  expect(await readFile(path.join(root, 'runtime.sarif'), 'utf8')).not.toContain('runtime-shots');
  expect(json.runtime.summary).not.toContain('shots');
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
