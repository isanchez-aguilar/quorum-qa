import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeGraphContextProvider, parseCallers, parseSymbols, pickTouchedSymbols } from '../../src/context/codegraph.js';
import { GitContextProvider, selectContextProvider } from '../../src/context/providers.js';
import { reviewChunks, MAX_PROMPT_CHARACTERS } from '../../src/cascade/prompts.js';
import { runCommand, CommandTimeoutError } from '../../src/process/runner.js';
import { resolveCommand } from '../../src/checks/resolver.js';
import type { CommandRunner, ReviewContext } from '../../src/types/index.js';
import { context } from '../fixtures/cascade.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const symbols = Array.from({ length: 8 }, (_, i) => ({ name: `symbol${i}`, kind: 'function', startLine: 10 + i * 10 }));
const symbolText = symbols.map(s => `- \`${s.name}\` (${s.kind}) (value: number) — :${s.startLine}`).join('\n');
const callerFixture = {
  symbol: 'symbol0', targets: [{ name: 'symbol0', kind: 'function', filePath: 'sample.ts', startLine: 10, id: 'synthetic-id', qualifiedName: 'sample.symbol0', language: 'typescript' }],
  ambiguous: false, aggregation: 'all', filteredOut: 0,
  definitions: [{ definition: { name: 'symbol0' }, roots: [], callers: [], edges: [], total: 1, limit: 5, truncated: false }],
  callers: [{ name: 'invoke', kind: 'function', filePath: 'client.ts', startLine: 12, relationships: ['CALLS'] }], total: 1, limit: 5, truncated: false,
};

it.each([
  ['- `compute` (function) — :12', 'compute', 'function', 12],
  [' - `compute` (method) (x: number): boolean — :42', 'compute', 'method', 42],
  ['\t-  `odd name`  ( function )   (x)  —   :  7  ', 'odd name', 'function', 7],
  ['-`other`(class)–:1', 'other', 'class', 1],
])('parses symbol lines: %s', (text, name, kind, startLine) => {
  expect(parseSymbols(text as string)).toEqual([{ name, kind, startLine }]);
});
it('ignores headers, group headings, hints, garbage and invalid line numbers', () => {
  expect(parseSymbols('**sample.ts** — 3 symbols\n## Functions\n> hint\ngarbage\n- `x` (function) — :0')).toEqual([]);
});
it.each([
  [5, 2, []], [5, 8, ['symbol0']], [10, 1, ['symbol0']], [15, 2, ['symbol0']],
  [19, 3, ['symbol0', 'symbol1']], [25, 0, ['symbol1']], [90, 1, ['symbol7']],
])('selects the nearest preceding symbol and symbols inside hunk %i,%i', (startLine, lineCount, names) => {
  expect(pickTouchedSymbols(symbols, [{ startLine: startLine as number, lineCount: lineCount as number }]).map(s => s.name)).toEqual(names);
});
it('deduplicates symbols selected by multiple hunks', () => {
  expect(pickTouchedSymbols(symbols, [{ startLine: 10, lineCount: 1 }, { startLine: 15, lineCount: 1 }])).toEqual([symbols[0]]);
});
it('parses the recorded callers shape and tolerates missing descriptive fields', () => {
  expect(parseCallers(JSON.stringify(callerFixture))).toEqual({ callers: [{ name: 'invoke', kind: 'function', filePath: 'client.ts', startLine: 12 }], truncated: false });
  expect(parseCallers('{"callers":[{"name":"partial"},null,{}]}').callers).toEqual([{ name: 'partial' }]);
  expect(parseCallers('{}')).toEqual({ callers: [], truncated: false });
  expect(parseCallers(JSON.stringify({ ...callerFixture, truncated: true })).truncated).toBe(true);
  expect(parseCallers('{"definitions":[{"truncated":true}]}').truncated).toBe(true);
});
it.each(['garbage', '[]', 'null', '{"callers":{}}'])('rejects unparseable callers: %s', text => {
  expect(() => parseCallers(text)).toThrow();
});

