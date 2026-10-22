import { describe, expect, it } from 'vitest';
import { combinedConfidence } from '../../src/dedupe/cluster.js';
import { dedupeFindings } from '../../src/dedupe/index.js';
import {
  CANDIDATE_METRICS,
  MERGE_JACCARD,
  MIN_SHARED_TOKENS,
  RELATED_OVERLAP,
  findingJaccard,
  findingOverlap,
  findingText,
  isRelated,
  isStrongMatch,
  tokenJaccard,
  tokenOverlap,
  tokenize,
} from '../../src/dedupe/similarity.js';
import type { Family, Finding, Origin, Severity, Tier } from '../../src/types/index.js';
import { ADVERSARIAL, CONTROLS, ROWS, finding } from '../fixtures/dedupe/rows.js';

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

const keyOf = (f: Finding) => `${f.file}:${f.line}:${f.trigger}`;

function rowFindings(number: number): Finding[] {
  return (ROWS.find((candidate) => candidate.row === number) as (typeof ROWS)[number]).findings;
}

describe('table 5.5: the ten rows', () => {
  // The paraphrased rows no longer merge: only near-identical wording does. Each paraphrase pair
  // stays separate, keeps its own severity and confidence, and points at the other.
  for (const row of ROWS) {
    it(`row ${row.row}: separate, ${row.paraphrases === undefined ? 'not related' : 'possibly related'}`, () => {
      const output = dedupeFindings(row.findings);
      expect(output).toHaveLength(row.findings.length);
      expect(output.map(keyOf).sort()).toEqual(row.findings.map(keyOf).sort());
      for (const original of row.findings) {
        const kept = output.find((candidate) => keyOf(candidate) === keyOf(original)) as Finding;
        expect(kept.severity).toBe(original.severity);
        expect(kept.confidence).toBe(original.confidence);
        expect(kept.origin).toBe(original.origin);
      }

      const related = new Set<string>();
      row.findings.forEach((original, index) => {
        const kept = output.find((candidate) => keyOf(candidate) === keyOf(original)) as Finding;
        for (const entry of kept.possibly_related ?? []) {
          const other = row.findings.findIndex(
            (candidate) =>
              candidate.provider === entry.provider &&
              candidate.model === entry.model &&
              candidate.line === entry.line,
          );
          expect(other).toBeGreaterThanOrEqual(0);
          related.add([index, other].sort().join('-'));
        }
      });
      // Row 6 also relates its first and last finding, which the table does not list.
      for (const pair of row.paraphrases ?? []) expect(related.has([...pair].sort().join('-'))).toBe(true);
      if (row.paraphrases === undefined) expect(related.size).toBe(0);
    });
  }

  it('rows 3 and 7 stay apart only because of location, not because of their text', () => {
    // Row 7 has identical text; row 3 has the same trigger and a paraphrased impact.
    const [seven, other] = rowFindings(7) as [Finding, Finding];
    expect(isStrongMatch(seven, other)).toBe(true);
    const [three, far] = rowFindings(3) as [Finding, Finding];
    expect(isStrongMatch(three, far)).toBe(false);
    expect(isRelated(three, far)).toBe(true);
    // They are not annotated either: row 3 is 12 lines apart, row 7 is two files.
    for (const number of [3, 7]) {
      expect(dedupeFindings(rowFindings(number)).every((f) => f.possibly_related === undefined)).toBe(true);
    }
  });

  describe('with the reviewers using the same words, the confidence arithmetic of the table holds', () => {
    for (const row of ROWS.filter((candidate) => candidate.sameWording !== undefined)) {
      it(`row ${row.row}`, () => {
        const expected = row.sameWording as NonNullable<(typeof row)['sameWording']>;
        const [anchor] = row.findings as [Finding];
        const output = dedupeFindings(
          row.findings.map((f) => ({ ...f, trigger: anchor.trigger, impact: anchor.impact })),
        );
        expect(output).toHaveLength(1);
        const [merged] = output as [Finding];
        expect(merged.severity).toBe(expected.severity);
        expect(merged.confidence).toBeCloseTo(expected.confidence, 9);
        if (expected.origin !== undefined) expect(merged.origin).toBe(expected.origin);
        expect(merged.possibly_related).toBeUndefined();
      });
    }
  });
});

