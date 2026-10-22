import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { ConfigError, resolveAuthorFamily, validateConfig } from '../../src/config/schema.js';

it('defaults context to git and validates the opt-in provider strictly', () => {
  expect(validateConfig({ checks: [] }).context).toEqual({ provider: 'git' });
  expect(validateConfig({ checks: [], context: {} }).context).toEqual({ provider: 'git' });
  expect(validateConfig({ checks: [], context: { provider: 'codegraph' } }).context).toEqual({ provider: 'codegraph' });
  for (const provider of ['other', '', null, 1, []]) {
    expect(() => validateConfig({ checks: [], context: { provider } })).toThrow('context.provider');
  }
  expect(() => validateConfig({ checks: [], context: null })).toThrow('context must be an object');
  expect(() => validateConfig({ checks: [], context: { unexpected: true } })).toThrow('in context');
});

it('defaults install scripts off and validates the explicit opt-in', () => {
  expect(validateConfig({ checks: [] }).reproduce.allowInstallScripts).toBe(false);
  expect(validateConfig({ checks: [], reproduce: { allowInstallScripts: true } }).reproduce.allowInstallScripts).toBe(true);
  expect(() => validateConfig({ checks: [], reproduce: { allowInstallScripts: 'true' } })).toThrow('reproduce.allowInstallScripts must be a boolean');
});

// The full PLAN.md example with the precision confirmation default made explicit.
const PLAN_EXAMPLE = {
  context: { provider: 'git' },
  base: 'origin/main',
  checks: [
    ['pnpm', 'lint'],
    ['pnpm', 'typecheck'],
    ['pnpm', 'test'],
  ],
  author: 'claude',
  tiers: {
    triage: ['agy:gemini-3.8-flash-low', 'qwen', 'agy:gpt-oss-120b-medium'],
    review: ['agy:gemini-4-argon-high', 'claude:sonnet'],
    confirm: ['codex', 'agy:claude-opus-5-5-high', 'claude:opus'],
    visual: ['agy:gemini-4-argon-high'],
  },
  escalate: { focus: ['money', 'auth', 'permissions'], belowConfidence: 0.7, confirmImportant: true },
  budget: { maxCalls: 12, maxMinutes: 20, maxCallSeconds: 300, quotaFloorPercent: 15 },
  reproduce: {
    allowInstallScripts: false,
    isolation: 'container',
    testGlobs: ['**/*.test.*', '**/*.spec.*'],
    testCommand: ['pnpm', 'vitest', 'run', '--reporter=json'],
  },
  jules: { enabled: false, repo: 'owner/name', maxSessionsPerRun: 3 },
  qwen: { endpoint: 'http://127.0.0.1:8080/v1' },
};

