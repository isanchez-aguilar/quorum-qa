import { expect, it } from 'vitest';
import { compareApi, scanExports } from '../../src/refactor/api.js';
import { compareTests, type RefactorEvidence } from '../../src/refactor/index.js';
import { evaluateRefactorVerdict } from '../../src/cli/refactor.js';
import { refactorMarkdown } from '../../src/reporters/refactor.js';
import { USAGE } from '../../src/cli/index.js';

const compare = (before: string, after = before, file = 'sample.ts') =>
  compareApi(new Map([[file, before]]), new Map([[file, after]]));
const passing = { runner: 'vitest' as const, tests: [{ file: 'sample.test.ts', name: 'works', status: 'passed' as const }], suiteErrors: [] };
const evidence = (api: ReturnType<typeof compareApi>): RefactorEvidence => ({
  available: true, reasons: [], summary: '', api, tests: compareTests(passing, passing),
  blastRadius: { dependents: [], withoutTests: [], notes: [] },
});
const cascade = { findings: [], unconfirmed: [], errors: [], coverage: {
  reviewedFiles: [], skippedFiles: [], truncatedHunks: [], binaryFiles: [], lostFindings: [], complete: true,
} };

it.each([';', ''])('captures a next-line union body with terminator %j', terminator => {
  const before = `export type Mode =\n  | 'a'\n  | 'b'${terminator}`;
  expect(compare(before, `export type Mode =\n  | 'a'${terminator}`)).toMatchObject({
    breaking: true, incomplete: false, changes: [expect.objectContaining({ name: 'Mode', kind: 'changed' })],
  });
});
it('caps next-line type bodies explicitly', () => {
  const api = compare("export type Mode =\n | 'a'" + " | 'b'".repeat(500));
  expect(api.incomplete).toBe(true);
  expect(api.notes.join(' ')).toContain('2000 characters');
});
it.each(["exports['alpha']", 'exports["alpha"]', "module.exports['alpha']", 'module.exports["alpha"]'])
('understands literal bracket assignment %s', target => {
  const api = compare(`${target} = 1;\nexports['beta'] = 2;`, "exports['beta'] = 2;");
  expect(api).toMatchObject({ incomplete: false, changes: [expect.objectContaining({ name: 'alpha', kind: 'removed' })] });
});
it.each(['module.exports', 'exports'])('understands Object.assign(%s, object)', target => {
  const api = compare(`Object.assign(${target}, { a, b, c: d });`, `Object.assign(${target}, { a, c: d });`);
  expect(api).toMatchObject({ incomplete: false, changes: [expect.objectContaining({ name: 'b', kind: 'removed' })] });
});
it.each(['', 'async '])('ignores default %sarrow bodies but compares parameters and return types', async => {
  const before = `export default ${async}(a: number) => { return a + 1; };`;
  expect(compare(before, before.replace('+ 1', '+ 2'))).toMatchObject({ changes: [], incomplete: false });
  expect(compare(before, before.replace('a: number', 'a: string')).breaking).toBe(true);
  const annotated = before.replace(') =>', '): number =>');
  expect(compare(annotated, annotated.replace('): number', '): string')).breaking).toBe(true);
  expect(compare(`export default ${async}(a: number) => a + 1;`,
    `export default ${async}(a: number) => a + 2;`)).toMatchObject({ changes: [], incomplete: false });
});
it('makes an unrecognised API miss visible per file, even beside a recognised change', () => {
  const before = 'export { x as default };\nexport declare const enum Odd { ??? a }';
  const after = before.replace('??? a', '??? b');
  const api = compareApi(new Map([['unknown.ts', before], ['known.ts', 'export const x = 1;']]),
    new Map([['unknown.ts', after], ['known.ts', 'export const y = 1;']]));
  expect(api.incomplete).toBe(true);
  expect(api.unscanned).toContain('unknown.ts');
  expect(api.notes).toContain('export-related lines changed but no API change was recognised: unknown.ts');
  expect(evaluateRefactorVerdict(evidence(compare(before, after)), cascade).verdict).toBe('SUSPECT');
});
it('does not add safety-net noise for a recognised change', () => {
  expect(compare('export const a = 1;', 'export const b = 1;').notes).toEqual([]);
});
it('ignores whitespace and comments in both signatures and the safety net', () => {
  const before = 'export type Mode = string;\nexport declare const enum Odd { ??? a }';
  const after = ' export /* comment */ type Mode=string; // trailing\n export declare const enum Odd { /* note */ ??? a }';
  expect(compare(before, after)).toMatchObject({ changes: [], incomplete: false, notes: [] });
  expect(compare(before, before.replace('??? a', '???\n a'))).toMatchObject({ changes: [], incomplete: false });
  expect(compare('export function f(a: number): string;',
    'export function f(a: number) // comment\n: string;')).toMatchObject({ changes: [], incomplete: false });
  expect(compare('export function f(a: number) // comment\n: string;',
    'export function f(a: number) // comment\n: number;').breaking).toBe(true);
});
it.each([
  ['overloads', 'export function f(a: number): number;\nexport function f(a: string): string;', 'a: string', 'a: boolean'],
  ['abstract', 'export abstract class A extends B {}', 'extends B', 'extends C'],
  ['const enum', 'export const enum A {}', 'enum A', 'enum B'],
  ['export assignment', 'export = Foo;', 'Foo', 'Bar'],
  ['CommonJS dotted', 'exports.foo = 1; module.exports.bar = 2;', 'exports.foo', 'exports.baz'],
  ['multiline signature', 'export function f(\n a: number\n): string {}', 'a: number', 'a: string'],
])('preserves existing comparison support: %s', (_name, source, from, to) => {
  expect(compare(source, source.replace(from, to))).toMatchObject({ breaking: true, incomplete: false });
});
it.each([
  ['export type Mode =\n  string;', 'string', 'number'],
  ['export type Mode = A\n & B;', '& B', '& C'],
  ['export type Mode = A extends B\n ? C\n : D;', ': D', ': E'],
  ['export type Mode = A\n.B;', '.B', '.C'],
  ['export type Mode = ()\n => string;', 'string', 'number'],
  ['export type Mode =\n { a: string };', 'string', 'number'],
  ['export type Mode = A\n [number];', 'number', 'string'],
])('retains type continuation tokens: %s', (source, from, to) => {
  expect(compare(source, source.replace(from, to)).breaking).toBe(true);
});
it('stops an unterminated type before the next declaration', () => {
  const before = "export type Mode =\n | 'a'\nconst implementation = 1;";
  expect(compare(before, before.replace('= 1', '= 2'))).toMatchObject({ changes: [], incomplete: false });
});
it.each([
  'export type Mode =\n' + '| '.repeat(128 * 1024),
  'exports['.repeat(32768),
  'Object.assign(module.exports, {' + ','.repeat(256 * 1024),
])('bounds new adversarial capture paths under 300 ms %#', source => {
  const start = performance.now();
  compare(source.slice(0, 256 * 1024));
  expect(performance.now() - start).toBeLessThan(300);
});