describe('adversarial pair: a different defect is never hidden', () => {
  it('"missing authorization" and "missing audit" stay separate at confidence 0.70', () => {
    const [authorization, audit] = ADVERSARIAL;
    expect(isStrongMatch(authorization, audit)).toBe(false);
    expect(isRelated(authorization, audit)).toBe(true);

    const output = dedupeFindings([authorization, audit]);
    expect(output).toHaveLength(2);
    expect(output.map((f) => f.confidence)).toEqual([0.7, 0.7]);
    expect(output.map((f) => f.severity)).toEqual(['IMPORTANT', 'IMPORTANT']);
    const [first, second] = output as [Finding, Finding];
    expect(first.possibly_related).toEqual([
      { provider: audit.provider, model: audit.model, line: 12, similarity: expect.any(Number) },
    ]);
    expect(second.possibly_related).toEqual([
      { provider: authorization.provider, model: authorization.model, line: 10, similarity: expect.any(Number) },
    ]);
    expect(first.possibly_related?.[0]?.similarity).toBeGreaterThanOrEqual(RELATED_OVERLAP);
    expect(first.verification_note).toBeUndefined();
  });

  it('is stable whatever the order, and annotating twice changes nothing', () => {
    const once = dedupeFindings([...ADVERSARIAL]);
    expect(dedupeFindings([...ADVERSARIAL].reverse())).toEqual(once);
    expect(dedupeFindings(once)).toEqual(once);
  });
});

describe('strong match and annotation rules', () => {
  const base = {
    severity: 'IMPORTANT' as const,
    confidence: 0.6,
    trigger: SAME_TEXT.trigger,
    impact: SAME_TEXT.impact,
    fix: '',
  };

  it('the merge threshold is 0.85 and related starts at 0.15', () => {
    expect(MERGE_JACCARD).toBe(0.85);
    expect(RELATED_OVERLAP).toBe(0.15);
    expect(MIN_SHARED_TOKENS).toBe(2);
  });

  it('near-identical wording merges across families, one extra word is still strong', () => {
    const a = finding({ ...base, line: 10, family: 'google' });
    const b = finding({ ...base, line: 12, family: 'openai', impact: `${base.impact} Monitoring` });
    expect(findingJaccard(a, b)).toBeGreaterThanOrEqual(MERGE_JACCARD);
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeCloseTo(0.85, 9);
  });

  it('wording just below the threshold does not merge', () => {
    const a = finding({ ...base, line: 10, family: 'google' });
    const b = finding({
      ...base,
      line: 12,
      family: 'openai',
      impact: `${base.impact} Monitoring alerting reporting audit.`,
    });
    expect(findingJaccard(a, b)).toBeLessThan(MERGE_JACCARD);
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.confidence)).toEqual([0.6, 0.6]);
    expect(out[0]?.possibly_related).toHaveLength(1);
  });

  it('the cross-family boost never comes from a related annotation', () => {
    const [a, b] = ADVERSARIAL;
    const strong = dedupeFindings([a, { ...a, line: 11, family: 'openai', provider: 'codex' }]);
    expect(strong).toHaveLength(1);
    expect(strong[0]?.confidence).toBeCloseTo(0.95, 9);
    const related = dedupeFindings([a, b]);
    expect(Math.max(...related.map((f) => f.confidence))).toBe(0.7);
  });

  it('annotates only inside the same file and within 5 lines, symmetrically', () => {
    const [a, b] = ADVERSARIAL;
    const farther = dedupeFindings([a, { ...b, line: a.line + 6 }]);
    expect(farther.every((f) => f.possibly_related === undefined)).toBe(true);
    const edge = dedupeFindings([a, { ...b, line: a.line + 5 }]);
    expect(edge.every((f) => f.possibly_related?.length === 1)).toBe(true);
    const otherFile = dedupeFindings([a, { ...b, file: 'src/other.ts' }]);
    expect(otherFile.every((f) => f.possibly_related === undefined)).toBe(true);
  });

  it('a merged cluster is annotated against a separate neighbour, never merged with it', () => {
    const [a, b] = ADVERSARIAL;
    const twin = { ...a, line: 11, family: 'anthropic' as const, provider: 'claude', model: 'sonnet' };
    const out = dedupeFindings([a, twin, b]);
    expect(out).toHaveLength(2);
    const authorization = out.find((f) => f.trigger === a.trigger) as Finding;
    const audit = out.find((f) => f.trigger === b.trigger) as Finding;
    expect(authorization.confidence).toBeCloseTo(0.95, 9);
    expect(audit.confidence).toBe(0.7);
    expect(authorization.possibly_related?.map((entry) => entry.line)).toEqual([12]);
    expect(audit.possibly_related?.map((entry) => entry.line)).toEqual([10, 11]);
  });

  it('a finding that strongly matches a member but is 6 lines from another does not join', () => {
    const out = dedupeFindings([
      same(10, 'google', 0.5),
      same(15, 'openai', 0.5),
      same(16, 'anthropic', 0.5),
    ]);
    // 10 and 15 merge; 16 is 6 lines from 10, so it stays alone, annotated against the one at 15.
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.line === 16)?.possibly_related?.map((entry) => entry.line)).toEqual([15]);
  });

  it('the same text twice from one provider still merges, without a boost', () => {
    const out = dedupeFindings([
      same(10, 'google', 0.6, { provider: 'agy', model: 'gemini-3.1-pro-high' }),
      same(10, 'google', 0.6, { provider: 'agy', model: 'gemini-3.1-pro-high' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.6);
    expect(out[0]?.verification_note).toBeUndefined();
    expect(out[0]?.possibly_related).toBeUndefined();
  });

  it('a finding without a usable line is never annotated or merged', () => {
    const out = dedupeFindings([same(Number.NaN, 'google', 0.5), same(10, 'openai', 0.5)]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.possibly_related === undefined)).toBe(true);
  });
});

