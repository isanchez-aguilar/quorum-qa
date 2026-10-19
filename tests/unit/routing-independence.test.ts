import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider } from '../../src/providers/fake.js';
import { catalog, context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

let root: string;
const argon = 'gemini-4-argon-high';
const models = [...catalog, { ...catalog[1]!, id: argon }];
const confirm = JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote });
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'quorum-independence-'));
  await writeFile(path.join(root, 'sample.ts'), source);
});
afterAll(async () => {
  expect(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'quorum-independence-'))).toBe(true);
  await rm(root, { recursive: true, force: true });
});

it.each([true, false])('warns on same-family confirm tier with route fallback=%s', async fallback => {
  const config = validateConfig({ checks: [],
    tiers: { triage: ['agy:flash'], review: [`agy:${argon}`], confirm: [`agy:${argon}`], visual: [] },
    escalate: { routes: fallback ? { money: ['codex'] } : { unrelated: ['codex'] } } });
  const agy = new FakeProvider('agy', 'google', originRunner(root), {
    flash: [JSON.stringify([finding({ trigger: 'money input' })])], [argon]: [confirm],
  });
  const result = await runCascade(context(root), config, new Map([['agy', agy]]),
    { catalog: models, clock: new FakeClock(), gitRunner: originRunner(root) });
  expect(result.calls.map(call => call.model)).toEqual(['flash', argon]);
  expect(result.findings).toHaveLength(1);
  expect(result.warnings.some(w => w.includes('falling back to confirm tier'))).toBe(fallback);
  expect(result.warnings).toContain("Independence rule cannot be met in confirm: only the finding's own family (google) is available.");
});

it.each([true, false])('second local money confirmation avoids all source families when independent=%s', async independent => {
  const config = validateConfig({ checks: [],
    tiers: { triage: ['qwen'], review: [`agy:${argon}`], confirm: ['codex'], visual: [] },
    escalate: { routes: { money: independent ? [`agy:${argon}`, 'codex'] : [`agy:${argon}`] } } });
  const qwen = new FakeProvider('qwen', 'local', originRunner(root), { qwen: [JSON.stringify([finding({ trigger: 'money input' })])] });
  const agy = new FakeProvider('agy', 'google', originRunner(root), { [argon]: ['[]', confirm, confirm] });
  const codex = new FakeProvider('codex', 'openai', originRunner(root), { codex: [confirm] });
  const result = await runCascade(context(root), config, new Map([['qwen', qwen], ['agy', agy], ['codex', codex]]),
    { catalog: models, clock: new FakeClock(), gitRunner: originRunner(root) });
  expect(result.calls.map(call => [call.model, call.purpose])).toEqual([
    ['qwen', 'review'], [argon, 'review'], [argon, 'confirm'], [independent ? 'codex' : argon, 'confirm'],
  ]);
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.confirmationFamilies).toEqual(expect.arrayContaining(independent ? ['local', 'google', 'openai'] : ['local', 'google']));
  expect(result.warnings.some(w => w.includes('Independence rule cannot be met in route "money"'))).toBe(!independent);
});