it.each([
  ['export abstract class BaseService { }', 'BaseService'],
  ['export default abstract class BaseService { }', 'default'],
  ['export const enum Direction { Up }', 'Direction'],
  ['export declare function declared(x: number): void;', 'declared'],
  ['export = Foo;', 'export='],
  ['export import x = require("x");', 'x'],
  ['export import A = B.C;', 'A'],
  ['export as namespace X;', 'X'],
])('recognizes %s', (source, name) => {
  expect(scanExports(source).map(item => item.name)).toEqual([name]);
});
it.each([
  ['export = Foo;', 'export = Bar;'],
  ['export import x = require("x");', 'export import x = require("y");'],
  ['export import A = B.C;', 'export import A = B.D;'],
  ['export type Token = string;', 'export type Token = number;'],
  ['export interface I { a: string; }', 'export interface I { a: number; }'],
  ['export const x: { a: string } = value;', 'export const x: { a: number } = value;'],
  ['export function calculate(\n  a: number,\n  b: string\n): boolean {', 'export function calculate(\n  a: number,\n  b: string,\n  c: number\n): boolean {'],
])('compares complete types and headers: %s', (before, after) => {
  expect(compare(before, after).changes).toContainEqual(expect.objectContaining({ kind: 'changed', breaking: true }));
});
it('keeps nested groups, literals and comments from ending declaration headers', () => {
  const before = 'export function f<T extends { x: string }>(\n a: [T, "]"], /* ) { */\n b: `literal { )`\n): boolean {';
  expect(scanExports(before)[0]?.signature).toContain('): boolean');
  expect(compare(before, before.replace('b:', 'c:')).breaking).toBe(true);
  expect(compare('export const x: string = "a";', 'export const x: string = "b";').changes).toEqual([]);
});
it.each([
  ['export const callback: (x: string) => number = fn;', 'export const callback: (x: string) => boolean = fn;'],
  ['export interface I<T extends { x: string }> { value: string; }', 'export interface I<T extends { x: string }> { value: number; }'],
  ['export const a =\n value, b: string = value;', 'export const a =\n value, b: number = value;'],
])('preserves nested annotation boundaries: %s', (before, after) => {
  expect(compare(before, after).breaking).toBe(true);
});
it('does not silently drop partially understood exports', () => {
  for (const source of ['export const { a } = obj;', 'module.exports = { a, ...rest };',
    'exports.a = fn; module.exports[key] = value;']) {
    const api = compare(source);
    expect(api.incomplete).toBe(true);
    expect(evaluateRefactorVerdict(evidence(api), cascade).verdict).toBe('SUSPECT');
  }
});
it('compares beyond the 300-character display limit', () => {
  const before = `export type Token = { ${'a: string; '.repeat(35)} last: string };`;
  expect(scanExports(before)[0]?.signature).toHaveLength(300);
  expect(compare(before, before.replace('last: string', 'last: number')).breaking).toBe(true);
});

