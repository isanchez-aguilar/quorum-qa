import { fastest } from '../helpers/timing.js';
import { expect, it } from 'vitest';
import { compareApi } from '../../src/refactor/api.js';
const C = (body: string) => `export class S {\n${body}\n}`;
const compare = (before: string, after = before) => compareApi(new Map([['sample.ts', before]]), new Map([['sample.ts', after]]));
it.each([
  ['typed', '  handler = (a: number): number => a + 1;', '  handler = (a: string): string => a;'],
  ['untyped', '  handler = (a) => a;', '  handler = (a, b) => a;'],
  ['async', '  handler = async (a: number) => a;', '  handler = async (a: string) => a;'],
  ['generic', '  handler = <T>(a: T): T => a;', '  handler = <T>(a: T, b: T): T => a;'],
])('retains class arrow signatures: %s', (_label, before, after) => {
  expect(compare(C(before), C(after)).changes).toContainEqual(expect.objectContaining({ name: 'S.handler', kind: 'changed' }));
});
it.each(['    doSomething();\n', ''])('keeps members after statement-start regex: %s', prefix => {
  const body = `  run(): void {\n${prefix}    /}/.test("x");\n  }`;
  expect(compare(C(body + '\n  stop(): void;'), C(body)).changes).toContainEqual(expect.objectContaining({ name: 'S.stop', kind: 'removed' }));
});
it('ignores regex method body changes (Q3)', () => {
  const before = C('  run(): void {\n    /}/.test("x");\n  }');
  expect(compare(before, before.replace('"x"', '"y"'))).toMatchObject({ changes: [], notes: [], incomplete: false });
});
it.each([
  ['Props', 'Button', 'interface Props {\n  label: string;\n}\nexport function Button(props: Props) {\n  return props.label;\n}', 'label: string', 'label: number'],
  ['Opts', 'make', 'type Opts = { a: number };\nexport const make = (o: Opts) => o;', 'a: number', 'a: string'],
  ['Mode', 'pick', 'enum Mode { A = 1 }\nexport function pick(m: Mode) { return m; }', 'A = 1', 'A = 2'],
  ['Model', 'pick', 'class Model { a: number; }\nexport function pick(m: Model) { return m; }', 'a: number', 'a: string'],
])('tracks referenced local %s', (local, name, before, from, to) => {
  expect(compare(before, before.replace(from, to)).changes).toContainEqual(expect.objectContaining({ name, kind: 'changed', detail: `uses ${local}, which changed` }));
});
it.each(['as const', 'satisfies Record<string, string>'])('retains object initializer with %s', suffix => {
  expect(compare(`export const routes = { home: '/' } ${suffix};`, `export const routes = { home: '/', about: '/a' } ${suffix};`).breaking).toBe(true);
});
it.each(['global', "module 'x'"])('tracks declare %s augmentation', name => {
  const before = `declare ${name} { interface Window { label: string; } }`;
  const api = compare(before, before.replace('string', 'number'));
  expect(api.changes.length > 0 || api.incomplete && api.notes.length > 0).toBe(true);
});
it.each([
  [C('handler = (a: number): number => a + 1;'), C('handler = (a: number): number => a + 2;')],
  [C('handler = async <T>(a: T) => { return a; };'), C('handler = async <T>(a: T) => { return [a]; };')],
  ['export const fn = (a: number) => a + 1;', 'export const fn = (a: number) => a + 2;'],
  ['export const value = 1;', 'export const value = 2;'],
  ['type Unused = {a: number}; export const k = 1;', 'type Unused = {a: string}; export const k = 1;'],
  [C('run() { return a / 2 / 3; }'), C('run() { return a / 2 / 4; }')],
])('keeps implementation-only changes quiet: %s', (before, after) => {
  expect(compare(before, after)).toMatchObject({ changes: [], notes: [], incomplete: false });
});
it.each([
  [C('@Route({ public: true })\nrun(): void;'), C('@Route({ public: false })\nrun(): void;')],
  [C('run(a: number = 1): number;'), C('run(a: number = 1): string;')],
])('preserves decorator/default parameter coverage: %s', (before, after) => expect(compare(before, after).breaking).toBe(true));
it('follows local references transitively and stops cycles', () => {
  const before = 'type A = { b: B }; type B = { a: A; value: number }; export function f(a: A) {}';
  expect(compare(before, before.replace('value: number', 'value: string')).breaking).toBe(true);
  expect(compare(before)).toMatchObject({ changes: [], notes: [], incomplete: false });
});
it('reports the local reference depth cap', () => {
  const before = 'type A = B; type B = C; type C = D; type D = E; type E = F; type F = number; export function f(a: A) {}';
  expect(compare(before)).toMatchObject({ incomplete: true });
  expect(compare(before).notes.join(' ')).toContain('depth');
});
it('reports the object signature cap', () => {
  const source = `export const routes = { home: '${'x'.repeat(8100)}' } as const;`;
  expect(compare(source)).toMatchObject({ incomplete: true });
  expect(compare(source).notes.join(' ')).toContain('8000');
});
it.each([
  C('run() {\n' + '/}/.test(x);\n'.repeat(50000) + '}\nstop(): void;'),
  'type T = ' + '{ a: '.repeat(10000) + 'number' + ' }'.repeat(10000) + '; export function f(a: T) {}',
])('bounds adversarial scanning', source => {
  expect(fastest(() => { compare(source); })).toBeLessThan(300);
});
it('retains ambiguous callable return types with explicit incomplete coverage', () => {
  const before = C('handler = (): (x: number) => string => x => "";');
  const api = compare(before, before.replace('=> string', '=> number'));
  expect(api.breaking).toBe(true);
  expect(api.incomplete).toBe(true);
  expect(api.notes.join(' ')).toContain('ambiguous');
});
it('keeps a multiline arrow body quiet and retains the next member', () => {
  const before = C('handler = (a: number): number =>\n { return a + 1; };\nstop(): void;');
  expect(compare(before, before.replace('+ 1', '+ 2'))).toMatchObject({ changes: [], incomplete: false });
  expect(compare(before, before.replace('stop(): void;', '')).changes).toContainEqual(expect.objectContaining({ name: 'S.stop', kind: 'removed' }));
});
it('does not match quoted substrings or unrelated identifier prefixes to local types', () => {
  const before = 'type Prop = number; export function f(value: "Prop", prop: Property) {}';
  expect(compare(before, before.replace('= number', '= string'))).toMatchObject({ changes: [], incomplete: false });
});
it('bounds a chain of 10000 local types', () => {
  const source = 'export function f(x: T0) {}\n' + Array.from({ length: 10000 }, (_, i) => `type T${i}=T${i + 1};`).join('');
  expect(fastest(() => { expect(compare(source).incomplete).toBe(true); })).toBeLessThan(300);
});
it('retains generic return annotations containing commas', () => {
  const before = C('handler = (a: number): Map<string, number> => new Map();');
  expect(compare(before, before.replace('Map<string, number>', 'Map<string, string>')).changes)
    .toContainEqual(expect.objectContaining({ name: 'S.handler', kind: 'changed' }));
  expect(compare(before, before.replace('new Map()', 'buildMap()'))).toMatchObject({ changes: [], incomplete: false });
});