describe('similarity calibration against table 5.5', () => {
  const paraphrases: Array<[Finding, Finding]> = [];
  const apart: Array<[Finding, Finding]> = [];
  for (const row of ROWS) {
    for (const [i, j] of row.paraphrases ?? []) {
      paraphrases.push([row.findings[i] as Finding, row.findings[j] as Finding]);
    }
    for (const [i, j] of row.distinct ?? []) {
      apart.push([row.findings[i] as Finding, row.findings[j] as Finding]);
    }
  }

  function window(metric: (a: string, b: string) => number) {
    const score = ([a, b]: [Finding, Finding]) => metric(findingText(a), findingText(b));
    return {
      minParaphrase: Math.min(...paraphrases.map(score)),
      maxApart: Math.max(...apart.map(score)),
    };
  }

  it('has the pairs the spec requires: rows 1, 2, 5, 6 (twice), 8, 9 paraphrase; 4 and 10 are distinct', () => {
    expect(paraphrases).toHaveLength(7);
    expect(apart).toHaveLength(2);
  });

  it('no paraphrase is a strong match, but every one is related and no distinct pair is', () => {
    for (const [a, b] of paraphrases) {
      expect(isStrongMatch(a, b)).toBe(false);
      expect(findingJaccard(a, b)).toBeLessThan(MERGE_JACCARD - 0.5);
      expect(isRelated(a, b)).toBe(true);
    }
    for (const [a, b] of apart) {
      expect(isStrongMatch(a, b)).toBe(false);
      expect(isRelated(a, b)).toBe(false);
      expect(findingOverlap(a, b)).toBeLessThan(RELATED_OVERLAP);
    }
  });

  it('the related threshold separates the groups with room on both sides', () => {
    const { minParaphrase, maxApart } = window(tokenOverlap);
    expect(maxApart).toBeLessThan(RELATED_OVERLAP - 0.04);
    expect(minParaphrase).toBeGreaterThan(RELATED_OVERLAP + 0.04);
  });

  it('the Jaccard threshold of 0.70 in 5.2 would merge none of the paraphrase rows either', () => {
    for (const [a, b] of paraphrases) {
      expect(tokenJaccard(findingText(a), findingText(b))).toBeLessThan(0.7);
    }
  });

  it('the word-level candidates all separate the rows at some threshold; the overlap gap is widest', () => {
    const windows: Record<string, { minParaphrase: number; maxApart: number }> = {};
    for (const name of ['tokenJaccard', 'trigramDice', 'tokenOverlap']) {
      windows[name] = window(CANDIDATE_METRICS[name] as (a: string, b: string) => number);
      expect(windows[name]?.minParaphrase, name).toBeGreaterThan(windows[name]?.maxApart as number);
    }
    const gap = (name: string) =>
      (windows[name]?.minParaphrase ?? 0) - (windows[name]?.maxApart ?? 0);
    expect(gap('tokenOverlap')).toBeGreaterThan(gap('tokenJaccard'));
    expect(gap('tokenOverlap')).toBeGreaterThan(gap('trigramDice'));
  });

  // Keeping negation changes calibration; the character metric still has a very narrow gap.
  it('the character-level Levenshtein candidate has less margin than overlap', () => {
    const { minParaphrase, maxApart } = window(
      CANDIDATE_METRICS.characterSimilarity as (a: string, b: string) => number,
    );
    const overlap = window(tokenOverlap);
    expect(minParaphrase - maxApart).toBeLessThan(overlap.minParaphrase - overlap.maxApart);
  });

  describe('control pairs written after the table (not part of the spec)', () => {
    it('no control pair is merged, paraphrased or not', () => {
      for (const control of CONTROLS) {
        expect(isStrongMatch(control.a, control.b), control.name).toBe(false);
        const out = dedupeFindings([control.a, control.b]);
        expect(out, control.name).toHaveLength(2);
        expect(out.map((f) => f.confidence), control.name).toEqual([0.7, 0.7]);
      }
    });

    it('no distinct defect is even annotated as related', () => {
      for (const control of CONTROLS.filter((c) => c.expect === 'distinct')) {
        expect(isRelated(control.a, control.b), control.name).toBe(false);
      }
    });

    // Paraphrases with (almost) no words in common cannot be related by any lexical metric.
    // Kept separate on purpose: a missed merge costs a duplicate, a false merge hides a defect.
    const KNOWN_MISSES = ['paraphrase: hardcoded credential', 'paraphrase: stream not closed'];

    it('most paraphrases are related and the known lexical misses are not', () => {
      const paraphrased = CONTROLS.filter((c) => c.expect === 'paraphrase');
      const missed = paraphrased.filter((c) => !isRelated(c.a, c.b)).map((c) => c.name);
      expect(missed.sort()).toEqual([...KNOWN_MISSES].sort());
      expect(paraphrased.length - missed.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('one shared word is never enough, even in very short texts', () => {
    const a = finding({ line: 1, severity: 'OPTIONAL', confidence: 0.5, family: 'google', trigger: 'Dead code', impact: 'Never runs', fix: '' });
    const b = finding({ line: 2, severity: 'OPTIONAL', confidence: 0.5, family: 'openai', trigger: 'Dead branch', impact: 'Wasted effort', fix: '' });
    expect(tokenOverlap(findingText(a), findingText(b))).toBeGreaterThanOrEqual(RELATED_OVERLAP);
    expect(MIN_SHARED_TOKENS).toBe(2);
    expect(findingOverlap(a, b)).toBe(0);
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.possibly_related === undefined)).toBe(true);
    // Identical one-word texts are not enough to merge either.
    const twin = { ...a, trigger: 'Typo', impact: '' };
    expect(dedupeFindings([twin, { ...twin, line: 2, family: 'openai' as const }])).toHaveLength(2);
  });

  it('tokenizes with stop words removed, stemming and camelCase splitting', () => {
    expect(tokenize('The retries were missing an idempotencyKey')).toEqual(['retry', 'missing', 'idempotency', 'key']);
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
    const low = { ...same(40, 'google', 0.5), fix: 'low fix' };
    const high = {
      ...same(42, 'openai', 0.9),
      trigger: `${SAME_TEXT.trigger} (high)`,
      fix: 'high fix',
    };
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
    expect(out.every((f) => f.possibly_related === undefined)).toBe(true);
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

  it('does not modify its input when it annotates', () => {
    const inputs = deepFreeze([...ADVERSARIAL]);
    const snapshot = structuredClone(inputs);
    const out = dedupeFindings(inputs);
    expect(inputs).toEqual(snapshot);
    expect(out.every((f) => f.possibly_related !== undefined)).toBe(true);
    expect(inputs.every((f) => f.possibly_related === undefined)).toBe(true);
  });
});

describe('M1 final round fix 3: the trigger and the impact must each be near-identical', () => {
  // The reviewer's pair: a long impact sentence in common drowns the three words of the trigger
  // that make them different defects.
  const LONG_IMPACT =
    'The deletion endpoint accepts requests from remote clients and removes account records ' +
    'permanently, exposing production customer data to misuse.';
  const authorization = finding({
    file: 'src/users.ts',
    line: 10,
    severity: 'IMPORTANT',
    confidence: 0.7,
    family: 'google',
    trigger: 'Missing authorization when deleting users',
    impact: LONG_IMPACT,
    fix: 'Check that the caller is an administrator before deleting.',
  });
  const audit = finding({
    file: 'src/users.ts',
    line: 12,
    severity: 'IMPORTANT',
    confidence: 0.7,
    family: 'openai',
    trigger: 'Missing audit when deleting users',
    impact: LONG_IMPACT,
    fix: 'Write an audit record for every deletion.',
  });

  it('keeps the pair separate at 0.70 and annotates it, although the combined text matches', () => {
    // What used to merge them: the Jaccard of the combined text.
    expect(tokenJaccard(findingText(authorization), findingText(audit))).toBeGreaterThanOrEqual(
      MERGE_JACCARD,
    );
    expect(tokenJaccard(authorization.impact, audit.impact)).toBe(1);
    expect(tokenJaccard(authorization.trigger, audit.trigger)).toBeLessThan(MERGE_JACCARD);
    expect(isStrongMatch(authorization, audit)).toBe(false);
    expect(findingJaccard(authorization, audit)).toBeLessThan(MERGE_JACCARD);
    expect(isRelated(authorization, audit)).toBe(true);

    const output = dedupeFindings([authorization, audit]);
    expect(output).toHaveLength(2);
    expect(output.map((f) => f.confidence)).toEqual([0.7, 0.7]);
    expect(output.map((f) => f.severity)).toEqual(['IMPORTANT', 'IMPORTANT']);
    expect(output.map((f) => f.line)).toEqual([10, 12]);
    const [first, second] = output as [Finding, Finding];
    expect(first.possibly_related).toEqual([
      { provider: audit.provider, model: audit.model, line: 12, similarity: expect.any(Number) },
    ]);
    expect(second.possibly_related).toEqual([
      {
        provider: authorization.provider,
        model: authorization.model,
        line: 10,
        similarity: expect.any(Number),
      },
    ]);
    expect(first.verification_note).toBeUndefined();
    expect(second.verification_note).toBeUndefined();
  });

  it('is the same in any order and when run twice', () => {
    const once = dedupeFindings([authorization, audit]);
    expect(dedupeFindings([audit, authorization])).toEqual(once);
    expect(dedupeFindings(once)).toEqual(once);
  });

  it('a long trigger in common does not merge two different impacts either', () => {
    const trigger =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november ' +
      'oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu extra shared words';
    const a = finding({
      file: 'src/users.ts',
      line: 10,
      severity: 'IMPORTANT',
      confidence: 0.7,
      family: 'google',
      trigger,
      impact: 'Audit trail missing',
      fix: '',
    });
    const b = finding({
      file: 'src/users.ts',
      line: 11,
      severity: 'IMPORTANT',
      confidence: 0.7,
      family: 'openai',
      trigger,
      impact: 'Anyone deletes',
      fix: '',
    });
    expect(tokenJaccard(findingText(a), findingText(b))).toBeGreaterThanOrEqual(MERGE_JACCARD);
    expect(tokenJaccard(a.impact, b.impact)).toBe(0);
    expect(isStrongMatch(a, b)).toBe(false);
    const output = dedupeFindings([a, b]);
    expect(output).toHaveLength(2);
    expect(output.map((f) => f.confidence)).toEqual([0.7, 0.7]);
    expect(output.every((f) => f.possibly_related?.length === 1)).toBe(true);
  });

  it('still merges when both fields are near-identical, one extra word in each', () => {
    const a = finding({
      line: 10,
      severity: 'IMPORTANT',
      confidence: 0.7,
      family: 'google',
      trigger: SAME_TEXT.trigger,
      impact: SAME_TEXT.impact,
      fix: '',
    });
    const b = finding({
      line: 12,
      severity: 'IMPORTANT',
      confidence: 0.7,
      family: 'openai',
      trigger: `${SAME_TEXT.trigger} Monitoring`,
      impact: `${SAME_TEXT.impact} Monitoring`,
      fix: '',
    });
    expect(tokenJaccard(a.trigger, b.trigger)).toBeGreaterThanOrEqual(MERGE_JACCARD);
    expect(tokenJaccard(a.impact, b.impact)).toBeGreaterThanOrEqual(MERGE_JACCARD);
    expect(isStrongMatch(a, b)).toBe(true);
    const output = dedupeFindings([a, b]);
    expect(output).toHaveLength(1);
    expect(output[0]?.confidence).toBeCloseTo(0.95, 9);
  });

  it('an empty impact on both sides does not block an identical trigger', () => {
    const a = finding({
      line: 10,
      severity: 'IMPORTANT',
      confidence: 0.6,
      family: 'google',
      trigger: SAME_TEXT.trigger,
      impact: '',
      fix: '',
    });
    const output = dedupeFindings([a, { ...a, line: 11, family: 'openai', provider: 'codex' }]);
    expect(output).toHaveLength(1);
  });
});
