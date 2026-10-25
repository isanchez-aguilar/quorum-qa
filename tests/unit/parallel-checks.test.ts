import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { review } from '../../src/cli/review.js';
import { buildReviewContext } from '../../src/context/index.js';
import { runCascade } from '../../src/cascade/index.js';
import { runDeterministicChecks } from '../../src/checks/index.js';
import { createReviewWorktree } from '../../src/worktree/index.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';
import type { ParsedFlags } from '../../src/cli/args.js';
import type { CommandRunner } from '../../src/types/index.js';
import { REVIEW_INSTRUCTIONS } from '../../src/cascade/prompts.js';
import { modeInstructions } from '../../src/modes/index.js';
import { CommandTimeoutError } from '../../src/process/runner.js';
import { runRules } from '../../src/rules/index.js';

vi.mock('../../src/context/index.js', () => ({ buildReviewContext: vi.fn() }));
vi.mock('../../src/checks/index.js', () => ({ runDeterministicChecks: vi.fn() }));
vi.mock('../../src/worktree/index.js', () => ({ createReviewWorktree: vi.fn(), isClean: async () => true }));
vi.mock('../../src/rules/index.js', () => ({ loadRulesAt: async () => [], runRules: vi.fn(async () => ({ passed: true, results: [], notes: [] })) }));
vi.mock('../../src/cascade/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/cascade/index.js')>();
  return { ...original, runCascade: vi.fn(original.runCascade) };
});

let root: string;
let trees: string[];
let cleaned: string[];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-check-speed-'));
  trees = []; cleaned = [];
  vi.mocked(buildReviewContext).mockResolvedValue({ ...context(root), mode: 'redesign' });
  vi.mocked(createReviewWorktree).mockImplementation(async () => {
    const directory = path.join(root, '.quorum', `tree${trees.length}`);
    trees.push(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'sample.ts'), source);
    return { path: directory, cleanup: async () => { cleaned.push(directory); await rm(directory, { recursive: true, force: true }); } };
  });
});
afterEach(async () => { vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });

const running = 'Deterministic checks: running concurrently; their result is not part of this prompt.';
const failed = { passed: false, results: [{ argv: ['node', 'test.cjs'], exitCode: 1, durationMs: 120_000,
  timedOut: false, timeoutMs: 120_000, stdoutTail: 'synthetic failed check', stderrTail: 'expected true' }] };
function fixture(flags: ParsedFlags = {}, budget = {}, isTTY = false, checkRunner?: CommandRunner) {
  const prompts: string[] = [];
  const triage = new FakeProvider('agy', 'google', originRunner(root), {});
  triage.executeReview = async (_ctx, _model, prompt) => {
    prompts.push(prompt);
    return { rawOutput: JSON.stringify([finding({ confidence: 0.2 })]), durationMs: 0, worktreeClean: true };
  };
  const confirmer = new FakeProvider('codex', 'openai', originRunner(root), {});
  confirmer.executeReview = async (_ctx, _model, prompt) => {
    prompts.push(prompt);
    return { rawOutput: '{"decision":"reject"}', durationMs: 0, worktreeClean: true };
  };
  const gitRunner: CommandRunner = async (command, args, options) => {
    if (args.includes('rev-parse') && !args.includes('--show-toplevel')) return { stdout: context(root).headCommit, stderr: '', exitCode: 0 };
    if (args.includes('show') && args.some(arg => arg.endsWith(':quorum.config.json'))) return {
      stdout: JSON.stringify({ setup: [['node', 'setup.cjs']], checks: [['node', 'test.cjs']], budget,
        tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } }), stderr: '', exitCode: 0,
    };
    return originRunner(options?.cwd ?? root)(command, args, options);
  };
  let out = ''; let err = ''; let time = 0;
  return { prompts, triage, confirmer, advance: (ms: number) => { time += ms; }, run: async () => {
    const code = await review({ mode: 'redesign', diff: 'base...HEAD', noCache: true, json: true, ...flags },
      { out: text => { out += text; }, err: text => { err += text; }, isTTY },
      { repoRoot: root, gitRunner, providers: new Map([['agy', triage], ['codex', confirmer]]), catalog,
        checkRunner, now: () => time, appendLedger: async () => {}, appendFindings: async () => {} });
    const result = JSON.parse(out);
    const markdown = await readFile(path.join(root, '.quorum', 'reports', `${result.runId}.md`), 'utf8');
    return { code, result, markdown, err };
  } };
}

