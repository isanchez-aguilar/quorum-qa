import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCascade } from '../../src/cascade/index.js';
import { createExecutionPlan, formatDryRun } from '../../src/cascade/planner.js';
import { BUDGET_WARNING } from '../../src/cascade/budget.js';
import { DEFAULT_CATALOG } from '../../src/catalog/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { FakeProvider, type FakeResponse } from '../../src/providers/fake.js';
import type { QuorumConfig } from '../../src/types/index.js';
import { context, FakeClock, finding, originRunner, source } from '../fixtures/cascade.js';

const flash = 'gemini-3.8-flash-medium';
const argon = 'gemini-4-argon-high';
const yes = JSON.stringify({ decision: 'confirm', evidence_quote: finding().evidence_quote });

describe('focus routes and local chunk coverage', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'quorum-routing-'));
    await writeFile(path.join(root, 'sample.ts'), source);
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  function config(routes: Record<string, string[]> = {}, overrides: Record<string, unknown> = {}): QuorumConfig {
    const result = validateConfig({ checks: [], tiers: { triage: [`agy:${flash}`], review: [`agy:${argon}`], confirm: ['claude:opus'], visual: [] }, ...overrides });
    Object.assign(result.escalate, { routes });
    return result;
  }
  function providers(scripts: Record<string, Record<string, readonly FakeResponse[]>>) {
    return new Map(Object.entries(scripts).map(([name, responses]) => [name,
      new FakeProvider(name, name === 'qwen' ? 'local' : name === 'codex' ? 'openai' : name === 'claude' ? 'anthropic' : 'google', originRunner(root), responses)]));
  }
  const options = () => ({ catalog: DEFAULT_CATALOG, clock: new FakeClock(), gitRunner: originRunner(root) });

  it.each(['money', 'a11y'])('sends %s findings to their route, including keywords outside focus', async keyword => {
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding({ trigger: keyword.toUpperCase() })])], [argon]: [yes] }, codex: { codex: [yes] }, claude: { opus: [yes] } });
    const result = await runCascade(context(root), config({ money: ['codex'], a11y: [`agy:${argon}`] }), pool, options());
    expect(result.calls.map(call => call.model)).toEqual([flash, keyword === 'money' ? 'codex' : argon]);
    expect(result.findings).toHaveLength(1);
    if (keyword === 'a11y') expect(result.warnings.join(' ')).toContain('Independence rule cannot be met');
  });

  it('uses the confirm tier without a route match', async () => {
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding({ confidence: 0.5 })])] }, claude: { opus: [yes] } });
    const result = await runCascade(context(root), config({ money: ['codex'] }), pool, options());
    expect(result.calls.map(call => call.model)).toEqual([flash, 'opus']);
  });

  it.each<{ routes: Record<string, string[]>; fields: { trigger: string; impact?: string }; expected: string }>([
    { routes: { money: ['codex'], a11y: [`agy:${argon}`] }, fields: { trigger: 'A11Y before money' }, expected: argon },
    { routes: { money: ['codex'], sample: [`agy:${argon}`] }, fields: { trigger: 'money' }, expected: argon },
    { routes: { money: ['codex'], a11y: [`agy:${argon}`] }, fields: { trigger: 'money', impact: 'a11y' }, expected: 'codex' },
    { routes: { mon: ['codex'], money: [`agy:${argon}`] }, fields: { trigger: 'money' }, expected: 'codex' },
  ])('chooses the first textual occurrence, with stable config ties: $fields', async ({ routes, fields, expected }) => {
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding(fields)])], [argon]: [yes] }, codex: { codex: [yes] }, claude: { opus: [yes] } });
    const result = await runCascade(context(root), config(routes), pool, options());
    expect(result.calls[1]?.model).toBe(expected);
  });

  it.each(['missing', 'quota', 'invalid', 'local'])('falls back to confirm and warns when a route is %s', async unavailable => {
    const route = unavailable === 'local' ? 'qwen' : 'codex';
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding({ trigger: 'money' })])] }, claude: { opus: [yes] },
      ...(unavailable === 'missing' ? {} : { codex: { codex: [unavailable === 'invalid' ? 'invalid' : { error: 'quota' } as FakeResponse] } }), qwen: { qwen: [yes] } });
    const result = await runCascade(context(root), config({ money: [route] }), pool, options());
    expect(result.calls.at(-1)?.model).toBe('opus');
    expect(result.findings).toHaveLength(1);
    expect(result.unconfirmed).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/route.*money.*falling back.*confirm/i);
    expect(pool.get('qwen')!.calls).toEqual([]);
  });

  it('validates every route ref before any call, including an unmatched route', async () => {
    const pool = providers({ agy: { [flash]: ['[]'] } });
    await expect(runCascade(context(root), config({ unused: ['agy:unknown'] }), pool, options())).rejects.toThrow('Unknown model reference');
    expect(pool.get('agy')!.calls).toEqual([]);
  });

  it('prefers another finding family and filters the author family within routes', async () => {
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding({ trigger: 'money' })])], [argon]: [yes] }, codex: { codex: [yes] }, claude: { opus: [yes] } });
    const result = await runCascade(context(root), config({ money: [`agy:${argon}`, 'claude:opus', 'codex'] }, { author: 'claude' }), pool, options());
    expect(result.calls.map(call => call.model)).toEqual([flash, 'codex']);
  });

  it('shares route failures and fallback with the run budget', async () => {
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding({ trigger: 'money' })])] }, codex: { codex: [{ error: 'quota' }] }, claude: { opus: [yes] } });
    const result = await runCascade(context(root), config({ money: ['codex'] }, { budget: { maxCalls: 2 } }), pool, options());
    expect(result.calls.map(call => call.model)).toEqual([flash, 'codex']);
    expect(result.unconfirmed).toHaveLength(1);
    expect(result.warnings).toContain(BUDGET_WARNING);
    expect(pool.get('claude')!.calls).toEqual([]);
  });

  it('shares quota groups across route refs and the fallback tier', async () => {
    const pool = providers({ agy: { [flash]: [JSON.stringify([finding({ trigger: 'money' })])] }, claude: { sonnet: [{ error: 'quota' }], opus: [yes] }, codex: { codex: [yes] } });
    const cfg = config({ money: ['claude:sonnet', 'claude:opus'] });
    cfg.tiers.confirm = ['claude:opus', 'codex'];
    const result = await runCascade(context(root), cfg, pool, options());
    expect(result.calls.map(call => call.model)).toEqual([flash, 'sonnet', 'codex']);
  });

  it('reviews an empty local chunk once through the nonlocal review tier', async () => {
    const cfg = config();
    cfg.tiers.triage = ['qwen'];
    const pool = providers({ qwen: { qwen: ['[]'] }, agy: { [argon]: ['[]'] } });
    const result = await runCascade(context(root), cfg, pool, options());
    expect(result.calls.map(call => [call.model, call.purpose])).toEqual([['qwen', 'review'], [argon, 'review']]);
    expect(pool.get('qwen')!.calls[0]!.prompt).toBe(pool.get('agy')!.calls[0]!.prompt);
    expect(result.coverage.complete).toBe(true);
    expect(result.warnings.join(' ')).not.toContain('reviewed only by a local model');
  });

  it.each(['budget', 'local tier', 'unavailable'])('keeps local coverage incomplete when escalation cannot run: %s', async reason => {
    const cfg = config({}, { budget: { maxCalls: reason === 'budget' ? 1 : 12 } });
    cfg.tiers.triage = ['qwen'];
    if (reason === 'local tier') cfg.tiers.review = ['qwen'];
    const pool = providers({ qwen: { qwen: ['[]'] }, ...(reason === 'unavailable' ? {} : { agy: { [argon]: ['[]'] } }) });
    const result = await runCascade(context(root), cfg, pool, options());
    expect(result.calls).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.warnings.join(' ')).toContain('reviewed only by a local model: sample.ts');
    if (reason === 'budget') expect(result.warnings).toContain(BUDGET_WARNING);
  });

  it('processes findings from chunk escalation while retaining rule 3b for local findings', async () => {
    const cfg = config({ money: ['codex'] });
    cfg.tiers.triage = ['qwen'];
    const pool = providers({ qwen: { qwen: [JSON.stringify([finding()])] }, agy: { [argon]: [JSON.stringify([finding({ trigger: 'money' })]), yes] }, codex: { codex: [yes] } });
    const result = await runCascade(context(root), cfg, pool, options());
    expect(result.calls.map(call => [call.tier, call.purpose])).toEqual([['triage', 'review'], ['review', 'review'], ['review', 'confirm'], ['confirm', 'confirm']]);
    expect(result.coverage.complete).toBe(true);
    expect(result.unconfirmed).toEqual([]);
  });

  it('preserves the confirmation reserve while trying local chunk coverage', async () => {
    const cfg = config({}, { budget: { maxCalls: 2 } });
    cfg.tiers.triage = ['qwen'];
    const pool = providers({ qwen: { qwen: [JSON.stringify([finding()])] }, agy: { [argon]: [yes] } });
    const result = await runCascade(context(root), cfg, pool, options());
    expect(result.calls.map(call => call.purpose)).toEqual(['review', 'confirm']);
    expect(result.coverage.complete).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it('shows configured routes and route-only quota groups in the dry-run plan', () => {
    const cfg = config({ money: ['codex'], a11y: [`agy:${argon}`] });
    const plan = createExecutionPlan(context(root), cfg, DEFAULT_CATALOG, {}, { clock: new FakeClock() });
    expect(formatDryRun(plan)).toContain('Route money: codex (openai)');
    expect(formatDryRun(plan)).toContain(`Route a11y: agy:${argon} (google)`);
    expect(plan.quotas.some(quota => quota.group === 'codex:openai')).toBe(true);
    expect(() => createExecutionPlan(context(root), config({ unused: ['agy:unknown'] }), DEFAULT_CATALOG)).toThrow('Unknown model reference');
  });
});

