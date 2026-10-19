import { describe, expect, it } from 'vitest';
import { parseFindings } from '../../src/cascade/parse.js';
import { catalog, finding } from '../fixtures/cascade.js';

const entry = catalog[0]!;

it.each(['I reviewed file [1] carefully.', '{}'])('skips non-payload prefix %s', prefix => {
  expect(parseFindings(prefix + JSON.stringify([finding()]), entry).findings).toHaveLength(1);
});
it('treats all invalid entries as parse failure', () => {
  expect(parseFindings('[{}]', entry).error).toBeDefined();
});
it('caps response findings at 100', () => {
  const result = parseFindings(JSON.stringify(Array.from({ length: 500 }, () => finding())), entry);
  expect(result.findings).toHaveLength(100);
  expect(result.dropped.filter(item => item.reason === 'too many findings')).toHaveLength(400);
});

describe('provider JSON parsing', () => {
  it.each([
    (json: string) => `Here is my review: ${json} End.`,
    (json: string) => `\`\`\`json\n${json}\n\`\`\``,
    (json: string) => `Review [complete] with {notes}: ${json}`,
  ])('extracts wrapped JSON', wrap => {
    expect(parseFindings(wrap(JSON.stringify([finding()])), entry).findings).toHaveLength(1);
  });

  it('accepts a findings envelope and escaped delimiters', () => {
    const item = finding({ trigger: 'An input contains "] } \\"' });
    for (const value of [[item], { findings: [item] }]) {
      expect(parseFindings(JSON.stringify(value), entry).findings[0]?.trigger).toBe(item.trigger);
    }
  });

  it('overwrites claimed identity, clamps confidence and ignores verification claims', () => {
    const parsed = parseFindings(JSON.stringify([{ ...finding({ provider: 'codex', confidence: 7 }), verified: true,
      verification_note: 'already checked', possibly_related: [{}], reproduction: { path: 'x.test.ts', content: 'test', expect: 'fails', status: 'reproduced' } }]), entry);
    expect(parsed.findings[0]).toMatchObject({ provider: 'agy', model: 'flash', family: 'google', confidence: 1,
      reproduction: { status: 'pending' } });
    expect(parsed.findings[0]).not.toHaveProperty('verified');
    expect(parsed.findings[0]).not.toHaveProperty('verification_note');
    expect(parsed.findings[0]).not.toHaveProperty('possibly_related');
    expect(parseFindings(JSON.stringify([finding({ confidence: -1 })]), entry).findings[0]?.confidence).toBe(0);
  });

  it.each(['file', 'line', 'severity', 'trigger', 'impact', 'evidence_quote', 'fix', 'confidence'])('drops a missing %s with a reason', field => {
    const item: Record<string, unknown> = { ...finding() };
    delete item[field];
    const result = parseFindings(JSON.stringify([item, finding()]), entry);
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toContain(field);
  });

  it.each([{ severity: ['BLOCKER'] }, { line: 1.2 }, { confidence: '0.5' },
    { evidence_quote: null }, { reproduction: { path: 'only' } }])('rejects invalid field types %j', override => {
    expect(parseFindings(JSON.stringify([{ ...finding(), ...override }]), entry).dropped).toHaveLength(1);
  });

  it.each(['not JSON', '[{ broken }]', '[', '{"findings": [}', 'x'.repeat(1_048_577)])('reports unparseable output', raw => {
    expect(parseFindings(raw, entry).error).toBeDefined();
  });
});

it('keeps a finding whose origin is unknown or missing (git blame sets it later)', () => {
  // Seen in a real run: Gemini Flash answered with an origin outside the enum.
  const { origin: _origin, ...withoutOrigin } = finding();
  const result = parseFindings(JSON.stringify([finding({ origin: 'regression' as never }), withoutOrigin]), entry);
  expect(result.findings).toHaveLength(2);
  expect(result.findings.every(item => item.origin === 'introduced')).toBe(true);
  expect(result.dropped).toEqual([]);
});
