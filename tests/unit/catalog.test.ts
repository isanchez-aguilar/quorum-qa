import { expect, it } from 'vitest';
import { DEFAULT_CATALOG, parseModelRef, resolveTier } from '../../src/catalog/index.js';
import { validateConfig } from '../../src/config/schema.js';
import { catalog } from '../fixtures/cascade.js';

it.each([
  ['agy:gemini-3.1-pro-high', 'agy', 'gemini-3.1-pro-high', 'google'],
  ['codex', 'codex', 'codex', 'openai'], ['claude:sonnet', 'claude', 'sonnet', 'anthropic'],
  ['qwen', 'qwen', 'qwen', 'local'],
])('parses %s', (ref, provider, model, family) => {
  expect(parseModelRef(ref!)).toEqual({ provider, model, family });
});

it('rejects unknown providers and models, and groups shared quotas', () => {
  expect(() => parseModelRef('rogue:model')).toThrow('Unknown provider');
  expect(() => parseModelRef('agy:missing')).toThrow('Unknown model');
  const anthropic = DEFAULT_CATALOG.filter(entry => entry.provider === 'agy' && entry.family === 'anthropic');
  expect(new Set(anthropic.map(entry => entry.quotaGroup)).size).toBe(1);
  expect(DEFAULT_CATALOG.every(entry => typeof entry.supportsImages === 'boolean')).toBe(true);
});

it('filters unavailable groups before applying author independence', () => {
  const config = validateConfig({ checks: [], author: 'claude', tiers: { triage: ['agy:sonnet', 'agy:flash'] } });
  expect(resolveTier('triage', config, catalog).models.map(entry => entry.id)).toEqual(['flash']);
  const fallback = resolveTier('triage', config, catalog, { 'agy:google': { remainingPercent: 15 } });
  expect(fallback.models.map(entry => entry.id)).toEqual(['sonnet']);
  expect(fallback.warnings.join(' ')).toContain('Independence rule cannot be met');
});

it('never automatically selects Fable, but accepts an explicitly named catalog entry', () => {
  const extra = [...catalog, { ...catalog[0]!, id: 'fable-synthetic' }];
  const config = validateConfig({ checks: [], tiers: { triage: ['agy:flash'] } });
  expect(resolveTier('triage', config, extra).models.map(entry => entry.id)).toEqual(['flash']);
  config.tiers.triage = ['agy:fable-synthetic'];
  expect(resolveTier('triage', config, extra).models[0]?.id).toBe('fable-synthetic');
});
