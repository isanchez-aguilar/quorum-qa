import { describe, expect, it } from 'vitest';
import { compareTests, defaultRefactorCommand, editedTestFiles, summarizeEvidence } from '../../src/refactor/index.js';
import { compareApi, scanExports } from '../../src/refactor/api.js';
import { parseTestReport } from '../../src/reproduce/evaluate.js';

describe('refactor deterministic evidence', () => {
  it('compares normalized test identities, all transitions, and edited tests', () => {
    const report = (root: string, statuses: Record<string, string>) => parseTestReport({ testResults: [{
      name: `${root}\\src\\a.test.ts`, assertionResults: Object.entries(statuses).map(([title, status]) =>
        ({ title, fullName: `group ${title}`, status, failureMessages: [] })),
    }] }, root)!;
    const compared = compareTests(report('C:\\base', { regression: 'passed', fixed: 'failed', removed: 'passed', both: 'failed', skip: 'passed' }),
      report('C:\\head', { regression: 'failed', fixed: 'passed', added: 'passed', both: 'failed', skip: 'pending' }), ['src/a.test.ts']);
    expect(compared.regressions.map(test => test.name)).toEqual(['group regression']);
    expect(compared.fixed).toHaveLength(1);
    expect(compared.removed).toHaveLength(1);
    expect(compared.added).toHaveLength(1);
    expect(compared.failingBoth).toHaveLength(1);
    expect(compared.skippedChanges).toHaveLength(1);
    expect(compared.editedFiles).toEqual(['src/a.test.ts']);
  });
  it('keeps describe path segments distinct even when full names match', () => {
    const report = (ancestorTitles: string[]) => parseTestReport({ testResults: [{ name: 'a.test.ts', assertionResults: [
      { title: 'c', fullName: 'a b c', ancestorTitles, status: 'passed', failureMessages: [] },
    ] }] })!;
    const comparison = compareTests(report(['a b']), report(['a', 'b']));
    expect(comparison.added).toHaveLength(1);
    expect(comparison.removed).toHaveLength(1);
  });
  it('marks modified custom suite names and mts tests from actual reports', () => {
    const report = { runner: 'vitest' as const, tests: [], suiteErrors: [], suiteFiles: ['src/custom.ts', 'src/check.mts'] };
    expect(editedTestFiles(['src/custom.ts', 'src/check.mts', 'src/new.mts'], report, report)).toEqual(['src/check.mts', 'src/custom.ts']);
  });
  it('keeps summaries valid JSON within 4 KiB even for hostile long names', () => {
    const test = { file: '😀'.repeat(1000), name: '"'.repeat(1000), status: 'failed' as const };
    const tests = compareTests({ runner: 'vitest', tests: [], suiteErrors: [] }, { runner: 'vitest', tests: [test], suiteErrors: [] });
    tests.regressions = Array(100).fill(test);
    tests.removed = Array(100).fill(test);
    const summary = summarizeEvidence({ available: true, reasons: [], tests,
      api: { changes: [], packageChanges: [], breaking: false, notes: [] },
      blastRadius: { dependents: [], withoutTests: [], notes: [] } });
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(summary).totals.regressions).toBe(100);
  });
  it('removes file and name filters only from the reproduction fallback command', () => {
    expect(defaultRefactorCommand(['pnpm', 'vitest', 'run', 'src/a.test.ts', '-t', 'one', '--reporter=json', '--outputFile=old.json']))
      .toEqual(['pnpm', 'vitest', 'run', '--reporter=json']);
    expect(defaultRefactorCommand(['pnpm', 'exec', 'jest', '--runTestsByPath', 'a.ts', 'src/unit', '--config', 'jest.config.js']))
      .toEqual(['pnpm', 'exec', 'jest', '--config', 'jest.config.js']);
  });
  it('handles multiple declarations, regular expressions and additive export lists', () => {
    expect(scanExports('export const a=1,b=2;').map(item => item.name)).toEqual(['a', 'b']);
    expect(scanExports('const regex=/export const fake = /; export const real=1;').map(item => item.name)).toEqual(['real']);
    expect(scanExports('const regex = condition && /export function fake()/; export function real() {}').map(item => item.name)).toEqual(['real']);
    for (const text of ['{', ',', ';']) expect(scanExports(`export const text = "${text}"; export function fn() {}`).map(item => item.name)).toEqual(['text', 'fn']);
    const diff = compareApi(new Map([['a.ts', 'export { a };']]), new Map([['a.ts', 'export { a, b };']]));
    expect(diff.breaking).toBe(false);
    expect(diff.changes.map(change => [change.kind, change.name])).toEqual([['added', 'b']]);
    expect(compareApi(new Map([['a.ts', "export { x } from './a';"]]), new Map([['a.ts', "export { x } from './b';"]])).breaking).toBe(true);
    for (const next of ['export type { Foo };', 'export { type Foo };']) {
      expect(compareApi(new Map([['a.ts', 'export { Foo };']]), new Map([['a.ts', next]])).breaking).toBe(true);
    }
    expect(scanExports('export { type };')[0]?.name).toBe('type');
  });
  it('extracts every export form and normalizes signatures', () => {
    const names = scanExports(`export function fn(x: number) { return x }
export class C {}
export const c = 1;
export let l = 1;
export var v = 1;
export type T = string;
export interface I {}
export enum E {}
export namespace N {}
export default function () {}
export { a, b as c2 };
export { x } from './x';
export * from './all';
export * as ns from './all';`).map(item => item.name);
    expect(names).toEqual(['fn', 'C', 'c', 'l', 'v', 'T', 'I', 'E', 'N', 'default', 'a', 'c2', 'x', '*:./all', 'ns']);
    expect(scanExports('export function  fn( x: number ) {')[0]?.signature).toBe('export function fn( x: number )');
    expect(scanExports('// export const fake = 1;\nconst s = "export default";')).toEqual([]);
  });
  it('compares signatures, renames, new/deleted files and package fields', () => {
    const api = compareApi(new Map([['a.ts', 'export function oldName(x: number) {}'], ['gone.ts', 'export const gone = 1;']]),
      new Map([['a.ts', 'export function newName(x: number) {}'], ['new.ts', 'export const fresh = 1;']]), { version: '1', exports: './a.js' }, { version: '2', exports: './b.js' });
    expect(api.changes.map(change => change.kind).sort()).toEqual(['added', 'removed', 'renamed']);
    expect(api.packageChanges.map(change => change.field)).toEqual(['exports', 'version']);
    expect(api.breaking).toBe(true);
    expect(compareApi(new Map([['a.ts', 'export function f(x: number) {}']]), new Map([['a.ts', 'export function f(x: string) {}']])).changes[0]?.kind).toBe('changed');
    expect(compareApi(new Map(), new Map(), { exports: { default: './generic.js', node: './node.js' } },
      { exports: { node: './node.js', default: './generic.js' } }).packageChanges).toHaveLength(1);
  });
  it.each(['export ' + ' '.repeat(65536), 'export {' + ','.repeat(65536), 'export const value' + 'x'.repeat(65536),
    'import ' + 'a '.repeat(32768), 'require(' + ' '.repeat(65536), '/*' + 'x'.repeat(65536), '"export ' + 'x'.repeat(65536)])('bounds adversarial scanner input', source => {
    const start = performance.now();
    scanExports(source);
    expect(performance.now() - start).toBeLessThan(200);
  });
  it('caps declaration signatures at 300 characters', () => {
    expect(scanExports('export function fn(' + 'x'.repeat(1000) + ') {}')[0]?.signature).toHaveLength(300);
  });
  it.each(['main', 'module', 'types', 'exports', 'bin', 'version'])('reports changes to package field %s', field => {
    expect(compareApi(new Map(), new Map(), { [field]: 'before' }, { [field]: 'after' }).packageChanges)
      .toEqual([{ field, before: 'before', after: 'after' }]);
  });
});
