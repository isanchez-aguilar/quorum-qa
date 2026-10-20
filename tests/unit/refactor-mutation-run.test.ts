import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runMutation } from '../../src/refactor/mutation.js';
import type { CommandRunner, TestReport } from '../../src/types/index.js';
import { CommandTimeoutError } from '../../src/process/runner.js';

let root: string;
const original = 'function value() { return 1; }\n';
const head: TestReport = { runner: 'vitest', suiteErrors: [], tests: [{ file: 'a.test.ts', name: 'value', status: 'passed' }] };
const output = { exitCode: 0, stdout: '', stderr: '' };
const diff = '+++ b/a.ts\n@@ -1 +1 @@\n-old\n+' + original;
const report = (status = 'passed', message = '') => JSON.stringify({ testResults: [{ name: 'a.test.ts', message,
  assertionResults: [{ title: 'value', status, failureMessages: status === 'failed' ? ['AssertionError: bad value'] : [] }] }] });
const reportPath = (args: string[]) => args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'quorum-mutation-')); await writeFile(path.join(root, 'a.ts'), original); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function options(runner: CommandRunner) {
  return { root, sources: new Map([['a.ts', original]]), diff, head, command: [process.execPath, 'fake.cjs'], runner, timeoutMs: 10000, reasons: [] as string[] };
}
it.each(['killed', 'survived', 'suite', 'missing', 'timeout', 'throw', 'exit', 'count'])('classifies %s and always restores', async kind => {
  const paths: string[] = [];
  const runner: CommandRunner = async (_command, args) => {
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).not.toBe(original);
    paths.push(reportPath(args));
    if (kind === 'timeout') throw new CommandTimeoutError('', 'timeout');
    if (kind === 'throw') throw new Error('fake failure');
    if (kind !== 'missing') await writeFile(reportPath(args), kind === 'count' ? '{"testResults":[]}' : report(kind === 'killed' ? 'failed' : 'passed', kind === 'suite' ? 'SyntaxError: bad syntax' : ''));
    return { ...output, exitCode: kind === 'exit' || kind === 'killed' ? 1 : 0 };
  };
  const result = await runMutation(options(runner));
  expect(result.attempted).toBe(2);
  expect(new Set(paths).size).toBe(2);
  expect(result.killed).toBe(kind === 'killed' ? 2 : 0);
  expect(result.survived).toHaveLength(kind === 'survived' ? 2 : 0);
  expect(result.invalid).toBe(['killed', 'survived'].includes(kind) ? 0 : 2);
  expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe(original);
});
it('aborts after a restore failure and records a verdict reason', async () => {
  let calls = 0;
  const opts = options(async () => { calls++; await rm(path.join(root, 'a.ts')); await mkdir(path.join(root, 'a.ts')); return output; });
  const result = await runMutation(opts);
  expect(result.attempted).toBe(1); expect(calls).toBe(1);
  expect(opts.reasons).toEqual(['mutation: could not restore a.ts']);
});
it('aborts on an on-disk mismatch without overwriting it', async () => {
  await writeFile(path.join(root, 'a.ts'), 'changed');
  const result = await runMutation(options(async () => { throw new Error('must not run'); }));
  expect(result.attempted).toBe(0); expect(result.skipped?.join(' ')).toContain('mismatch');
  expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('changed');
});
it.each(['failed', 'suite', 'missing'])('skips unsuitable head: %s', async kind => {
  const opts = options(async () => { throw new Error('must not run'); });
  const result = await runMutation({ ...opts, head: kind === 'missing' ? undefined : { ...head,
    tests: [{ ...head.tests[0]!, status: kind === 'failed' ? 'failed' : 'passed' }], suiteErrors: kind === 'suite' ? ['bad suite'] : [] } });
  expect(result.attempted).toBe(0); expect(result.skipped?.join(' ')).toContain(kind === 'failed' ? 'failing tests' : 'report');
});
it('stops at budget and clamps the runner timeout', async () => {
  let time = 0; let timeout = 0;
  const opts = options(async (_command, args, runnerOptions) => {
    timeout = runnerOptions!.timeoutMs!; time = 30001;
    await writeFile(reportPath(args), report()); return output;
  });
  const result = await runMutation({ ...opts, timeoutMs: 60000, budgetSeconds: 30, now: () => time });
  expect(timeout).toBe(30000); expect(result.attempted).toBe(1); expect(result.budgetExhausted).toBe(true);
});
it('excludes configured tests and non-source files and rejects outside paths', async () => {
  for (const file of ['a.ts', 'a.txt', '../escape.ts']) {
    const result = await runMutation({ ...options(async () => { throw new Error('must not run'); }),
      sources: new Map([[file, original]]), diff: diff.replace('b/a.ts', `b/${file}`), testGlobs: ['a.ts'] });
    expect(result.attempted).toBe(0);
  }
});

it('refuses a hard-linked target without writing to its other name', async () => {
  const { link } = await import('node:fs/promises');
  await link(path.join(root, 'a.ts'), path.join(root, 'linked.ts'));
  const result = await runMutation(options(async () => { throw new Error('must not run'); }));
  expect(result.attempted).toBe(0);
  expect(await readFile(path.join(root, 'linked.ts'), 'utf8')).toBe(original);
});
it('honors maxMutants and stops before the first run when the budget is exhausted', async () => {
  const opts = options(async (_command, args) => { await writeFile(reportPath(args), report()); return output; });
  expect((await runMutation({ ...opts, maxMutants: 1 })).attempted).toBe(1);
  let tick = 0;
  const result = await runMutation({ ...opts, now: () => tick++ === 0 ? 0 : 300001 });
  expect(result.attempted).toBe(0); expect(result.budgetExhausted).toBe(true); expect(result.skipped).toContain('mutation skipped: 0 mutants ran');
});
