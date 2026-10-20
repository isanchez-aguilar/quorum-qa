import { expect, it, vi } from 'vitest';
import { addedLines, loadRulesAt, runRules, safeMatch, validateRules } from '../../src/rules/index.js';
import type { CommandRunner } from '../../src/types/index.js';

const rule = { id: 'no-foo', pattern: 'foo', message: 'Avoid foo', severity: 'error' as const };

it('accepts rules and optional flags and paths', () => {
  expect(validateRules({ rules: [{ ...rule, flags: 'i', paths: ['src/**'] }] })).toEqual([{ ...rule, flags: 'i', paths: ['src/**'] }]);
  expect(validateRules({ rules: [] })).toEqual([]);
});

it.each([
  [null, 'object'], [{ rules: [], extra: true }, 'extra'], [{}, 'rules'],
  [{ rules: [null] }, 'object'], [{ rules: [{ ...rule, secret: true }] }, 'secret'],
  ...['', 'UPPER', '-bad', 'a'.repeat(65)].map(id => [{ rules: [{ ...rule, id }] }, 'id']),
  [{ rules: [rule, rule] }, 'unique'], [{ rules: Array.from({ length: 201 }, (_, i) => ({ ...rule, id: `rule-${i}` })) }, '200'],
  ...[null, 'x'.repeat(501), '['].map(pattern => [{ rules: [{ ...rule, pattern }] }, 'pattern']),
  ...['g', 'ii', 'im', null].map(flags => [{ rules: [{ ...rule, flags }] }, 'flags']),
  ...[null, 'x'.repeat(301)].map(message => [{ rules: [{ ...rule, message }] }, 'message']),
  [{ rules: [{ ...rule, severity: 'BLOCKER' }] }, 'severity'],
  ...[null, [''], [1]].map(paths => [{ rules: [{ ...rule, paths }] }, 'paths']),
] as Array<[unknown, string]>)('rejects malformed rules %# with a named problem', (raw, problem) => {
  expect(() => validateRules(raw)).toThrow(String(problem));
});

it('loads the exact trusted commit and distinguishes missing files from git failures', async () => {
  const runner = vi.fn<CommandRunner>().mockResolvedValueOnce({ exitCode: 0, stdout: '100644 blob abc\tquorum.rules.json\0', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ rules: [rule] }), stderr: '' });
  expect(await loadRulesAt('base123', process.cwd(), runner)).toEqual([rule]);
  expect(runner.mock.calls[1]?.[1]).toContain('base123:quorum.rules.json');
  runner.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
  expect(await loadRulesAt('head123', process.cwd(), runner)).toEqual([]);
  runner.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'bad revision' });
  await expect(loadRulesAt('missing', process.cwd(), runner)).rejects.toThrow('bad revision');
});

it('extracts only added lines, preserves new line numbers and filters paths', async () => {
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n foo old\n-foo deleted\n+foo added\n unchanged\n'
    + 'diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -0,0 +1 @@\n+foo excluded\n';
  expect(addedLines(diff)).toEqual([{ file: 'src/a.ts', line: 2, text: 'foo added' }, { file: 'other.ts', line: 1, text: 'foo excluded' }]);
  const result = await runRules([{ ...rule, paths: ['src/**'] }], { diff });
  expect(result.passed).toBe(false);
  expect(result.results[0]?.matches).toEqual([{ file: 'src/a.ts', line: 2, text: 'foo added' }]);
  expect((await runRules([{ ...rule, severity: 'warning' }], { diff })).passed).toBe(true);
});

it('bounds reported matches, counts all hits and skips long lines', async () => {
  const lines = Array.from({ length: 55 }, (_, i) => ({ file: 'a.ts', line: i + 1, text: 'foo' }));
  const result = await safeMatch('foo', '', [...lines, { file: 'a.ts', line: 56, text: 'foo'.repeat(1000) }]);
  expect(result).toMatchObject({ totalMatches: 55, timedOut: false, skippedLongLines: 1 });
  expect(result.matches).toHaveLength(50);
  expect((await safeMatch('foo', '', lines, { maxMatches: 2, stopAfterMatches: 3 })).totalMatches).toBe(3);
});

it('matches case-insensitively and records skipped long lines as a note', async () => {
  const result = await runRules([{ ...rule, flags: 'i' }], {
    diff: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+FOO\n+${'foo'.repeat(1000)}\n`,
  });
  expect(result.results[0]?.matches).toEqual([{ file: 'a.ts', line: 1, text: 'FOO' }]);
  expect(result.notes).toContain('rule no-foo: skipped 1 lines longer than 2000 characters');
});

it('decodes quoted paths, handles multiple hunks and ignores binary content', () => {
  const diff = 'diff --git "a/sp\\303\\251cial.ts" "b/sp\\303\\251cial.ts"\n--- "a/sp\\303\\251cial.ts"\n+++ "b/sp\\303\\251cial.ts"\n'
    + '@@ -1 +1 @@\n-old\n+new\n@@ -10 +20 @@\n-old\n+later\n'
    + 'diff --git a/binary b/binary\nBinary files a/binary and b/binary differ\n';
  expect(addedLines(diff)).toEqual([{ file: 'spécial.ts', line: 1, text: 'new' }, { file: 'spécial.ts', line: 20, text: 'later' }]);
});

it('rejects invalid JSON and failure to read an existing rules blob', async () => {
  const runner = vi.fn<CommandRunner>()
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'exists', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '{broken', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'exists', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'blob unreadable' });
  await expect(loadRulesAt('base', process.cwd(), runner)).rejects.toThrow('not valid JSON');
  await expect(loadRulesAt('base', process.cwd(), runner)).rejects.toThrow('blob unreadable');
});

it('terminates catastrophic patterns within five seconds and warns without failing', async () => {
  const start = Date.now();
  const result = await runRules([{ ...rule, pattern: '(a+)+$' }], {
    diff: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+${'a'.repeat(1000)}!\n`,
  });
  expect(Date.now() - start).toBeLessThan(5000);
  expect(result.passed).toBe(true);
  expect(result.results[0]?.timedOut).toBe(true);
  expect(result.notes).toContain('rule no-foo timed out; skipped');
});
