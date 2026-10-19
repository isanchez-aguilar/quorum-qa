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

const hunk = (start: number, count = 1) => `@@ -${start},${count} +${start},${count} @@\n${Array.from({ length: count }, () => "-old\n+new\n").join("") || "-old\n"}`;
const diff = (...hunks: string[]) => 'diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n' + hunks.join('');
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('bughunt flags', () => {
  it.each([[undefined, 40], ['0', 1], ['-7', 1], ['201', 200], ['12', 12]])('clamps radius %s to %s', (value, expected) => {
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
  it('clamps selector radius zero to one', () => { expect(selectWindows(diff(hunk(10)), 20, 0)).toEqual([{ start: 9, end: 9 }, { start: 11, end: 11 }]); });
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
  it('skips an oversized single line without splitting it', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
    await writeFile(path.join(root, 'sample.ts'), `${'x'.repeat(25_000)}\nchanged\nlast\n`);
    const ctx = { ...context(root), mode: 'bughunt' as const, radius: 1, diff: diff(hunk(2)) };
    ctx.bughunt = await buildBughuntContext(ctx, root);
    const payload = reviewChunks(ctx);
    expect(payload.skippedFiles).toEqual(['sample.ts']);
    expect(payload.chunks.flatMap(chunk => chunk.windows ?? [])).toEqual([{ file: 'sample.ts', start: 3, end: 3 }]);
    expect(payload.notes.join()).toContain('single line skipped');
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

it('retains unified context between nearby edits', () => {
 expect(selectWindows(diff('@@ -1,7 +1,7 @@\n before\n-old\n+new\n one\n two\n three\n-old2\n+new2\n after\n'), 7, 3)).toEqual([{start:1,end:1},{start:3,end:5},{start:7,end:7}]);
});
it('anchors pure deletions within unified context', () => {
 expect(selectWindows(diff('@@ -1,5 +1,4 @@\n first\n second\n-deleted\n third\n fourth\n'),4,1)).toEqual([{start:2,end:3}]);
});
it('splits 401 whole lines after truncating orientation', () => {
 const ctx = {...context('unused'), mode:'bughunt' as const, bughunt:{windows:[{file:'sample.ts',start:1,end:401,content:Array.from({length:401},(_,i)=>String(i+1).padStart(4,'0')+': '+'x'.repeat(100)).join('\n'),orientation:'change'.repeat(10000)}],skippedFiles:[],binaryFiles:[],notes:[]}};
 const result=reviewChunks(ctx);
 expect(result.chunks.length).toBeGreaterThan(1);
 expect(result.chunks.every(c=>c.prompt.length<=MAX_PROMPT_CHARACTERS)).toBe(true);
 expect(result.chunks.flatMap(c=>c.windows??[]).flatMap(w=>Array.from({length:w.end-w.start+1},(_,i)=>w.start+i))).toEqual(Array.from({length:401},(_,i)=>i+1));
 expect(result.chunks.map(c=>c.prompt).join('')).toContain('[... truncated ...]');
 expect(result.truncatedHunks).toEqual([]); expect(result.skippedFiles).toEqual([]);
});
it('records a single oversized line', () => {
 const ctx={...context('unused'),mode:'bughunt' as const,bughunt:{windows:[{file:'sample.ts',start:7,end:7,content:'x'.repeat(25000),orientation:''}],skippedFiles:[],binaryFiles:[],notes:[]}};
 expect(reviewChunks(ctx).truncatedHunks).toEqual([{file:'sample.ts',hunk:7}]);
});
it('does not count deleted files as missing coverage', async () => {
 root=await mkdtemp(path.join(tmpdir(),'quorum-bughunt-'));
 const ctx={...context(root),mode:'bughunt' as const,diff:'diff --git a/sample.ts b/sample.ts\ndeleted file mode 100644\n--- a/sample.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n'};
 const result=await buildBughuntContext(ctx,root);
 expect(result.skippedFiles).toEqual([]); expect(result.notes.join()).toContain('deleted at head: nothing to hunt');
});

it('counts all sub-windows as complete after successful remote review', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
  const ctx = { ...context(root), mode: 'bughunt' as const, bughunt: { windows: [{ file: 'sample.ts', start: 1, end: 401,
    content: Array.from({ length: 401 }, () => 'x'.repeat(100)).join('\n'), orientation: 'change'.repeat(10000) }], skippedFiles: [], binaryFiles: [], notes: [] } };
  const fake = new FakeProvider('agy', 'google', originRunner(root), { flash: Array(10).fill('[]') });
  const config = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] } });
  const result = await runCascade(ctx, config, new Map([['agy', fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.coverage.complete).toBe(true); expect(result.coverage.skippedWindows).toEqual([]);
});
it('verifies multiline numbered evidence in the review tier', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-bughunt-'));
  await writeFile(path.join(root, 'sample.ts'), 'const first = read(input);\nconst second = consume(first);\n');
  const ctx = { ...context(root), mode: 'bughunt' as const, bughunt: { windows: [{ file: 'sample.ts', start: 1, end: 2, content: '0001: const first = read(input);\n0002: const second = consume(first);', orientation: '' }], skippedFiles: [], binaryFiles: [], notes: [] } };
  const raw = JSON.stringify([{ severity: 'IMPORTANT', origin: 'pre-existing', file: 'sample.ts', line: 1, trigger: 'Invalid input', impact: 'Bad output', fix: 'Validate input', confidence: 0.9, evidence_quote: ctx.bughunt.windows[0]!.content }]);
  const fake = new FakeProvider('agy', 'google', originRunner(root), { pro: [raw] });
  const config = validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: [], visual: [] }, escalate: { focus: [], belowConfidence: 0.6 } });
  const result = await runCascade(ctx, config, new Map([['agy', fake]]), { catalog, gitRunner: originRunner(root) });
  expect(result.findings).toMatchObject([{ verified: true, evidence_quote: 'const first = read(input);\nconst second = consume(first);' }]);
});
