import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { USAGE } from '../../src/cli/index.js';
import { buildBughuntContext, selectWindows } from '../../src/context/bughunt.js';
import { reviewChunks, MAX_PROMPT_CHARACTERS } from '../../src/cascade/prompts.js';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, originRunner } from '../fixtures/cascade.js';

const hunk = (start: number, count = 1) => `@@ -${start},${count} +${start},${count} @@\n-old\n+new\n`;
const diff = (...hunks: string[]) => 'diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n' + hunks.join('');
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('bughunt flags', () => {
  it.each([[undefined, 40], ['0', 0], ['-7', 0], ['201', 200], ['12', 12]])('clamps radius %s to %s', (value, expected) => {
    const args = ['review', '--mode', 'bughunt', ...(value === undefined ? [] : ['--radius', value])];
    expect(parseArgs(args).flags).toMatchObject({ mode: 'bughunt', radius: expected });
  });
  it.each(['1.5', 'NaN', 'Infinity', 'foo'])('rejects invalid radius %s', value => {
    expect(() => parseArgs(['review', '--radius', value])).toThrow(/integer/);
  });
  it('documents mode and radius', () => { expect(USAGE).toContain('bughunt'); expect(USAGE).toContain('--radius <n>'); });
});

describe('unchanged HEAD windows', () => {
  it('selects both sides of one hunk', () => {
    expect(selectWindows(diff(hunk(10, 2)), 30, 3)).toEqual([{ start: 7, end: 9 }, { start: 12, end: 14 }]);
  });
  it('merges overlap without including another hunk', () => {
    expect(selectWindows(diff(hunk(10), hunk(15)), 30, 4)).toEqual([
      { start: 6, end: 9 }, { start: 11, end: 14 }, { start: 16, end: 19 },
    ]);
  });
  it('caps hunks at the start and end', () => {
    expect(selectWindows(diff(hunk(1), hunk(20)), 20, 3)).toEqual([{ start: 2, end: 4 }, { start: 17, end: 19 }]);
  });
  it('selects nothing at radius zero', () => { expect(selectWindows(diff(hunk(10)), 20, 0)).toEqual([]); });
  it('clamps a hunk beyond HEAD to the file end', () => {
    expect(selectWindows(diff(hunk(50)), 20, 3)).toEqual([{ start: 18, end: 20 }]);
  });
  it('handles a zero-length deletion hunk between HEAD lines', () => {
    expect(selectWindows(diff(hunk(10, 0)), 20, 2)).toEqual([{ start: 9, end: 12 }]);
  });
  it('numbers real lines and labels the orientation hunk', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    await writeFile(path.join(root, 'sample.ts'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 2, diff: diff(hunk(10)) };
    ctx.bughunt = await buildBughuntContext(ctx, root);
    const payload = reviewChunks(ctx);
    expect(payload.chunks[0]?.prompt).toContain('0008: line 8');
    expect(payload.chunks[0]?.prompt).toContain('the change, for orientation only');
    expect(payload.chunks[0]?.prompt).toContain('UNCHANGED');
    expect(payload.chunks.flatMap(chunk => chunk.windows ?? [])).toEqual([
      { file: 'sample.ts', start: 8, end: 9 }, { file: 'sample.ts', start: 11, end: 12 },
    ]);
  });
  it('skips deleted and binary files with notes', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    const ctx = { ...context(root), mode: 'bughunt' as const, diff: diff(hunk(1)) + '\ndiff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n', touchedFiles: ['sample.ts', 'image.bin'] };
    const selection = await buildBughuntContext(ctx, root);
    expect(selection.skippedFiles).toContain('sample.ts');
    expect(selection.binaryFiles).toEqual(['image.bin']);
    expect(selection.notes.join(' ')).toMatch(/sample.ts.*no HEAD version/);
  });
  it('splits many windows only at boundaries and preserves all lines', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    await writeFile(path.join(root, 'sample.ts'), Array.from({ length: 120 }, (_, i) => `line ${i + 1} ${'x'.repeat(1000)}`).join('\n'));
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 2, diff: diff(...[10, 30, 50, 70, 90, 110].map(n => hunk(n))) };
    ctx.bughunt = await buildBughuntContext(ctx, root);
    const payload = reviewChunks(ctx);
    expect(payload.chunks.length).toBeGreaterThan(1);
    expect(payload.chunks.every(chunk => chunk.prompt.length <= MAX_PROMPT_CHARACTERS)).toBe(true);
    expect(payload.chunks.flatMap(chunk => chunk.windows ?? [])).toEqual(ctx.bughunt.windows.map(({ file, start, end }) => ({ file, start, end })));
    expect(payload.skippedFiles).toEqual([]);
    expect(payload.chunks.map(chunk => chunk.prompt).join('')).not.toContain('[... truncated ...]');
  });
  it('drops optional provider context before sacrificing windows', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    await writeFile(path.join(root, 'sample.ts'), 'first\nchanged\nlast\n');
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 1, diff: diff(hunk(2)) };
    ctx.bughunt = await buildBughuntContext(ctx, root);
    const plain = reviewChunks(ctx);
    ctx.providerContext = new Map([['sample.ts', 'oversized'.repeat(10_000)]]);
    const enriched = reviewChunks(ctx);
    expect(enriched.chunks).toEqual(plain.chunks);
    expect(enriched.notes.join()).toContain('provider context dropped');
  });
  it('skips an oversized atomic window whole without splitting lines', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    await writeFile(path.join(root, 'sample.ts'), `${'x'.repeat(25_000)}\nchanged\nlast\n`);
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 1, diff: diff(hunk(2)) };
    ctx.bughunt = await buildBughuntContext(ctx, root);
    const payload = reviewChunks(ctx);
    expect(payload.skippedFiles).toEqual(['sample.ts']);
    expect(payload.chunks.flatMap(chunk => chunk.windows ?? [])).toEqual([{ file: 'sample.ts', start: 3, end: 3 }]);
    expect(payload.notes.join()).toContain('whole window skipped');
    expect(payload.chunks[0]?.prompt).not.toContain('x'.repeat(100));
  });
  it('keeps inline diff truncation visible even without a context flag', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    await writeFile(path.join(root, 'sample.ts'), 'first\nchanged\nlast\n');
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 1, diff: diff(hunk(2)) + '\n[Quorum: diff truncated at 512 KiB]\n' };
    ctx.bughunt = await buildBughuntContext(ctx, root);
    expect(reviewChunks(ctx).truncatedHunks).toEqual([{ file: 'sample.ts', hunk: 1 }]);
  });
  it('tracks partial non-local coverage per window when one file spans chunks', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 1,
      bughunt: { windows: Array.from({ length: 4 }, (_, i) => ({ file: 'sample.ts', start: i * 3 + 1, end: i * 3 + 1, content: 'x'.repeat(8000), orientation: '@@ -2 +2 @@\n-old\n+new' })), skippedFiles: [], binaryFiles: [], notes: [] } };
    const chunks = reviewChunks(ctx).chunks;
    expect(chunks).toHaveLength(2);
    const local = new FakeProvider('qwen', 'local', originRunner(root), { qwen: ['[]', '[]'] });
    const remote = new FakeProvider('agy', 'google', originRunner(root), { pro: ['[]'] });
    const config = validateConfig({ checks: [], budget: { maxCalls: 3 }, tiers: { triage: ['qwen'], review: ['agy:pro'], confirm: [], visual: [] } });
    const result = await runCascade(ctx, config, new Map([['qwen', local], ['agy', remote]]), { catalog, gitRunner: originRunner(root) });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reviewedWindows).toEqual(chunks[0]?.windows);
    expect(result.coverage.skippedWindows).toEqual(chunks[1]?.windows);
  });
});