function issuesOf(raw: unknown): string[] {
  try {
    validateConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected validateConfig to throw');
}

describe('validateConfig', () => {
  it('testConfig_ChecksRequired', () => {
    expect(() => validateConfig({})).toThrow(/checks is required/);
    // An empty list is the explicit way to say "this repo has no deterministic checks".
    expect(validateConfig({ checks: [] }).checks).toEqual([]);
    // Inherited properties are not configuration.
    expect(() => validateConfig(Object.create({ checks: [['npm', 'test']] }))).toThrow(
      /must be a JSON object/,
    );
  });

  it('testConfig_PlanExample', () => {
    const config = validateConfig(structuredClone(PLAN_EXAMPLE));
    expect(config).toEqual({ ...PLAN_EXAMPLE, budget: { ...PLAN_EXAMPLE.budget, concurrency: 3, sequentialChecks: false, maxCallsExplicit: true } });
    expect(resolveAuthorFamily(config.author as string)).toBe('anthropic');
  });

  it('testConfig_UnknownAuthor', () => {
    const issues = issuesOf({ checks: [['npm', 'test']], author: 'bard' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/unknown author "bard"/);
    expect(issues[0]).toMatch(/claude, codex, gemini, qwen/);
  });

  it('testConfig_InvalidChecks', () => {
    expect(() => validateConfig({ checks: 'pnpm lint' })).toThrow(
      /checks must be an array of string arrays/,
    );
  });

  it('rejects a check that is not a non-empty array of non-empty strings', () => {
    expect(issuesOf({ checks: [['pnpm', 'lint'], 'pnpm test'] })[0]).toMatch(
      /checks must be an array of string arrays/,
    );
    expect(issuesOf({ checks: [[]] })).toEqual([
      'checks[0] must be a non-empty array of non-empty strings',
    ]);
    expect(issuesOf({ checks: [['pnpm', '']] })).toEqual([
      'checks[0] must be a non-empty array of non-empty strings',
    ]);
    expect(issuesOf({ checks: [['pnpm', 1]] })).toEqual([
      'checks[0] must be a non-empty array of non-empty strings',
    ]);
  });

  it('testConfig_MissingBaseFallback', () => {
    const config = validateConfig({ checks: [['npm', 'test']] });
    expect(config.base).toBe('origin/main');
  });

  it('fills every other default from PLAN.md', () => {
    const config = validateConfig({ checks: [['npm', 'test']] });
    const { author: _author, ...planDefaults } = PLAN_EXAMPLE;
    expect(config).toEqual({
      ...planDefaults,
      budget: { ...planDefaults.budget, concurrency: 3, sequentialChecks: false, maxCallsExplicit: false },
      checks: [['npm', 'test']],
      jules: { enabled: false, repo: '', maxSessionsPerRun: 3 },
    });
    expect('author' in config).toBe(false);
  });

  it('merges partial nested sections over the defaults', () => {
    const config = validateConfig({
      checks: [['npm', 'test']],
      budget: { maxCalls: 5 },
      tiers: { review: ['codex'] },
    });
    expect(config.budget).toEqual({ concurrency: 3, sequentialChecks: false, maxCalls: 5, maxCallsExplicit: true, maxMinutes: 20, maxCallSeconds: 300, quotaFloorPercent: 15 });
    expect(config.tiers.review).toEqual(['codex']);
    expect(config.tiers.triage).toEqual(PLAN_EXAMPLE.tiers.triage);
  });

  it('does not share default arrays between calls', () => {
    const first = validateConfig({ checks: [['npm', 'test']] });
    first.tiers.triage.push('mutated');
    first.escalate.focus.push('mutated');
    const second = validateConfig({ checks: [['npm', 'test']] });
    expect(second.tiers.triage).toEqual(PLAN_EXAMPLE.tiers.triage);
    expect(second.escalate.focus).toEqual(PLAN_EXAMPLE.escalate.focus);
  });

  it('rejects an unknown top-level key and names it', () => {
    const issues = issuesOf({ checks: [['npm', 'test']], bse: 'main' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/unknown top-level key "bse"/);
  });

  it('rejects an unknown nested key and an unknown tier', () => {
    expect(issuesOf({ checks: [['npm', 'test']], budget: { maxCall: 1 } })[0]).toMatch(
      /unknown key "maxCall" in budget/,
    );
    expect(issuesOf({ checks: [['npm', 'test']], tiers: { fast: [] } })[0]).toMatch(
      /unknown key "fast" in tiers/,
    );
  });

  it('rejects out-of-range and mistyped values', () => {
    const issues = issuesOf({
      checks: [['npm', 'test']],
      base: '',
      escalate: { belowConfidence: 1.5 },
      budget: { maxCalls: 0, maxMinutes: -1, quotaFloorPercent: 101 },
      reproduce: { isolation: 'host', testCommand: [], timeoutSeconds: 1.5 },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'base must be a non-empty string',
        'escalate.belowConfidence must be a number between 0 and 1',
        'budget.maxCalls must be an integer between 1 and 200',
        'budget.maxMinutes must be a number between 0 and 240',
        'budget.quotaFloorPercent must be a number between 0 and 100',
        'reproduce.isolation must be "container" or "interactive"',
        'reproduce.testCommand must be a non-empty array of non-empty strings',
        'reproduce.timeoutSeconds must be an integer of at least 1',
      ]),
    );
  });

  it('requires a repo when jules is enabled', () => {
    expect(issuesOf({ checks: [['npm', 'test']], jules: { enabled: true } })).toEqual([
      'jules.repo is required when jules.enabled is true',
    ]);
  });

  it('bounds M3 budgets and requires usable triage and review tiers', () => {
    for (const budget of [{ maxCalls: 201 }, { maxMinutes: 241 }, { maxMinutes: 0 }]) {
      expect(() => validateConfig({ checks: [], budget })).toThrow(ConfigError);
    }
    for (const tier of ['triage', 'review']) {
      expect(() => validateConfig({ checks: [], tiers: { [tier]: [] } })).toThrow(/non-empty array/);
    }
    expect(validateConfig({ checks: [], budget: { maxCalls: 200, maxMinutes: 240 },
      tiers: { confirm: [], visual: [] } }).budget.maxCalls).toBe(200);
  });

  it('keeps reproduce.image and timeoutSeconds only when given', () => {
    const plain = validateConfig({ checks: [['npm', 'test']] });
    expect('image' in plain.reproduce).toBe(false);
    expect('timeoutSeconds' in plain.reproduce).toBe(false);
    const set = validateConfig({
      checks: [['npm', 'test']],
      reproduce: { image: 'node:22-bookworm-slim', timeoutSeconds: 60 },
    });
    expect(set.reproduce.image).toBe('node:22-bookworm-slim');
    expect(set.reproduce.timeoutSeconds).toBe(60);
  });

  it('rejects a config that is not an object', () => {
    expect(() => validateConfig([])).toThrow(/must be a JSON object/);
    expect(() => validateConfig(null)).toThrow(/must be a JSON object/);
  });
});

describe('resolveAuthorFamily', () => {
  it('maps the aliases to families', () => {
    expect(resolveAuthorFamily('claude')).toBe('anthropic');
    expect(resolveAuthorFamily('codex')).toBe('openai');
    expect(resolveAuthorFamily('gemini')).toBe('google');
    expect(resolveAuthorFamily('qwen')).toBe('local');
  });

  it('passes a family through', () => {
    for (const family of ['anthropic', 'openai', 'google', 'local'] as const) {
      expect(resolveAuthorFamily(family)).toBe(family);
    }
  });

  it('rejects anything else', () => {
    expect(() => resolveAuthorFamily('bard')).toThrow(/Allowed aliases/);
    expect(() => resolveAuthorFamily('constructor')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'quorum-config-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and validates a file, tolerating a UTF-8 BOM', async () => {
    const file = path.join(dir, 'quorum.config.json');
    await writeFile(file, '﻿' + JSON.stringify({ checks: [['npm', 'test']] }));
    const config = await loadConfig(file);
    expect(config.checks).toEqual([['npm', 'test']]);
    expect(config.base).toBe('origin/main');
  });

  it('names the file when it is missing', async () => {
    const file = path.join(dir, 'missing.json');
    await expect(loadConfig(file)).rejects.toThrow(/file not found/);
  });

  it('names the file when the JSON is broken', async () => {
    const file = path.join(dir, 'quorum.config.json');
    await writeFile(file, '{ "checks": ');
    await expect(loadConfig(file)).rejects.toThrow(/is not valid JSON/);
  });

  it('surfaces validation errors', async () => {
    const file = path.join(dir, 'quorum.config.json');
    await writeFile(file, '{}');
    await expect(loadConfig(file)).rejects.toThrow(/checks is required/);
  });
});
