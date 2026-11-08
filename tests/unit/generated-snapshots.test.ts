import { expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { createExecutionPlan } from '../../src/cascade/planner.js';
import { isGeneratedSnapshot, reviewChunks } from '../../src/cascade/prompts.js';
import { validateConfig } from '../../src/config/schema.js';
import { generateMarkdownReport, type ReviewResult } from '../../src/reporters/index.js';
import { catalog, context, originRunner } from '../fixtures/cascade.js';

const config = () => validateConfig({ checks: [], tiers: { triage: ['agy:flash'], review: ['agy:pro'], confirm: ['codex'], visual: [] } });
const SNAPSHOT = 'apps/mobile/src/screens/__snapshots__/CouponsScreen.test.tsx.snap';
const section = (file: string, lines: number) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n`
  + Array.from({ length: lines }, (_, i) => `+exports[\`row ${i}\`] = \`<View style="${'x'.repeat(60)}" />\`;`).join('\n') + '\n';
const withSnapshot = () => {
  const ctx = context('.');
  return { ...ctx, touchedFiles: [...ctx.touchedFiles, SNAPSHOT], diff: ctx.diff + section(SNAPSHOT, 900) };
};

it.each([
  ['a.snap', true],
  ['apps/mobile/src/screens/__snapshots__/CouponsScreen.test.tsx.snap', true],
  ['pkg/__snapshots__/readme.md', true],
  ['pkg/__snapshots__/nested/deep.txt', true],
  ['__snapshots__/root.txt', true],
  ['src/snapshots.ts', false],
  ['src/my__snapshots__/a.ts', false],
  ['src/a.snap.ts', false],
  ['src/snap', false],
])('classifies %s as generated=%s', (file, expected) => {
  expect(isGeneratedSnapshot(file)).toBe(expected);
});

it('excludes generated snapshots from the payload and lists them instead of truncating them', () => {
  const plain = reviewChunks(context('.'));
  const payload = reviewChunks(withSnapshot());
  expect(payload.generatedFiles).toEqual([SNAPSHOT]);
  expect(payload.truncatedHunks).toEqual([]);
  expect(payload.skippedFiles).toEqual([]);
  // The reviewed payload is exactly what it would be without the snapshot.
  expect(payload.chunks.map(chunk => chunk.prompt)).toEqual(plain.chunks.map(chunk => chunk.prompt));
  expect(payload.chunks.flatMap(chunk => chunk.files)).toEqual(['sample.ts']);
  expect(payload.chunks.some(chunk => chunk.prompt.includes('CouponsScreen') || chunk.prompt.includes('row 0'))).toBe(false);
  expect(plain.generatedFiles).toEqual([]);
});

it('cuts the chunk count and payload size a snapshot used to cost', () => {
  const ctx = withSnapshot();
  const planned = createExecutionPlan(ctx, config(), catalog);
  const baseline = createExecutionPlan(context('.'), config(), catalog);
  expect(planned.chunkCount).toBe(baseline.chunkCount);
  expect(planned.payloadCharacters).toBe(baseline.payloadCharacters);
  expect(planned.warnings).toContain(`${SNAPSHOT}: generated snapshot excluded from text review.`);
  expect(planned.warnings.some(warning => warning.includes('truncated hunk'))).toBe(false);
});

it('reports excluded snapshots in coverage and warnings without making the run incomplete', async () => {
  const result = await runCascade(withSnapshot(), config(), new Map(), { catalog, gitRunner: originRunner('.') });
  expect(result.coverage.generatedFiles).toEqual([SNAPSHOT]);
  expect(result.coverage.truncatedHunks).toEqual([]);
  expect(result.coverage.skippedFiles).not.toContain(SNAPSHOT);
  expect(result.warnings).toContain(`${SNAPSHOT}: generated snapshot excluded from text review.`);
  const markdown = generateMarkdownReport({ runId: 'synthetic', timestamp: '', mode: 'feature', range: 'base...HEAD', headSha: 'b', baseSha: 'a',
    checks: null, criteria: [], inventory: [], families: [], exitCode: 0, ...result } as unknown as ReviewResult);
  expect(markdown).toContain(`- Generated snapshots: ${SNAPSHOT} (excluded from text review)`);
});

it('omits the generated-snapshot line when nothing was excluded', () => {
  const markdown = generateMarkdownReport({ runId: 'synthetic', timestamp: '', mode: 'feature', range: 'base...HEAD', headSha: 'b', baseSha: 'a',
    checks: null, criteria: [], inventory: [], families: [], exitCode: 0, findings: [], unconfirmed: [], related: [], warnings: [], errors: [],
    calls: [], ledgerDraft: [], cacheHits: 0, reviewedFamilies: [],
    coverage: { complete: true, reviewedFiles: [], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [] } } as unknown as ReviewResult);
  expect(markdown).not.toContain('Generated snapshots');
});
