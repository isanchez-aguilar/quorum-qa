import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { evidenceShape, proposeRules, renderRuleProposals } from '../../src/rules/mining.js';
import { CommandOutputLimitError, runCommand } from '../../src/process/runner.js';
import type { CommandRunner } from '../../src/types/index.js';

const roots: string[] = [];
const now = new Date('2026-10-19T12:00:00Z');
function finding(index: number, extra: Record<string, unknown> = {}) {
  return { runId: `run-${index}`, timestamp: now.toISOString(), mode: 'feature',
    file: `src/${index}.ts`, line: 1, severity: 'IMPORTANT', origin: 'introduced',
    trigger: 'Unsafe return', evidence_quote: `return user${index}.token;`, ...extra };
}
async function fixture(entries: unknown[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quorum-mining-')); roots.push(root);
  await mkdir(path.join(root, '.quorum'));
  await writeFile(path.join(root, '.quorum/findings.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));
  return root;
}
const emptyRepo: CommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('abstracts identifiers, strings and numbers but retains keywords and punctuation', () => {
  expect(evidenceShape('const item = read("hello", 42);')?.shape).toBe('const ID = ID ( STR , NUM ) ;');
  expect(evidenceShape('return value;')?.shape).toBe('return ID ;');
  expect(evidenceShape('a')).toBeUndefined();
  expect(evidenceShape('a\nb')).toBeUndefined();
});

it('requires multiple runs and files, excludes optional and improvement, counts multiline', async () => {
  for (const override of [{ runId: 'one' }, { file: 'one.ts' }, { severity: 'OPTIONAL' }, { origin: 'improvement' }]) {
    const root = await fixture([1, 2, 3].map(i => finding(i, override)));
    expect((await proposeRules(root, { now, runner: emptyRepo })).clusters).toEqual([]);
  }
  const root = await fixture([finding(1), finding(2), finding(3), finding(4, { evidence_quote: 'return\nvalue;' })]);
  const report = await proposeRules(root, { now, runner: emptyRepo });
  expect(report.findingsSeen).toBe(4);
  expect(report.skippedMultiline).toBe(1);
  expect(report.clusters[0]).toMatchObject({ count: 3, shape: 'return ID . ID ;', status: 'candidate' });
  expect(report.clusters[0]?.noise).toMatchObject({ matches: 0, knownSites: 0, noisy: true });
});

it('self-verifies, escapes punctuation, permits whitespace and refuses unsafe abstractions', async () => {
  const root = await fixture([finding(1, { evidence_quote: 'return a.b;' }), finding(2, { evidence_quote: 'return   c . d ;' }),
    finding(3, { evidence_quote: 'return e.f;' })]);
  const report = await proposeRules(root, { now, runner: emptyRepo });
  const regex = new RegExp(report.clusters[0]!.pattern!);
  expect(regex.test('return   example . field ;')).toBe(true);
  expect(regex.test('return exampleXfield;')).toBe(false);
  const unsupported = await fixture([1, 2, 3].map(i => finding(i, { evidence_quote: 'return 0xFF;' })));
  expect((await proposeRules(unsupported, { now, runner: emptyRepo })).clusters[0]?.status).toBe('no safe pattern');
});

it('filters dates, validates ranges, and reports no candidates with findings seen', async () => {
  const root = await fixture([finding(1, { timestamp: '2020-01-01' }), finding(2)]);
  const report = await proposeRules(root, { now, runner: emptyRepo });
  expect(report.findingsSeen).toBe(1);
  expect(renderRuleProposals(report)).toContain('No qualifying clusters');
  expect(renderRuleProposals(report)).toContain('1 findings seen');
  for (const options of [{ min: 1 }, { min: 51 }, { min: 2.5 }, { days: 0 }, { days: 3651 }]) {
    await expect(proposeRules(root, options)).rejects.toThrow();
  }
});

it('supports quoted strings and decimal literals and declines escaped quotes it cannot reproduce', async () => {
  const root = await fixture([
    finding(1, { evidence_quote: 'call("first", 12.5);' }),
    finding(2, { evidence_quote: "other('second', 7);" }),
    finding(3, { evidence_quote: 'third ( "last" , 123 );' }),
  ]);
  const report = await proposeRules(root, { now, runner: emptyRepo });
  expect(report.clusters[0]?.status).toBe('candidate');
  const regex = new RegExp(report.clusters[0]!.pattern!);
  expect(regex.test("fn('test', 123.45);")).toBe(true);
  const escaped = await fixture([1, 2, 3].map(i => finding(i, { evidence_quote: 'call("escaped\\"quote", 2);' })));
  expect((await proposeRules(escaped, { now, runner: emptyRepo })).clusters[0]?.status).toBe('no safe pattern');
});

it.each(['value = 0xFF', 'return foo + café'])('declines partial self-matches for %s', async quote => {
  const root = await fixture([1, 2, 3].map(i => finding(i, { evidence_quote: quote })));
  const report = await proposeRules(root, { now, runner: emptyRepo });
  expect(report.clusters[0]?.status).toBe('no safe pattern');
  expect(report.clusters[0]?.rule).toBeUndefined();
});

it('tolerates malformed history and reports a missing history as empty', async () => {
  const root = await fixture([finding(1), null, { evidence_quote: 'return a;' }]);
  await writeFile(path.join(root, '.quorum/findings.jsonl'),
    [JSON.stringify(finding(1)), '{broken', 'null'].join('\n'));
  expect(await proposeRules(root, { now, runner: emptyRepo })).toMatchObject({ findingsSeen: 1, invalidEntries: 2 });
  await rm(path.join(root, '.quorum/findings.jsonl'));
  expect(await proposeRules(root, { now, runner: emptyRepo })).toMatchObject({ findingsSeen: 0, clusters: [] });
});

it('estimates noise from tracked HEAD, counts known sites, ignores binary and oversized files', async () => {
  const root = await fixture([finding(1), finding(2), finding(3)]);
  const git = async (...args: string[]) => {
    const result = await runCommand('git', args, { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  };
  await git('init');
  await mkdir(path.join(root, 'src'));
  await Promise.all([1, 2, 3].map(i => writeFile(path.join(root, `src/${i}.ts`), `return user${i}.token;\n`)));
  await writeFile(path.join(root, 'other.ts'), 'return another.value;\n'.repeat(55));
  await writeFile(path.join(root, 'binary.dat'), '\0return user.token;\n');
  await writeFile(path.join(root, 'large.ts'), 'return user.token;\n'.repeat(20000));
  await git('add', 'src', 'other.ts', 'binary.dat', 'large.ts');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  await writeFile(path.join(root, 'other.ts'), 'uncommitted content');
  const result = await proposeRules(root, { now });
  expect(result.clusters[0]?.noise).toMatchObject({ matches: 58, knownSites: 3, noisy: true });
  expect(renderRuleProposals(result)).toContain('quorum.rules.json');
});

it('caps HEAD files at 3000 and matched lines at 2000', async () => {
  const root = await fixture([finding(1), finding(2), finding(3)]);
  let blobs = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes('ls-tree')) return { exitCode: 0, stdout: Array.from({ length: 3002 }, (_, i) =>
      `100644 blob ${String(i).padStart(40, '0')} 18\tfile-${i}.ts`).join('\0'), stderr: '' };
    blobs++;
    return { exitCode: 0, stdout: 'return user.token;', stderr: '' };
  };
  const report = await proposeRules(root, { now, runner });
  expect(blobs).toBe(3000);
  expect(report.clusters[0]?.noise).toMatchObject({ matches: 2000, filesCapped: true, matchesCapped: true });
});

it('uses complete listing records on successful output overflow and reports incomplete coverage', async () => {
  const root = await fixture([finding(1), finding(2), finding(3)]);
  let blobs = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes('ls-tree')) throw new CommandOutputLimitError(
      '100644 blob abc 18\tsrc/1.ts\0' + '100644 blob def 18\tpartial.ts', '', '', '', 0);
    blobs++;
    return { exitCode: 0, stdout: 'return user.token;', stderr: '' };
  };
  const report = await proposeRules(root, { now, runner });
  expect(blobs).toBe(1);
  expect(report.clusters[0]?.noise).toMatchObject({ matches: 1, knownSites: 1, filesCapped: true, noisy: true });
  expect(renderRuleProposals(report)).toContain('listing output limit');
  await expect(proposeRules(root, { now, runner: async () => {
    throw new CommandOutputLimitError('', '', '', '', 128);
  } })).rejects.toThrow('capture limit');
});

it.each(['lines', 'bytes'])('bounds aggregate noise scan memory by %s and labels the estimate incomplete', async limit => {
  const root = await fixture([finding(1), finding(2), finding(3)]);
  let blobs = 0;
  const content = limit === 'lines' ? '\n'.repeat(120000) : `${'x'.repeat(1023)}\n`.repeat(250);
  const count = limit === 'lines' ? 20 : 100;
  const runner: CommandRunner = async (_command, args) => {
    if (args.includes('ls-tree')) return { exitCode: 0, stdout: Array.from({ length: count }, (_, i) =>
      `100644 blob ${String(i).padStart(40, '0')} ${content.length}\tfile-${i}.ts\0`).join(''), stderr: '' };
    blobs++;
    return { exitCode: 0, stdout: content, stderr: '' };
  };
  const report = await proposeRules(root, { now, runner });
  expect(report.clusters[0]?.noise).toMatchObject({ scanCapped: true, noisy: true });
  expect(blobs).toBeLessThan(count);
  expect(renderRuleProposals(report)).toContain('100000 lines or 16 MiB');
});
