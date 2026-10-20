import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildBlastRadius } from '../../src/refactor/blast.js';
import { CodeGraphContextProvider } from '../../src/context/codegraph.js';
import type { CommandRunner } from '../../src/types/index.js';
import { scanExports } from '../../src/refactor/api.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-refactor-blast-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function put(file: string, source: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), source);
}
it('finds two hops, terminates a cycle and identifies missing test dependents', async () => {
  await put('a.ts', "import './b'; export const a=1;");
  await put('b.ts', "import './a.js';");
  await put('b.test.ts', "import './b';");
  await put('c.ts', 'export const c=1;');
  const blast = await buildBlastRadius(root, ['a.ts', 'c.ts']);
  expect(blast.dependents.map(item => [item.file, item.hop, item.isTest])).toEqual([['b.ts', 1, false], ['b.test.ts', 2, true]]);
  expect(blast.withoutTests).toEqual(['c.ts']);
});
it('resolves root index imports and skips node_modules', async () => {
  await put('index.ts', 'export const a=1;');
  await put('index.test.ts', "import './';");
  await put('nested/a.ts', "import '../';");
  await put('node_modules/ignored.test.ts', "import '../index';");
  const blast = await buildBlastRadius(root, ['index.ts']);
  expect(blast.dependents.map(item => item.file)).toEqual(['index.test.ts', 'nested/a.ts']);
  expect(blast.withoutTests).toEqual([]);
});
it('uses runner suite identities to mark custom-named test dependents', async () => {
  await put('a.ts', '');
  await put('check.mts', "import './a';");
  const blast = await buildBlastRadius(root, ['a.ts'], { testFiles: ['check.mts'] });
  expect(blast.dependents[0]?.isTest).toBe(true);
  expect(blast.withoutTests).toEqual([]);
});
it('caps scanned files, bounds file size and records list truncation without losing test coverage', async () => {
  await put('a.ts', 'export const a=1;');
  await put('b.ts', "import './a';");
  await put('c.test.ts', "import './a';");
  await put('huge.ts', 'x'.repeat(65537));
  const limited = await buildBlastRadius(root, ['a.ts'], { maxDependents: 1 });
  expect(limited.dependents).toHaveLength(1);
  expect(limited.withoutTests).toEqual([]);
  expect(limited.notes.join(' ')).toContain('200 dependents');
  expect(limited.notes.join(' ')).toContain('64 KiB');
  expect(limited.incomplete).toBe(true);
  expect((await buildBlastRadius(root, ['a.ts'], { maxFiles: 1 })).notes.join(' ')).toContain('3000 files');
});
it('merges bounded untrusted CodeGraph callers without trusting them for test coverage', async () => {
  await put('a.ts', 'export const a=1;');
  await put('caller.ts', '');
  await put('stale.test.ts', '');
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify({ callers: [
      { name: 'caller', filePath: 'caller.ts' }, { name: 'stale', filePath: 'stale.test.ts' }, { name: 'outside', filePath: '../outside.ts' },
    ] }), stderr: '' };
  };
  class FakeCodeGraph extends CodeGraphContextProvider {
    override async available() { return true; }
    override resolveInvocation(args: string[]) { return { file: 'fake-codegraph', args, windowsVerbatimArguments: false }; }
  }
  const blast = await buildBlastRadius(root, ['a.ts'], {
    codegraph: { root, runner, provider: new FakeCodeGraph(), symbols: new Map([['a.ts', scanExports('export const a=1;')]]) },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 2)).toEqual(['callers', 'a']);
  expect(blast.dependents.map(item => item.file)).toEqual(['caller.ts', 'stale.test.ts']);
  expect(blast.withoutTests).toEqual(['a.ts']);
  expect(blast.notes.join(' ')).toContain('may be stale');
});
it('does not merge a CodeGraph response that crosses the 16 KiB cumulative cap', async () => {
  await put('a.ts', '');
  for (let i = 0; i < 5; i++) await put(`caller${i}.ts`, '');
  let calls = 0;
  const runner: CommandRunner = async () => ({
    exitCode: 0, stdout: JSON.stringify({ callers: [{ name: 'caller', filePath: `caller${calls++}.ts` }], padding: 'x'.repeat(3900) }), stderr: '',
  });
  class FakeCodeGraph extends CodeGraphContextProvider {
    override async available() { return true; }
    override resolveInvocation(args: string[]) { return { file: 'fake-codegraph', args, windowsVerbatimArguments: false }; }
  }
  const blast = await buildBlastRadius(root, ['a.ts'], { codegraph: {
    root, runner, provider: new FakeCodeGraph(),
    symbols: new Map(Array.from({ length: 5 }, (_, i) => [`file${i}.ts`, scanExports(`export const x${i}=1;`)])),
  } });
  expect(calls).toBe(5);
  expect(blast.dependents).toHaveLength(4);
});
