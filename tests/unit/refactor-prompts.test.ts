import { expect, it } from 'vitest';
import { boundedPrompt, confirmationBatchPrompt, MAX_PROMPT_CHARACTERS, refactorPrefix, reproductionPrompt, reviewChunks } from '../../src/cascade/prompts.js';
import { context, finding } from '../fixtures/cascade.js';

it('keeps refactor evidence in a bounded stable prefix and hashes the complete summary', () => {
  const ctx = { ...context('/synthetic'), mode: 'refactor' as const, refactorSummary: '\0'.repeat(24000) + 'first' };
  const prefix = refactorPrefix(ctx);
  expect(prefix).toContain('UNTRUSTED DETERMINISTIC EVIDENCE');
  expect(prefix).toContain('"summaryTruncated":true');
  expect(prefix.length).toBeLessThan(7000);
  expect(refactorPrefix({ ...ctx, refactorSummary: '\0'.repeat(24000) + 'second' })).not.toEqual(prefix);
  const chunks = reviewChunks(ctx).chunks;
  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.prompt).toContain('observable behaviour');
  expect(chunks[0]?.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARACTERS);
});
it('reserves room for refactor prefixes before bounding confirmations and reproductions', () => {
  const ctx = { ...context('/synthetic'), mode: 'refactor' as const, refactorSummary: 'evidence '.repeat(4000) };
  const prefix = refactorPrefix(ctx);
  const hunk = 'untrusted hunk '.repeat(6000);
  const prompts = [
    boundedPrompt(prefix + 'Confirm this finding.\n', { finding: finding(), hunk }),
    confirmationBatchPrompt([{ id: 'c1', finding: finding(), hunk }], 'refactor', prefix),
    reproductionPrompt(finding(), ['**/*.test.*'], hunk, prefix),
  ];
  for (const prompt of prompts) {
    expect(prompt.startsWith(prefix)).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARACTERS);
  }
});