const overloads = ['export function parse(x: string): string;', 'export function parse(x: number): number;',
  'export function parse(x: string | number) { return x; }'];
it('reports a removed overload with its signature and before/after counts', () => {
  const api = compare(overloads.join('\n'), overloads.slice(1).join('\n'));
  expect(api.changes).toHaveLength(1);
  expect(api.changes[0]).toMatchObject({ kind: 'removed', before: overloads[0]!.slice(0, -1), breaking: true });
  const text = refactorMarkdown({ ...evidence(api), verdict: 'NOT EQUIVALENT', allowApiChange: false, modelReview: false }).join('\n');
  expect(text).toContain('overloads: 3 before, 2 after');
});
it('reports a changed overload even if the implementation is unchanged', () => {
  expect(compare(overloads.join('\n'), overloads.join('\n').replace('x: string): string', 'x: boolean): boolean')).changes)
    .toContainEqual(expect.objectContaining({ kind: 'changed', breaking: true }));
});
it('compares overloads as a multiset, independent of order and including duplicates', () => {
  expect(compare(overloads.join('\n'), [...overloads].reverse().join('\n')).changes).toEqual([]);
  expect(compare([...overloads, overloads[0]].join('\n'), overloads.join('\n')).breaking).toBe(true);
});

it.each(['.js', '.cjs', '.mjs', '.ts'])('scans CommonJS forms in %s', extension => {
  const source = `module.exports = { add, double }; exports.foo = function () {};`;
  expect(compare('', source, 'sample' + extension).changes.map(change => change.name)).toEqual(['add', 'double', 'foo']);
});
it.each([
  ['module.exports = Foo;', ['module.exports']],
  ['module.exports = { a, b: c, d() {} };', ['a', 'b', 'd']],
  ['module.exports.name = function (a) {};', ['name']],
  ['exports.foo = function () {};', ['foo']],
  ["Object.defineProperty(exports, 'name', { value: 1 });", ['name']],
  ["Object.defineProperty(module.exports, 'name', { value: 1 });", ['name']],
])('recognizes CommonJS: %s', (source, names) => {
  expect(scanExports(source).map(item => item.name)).toEqual(names);
});
it('reports unknown CommonJS without claiming complete evidence', () => {
  const api = compare("module.exports[key] = value;");
  expect(api).toMatchObject({ incomplete: true });
  expect(api.notes).toContain('CommonJS export form not understood: sample.ts');
  expect(evaluateRefactorVerdict(evidence(api), cascade).verdict).toBe('SUSPECT');
});
it('compares CommonJS arrow headers without including implementation bodies', () => {
  const before = 'exports.f = (x) => { return 1; };';
  expect(compare(before, before.replace('return 1', 'return 2')).changes).toEqual([]);
  expect(compare(before, before.replace('(x)', '(x, y)')).breaking).toBe(true);
});
it.each([
  ['2000 exports', Array.from({ length: 4000 }, (_, i) => `export const x${i} = ${i};`).join('\n')],
  ['256 KiB', ' '.repeat(300 * 1024)],
  ['4096', 'export { ' + 'a,'.repeat(2500) + 'b };'],
  ['2000 characters', 'export type Huge = "' + 'x'.repeat(2100) + '";'],
])('discloses the %s cap and makes the verdict SUSPECT', (cap, source) => {
  const api = compare(source);
  expect(api).toMatchObject({ incomplete: true });
  expect(api.notes.join(' ')).toContain('sample.ts');
  expect(api.notes.join(' ')).toContain(cap);
  const verdict = evaluateRefactorVerdict(evidence(api), cascade);
  expect(verdict.verdict).toBe('SUSPECT');
  expect(verdict.reasons.join(' ')).toContain(cap);
  expect(evaluateRefactorVerdict(evidence(api), cascade, true).verdict).toBe('SUSPECT');
  expect(evaluateRefactorVerdict({ ...evidence(api), available: false }, cascade).verdict).toBe('UNKNOWN');
});
it('reads exports beyond the former 64 KiB cap', () => {
  expect(scanExports(' '.repeat(70 * 1024) + 'export const last = 1;').map(item => item.name)).toEqual(['last']);
});
it.each(['.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.scala', '.dart'])
('discloses unsupported %s sources with passing tests', extension => {
  const file = 'sample' + extension;
  const api = compare('before', 'after', file);
  expect(api).toMatchObject({ unscanned: [file] });
  const reason = `public API not checked for ${file} (language not supported)`;
  expect(api.notes).toContain(reason);
  expect(evaluateRefactorVerdict(evidence(api), cascade)).toMatchObject({ verdict: 'SUSPECT', reasons: expect.arrayContaining([reason]) });
});
it.each([
  'export ' + ' '.repeat(256 * 1024), 'export {' + ','.repeat(256 * 1024),
  'export const value' + 'x'.repeat(256 * 1024), 'import ' + 'a '.repeat(128 * 1024),
  'require(' + ' '.repeat(256 * 1024), '/*' + 'x'.repeat(256 * 1024), '"export ' + 'x'.repeat(256 * 1024),
])('scans adversarial 256 KiB input under 300 ms %#', source => {
  const start = performance.now();
  compare(source);
  expect(performance.now() - start).toBeLessThan(300);
});
it('documents conservative signature comparison in help and the API report', () => {
  expect(USAGE).toContain('optional parameter');
  expect(USAGE).toContain('widening');
  expect(refactorMarkdown({ ...evidence(compare('')), verdict: 'NO BEHAVIOUR CHANGE FOUND', allowApiChange: false, modelReview: false }).join('\n'))
    .toContain('signature changes are reported conservatively; review whether compatible');
});