describe('CodeGraph context with synthetic index and injected runner', () => {
  let root: string;
  let provider: CodeGraphContextProvider;
  let runner: ReturnType<typeof vi.fn<CommandRunner>>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-context-'));
    await mkdir(path.join(root, '.codegraph'));
    provider = new CodeGraphContextProvider({ resolve: (_name, args) => ({ file: 'synthetic-codegraph', args }) });
    runner = vi.fn(async (_command, args) => ok(args[0] === 'node' ? symbolText : JSON.stringify(callerFixture)));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const filesContext = (files: number, lines = 90): ReviewContext => {
    const ctx = context(root);
    ctx.touchedFiles = Array.from({ length: files }, (_, i) => `file${i}.ts`);
    ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${lines} +1,${lines} @@\n+synthetic();\n`).join('');
    return ctx;
  };
  const enrich = (ctx: ReviewContext, deadlineMs = 60_000) => provider.enrich(ctx, reviewChunks(ctx).chunks, { runner, deadlineMs });

  it('queries at most five touched symbols with exact argv, root, timeout and untrusted output', async () => {
    const ctx = filesContext(1);
    const result = await enrich(ctx);
    expect(runner).toHaveBeenCalledTimes(6);
    expect(runner.mock.calls[0]).toEqual(['synthetic-codegraph', ['node', '-f', 'file0.ts', '--symbols-only', '-p', root], { cwd: root, env: undefined, timeoutMs: 10_000 }]);
    expect(runner.mock.calls[1]?.[1]).toEqual(['callers', 'symbol0', '-f', 'file0.ts', '-l', '5', '-j', '-p', root]);
    const block = result.perFile.get('file0.ts')!;
    expect(block).toContain('UNTRUSTED CONTEXT DATA');
    expect(block).toContain('Touched symbols and their callers (from CodeGraph, may be stale)');
    expect(block).toContain('"invoke" ("function"), "client.ts":12');
    expect(block).not.toContain('symbol5');
    expect(result.notes.join()).toContain('5 touched symbols');
  });
  it('caps total invocations at thirty, including node calls', async () => {
    const result = await enrich(filesContext(8));
    expect(runner).toHaveBeenCalledTimes(30);
    expect(result.perFile.size).toBe(5);
    expect(result.notes.join()).toContain('30 invocation cap');
  });
  it('discards a partially queried file when its final caller would exceed the call cap', async () => {
    const ctx = filesContext(7, 10); // Two calls per file.
    ctx.diff += filesContext(6).diff.replaceAll('file', 'large');
    ctx.touchedFiles.push(...Array.from({ length: 6 }, (_, i) => `large${i}.ts`));
    const result = await enrich(ctx);
    expect(runner).toHaveBeenCalledTimes(30);
    expect(result.perFile.has('large2.ts')).toBe(false);
  });
  it('enforces UTF-8 4 KiB/file and 16 KiB/run caps including markers', async () => {
    runner.mockImplementation(async (_cmd, args) => ok(args[0] === 'node' ? '- `one` (function) — :1' : JSON.stringify({ callers: [{ name: '雪'.repeat(6000), filePath: 'caller.ts', startLine: 1 }] })));
    const result = await enrich(filesContext(8));
    const blocks = [...result.perFile.values()];
    expect(blocks).toHaveLength(4);
    expect(blocks.every(block => Buffer.byteLength(block) <= 4096 && !block.includes('\uFFFD') && block.endsWith('END UNTRUSTED CONTEXT DATA'))).toBe(true);
    expect(blocks.reduce((sum, block) => sum + Buffer.byteLength(block), 0)).toBeLessThanOrEqual(16_384);
    expect(result.notes.join()).toMatch(/4 KiB file/);
    expect(result.notes.join()).toMatch(/16 KiB run/);
  });
  it.each(['timeout', 'failure', 'symbols', 'callers'])('omits failed file without failing review: %s', async failure => {
    runner.mockImplementation(async (_cmd, args) => {
      if (failure === 'symbols') return ok('garbage');
      if (args[0] === 'node') return ok(symbolText);
      if (failure === 'timeout') throw new CommandTimeoutError('untrusted stdout', 'private stderr');
      if (failure === 'failure') return { ...ok(), exitCode: 1 };
      return ok('invalid JSON');
    });
    const result = await enrich(filesContext(1));
    expect(result.perFile.size).toBe(0);
    expect(result.notes.join()).toMatch(/omitted/);
    expect(result.notes.join()).not.toMatch(/untrusted stdout|private stderr/);
    if (failure === 'timeout') expect(result.notes.join()).toMatch(/timed out/);
  });
  it('uses remaining run time for every call and starts no calls after the deadline', async () => {
    let now = 0;
    provider = new CodeGraphContextProvider({ resolve: (_cmd, args) => ({ file: 'fake', args }), now: () => now });
    runner.mockImplementation(async (_cmd, args) => { now += 60; return ok(args[0] === 'node' ? symbolText : JSON.stringify(callerFixture)); });
    const result = await enrich(filesContext(2), 100);
    expect(runner.mock.calls.map(call => call[2]?.timeoutMs)).toEqual([100, 40]);
    expect(result.perFile.size).toBe(0);
    expect(result.notes.join()).toMatch(/deadline/);
  });
  it('records caller truncation from both the block and notes', async () => {
    runner.mockImplementation(async (_cmd, args) => ok(args[0] === 'node' ? symbolText : JSON.stringify({ ...callerFixture, truncated: true })));
    const result = await enrich(filesContext(1));
    expect(result.perFile.get('file0.ts')).toContain('[Callers truncated]');
    expect(result.notes.join()).toContain('callers truncated');
  });
  it('discards partial context on a later caller failure and still enriches the next file', async () => {
    runner.mockImplementation(async (_cmd, args) => {
      if (args[0] === 'node') return ok(symbolText);
      if (args[1] === 'symbol1' && args[3] === 'file0.ts') throw new Error('synthetic failure');
      return ok(JSON.stringify(callerFixture));
    });
    const result = await enrich(filesContext(2));
    expect(result.perFile.has('file0.ts')).toBe(false);
    expect(result.perFile.get('file1.ts')).toContain('invoke');
    expect(result.notes.join()).toContain('omitted for file0.ts');
  });
  it('resets caps between runs on the same provider instance', async () => {
    const ctx = filesContext(7);
    const first = await enrich(ctx);
    runner.mockClear();
    const second = await enrich(ctx);
    expect(runner).toHaveBeenCalledTimes(30);
    expect(second).toEqual(first);
  });
  it('accepts a valid empty symbol list and skips binaries without queries', async () => {
    runner.mockResolvedValue(ok('**file0.ts** — 0 symbols\n> hint'));
    const ctx = filesContext(1);
    ctx.touchedFiles.push('data.bin');
    ctx.diff += 'diff --git a/data.bin b/data.bin\nBinary files a/data.bin and b/data.bin differ\n';
    const result = await enrich(ctx);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ perFile: new Map(), notes: [] });
  });
  it('falls back once when index or executable is missing, without invoking codegraph', async () => {
    await rm(path.join(root, '.codegraph'), { recursive: true });
    const absent = await selectContextProvider('codegraph', root, provider);
    expect(absent.available).toBe(false); expect(absent.provider.name).toBe('git'); expect(absent.notes).toHaveLength(1);
    await mkdir(path.join(root, '.codegraph'));
    const missing = new CodeGraphContextProvider({ env: { PATH: '' } });
    expect(await missing.available(root)).toBe(false);
    const result = await selectContextProvider('codegraph', root, missing);
    expect(result.notes).toHaveLength(1);
    expect(await result.provider.enrich(filesContext(1), [], { runner, deadlineMs: 1 })).toEqual({ perFile: new Map(), notes: [] });
    expect(runner).not.toHaveBeenCalled();
  });
  it('resolves through PATH, including the npm .cmd shim on Windows', async () => {
    const bin = path.join(root, 'bin'); await mkdir(bin);
    await writeFile(path.join(bin, 'codegraph' + (process.platform === 'win32' ? '.EXE' : '')), 'synthetic');
    expect(await new CodeGraphContextProvider({ env: { PATH: bin, PATHEXT: '.EXE' } }).available(root)).toBe(true);
    // npm installs codegraph as codegraph.cmd on Windows; the resolver runs it through cmd.exe safely.
    const shim = new CodeGraphContextProvider({ resolve: () => ({ file: 'C:\Windows\System32\cmd.exe', args: ['/d', '/s', '/c', '""C:\npm\codegraph.cmd""'], windowsVerbatimArguments: true }) });
    expect(await shim.available(root)).toBe(true);
    // A resolver that refuses (for example a cmd metacharacter in an argument) makes it unavailable, not a crash.
    const refused = new CodeGraphContextProvider({ resolve: () => { throw new Error('Disallowed command metacharacter: &'); } });
    expect(await refused.available(root)).toBe(false);
  });
  it('git is always available and does no work', async () => {
    const git = new GitContextProvider();
    expect(await git.available(root)).toBe(true);
    expect(await git.enrich()).toEqual({ perFile: new Map(), notes: [] });
    expect((await selectContextProvider('git', root, provider)).notes).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
  it('leaves git status unchanged; fake runner detects attempted writes/indexing', async () => {
    const git = async (...args: string[]) => {
      const resolved = resolveCommand('git', args, { cwd: root });
      const result = await runCommand(resolved.file, resolved.args, { cwd: root, timeoutMs: 10_000 });
      expect(result.exitCode).toBe(0); return result.stdout;
    };
    await git('init');
    await writeFile(path.join(root, 'sample.ts'), 'synthetic source\n');
    const before = await git('status', '--porcelain', '--untracked-files=all');
    runner.mockImplementation(async (_cmd, args) => {
      if (!['node', 'callers'].includes(args[0]!)) await writeFile(path.join(root, 'unexpected-write'), 'attempted write');
      return ok(args[0] === 'node' ? symbolText : JSON.stringify(callerFixture));
    });
    await enrich(filesContext(1));
    expect(await git('status', '--porcelain', '--untracked-files=all')).toBe(before);
    expect(runner.mock.calls.every(call => ['node', 'callers'].includes(call[1][0]!))).toBe(true);
  });
});

it('drops huge provider context before any diff and does not change coverage', () => {
  const ctx = context('.');
  const plain = reviewChunks(ctx);
  ctx.providerContext = new Map([['sample.ts', '"\\雪'.repeat(30_000)]]);
  const enriched = reviewChunks(ctx);
  expect(enriched.chunks).toEqual(plain.chunks);
  expect(enriched.skippedFiles).toEqual(plain.skippedFiles);
  expect(enriched.truncatedHunks).toEqual(plain.truncatedHunks);
  expect(enriched.notes).toEqual([expect.stringContaining('provider context dropped')]);
});
it('attaches only each chunk\'s files and retains valid bounded JSON', () => {
  const ctx = context('.'); ctx.mode = 'redesign';
  ctx.touchedFiles = ['a.ts', 'b.ts'];
  ctx.diff = ctx.touchedFiles.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n+${'x'.repeat(14_000)}\n`).join('');
  ctx.providerContext = new Map([['a.ts', 'UNTRUSTED first'], ['b.ts', 'UNTRUSTED second'], ['absent.ts', 'not included']]);
  const result = reviewChunks(ctx);
  expect(result.chunks).toHaveLength(2);
  for (const [index, chunk] of result.chunks.entries()) {
    expect(chunk.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARACTERS);
    const data = JSON.parse(chunk.prompt.slice(chunk.prompt.indexOf('{')));
    expect(data.providerContext).toEqual([{ file: ctx.touchedFiles[index], content: index ? 'UNTRUSTED second' : 'UNTRUSTED first' }]);
    expect(data.diff).toContain('x'.repeat(14_000));
  }
  expect(result.notes).toEqual([]);
});
