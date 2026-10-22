import { fastest } from '../helpers/timing.js';
import { expect, it } from 'vitest';
import { compareApi, scanExports } from '../../src/refactor/api.js';
import { compareTests } from '../../src/refactor/index.js';
import { refactorMarkdown, refactorSarif, type RefactorReport } from '../../src/reporters/refactor.js';

const compare = (before: string, after = before) =>
  compareApi(new Map([['sample.ts', before]]), new Map([['sample.ts', after]]));

it.each([
  ['arrow return type', 'export default (): (x: number) => string => x => "";',
    'export default (): (x: number) => number => x => 1;'],
  ['local variable', 'const x: number = 1; export { x };', 'const x: string = "a"; export { x };'],
  ['local function', 'function f(a) {} export { f };', 'function f(a, b) {} export { f };'],
  ['class parameter', 'export class S { run(a: number): number { return a; } }',
    'export class S { run(a: number, b: number): number { return a; } }'],
  ['class removal', 'export class S { run(); stop(); }', 'export class S { run(); }'],
  ['enum removal', 'export enum E { A = 1, B = 2 }', 'export enum E { A = 1 }'],
])('closes reproduced silent miss: %s', (_name, before, after) => {
  expect(compare(before, after)).toMatchObject({ breaking: true, incomplete: false });
});
it.each([
  ['arrow body', 'export const fn = (a: number) => a + 1;', 'export const fn = (a: number) => a + 2;'],
  ['value', 'export const value = 1;', 'export const value = 2;'],
  ['method body', 'export class S { run() { return 1; } }', 'export class S { run() { return 2; } }'],
  ['comment', 'export class S { run(); }', 'export /* comment */ class S { run(); /* stop(); */ }'],
])('does not confuse implementation with API: %s', (_name, before, after) => {
  expect(compare(before, after)).toMatchObject({ changes: [], incomplete: false, notes: [] });
});
it('keeps multiline interfaces and additive exports working', () => {
  expect(compare('export interface I {\n a: number;\n}', 'export interface I {\n a: string;\n}').breaking).toBe(true);
  expect(compare('', 'export const added = 1;')).toMatchObject({ breaking: false, incomplete: false });
});
it('does not hide an enum change behind an added export', () => {
  const api = compare('export enum E { A = 1, B = 2 }', 'export enum E { A = 1 }\nexport const added = 1;');
  expect(api.breaking).toBe(true);
  expect(api.changes).toContainEqual(expect.objectContaining({ name: 'E.B', kind: 'removed' }));
});
it('does not hide an unexplained line behind a recognised change in the same file', () => {
  const api = compare('export mystery Alpha;', 'export mystery Beta;\nexport const added = 1;');
  expect(api.incomplete).toBe(true);
  expect(api.notes.join('\n')).toContain('sample.ts: export-related lines changed but no API change was recognised for: export mystery');
});
it.each([
  ['add', 'run();', 'run(); stop();', 'stop', 'added', false],
  ['remove', 'run(); stop();', 'run();', 'stop', 'removed', true],
  ['type', 'value: number;', 'value: string;', 'value', 'changed', true],
  ['parameter', 'run(a: number);', 'run(a: number, b: number);', 'run', 'changed', true],
  ['static', 'run();', 'static run();', 'run', 'changed', true],
  ['readonly', 'value: number;', 'readonly value: number;', 'value', 'changed', true],
  ['protected', 'run();', 'protected run();', 'run', 'changed', true],
  ['optional', 'value: number;', 'value?: number;', 'value', 'changed', true],
  ['async', 'run() {}', 'async run() {}', 'run', 'changed', true],
  ['accessor', 'get value(): number {}', 'get value(): string {}', 'value', 'changed', true],
  ['abstract', 'run(): void;', 'abstract run(): void;', 'run', 'changed', true],
  ['overload', 'run(a: string); run(a: number);', 'run(a: number);', 'run', 'removed', true],
  ['duplicate', 'run(); run();', 'run();', 'run', 'removed', true],
])('compares class members: %s', (_label, before, after, member, kind, breaking) => {
  const api = compare(`export abstract class S { ${before} }`, `export abstract class S { ${after} }`);
  expect(api).toMatchObject({ breaking, incomplete: false });
  expect(api.changes).toContainEqual(expect.objectContaining({ name: `S.${member}`, kind, breaking }));
});
it.each([
  ['private value: number;', 'private value: string;'],
  ['#value: number;', '#value: string;'],
  ['private run(a: number) {}', 'private run(a: string, b: string) {}'],
  ['run() { return { a: 1 }; }', 'run() { return { b: 2 }; }'],
  ['value: number = 1;', 'value: number = 2;'],
  ['run(); stop();', 'stop(); run();'],
  ['run(a: string); run(a: number);', 'run(a: number); run(a: string);'],
])('ignores non-API class differences: %s', (before, after) => {
  expect(compare(`export class S { ${before} }`, `export class S { ${after} }`))
    .toMatchObject({ changes: [], incomplete: false });
});
it.each([
  ['A = 1, B = 2', 'A = 1', 'B', 'removed', true],
  ['A = 1', 'A = 1, B = 2', 'B', 'added', false],
  ['A = 1', 'A = 2', 'A', 'changed', true],
])('compares enum members: %s', (before, after, name, kind, breaking) => {
  expect(compare(`export enum E { ${before} }`, `export enum E { ${after} }`))
    .toMatchObject({ breaking, incomplete: false, changes: [expect.objectContaining({ name: `E.${name}`, kind })] });
});
it('ignores enum order', () => {
  expect(compare('export enum E { A = 1, B = 2 }', 'export enum E { B = 2, A = 1 }'))
    .toMatchObject({ changes: [], incomplete: false });
});
it.each(['interface I', 'type I ='])('compares type members as multisets: %s', declaration => {
  const before = `export ${declaration} { a: number; b: string; }`;
  expect(compare(before, `export ${declaration} { b: string; a: number; }`).changes).toEqual([]);
  expect(compare(before, `export ${declaration} { a: number; }`).changes)
    .toContainEqual(expect.objectContaining({ name: 'I.b', kind: 'removed' }));
});
it.each(['namespace', 'module'])('recursively skeletonizes exported %s members', kind => {
  const before = `export ${kind} N { export namespace Inner { export class S { run() { return 1; } stop(); } } const hidden = 1; }`;
  expect(compare(before, before.replace('return 1', 'return 2').replace('hidden = 1', 'hidden = 2')))
    .toMatchObject({ changes: [], incomplete: false });
  expect(compare(before, before.replace('stop();', '')).changes)
    .toContainEqual(expect.objectContaining({ name: 'N.Inner.S.stop', kind: 'removed' }));
});
it.each(['export { x };', 'export { x as y };', 'export default x;'])('resolves local binding: %s', tail => {
  expect(compare(`const x: number = 1; ${tail}`, `const x: string = "a"; ${tail}`))
    .toMatchObject({ breaking: true, incomplete: false });
});
it.each([
  'declare function x(a: number): void;', 'abstract class x { run(a: number); }',
  'let x: number = 1;', 'var x: number = 1;', 'type x = number;',
  'interface x { value: number; }', 'enum x { A = 1, B = 2 }', 'namespace x { export const value: number = 1; }',
])('resolves declaration behind a list: %s', declaration => {
  const after = declaration.includes('B = 2') ? declaration.replace(', B = 2', '') : declaration.replace('number', 'string');
  expect(compare(`${declaration} export { x };`, `${after} export { x };`).breaking).toBe(true);
});
it('resolves imported bindings and reports missing ones', () => {
  expect(compare("import { x } from './a'; export { x };", "import { x } from './b'; export { x };"))
    .toMatchObject({ breaking: true, incomplete: false });
  expect(scanExports('export { missing };')[0]?.signature).toContain('<unresolved>');
  expect(compare('export { missing };')).toMatchObject({ incomplete: true, notes: [expect.stringContaining('missing')] });
});
it('does not resolve nested declarations as top-level bindings', () => {
  expect(compare('function outer() { const x = 1; } export { x };').incomplete).toBe(true);
});
it.each([
  ['generic class', 'export class S<T extends { value: number }> { run(); stop(); }', 'stop();', ''],
  ['generic interface', 'export interface I<T extends { value: number }> { run(); stop(); }', 'stop();', ''],
  ['local overload', 'function f(a: number): number;\nfunction f(a: string): string;\nexport { f };',
    'function f(a: string): string;', ''],
  ['multiple locals', 'const a = 1, x: number = 1; export { x };', 'x: number', 'x: string'],
  ['multiline local', 'const x =\n  1;\nconst y: number = 2;\nexport { y };', 'y: number', 'y: string'],
  ['unterminated default statement', 'const x: number = 1;\nexport default x\nconst internal = 1;', 'x: number', 'x: string'],
  ['namespace list', 'export namespace N { class S { run(); stop(); } export { S }; }', 'stop();', ''],
  ['namespace multiple variables', 'export namespace N { export const a = 1, b: number = 2; }', 'b: number', 'b: string'],
])('retains complete scoped declarations: %s', (_label, before, from, to) => {
  expect(compare(before, before.replace(from, to))).toMatchObject({ breaking: true, incomplete: false });
});
it.each([
  ['static private', 'export class S { static #x: number = 1; }', 'number = 1', 'string = "a"'],
  ['static initializer', 'export class S { static { initialize(1); } }', '(1)', '(2)'],
  ['nested namespace', 'namespace Internal { export const value: number = 1; }', 'number', 'string'],
  ['nested templates', 'export class S { run() { const x = `outer ${`inner ${ { x: "}" } }`} tail`; } stop(); }', 'tail', 'changed'],
  ['curried arrow body', 'export default (a: number) => (b: number) => b + 1;', 'b: number', 'b: string'],
])('ignores non-public or implementation-only changes: %s', (_label, before, from, to) => {
  expect(compare(before, before.replace(from, to))).toMatchObject({ changes: [], incomplete: false });
});
it('does not lose a class method after a nested template literal', () => {
  const before = 'export class S { run() { const x = `outer ${`inner {{{ ${ { x: "}" } }`} tail`; } stop(); }';
  const api = compare(before, before.replace('stop();', ''));
  expect(api.incomplete).toBe(false);
  expect(api.changes)
    .toContainEqual(expect.objectContaining({ name: 'S.stop', kind: 'removed' }));
});
it.each([
  ['anonymous default class', 'export default class { run(); stop(); }', 'stop();', ''],
  ['generic object alias', 'export type T<X> = { a: X; b: number; };', 'b: number;', ''],
  ['object intersection', 'export type T = { a: number } & { b: string };', 'b: string', 'b: number'],
  ['namespace alias', 'export namespace N { class S {} export { S as Before }; }', 'as Before', 'as After'],
])('retains skeleton identity and full type: %s', (_label, before, from, to) => {
  expect(compare(before, before.replace(from, to))).toMatchObject({ breaking: true, incomplete: false });
});
it('caps namespace declarations with no bodies using the shared skeleton budget', () => {
  const api = compare(`export namespace N { ${Array.from({ length: 2000 }, (_, i) => `export const x${i}: number;`).join(' ')} }`);
  expect(api.incomplete).toBe(true);
  expect(api.notes.join(' ')).toContain('8000');
});
it.each(['main', 'module', 'types', 'typings', 'exports', 'imports', 'bin', 'version', 'type', 'engines', 'files',
  'sideEffects', 'browser', 'typesVersions', 'peerDependencies', 'workspaces'])('compares package field %s', field => {
  expect(compareApi(new Map(), new Map(), { [field]: { a: ['before'] } }, { [field]: { a: ['after'] } }))
    .toMatchObject({ breaking: true, packageChanges: [{ field, before: { a: ['before'] }, after: { a: ['after'] } }] });
  expect(compareApi(new Map(), new Map(), { [field]: { a: 1, b: [2] } }, { [field]: { b: [2], a: 1 } }).packageChanges).toHaveLength(['exports', 'imports', 'typesVersions'].includes(field) ? 1 : 0);
});
it('reports added, removed and changed members in Markdown and SARIF', () => {
  const api = compare('export class S { old(); run(a: number); }', 'export class S { fresh(); run(a: string); }');
  const passing = { runner: 'vitest' as const, tests: [], suiteErrors: [] };
  const report: RefactorReport = { api, tests: compareTests(passing, passing), available: true, reasons: [], summary: '',
    blastRadius: { dependents: [], withoutTests: [], notes: [] }, verdict: 'NOT EQUIVALENT', allowApiChange: false, modelReview: false };
  for (const output of [refactorMarkdown(report).join('\n'), JSON.stringify(refactorSarif(report))]) {
    for (const name of ['S.old', 'S.fresh', 'S.run']) expect(output).toContain(name);
    for (const kind of ['added', 'removed', 'changed']) expect(output).toContain(kind);
  }
});
it('compares skeletons past 2000 characters and discloses the 8000-character cap', () => {
  const before = `export class S { ${'a: string; '.repeat(250)} last: string; }`;
  expect(compare(before, before.replace('last: string', 'last: number')))
    .toMatchObject({ breaking: true, incomplete: false });
  expect(scanExports(before)[0]?.signature).toHaveLength(300);
  const capped = compare(`export class S { ${'a: string; '.repeat(1000)} }`);
  expect(capped.incomplete).toBe(true);
  expect(capped.notes.join(' ')).toContain('8000');
});
const pad = (text: string) => text.slice(0, 256 * 1024).padEnd(256 * 1024);
it.each([
  ['50000 members', pad('export class X {' + 'a();'.repeat(50000) + '}')],
  ['10000 levels', pad('export class X { run() {' + '{'.repeat(10000) + '}'.repeat(10000) + '} }')],
  ['unclosed', pad('export class X {')],
  // Repeated exports would expand a 64 KiB declaration past 3 MB without a shared capture budget.
  ['expansion', pad('class X {' + 'a();'.repeat(16000) + '}\nexport { ' + Array.from({ length: 50 }, (_, i) => `X as X${i}`).join(',') + ' };')],
  ['commas', pad('export class X {' + ','.repeat(256 * 1024))],
  ['quoted braces', pad('export class X { value: "{ }"; run() { const a = "}"; const b = `x ${ { a: "}" } }`; } }')],
])('bounds adversarial skeleton capture: %s', (_label, source) => {
  expect(fastest(() => { compare(source); })).toBeLessThan(300);
});