describe('route configuration', () => {
  it('accepts arbitrary nonempty keywords and copies ordered refs', () => {
    const routes = { money: ['codex', 'claude:opus'], a11y: [`agy:${argon}`] };
    const config = validateConfig({ checks: [], escalate: { routes } });
    expect(config.escalate).toMatchObject({ routes });
    routes.money.push('qwen');
    expect(config.escalate).toMatchObject({ routes: { money: ['codex', 'claude:opus'] } });
  });
  it.each([null, [], 'money'].map(routes => ({ routes })))('rejects non-object routes: $routes', ({ routes }) => {
    expect(() => validateConfig({ checks: [], escalate: { routes } })).toThrow('escalate.routes must be an object');
  });
  it.each(['', '   '])('rejects empty route keywords: %j', keyword => {
    expect(() => validateConfig({ checks: [], escalate: { routes: { [keyword]: ['codex'] } } })).toThrow('non-empty keyword');
  });
  it.each([[], [''], [1], 'codex', { model: 'codex' }].map(refs => ({ refs })))('rejects invalid route lists: $refs', ({ refs }) => {
    expect(() => validateConfig({ checks: [], escalate: { routes: { money: refs } } })).toThrow('escalate.routes.money must be a non-empty array of non-empty strings');
  });
  it('still rejects unknown escalate keys', () => {
    expect(() => validateConfig({ checks: [], escalate: { route: { money: ['codex'] } } })).toThrow('unknown key "route" in escalate');
  });
});
