import { expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { reviewChunks } from '../../src/cascade/prompts.js';
import { context } from '../fixtures/cascade.js';

it('accepts general as an explicit mode', () => {
  expect(parseArgs(['review', '--mode', 'general']).flags.mode).toBe('general');
});

it('general uses the ordinary review prompt without specification or criteria', () => {
  const review = { ...context('.'), mode: 'general' as const, specContent: '# Acceptance\n- [ ] Must not leak into general' };
  const prompt = reviewChunks(review).chunks[0]!.prompt;
  expect(prompt).toContain('MODE: GENERAL REVIEW. Report real defects introduced by this change');
  expect(prompt).toContain('untrusted');
  expect(prompt).not.toMatch(/"spec"|"criteria"|AC1|FEATURE AUDIT|REDESIGN|Must not leak/);
});
