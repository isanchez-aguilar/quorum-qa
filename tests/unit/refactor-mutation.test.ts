import { expect, it } from 'vitest';
import { changedLines, generateMutants, selectMutants } from '../../src/refactor/mutation.js';

it('reads head lines, renames, spaces, no-newline markers and multiple hunks', () => {
  const diff = 'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n+++ b/new.ts\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+added\n\\ No newline at end of file\n@@ -8 +9 @@\n-old\n+new\ndiff --git a/a b/a\n+++ "b/a space.ts"\n@@ -0,0 +1 @@\n+x\n';
  expect([...changedLines(diff)].map(([file, lines]) => [file, [...lines]])).toEqual([['new.ts', [2, 3, 9]], ['a space.ts', [1]]]);
  expect(changedLines('+++ /dev/null\n@@ -1 +0,0 @@\n-old\n')).toEqual(new Map());
  expect(changedLines('Binary files a/x and b/x differ')).toEqual(new Map());
  expect(changedLines('')).toEqual(new Map());
});
it.each([
  ['a === b', '===', '!=='], ['a !== b', '!==', '==='], ['a == b', '==', '!='], ['a != b', '!=', '=='],
  ['a < 2', '<', '<='], ['a <= 2', '<=', '<'], ['a > 2', '>', '>='], ['a >= 2', '>=', '>'],
  ['a && b', '&&', '||'], ['a || b', '||', '&&'], ['true', 'true', 'false'], ['false', 'false', 'true'],
  ['a + b', '+', '-'], ['a - b', '-', '+'], ['0', '0', '1'], ['1', '1', '0'], ['42', '42', '43'],
  ['return value;', 'return value;', 'return undefined;'], ['return { value: 2 };', 'return { value: 2 };', 'return undefined;'], ['if (a && (b)) run();', 'if (a && (b))', 'if (!(a && (b)))'],
])('mutates one safe spot in %s', (content, before, after) => {
  const mutant = generateMutants('a.ts', content, new Set([1])).find(item => item.before === before);
  expect(mutant).toMatchObject({ before, after, line: 1 });
  expect(mutant!.text).toBe(content.slice(0, mutant!.column - 1) + after + content.slice(mutant!.column - 1 + before.length));
});
it.each(['"true + 1"', "'false === 0'", '`true + 1`', '// true + 1', '/* false */', '/true+1/.test(x)',
  'import x from "x";', 'type X = true;', 'interface X { a: true }', 'export type X = false;', 'export { x } from "x";',
  'declare const x: true;', '@decorator(true)', 'Array<number>', 'fn<Type>(x)', 'x++', 'x += y', 'x => x', '-x', 'return;', 'return undefined;'])('skips %s', content => {
  expect(generateMutants('a.ts', content, new Set([1]))).toEqual([]);
});
it('is deterministic, changed-line only, excludes tests, and round-robins operators', () => {
  const content = 'a === b && true;\nreturn 42;';
  const candidates = generateMutants('a.ts', content, new Set([1]));
  expect(candidates.every(item => item.line === 1)).toBe(true);
  expect(selectMutants(candidates, 2)).toEqual(selectMutants(generateMutants('a.ts', content, new Set([1])), 2));
  expect(new Set(selectMutants(candidates, 3).map(item => item.operator)).size).toBe(3);
  expect(selectMutants(candidates, 2)).toHaveLength(2);
  expect(generateMutants('a.test.ts', content, new Set([1]))).toEqual([]);
});
it('bounds adversarial scanning without materializing every mutated file', () => {
  // A 300 ms wall-clock bound was flaky under full-suite load (317 ms seen; about 70 ms alone).
  // Check the work deterministically instead: one candidate per operator, and mutated text built
  // only on demand. The loose time ceiling still catches a quadratic scan, which takes minutes here.
  const cases: Array<[string, number]> = [[('a+').repeat(100000), 99999], ['"' + 'a+'.repeat(100000), 0], ['`' + 'a+'.repeat(100000), 0]];
  for (const [text, candidates] of cases) {
    const content = text.padEnd(256 * 1024);
    const start = performance.now();
    const mutants = generateMutants('a.ts', content, new Set([1]));
    expect(performance.now() - start).toBeLessThan(5000);
    expect(mutants).toHaveLength(candidates);
    expect(mutants.every(item => typeof Object.getOwnPropertyDescriptor(item, 'text')?.get === 'function')).toBe(true);
    expect(mutants.slice(0, 25).every(item => item.text.length <= 256 * 1024)).toBe(true);
  }
  expect(generateMutants('a.ts', 'a'.repeat(256 * 1024 + 1), new Set([1]))).toEqual([]);
});

it('decodes Git octal UTF-8 paths and does not treat added headers as metadata', () => {
  expect([...changedLines('+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1,2 @@\n++++ b/fake.ts\n+true\n')])
    .toEqual([['café.ts', new Set([1, 2])]]);
});
it('selection is independent of candidate input order and capped at 25', () => {
  const candidates = generateMutants('a.ts', Array.from({ length: 40 }, () => 'x = true;').join('\n'), new Set(Array.from({ length: 40 }, (_, i) => i + 1)));
  expect(selectMutants(candidates, 25)).toEqual(selectMutants([...candidates].reverse(), 25));
  expect(selectMutants(candidates, 100)).toHaveLength(25);
});
it('does not interpret prototype names or logical assignments as operators', () => {
  expect(generateMutants('a.ts', 'constructor; toString; a &&= b; a ||= b;', new Set([1]))).toEqual([]);
});
it('keeps mutated UTF-8 bytes within the API cap', () => {
  const content = 'true;' + ' '.repeat(256 * 1024 - 5);
  expect(generateMutants('a.ts', content, new Set([1]))).toEqual([]);
});
