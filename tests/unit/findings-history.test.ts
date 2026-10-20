import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendFindings, historyEntries, FINDINGS_MAX_BYTES } from '../../src/storage/findings.js';
import type { Finding } from '../../src/types/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'quorum-findings-')); });
afterEach(async () => {
  if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-findings-'))) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});
const metadata = { runId: 'one', timestamp: '2026-10-19T00:00:00.000Z', mode: 'feature' };
const finding: Finding = { severity: 'IMPORTANT', origin: 'introduced', file: 'src/a.ts', line: 2,
  trigger: 'unsafe value', impact: 'failure', evidence_quote: 'value.run();', fix: 'validate', provider: 'fake',
  model: 'synthetic', family: 'google', confidence: 0.9, verified: true };

it('records only verified findings with bounded quotes and explicit proof states', () => {
  const rows = historyEntries([finding, { ...finding, verified: false },
    { ...finding, evidence_quote: 'x'.repeat(500), confirmationFamilies: ['google', 'openai'],
      reproduction: { path: '', content: '', expect: '', status: 'reproduced' } }], metadata);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ ...metadata, severity: finding.severity, origin: finding.origin,
    file: finding.file, line: 2, trigger: finding.trigger, impact: finding.impact,
    evidence_quote: finding.evidence_quote, provider: 'fake', model: 'synthetic', family: 'google',
    confirmed: false, reproduction: 'unproven' });
  expect(rows[1]).toMatchObject({ confirmed: true, reproduction: 'reproduced' });
  expect(rows[1]!.evidence_quote).toHaveLength(400);
});

it('serializes concurrent runs without losing findings or leaving lock files', async () => {
  const file = path.join(root, 'findings.jsonl');
  await Promise.all(['one', 'two'].map(runId => appendFindings(historyEntries([finding], { ...metadata, runId }), file, root)));
  expect((await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line).runId).sort()).toEqual(['one', 'two']);
  expect(await readdir(root)).toEqual(['findings.jsonl']);
});

it('keeps the newest half of bytes as complete JSONL records when exceeding 5 MiB', async () => {
  const file = path.join(root, 'findings.jsonl');
  const rows = Array.from({ length: 12000 }, (_, line) => historyEntries([{ ...finding, line, evidence_quote: 'é'.repeat(400) }], metadata)[0]!);
  await appendFindings(rows.slice(0, 4000), file, root);
  expect(Buffer.byteLength(await readFile(file, 'utf8'))).toBeLessThan(FINDINGS_MAX_BYTES);
  await appendFindings(rows.slice(4000), file, root);
  const text = await readFile(file, 'utf8');
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FINDINGS_MAX_BYTES / 2);
  expect(Buffer.byteLength(text)).toBeGreaterThan(FINDINGS_MAX_BYTES / 2 - 2000);
  const retained = text.trim().split('\n').map(line => JSON.parse(line));
  expect(retained[0].line).toBeGreaterThan(0);
  expect(retained.at(-1).line).toBe(11999);
});

it('propagates storage failure for the review caller to warn without leaving artifacts', async () => {
  const file = path.join(root, 'blocked');
  await writeFile(file, 'not a directory');
  await expect(appendFindings(historyEntries([finding], metadata), path.join(file, 'findings.jsonl'), root)).rejects.toThrow();
  expect(await readdir(root)).toEqual(['blocked']);
});
