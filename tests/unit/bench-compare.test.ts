import { expect, it } from 'vitest';

const modulePath = '../../bench/compare.mjs';
const { compare } = await import(modulePath);

it('compares metrics B minus A, preserving undefined rates and missing exit buckets', () => {
  expect(compare({ totals: { all: { recall: 0.5, precision: null }, calls: 2, exitCodes: { 0: 1 } } },
    { totals: { all: { recall: 0.75, precision: 1 }, calls: 1, exitCodes: { 2: 1 } } })).toEqual([
    { metric: 'all.precision', before: null, after: 1, delta: null },
    { metric: 'all.recall', before: 0.5, after: 0.75, delta: 0.25 },
    { metric: 'calls', before: 2, after: 1, delta: -1 },
    { metric: 'exitCodes.0', before: 1, after: 0, delta: -1 },
    { metric: 'exitCodes.2', before: 0, after: 1, delta: 1 },
  ]);
});
