import { describe, expect, it } from 'vitest';
import { combinedConfidence } from '../../src/dedupe/cluster.js';
import { dedupeFindings } from '../../src/dedupe/index.js';
import {
  CANDIDATE_METRICS,
  DEDUPE_THRESHOLD,
  MIN_SHARED_TOKENS,
  dedupeMetric,
  findingSimilarity,
  findingText,
  isSameDefect,
  tokenJaccard,
  tokenOverlap,
  tokenize,
} from '../../src/dedupe/similarity.js';
import type { Family, Finding, Origin, Severity, Tier } from '../../src/types/index.js';
import { CONTROLS, ROWS, finding } from '../fixtures/dedupe/rows.js';

const SAME_TEXT = {
  trigger: 'Refund amount is not validated against the original payment',
  impact: 'A caller can request a refund larger than the payment and drain the merchant balance.',
  fix: 'Reject refunds above the captured amount.',
};

function same(
  line: number,
  family: Family,
  confidence: number,
  extra: { severity?: Severity; origin?: Origin; file?: string; provider?: string; model?: string } = {},
): Finding {
  return finding({
    line,
    family,
    confidence,
    severity: extra.severity ?? 'IMPORTANT',
    ...SAME_TEXT,
    ...(extra.origin === undefined ? {} : { origin: extra.origin }),
    ...(extra.file === undefined ? {} : { file: extra.file }),
    ...(extra.provider === undefined ? {} : { provider: extra.provider }),
    ...(extra.model === undefined ? {} : { model: extra.model }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('table 5.5: the ten rows', () => {
  for (const row of ROWS) {
    it(`row ${row.row}: ${row.result}`, () => {
      const output = dedupeFindings(row.findings);
      if (row.result === 'separate') {
        expect(output).toHaveLength(row.findings.length);
        const key = (f: Finding) => `${f.file}:${f.line}:${f.trigger}`;
        expect(output.map(key).sort()).toEqual(row.findings.map(key).sort());
        return;
      }
      expect(output).toHaveLength(1);
      const [merged] = output as [Finding];
      expect(merged.severity).toBe(row.finalSeverity);
      expect(merged.confidence).toBeCloseTo(row.finalConfidence as number, 9);
      if (row.finalOrigin !== undefined) expect(merged.origin).toBe(row.finalOrigin);
    });
  }

  it('rows 3 and 7 stay apart only because of location, not because of their text', () => {
    for (const number of [3, 7]) {
      const row = ROWS.find((candidate) => candidate.row === number);
      const [first, second] = (row as (typeof ROWS)[number]).findings as [Finding, Finding];
      expect(isSameDefect(first, second)).toBe(true);
    }
  });
});

describe('similarity calibration against table 5.5', () => {
  const merges: Array<[Finding, Finding]> = [];
  const apart: Array<[Finding, Finding]> = [];
  for (const row of ROWS) {
    for (const [i, j] of row.linked ?? []) merges.push([row.findings[i] as Finding, row.findings[j] as Finding]);
    for (const [i, j] of row.distinct ?? []) apart.push([row.findings[i] as Finding, row.findings[j] as Finding]);
  }

  function window(metric: (a: string, b: string) => number) {
    const score = ([a, b]: [Finding, Finding]) => metric(findingText(a), findingText(b));
    return {
      minMerge: Math.min(...merges.map(score)),
      maxApart: Math.max(...apart.map(score)),
    };
  }

  it('has the pairs the spec requires: rows 1, 2, 5, 6 (twice), 8, 9 merge; 4 and 10 stay apart', () => {
    expect(merges).toHaveLength(7);
    expect(apart).toHaveLength(2);
  });

  it('the chosen metric separates the two groups with room on both sides', () => {
    const { minMerge, maxApart } = window(dedupeMetric);
    expect(dedupeMetric).toBe(tokenOverlap);
    expect(maxApart).toBeLessThan(DEDUPE_THRESHOLD - 0.04);
    expect(minMerge).toBeGreaterThan(DEDUPE_THRESHOLD + 0.04);
  });

  it('every pair that must merge is similar and every pair that must stay apart is not', () => {
    for (const [a, b] of merges) expect(isSameDefect(a, b)).toBe(true);
    for (const [a, b] of apart) expect(isSameDefect(a, b)).toBe(false);
  });

  it('the Jaccard threshold of 0.70 in 5.2 would merge none of the paraphrase rows', () => {
    for (const [a, b] of merges) {
      expect(tokenJaccard(findingText(a), findingText(b))).toBeLessThan(0.7);
    }
  });

  it('the word-level candidates all separate the rows at some threshold; the overlap gap is widest', () => {
    const windows: Record<string, { minMerge: number; maxApart: number }> = {};
    for (const name of ['tokenJaccard', 'trigramDice', 'tokenOverlap']) {
      windows[name] = window(CANDIDATE_METRICS[name] as (a: string, b: string) => number);
      expect(windows[name]?.minMerge, name).toBeGreaterThan(windows[name]?.maxApart as number);
    }
    const gap = (name: string) => (windows[name]?.minMerge ?? 0) - (windows[name]?.maxApart ?? 0);
    expect(gap('tokenOverlap')).toBeGreaterThan(gap('tokenJaccard'));
    expect(gap('tokenOverlap')).toBeGreaterThan(gap('trigramDice'));
  });

  // Documents a candidate that was tried and cannot satisfy the table: the character-level
  // Levenshtein similarity scores the distinct defects of row 4 (about 0.23) above the paraphrase
  // of row 8 (about 0.22), so no threshold separates the ten rows.
  it('the character-level Levenshtein candidate cannot satisfy the rows', () => {
    const { minMerge, maxApart } = window(CANDIDATE_METRICS.characterSimilarity as (a: string, b: string) => number);
    expect(minMerge).toBeLessThan(maxApart);
  });

  describe('control pairs written after the table (not part of the spec)', () => {
    it('no distinct defect is merged', () => {
      for (const control of CONTROLS.filter((c) => c.expect === 'separate')) {
        expect(isSameDefect(control.a, control.b), control.name).toBe(false);
      }
    });

    // Paraphrases with (almost) no words in common cannot be matched by any lexical metric.
    // Kept separate on purpose: a missed merge costs a duplicate, a false merge hides a defect.
    const KNOWN_MISSES = ['merge: hardcoded credential', 'merge: stream not closed'];

    it('most paraphrases merge and the known lexical misses stay separate', () => {
      const merged = CONTROLS.filter((c) => c.expect === 'merge');
      const missed = merged.filter((c) => !isSameDefect(c.a, c.b)).map((c) => c.name);
      expect(missed.sort()).toEqual([...KNOWN_MISSES].sort());
      expect(merged.length - missed.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('one shared word is never enough, even in very short texts', () => {
    const a = finding({ line: 1, severity: 'OPTIONAL', confidence: 0.5, family: 'google', trigger: 'Dead code', impact: 'Never runs', fix: '' });
    const b = finding({ line: 2, severity: 'OPTIONAL', confidence: 0.5, family: 'openai', trigger: 'Dead branch', impact: 'Wasted effort', fix: '' });
    expect(tokenOverlap(findingText(a), findingText(b))).toBeGreaterThanOrEqual(DEDUPE_THRESHOLD);
    expect(MIN_SHARED_TOKENS).toBe(2);
    expect(findingSimilarity(a, b)).toBe(0);
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it('tokenizes with stop words removed, stemming and camelCase splitting', () => {
    expect(tokenize('The retries were missing an idempotencyKey')).toEqual(['retry', 'idempotency', 'key']);
    expect(tokenize('Documented, documentation')).toEqual(['document', 'documentation']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('confidence arithmetic (5.3)', () => {
  it('one family keeps the highest confidence', () => {
    const out = dedupeFindings([same(10, 'google', 0.6), same(11, 'google', 0.8), same(12, 'google', 0.7)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.8);
  });

  it('two distinct families add 0.25 to the highest', () => {
    const out = dedupeFindings([same(10, 'google', 0.5), same(11, 'openai', 0.5)]);
    expect(out[0]?.confidence).toBeCloseTo(0.75, 9);
    const other = dedupeFindings([same(10, 'google', 0.6), same(11, 'anthropic', 0.7)]);
    expect(other[0]?.confidence).toBeCloseTo(0.95, 9);
  });

  it('two distinct families are capped at 1', () => {
    const out = dedupeFindings([same(10, 'google', 0.9), same(11, 'openai', 0.2)]);
    expect(out[0]?.confidence).toBe(1);
  });

  it('three distinct families give 1.0 whatever the individual scores', () => {
    const out = dedupeFindings([same(10, 'google', 0.1), same(11, 'openai', 0.2), same(12, 'anthropic', 0.3)]);
    expect(out[0]?.confidence).toBe(1);
    const four = dedupeFindings([
      same(10, 'google', 0.1),
      same(11, 'openai', 0.2),
      same(12, 'anthropic', 0.3),
      same(13, 'local', 0.1),
    ]);
    expect(four[0]?.confidence).toBe(1);
  });

  it('a family counts once even when it arrives through two CLIs', () => {
    const out = dedupeFindings([
      same(10, 'anthropic', 0.8, { provider: 'claude', model: 'sonnet' }),
      same(11, 'anthropic', 0.75, { provider: 'agy', model: 'claude-opus-5-5-high' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.8);
  });

  it('two CLIs of one family plus one other family are two families, not three', () => {
    const out = dedupeFindings([
      same(10, 'anthropic', 0.6, { provider: 'claude', model: 'sonnet' }),
      same(11, 'anthropic', 0.5, { provider: 'agy', model: 'claude-opus-5-5-high' }),
      same(12, 'google', 0.4),
    ]);
    expect(out[0]?.confidence).toBeCloseTo(0.85, 9);
  });

  it('combinedConfidence works on a list directly', () => {
    expect(combinedConfidence([same(1, 'google', 0.3)])).toBe(0.3);
    expect(combinedConfidence([same(1, 'google', 0.3), same(2, 'local', 0.4)])).toBeCloseTo(0.65, 9);
  });
});

describe('merging rules', () => {
  it('takes the highest severity, even from the less confident finding', () => {
    const out = dedupeFindings([
      same(10, 'google', 0.9, { severity: 'OPTIONAL' }),
      same(11, 'openai', 0.4, { severity: 'BLOCKER' }),
      same(12, 'anthropic', 0.5, { severity: 'IMPORTANT' }),
    ]);
    expect(out[0]?.severity).toBe('BLOCKER');
    const mid = dedupeFindings([
      same(10, 'google', 0.9, { severity: 'OPTIONAL' }),
      same(11, 'openai', 0.4, { severity: 'IMPORTANT' }),
    ]);
    expect(mid[0]?.severity).toBe('IMPORTANT');
  });

  it('resolves the origin: introduced > pre-existing > improvement', () => {
    const origin = (...origins: Origin[]) =>
      dedupeFindings(origins.map((o, i) => same(10 + i, i % 2 === 0 ? 'google' : 'openai', 0.5 + i / 100, { origin: o })))[0]?.origin;
    expect(origin('introduced', 'pre-existing')).toBe('introduced');
    expect(origin('pre-existing', 'introduced')).toBe('introduced');
    expect(origin('pre-existing', 'improvement')).toBe('pre-existing');
    expect(origin('improvement', 'improvement')).toBe('improvement');
  });

  it('keeps the text, line and source of the most confident finding', () => {
    const low = finding({ line: 40, severity: 'IMPORTANT', confidence: 0.5, family: 'google', trigger: 'Refund exceeds payment amount', impact: 'The refund can be larger than the payment that was captured.', fix: 'low fix' });
    const high = finding({ line: 42, severity: 'IMPORTANT', confidence: 0.9, family: 'openai', trigger: 'Refund larger than captured payment', impact: 'A refund bigger than the payment amount drains the merchant balance.', fix: 'high fix' });
    const out = dedupeFindings([low, high]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      line: 42,
      trigger: high.trigger,
      impact: high.impact,
      provider: high.provider,
      model: high.model,
      family: 'openai',
      fix: 'high fix',
    });
  });

  it('notes which other reviewers agreed, without touching the text', () => {
    const a = same(10, 'google', 0.9);
    const b = same(11, 'openai', 0.5);
    const out = dedupeFindings([a, b]);
    expect(out[0]?.trigger).toBe(a.trigger);
    expect(out[0]?.verification_note).toBe('also reported by codex:gpt-5 (openai)');
    const withNote = { ...a, verification_note: 'fuzzy quote match' };
    expect(dedupeFindings([withNote, b])[0]?.verification_note).toBe(
      'fuzzy quote match; also reported by codex:gpt-5 (openai)',
    );
  });

  it('takes the fix from the highest tier when the tier is known', () => {
    const triage = { ...same(10, 'google', 0.9), fix: 'triage fix', model: 'flash' };
    const confirm = { ...same(11, 'openai', 0.5), fix: 'confirm fix', model: 'gpt-5' };
    const review = { ...same(12, 'anthropic', 0.7), fix: 'review fix', model: 'sonnet' };
    const tiers: Record<string, Tier> = { flash: 'triage', 'gpt-5': 'confirm', sonnet: 'review' };
    const tierOf = (f: Finding) => tiers[f.model];
    expect(dedupeFindings([triage, confirm, review], { tierOf })[0]?.fix).toBe('confirm fix');
    expect(dedupeFindings([triage, review], { tierOf })[0]?.fix).toBe('review fix');
    // Without tiers the most confident finding's fix is used.
    expect(dedupeFindings([triage, confirm, review])[0]?.fix).toBe('triage fix');
    // Unknown tiers fall back to the most confident finding.
    expect(dedupeFindings([triage, confirm], { tierOf: () => undefined })[0]?.fix).toBe('triage fix');
  });

  it('does not take an empty fix from a higher tier', () => {
    const triage = { ...same(10, 'google', 0.9), fix: 'triage fix', model: 'flash' };
    const confirm = { ...same(11, 'openai', 0.5), fix: '  ', model: 'gpt-5' };
    const tierOf = (f: Finding): Tier => (f.model === 'gpt-5' ? 'confirm' : 'triage');
    expect(dedupeFindings([triage, confirm], { tierOf })[0]?.fix).toBe('triage fix');
  });
});

describe('clustering', () => {
  it('merges at a line distance of 5 and not at 6', () => {
    expect(dedupeFindings([same(10, 'google', 0.5), same(15, 'openai', 0.5)])).toHaveLength(1);
    expect(dedupeFindings([same(10, 'google', 0.5), same(16, 'openai', 0.5)])).toHaveLength(2);
  });

  it('does not let a chain of near findings swallow lines that are far apart', () => {
    const out = dedupeFindings([
      same(10, 'google', 0.5),
      same(14, 'openai', 0.5),
      same(18, 'anthropic', 0.5),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.line).sort((a, b) => a - b)).toEqual([10, 18]);
  });

  it('never merges findings from different files', () => {
    const out = dedupeFindings([
      same(10, 'google', 0.8, { file: 'src/a.ts' }),
      same(10, 'openai', 0.8, { file: 'src/b.ts' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.confidence === 0.8)).toBe(true);
  });

  it('treats equivalent spellings of one path as the same file', () => {
    const out = dedupeFindings([
      same(10, 'google', 0.5, { file: 'src/a.ts' }),
      same(11, 'openai', 0.5, { file: 'src\\a.ts' }),
      same(12, 'anthropic', 0.5, { file: './src/a.ts' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(1);
  });

  it('is independent of the input order', () => {
    const inputs = [same(10, 'google', 0.5), same(12, 'openai', 0.6), same(40, 'google', 0.7)];
    const forward = dedupeFindings(inputs);
    const reversed = dedupeFindings([...inputs].reverse());
    expect(reversed).toEqual(forward);
  });

  it('keeps unrelated findings in the same neighbourhood apart', () => {
    const out = dedupeFindings(
      ROWS.filter((row) => row.row === 4 || row.row === 10).flatMap((row) => row.findings),
    );
    expect(out).toHaveLength(4);
  });

  it('orders output by file first seen, then by line', () => {
    const out = dedupeFindings([
      same(90, 'google', 0.5, { file: 'src/b.ts' }),
      same(5, 'google', 0.5, { file: 'src/a.ts' }),
      same(1, 'google', 0.5, { file: 'src/b.ts' }),
    ]);
    expect(out.map((f) => `${f.file}:${f.line}`)).toEqual(['src/b.ts:1', 'src/b.ts:90', 'src/a.ts:5']);
  });

  it('survives a non-finite line', () => {
    const out = dedupeFindings([same(Number.NaN, 'google', 0.5), same(Number.NaN, 'openai', 0.5), same(10, 'google', 0.5)]);
    expect(out).toHaveLength(3);
  });
});

describe('purity and edge cases', () => {
  it('returns an empty list for no findings', () => {
    expect(dedupeFindings([])).toEqual([]);
  });

  it('returns a single finding unchanged', () => {
    const only = same(10, 'google', 0.42, { severity: 'BLOCKER', origin: 'pre-existing' });
    const out = dedupeFindings([only]);
    expect(out).toEqual([only]);
    expect(out[0]).not.toBe(only);
  });

  it('does not modify its input and does not alias nested objects', () => {
    const withProof: Finding = {
      ...same(10, 'google', 0.5),
      reproduction: { path: 'tests/a.test.ts', content: 'x', expect: 'y' },
    };
    const inputs = deepFreeze([withProof, same(11, 'openai', 0.9), same(40, 'local', 0.3)]);
    const snapshot = structuredClone(inputs);
    const out = dedupeFindings(inputs);
    expect(inputs).toEqual(snapshot);
    for (const result of out) for (const original of inputs) expect(result).not.toBe(original);
    // The reproduction of the less confident finding is not lost.
    expect(out[0]?.reproduction).toEqual(withProof.reproduction);
    expect(out[0]?.reproduction).not.toBe(withProof.reproduction);
    expect(out[0]?.reproduction).toBeDefined();
  });
});
