import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { historyEntries } from '../../src/storage/findings.js';
import { catalog, context, finding, originRunner, source } from '../fixtures/cascade.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-history-confirmation-'));
  await writeFile(path.join(root, 'sample.ts'), source);
});
afterAll(async () => {
  if (!path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-history-confirmation-'))) throw new Error('Unsafe cleanup');
  await rm(root, { recursive: true, force: true });
});

it.each(['batch', 'mandatory', 'none'])('records the actual %s confirmation outcome even within one family', async kind => {
  const item = finding({ severity: kind === 'mandatory' ? 'BLOCKER' : 'IMPORTANT' });
  const answer = kind === 'batch' ? { decisions: [{ id: 'c1', decision: 'confirm' }] }
    : { decision: 'confirm', evidence_quote: item.evidence_quote };
  const provider = new FakeProvider('agy', 'google', originRunner(root), {
    flash: [JSON.stringify([item])], pro: [JSON.stringify(answer)],
  });
  const config = validateConfig({ checks: [], tiers: {
    triage: ['agy:flash'], review: ['agy:pro'], confirm: ['agy:pro'], visual: [],
  }, escalate: { focus: [], belowConfidence: 0.6, confirmImportant: kind !== 'none' } });
  const result = await runCascade(context(root), config, new Map([['agy', provider]]),
    { catalog, gitRunner: originRunner(root) });
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]!.confirmationFamilies).toEqual(['google']);
  expect(historyEntries(result.findings, { runId: 'run', timestamp: '', mode: 'feature' })[0]!.confirmed).toBe(kind !== 'none');
});
