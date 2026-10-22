import { fastest } from '../helpers/timing.js';
import { expect, it } from 'vitest';
import { compareApi } from '../../src/refactor/api.js';
const compare = (before: string, after = before) => compareApi(new Map([['sample.ts', before]]), new Map([['sample.ts', after]]));
const namespace = (body: string) => `export namespace API {\n${body}\n}`;
const cls = (body: string) => `export class S {\n${body}\n}`;
it.each(['as const', 'satisfies string[]'])('retains module arrays with %s', suffix => {
  const before = `export const M = ['GET', 'POST'] ${suffix};`;
  expect(compare(before, before.replace(", 'POST'", '')).changes).toContainEqual(expect.objectContaining({ name: 'M', kind: 'changed' }));
});
it('explains every segment of a recognized namespace member change', () => {
  const api = compare(namespace('export const x = 1;'), namespace('export const y = 1;'));
  expect(api.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'API.x', kind: 'removed' }),
    expect.objectContaining({ name: 'API.y', kind: 'added' }),
  ]));
  expect(api).toMatchObject({ notes: [], incomplete: false });
});
it.each(['interface C { t: number; }', 'type C = { t: number; };', 'class C { t: number; }'])('tracks namespace local types: %s', declaration => {
  const before = namespace(`${declaration}\nexport function f(c: C): void {}`);
  expect(compare(before, before.replace('t: number', 't: string')).breaking).toBe(true);
  expect(compare(before, before.replace('t: number', 't: string')).incomplete).toBe(false);
});
it('resolves namespace locals transitively with lexical shadowing', () => {
  const before = 'interface C { outer: number; }\n' + namespace('interface C { t: D; }\ninterface D { t: number; }\nexport namespace Inner {\nexport function f(c: C): void {}\n}');
  expect(compare(before, before.replace('t: number', 't: string')).breaking).toBe(true);
  expect(compare(before, before.replace('outer: number', 'outer: string'))).toMatchObject({ changes: [], incomplete: false });
});
it.each([
  ["{ home: '/' }", "{ home: '/', about: '/a' }", 'as const'],
  ["{ home: '/' }", "{ home: '/', about: '/a' }", 'satisfies Record<string, string>'],
  ["['GET']", "['GET', 'POST']", 'as const'],
  ["['GET']", "['GET', 'POST']", 'satisfies string[]'],
])('retains public class property %s with %s / %s', (from, to, suffix) => {
  expect(compare(cls(`routes = ${from} ${suffix};`), cls(`routes = ${to} ${suffix};`)).changes)
    .toContainEqual(expect.objectContaining({ name: 'S.routes', kind: 'changed' }));
});
it.each([
  [namespace('interface C { t: number; }\nexport function f(): void {}'), 'number', 'string'],
  [cls('count = 0;'), '0', '5'],
  [cls('handler = (a: number) => a + 1;'), '+ 1', '+ 2'],
  [cls("private routes = ['GET'] as const;"), 'GET', 'POST'],
  [cls("#routes = { home: '/' } as const;"), "'/'", "'/a'"],
  [namespace('interface C { t: number; }\nexport function f(c: C): void {}') + '\nexport namespace Other { interface C { t: boolean; } }', 'boolean', 'string'],
])('keeps unrelated or implementation changes quiet: %s', (before, from, to) => {
  expect(compare(before, before.replace(from, to))).toMatchObject({ changes: [], notes: [], incomplete: false });
});
it.each(['export const M = ', 'export class S { routes = '])('reports the retained array cap: %s', prefix => {
  const source = `${prefix}['${'x'.repeat(8100)}'] as const;${prefix.includes('class') ? '}' : ''}`;
  expect(compare(source)).toMatchObject({ incomplete: true });
  expect(compare(source).notes.join(' ')).toContain('8000');
});
it.each([
  `export const M = [${'['.repeat(65520)}0${']'.repeat(65520)}] as const;`,
  namespace('interface C { t: number; }\n' + 'export function f(c: C): void {}\n'.repeat(8000)),
])('bounds adversarial 256 KiB input', input => {
  const source = input.slice(0, 256 * 1024).padEnd(256 * 1024, ' ');
  expect(fastest(() => { compare(source); })).toBeLessThan(300);
});