it.each([[false, false], [true, false], [false, true], [true, true]])('prints completion only for TTY=%s or verbose=%s', async (isTTY, verbose) => {
  vi.mocked(runDeterministicChecks).mockResolvedValue({ passed: true, results: [] });
  const actual = await fixture({ verbose }, {}, isTTY).run();
  expect(actual.err.includes('quorum: done in')).toBe(isTTY || verbose);
  expect(actual.result.durations).toBeDefined();
  expect(actual.markdown).toContain('checks ');
});

it.each([false, true])('wires the configured limit into setup and checks, sequential=%s', async sequentialChecks => {
  const original = await vi.importActual<typeof import('../../src/checks/index.js')>('../../src/checks/index.js');
  vi.mocked(runDeterministicChecks).mockImplementation(original.runDeterministicChecks);
  const runner = vi.fn<CommandRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const actual = await fixture({ sequentialChecks }, { checkTimeoutSeconds: 600 }, false, runner).run();
  expect(actual.code).toBe(0);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls.map(call => call[2]?.timeoutMs)).toEqual([600_000, 600_000]);
  expect(actual.result.checks.results.map((row: { timeoutMs: number }) => row.timeoutMs)).toEqual([600_000, 600_000]);
});

it.each([false, true].flatMap(sequential => ['setup.cjs', 'test.cjs'].map(command => ({ sequential, command }))))(
  'reports an incomplete timeout in $command, sequential=$sequential', async ({ sequential, command }) => {
    const original = await vi.importActual<typeof import('../../src/checks/index.js')>('../../src/checks/index.js');
    vi.mocked(runDeterministicChecks).mockImplementation(original.runDeterministicChecks);
    const runner = vi.fn<CommandRunner>(async (_file, args) => {
      if (args.includes(command)) throw new CommandTimeoutError('', '');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const test = fixture({ sequentialChecks: sequential }, {}, false, runner);
    const actual = await test.run();
    expect(actual.code).toBe(2);
    expect(actual.result.coverage.complete).toBe(false);
    const warning = `check "node ${command}" timed out after 120s; raise budget.checkTimeoutSeconds`;
    expect(actual.result.warnings).toContain(warning);
    expect(actual.err).toContain(warning);
    expect(actual.result.checks.results.at(-1)).toMatchObject({ timedOut: true, timeoutMs: 120_000 });
    expect(actual.markdown).toContain(`node ${command}: TIMED OUT after 120s`);
    expect(actual.markdown).not.toContain('FAILED');
    expect(actual.result.warnings.join('\n')).not.toContain('checks failed');
    const prompt = test.prompts[1]!;
    expect(prompt).toContain('TIMED OUT');
    expect(prompt).not.toContain('failed');
    expect(runner).toHaveBeenCalledTimes(command === 'setup.cjs' ? 1 : 2);
  });

it('keeps exit 0 for a real failing check: it is evidence in the report, not an exit condition', async () => {
  vi.mocked(runDeterministicChecks).mockResolvedValue(failed);
  expect((await fixture().run()).code).toBe(0);
});

it.each(['BLOCKER', 'rule'] as const)('keeps exit 1 for %s even with a check timeout', async reason => {
  vi.mocked(runDeterministicChecks).mockResolvedValue({ passed: false, results: [{ ...failed.results[0]!,
    timedOut: true, timeoutMs: 120_000, stdoutTail: '', stderrTail: '' }] });
  const original = await vi.importActual<typeof import('../../src/cascade/index.js')>('../../src/cascade/index.js');
  vi.mocked(runCascade).mockImplementationOnce(async (...args) => {
    const cascade = await original.runCascade(...args);
    if (reason === 'BLOCKER') cascade.findings.push(finding({ severity: 'BLOCKER' }));
    return cascade;
  });
  if (reason === 'rule') vi.mocked(runRules).mockResolvedValueOnce({ passed: false, results: [], notes: [] });
  const actual = await fixture().run();
  expect(actual.code).toBe(1);
  expect(actual.result.coverage.complete).toBe(false);
});

it('overlaps checks with triage, joins before confirmation, and preserves failed-check status', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const parallel = fixture({ verbose: true });
  vi.mocked(runDeterministicChecks).mockImplementation(async (commands, directory) => {
    expect(directory).toBe(trees[0]);
    order.push(commands[0]![1]!);
    if (commands[0]![1] === 'setup.cjs') return { passed: true, results: [] };
    await gate;
    parallel.advance(120_000);
    return failed;
  });
  const execute = parallel.triage.executeReview.bind(parallel.triage);
  parallel.triage.executeReview = async (...args) => { order.push('triage'); release(); return execute(...args); };
  const actual = await parallel.run();
  expect(order).toEqual(['setup.cjs', 'test.cjs', 'triage']);
  expect(parallel.prompts[0]).toContain(running);
  expect(parallel.prompts[0]).not.toContain('synthetic failed check');
  expect(parallel.prompts[1]).toContain('synthetic failed check');
  expect(actual.result.warnings).toContain('Deterministic checks failed after triage had started; triage ran without that context.');
  expect(actual.result.durations.checks).toBe(120_000);
  expect(actual.result.durations.total).toBe(120_000);
  expect(actual.markdown).toContain('checks 2m 00s');
  expect(actual.err).toContain('ran in parallel with triage');
  expect(new Set(trees).size).toBe(2);
  expect(cleaned.sort()).toEqual([...trees].sort());

  const sequential = fixture({ sequentialChecks: true });
  vi.mocked(runDeterministicChecks).mockResolvedValue(failed);
  const expected = await sequential.run();
  expect(expected.result.checks).toEqual(actual.result.checks);
  expect(expected.code).toBe(actual.code);
  expect(expected.markdown.match(/\*\*Status:\*\*[^\n]+/)?.[0]).toBe(actual.markdown.match(/\*\*Status:\*\*[^\n]+/)?.[0]);
  expect(sequential.prompts[0]).toContain('synthetic failed check');
  expect(sequential.prompts[0]).toBe(REVIEW_INSTRUCTIONS + modeInstructions('redesign') + JSON.stringify({
    mode: 'redesign', diff: context(root).diff, touchedFiles: context(root).touchedFiles,
    checks: JSON.stringify([{ name: 'node test.cjs', exitCode: 1, stdout: 'synthetic failed check', stderr: 'expected true' }]),
  }));
  expect(sequential.prompts.join('')).not.toContain(running);
  expect(sequential.prompts[1]).toContain('UNTRUSTED DETERMINISTIC CHECKS');
});

it('config sequentialChecks waits for evidence, and no-checks starts no check worktree', async () => {
  let done = false;
  vi.mocked(runDeterministicChecks).mockImplementation(async () => { done = true; return failed; });
  const sequential = fixture({}, { sequentialChecks: true });
  const execute = sequential.triage.executeReview.bind(sequential.triage);
  sequential.triage.executeReview = async (...args) => { expect(done).toBe(true); return execute(...args); };
  await sequential.run();
  expect(sequential.prompts[0]).not.toContain(running);
  vi.mocked(runDeterministicChecks).mockClear();
  const without = fixture({ noChecks: true });
  expect((await without.run()).result.checks).toBeNull();
  expect(runDeterministicChecks).not.toHaveBeenCalled();
  expect(without.prompts[0]).toContain('Checks skipped (--no-checks).');
});

it.each([false, true])('reports rejected check infrastructure in sequential=%s', async sequentialChecks => {
  vi.mocked(runDeterministicChecks).mockRejectedValue(new Error('synthetic checks infrastructure'));
  await expect(fixture({ sequentialChecks }).run()).rejects.toThrow('synthetic checks infrastructure');
  expect(cleaned.sort()).toEqual([...trees].sort());
});

it('waits for check cleanup even when the cascade throws', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(runDeterministicChecks).mockImplementation(async () => { entered(); await gate; return failed; });
  vi.mocked(runCascade).mockRejectedValueOnce(new Error('synthetic cascade error'));
  let returned = false;
  const pending = fixture().run().finally(() => { returned = true; });
  const assertion = expect(pending).rejects.toThrow('synthetic cascade error');
  await started;
  expect(returned).toBe(false);
  release();
  await assertion;
  expect(cleaned.sort()).toEqual([...trees].sort());
});

it('reports both infrastructure failures after both worktrees have cleaned up', async () => {
  vi.mocked(runDeterministicChecks).mockRejectedValue(new Error('synthetic checks infrastructure'));
  vi.mocked(runCascade).mockRejectedValueOnce(new Error('synthetic cascade error'));
  await expect(fixture().run()).rejects.toThrow('synthetic cascade error; deterministic checks failed: Error: synthetic checks infrastructure');
  expect(cleaned.sort()).toEqual([...trees].sort());
});
