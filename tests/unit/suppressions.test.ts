import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { finding } from '../fixtures/cascade.js';
import type { CommandRunner } from '../../src/types/index.js';

const entry = { file: 'sample.ts', quote: 'export const value = compute(input);', reason: 'Reviewed: this is intentional.' };
const api = () => import('../../src/suppressions/index.js');

it('generates stable normalized fingerprints', async () => {
  const { suppressionId } = await api();
  expect(suppressionId('./src\\x.ts', "return  'allowed';")).toBe(suppressionId('src/x.ts', 'return "allowed";'));
  expect(suppressionId('sample.ts', entry.quote)).toBe(createHash('sha256').update('sample.ts\n' + entry.quote).digest('hex').slice(0, 10));
});
it('accepts optional fields, generates ids, and preserves boundary lengths', async () => {
  const { validateSuppressions, suppressionId } = await api();
  expect(validateSuppressions({ suppressions: [entry] })[0]?.id).toBe(suppressionId(entry.file, entry.quote));
  for (const quote of ['x', 'x'.repeat(2000)]) for (const reason of ['x'.repeat(10), 'x'.repeat(500)]) {
    expect(validateSuppressions({ suppressions: [{ ...entry, id: 's1', quote, reason, created: '2024-02-29', expires: '2027-01-01' }] })).toHaveLength(1);
  }
  expect(validateSuppressions({ suppressions: [] })).toEqual([]);
  expect(validateSuppressions({ suppressions: Array.from({ length: 400 }, (_, i) => ({ ...entry, quote: `quote ${i}` })) })).toHaveLength(400);
});
it.each([
  null, {}, { suppressions: [], extra: true }, { suppressions: [null] },
  ...[{ extra: true }, { file: '' }, { file: '../x' }, { file: '/x' }, { file: 'C:\\x' }, { quote: '' }, { quote: 'x'.repeat(2001) },
    { reason: 'short' }, { reason: 'x'.repeat(501) }, { reason: ' '.repeat(10) }, { id: '' }, { created: '2026-02-30' },
    { expires: 'tomorrow' }, { expires: null }, ...['file', 'quote', 'reason', 'id'].map(key => ({ [key]: 'hello\u0000world' }))]
    .map(change => ({ suppressions: [{ ...entry, ...change }] })),
  { suppressions: [entry, entry] }, { suppressions: [{ ...entry, id: 's1' }, { ...entry, id: 's2' }] },
  { suppressions: [{ ...entry, id: 'same' }, { ...entry, id: 'same', quote: 'different quote' }] },
  { suppressions: Array.from({ length: 401 }, (_, i) => ({ ...entry, quote: `quote ${i}` })) },
])('rejects invalid suppression %#', async raw => {
  const { validateSuppressions } = await api();
  expect(() => validateSuppressions(raw)).toThrow();
});
it('matches moved code and quote styles but never tiny, changed, expired or different-file quotes', async () => {
  const { validateSuppressions, matchesSuppression } = await api();
  const s = validateSuppressions({ suppressions: [{ ...entry, quote: "return 'allowed';" }] })[0]!;
  expect(matchesSuppression(finding({ line: 900, evidence_quote: '  return "allowed";  ' }), s, '2026-10-22')).toBe(true);
  expect(matchesSuppression(finding({ evidence_quote: 'prefix return "allowed"; suffix' }), s, '2026-10-22')).toBe(true);
  for (const f of [finding({ evidence_quote: 'return' }), finding({ file: 'other.ts', evidence_quote: s.quote }), finding({ evidence_quote: 'return "denied";' })]) {
    expect(matchesSuppression(f, s, '2026-10-22')).toBe(false);
  }
  expect(matchesSuppression(finding({ evidence_quote: s.quote }), { ...s, expires: '2026-10-21' }, '2026-10-22')).toBe(false);
  expect(matchesSuppression(finding({ evidence_quote: s.quote }), { ...s, expires: '2026-10-22' }, '2026-10-22')).toBe(true);
});
it('partitions findings and protects only reproduced two-family BLOCKERs', async () => {
  const { validateSuppressions, applySuppressions } = await api();
  const entries = validateSuppressions({ suppressions: [entry] });
  const blocker = finding({ severity: 'BLOCKER', confirmationFamilies: ['google', 'openai'], reproduction: { status: 'reproduced', path: 'a.test.ts', content: '', expect: '' } });
  const result = applySuppressions([finding(), blocker], entries, '2026-10-22');
  expect(result.active).toEqual([blocker]); expect(result.suppressed).toHaveLength(1);
  expect(result.warnings).toContain(`suppression ${entries[0]!.id} ignored: reproduced BLOCKER`);
  expect(applySuppressions([{ ...blocker, confirmationFamilies: ['google', 'google'] }], entries, '2026-10-22').active).toEqual([]);
  expect(applySuppressions([finding()], [{ ...entries[0]!, expires: '2020-01-01' }], '2026-10-22').warnings.join()).toContain('expired');
});
it('loads only the selected trusted commit, refusing links and oversized blobs', async () => {
  const { loadSuppressionsAt } = await api();
  const runner = vi.fn<CommandRunner>().mockResolvedValueOnce({ exitCode: 0, stdout: '100644 blob abc\tquorum.suppress.json\0', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ suppressions: [entry] }), stderr: '' });
  expect(await loadSuppressionsAt('base123', process.cwd(), runner)).toHaveLength(1);
  expect(runner.mock.calls[1]?.[1]).toContain('base123:quorum.suppress.json');
  runner.mockResolvedValueOnce({ exitCode: 0, stdout: '120000 blob abc\tquorum.suppress.json\0', stderr: '' });
  await expect(loadSuppressionsAt('HEAD', process.cwd(), runner)).rejects.toThrow('regular file');
  runner.mockResolvedValueOnce({ exitCode: 0, stdout: '100644 blob abc\tquorum.suppress.json\0', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: ' '.repeat(8 * 1024 * 1024 + 1), stderr: '' });
  await expect(loadSuppressionsAt('HEAD', process.cwd(), runner)).rejects.toThrow('size');
});
