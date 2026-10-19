import type { Family, QuorumConfig, Tier } from '../types/index.js';

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[], prefix = 'Invalid quorum config') {
    super(issues.length === 1 ? `${prefix}: ${issues[0]}` : `${prefix}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const FAMILIES: readonly Family[] = ['google', 'anthropic', 'openai', 'local'];

export const AUTHOR_ALIASES: Readonly<Record<string, Family>> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  qwen: 'local',
};

export const TIERS: readonly Tier[] = ['triage', 'review', 'confirm', 'visual'];

export function resolveAuthorFamily(author: string): Family {
  const key = author.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(AUTHOR_ALIASES, key)) {
    return AUTHOR_ALIASES[key] as Family;
  }
  if ((FAMILIES as readonly string[]).includes(key)) return key as Family;
  throw new ConfigError(
    [
      `unknown author "${author}". Allowed aliases: ${Object.keys(AUTHOR_ALIASES).join(', ')}; ` +
        `or a family: ${FAMILIES.join(', ')}.`,
    ],
    'Invalid author',
  );
}

export function defaultConfig(): Required<Omit<QuorumConfig, 'checks' | 'setup' | 'author'>> {
  return {
    context: { provider: 'git' },
    base: 'origin/main',
    tiers: {
      triage: ['agy:gemini-3.8-flash-low', 'qwen', 'agy:gpt-oss-120b-medium'],
      review: ['agy:gemini-4-argon-high', 'claude:sonnet'],
      confirm: ['codex', 'agy:claude-opus-5-5-high', 'claude:opus'],
      visual: ['agy:gemini-4-argon-high'],
    },
    escalate: { focus: ['money', 'auth', 'permissions'], belowConfidence: 0.7 },
    budget: { maxCalls: 12, maxMinutes: 20, maxCallSeconds: 300, quotaFloorPercent: 15 },
    reproduce: {
      allowInstallScripts: false,
      isolation: 'container',
      testGlobs: ['**/*.test.*', '**/*.spec.*'],
      testCommand: ['pnpm', 'vitest', 'run', '--reporter=json'],
    },
    jules: { enabled: false, repo: '', maxSessionsPerRun: 3 },
    qwen: { endpoint: 'http://127.0.0.1:8080/v1' },
  };
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

class Reader {
  readonly issues: string[] = [];

  // Reads `raw` as an object and reports every key that is not in `known`.
  object(raw: unknown, path: string, known: readonly string[]): Obj | undefined {
    if (raw === undefined) return undefined;
    if (!isObject(raw)) {
      this.issues.push(`${path} must be an object`);
      return undefined;
    }
    for (const key of Object.keys(raw)) {
      if (!known.includes(key)) {
        this.issues.push(
          path === ''
            ? `unknown top-level key "${key}". Allowed keys: ${known.join(', ')}`
            : `unknown key "${key}" in ${path}. Allowed keys: ${known.join(', ')}`,
        );
      }
    }
    return raw;
  }

  string(raw: unknown, path: string, fallback: string): string {
    if (raw === undefined) return fallback;
    if (!isNonEmptyString(raw)) {
      this.issues.push(`${path} must be a non-empty string`);
      return fallback;
    }
    return raw;
  }

  stringArray(raw: unknown, path: string, fallback: string[], allowEmpty: boolean): string[] {
    if (raw === undefined) return [...fallback];
    if (!isStringArray(raw) || (!allowEmpty && raw.length === 0)) {
      this.issues.push(
        `${path} must be ${allowEmpty ? 'an array' : 'a non-empty array'} of non-empty strings`,
      );
      return [...fallback];
    }
    return [...raw];
  }

  number(
    raw: unknown,
    path: string,
    fallback: number,
    rule: { min: number; max?: number; integer?: boolean; minExclusive?: boolean },
  ): number {
    if (raw === undefined) return fallback;
    const belowMin = typeof raw === 'number' && (rule.minExclusive ? raw <= rule.min : raw < rule.min);
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      belowMin ||
      (rule.max !== undefined && raw > rule.max) ||
      (rule.integer === true && !Number.isInteger(raw))
    ) {
      const kind = rule.integer ? 'an integer' : 'a number';
      const range =
        rule.max !== undefined
          ? ` between ${rule.min} and ${rule.max}`
          : rule.minExclusive
            ? ` greater than ${rule.min}`
            : ` of at least ${rule.min}`;
      this.issues.push(`${path} must be ${kind}${range}`);
      return fallback;
    }
    return raw;
  }
}

function readChecks(raw: unknown, issues: string[], name = 'checks'): string[][] {
  if (raw === undefined) {
    issues.push(`${name} is required: an array of argv arrays, e.g. [["pnpm", "test"]]`);
    return [];
  }
  if (!Array.isArray(raw) || !raw.every((check) => Array.isArray(check))) {
    issues.push(`${name} must be an array of string arrays, e.g. [["pnpm", "test"]]`);
    return [];
  }
  const checks: string[][] = [];
  raw.forEach((check, index) => {
    if (!isStringArray(check) || check.length === 0) {
      issues.push(`${name}[${index}] must be a non-empty array of non-empty strings`);
    } else {
      checks.push([...check]);
    }
  });
  return checks;
}

export function validateConfig(raw: unknown): QuorumConfig {
  const defaults = defaultConfig();
  const r = new Reader();

  if (!isObject(raw)) {
    throw new ConfigError(['the config must be a JSON object']);
  }

  const top = r.object(raw, '', [
    'base',
    'checks',
    'setup',
    'author',
    'tiers',
    'escalate',
    'budget',
    'reproduce',
    'jules',
    'qwen',
    'context',
  ]) as Obj;

  const checks = readChecks(top.checks, r.issues);
  const setup = top.setup === undefined ? undefined : readChecks(top.setup, r.issues, 'setup');
  const contextRaw = r.object(top.context, 'context', ['provider']) ?? {};
  let contextProvider = defaults.context.provider;
  if (contextRaw.provider !== undefined) {
    if (contextRaw.provider === 'git' || contextRaw.provider === 'codegraph') contextProvider = contextRaw.provider;
    else r.issues.push('context.provider must be "git" or "codegraph"');
  }
  const base = r.string(top.base, 'base', defaults.base);

  let author: string | undefined;
  if (top.author !== undefined) {
    if (!isNonEmptyString(top.author)) {
      r.issues.push('author must be a non-empty string');
    } else {
      try {
        resolveAuthorFamily(top.author);
        author = top.author;
      } catch (error) {
        r.issues.push(error instanceof ConfigError ? (error.issues[0] as string) : String(error));
      }
    }
  }

  const tiers = { ...defaults.tiers };
  const tiersRaw = r.object(top.tiers, 'tiers', TIERS);
  if (tiersRaw) {
    for (const tier of TIERS) {
      tiers[tier] = r.stringArray(tiersRaw[tier], `tiers.${tier}`, defaults.tiers[tier], tier !== 'triage' && tier !== 'review');
    }
  }

  const escalateRaw = r.object(top.escalate, 'escalate', ['focus', 'belowConfidence', 'routes']) ?? {};
  const escalate: QuorumConfig['escalate'] = {
    focus: r.stringArray(escalateRaw.focus, 'escalate.focus', defaults.escalate.focus, true),
    belowConfidence: r.number(
      escalateRaw.belowConfidence,
      'escalate.belowConfidence',
      defaults.escalate.belowConfidence,
      { min: 0, max: 1 },
    ),
  };

  if (escalateRaw.routes !== undefined) {
    if (!isObject(escalateRaw.routes)) r.issues.push('escalate.routes must be an object');
    else {
      escalate.routes = Object.fromEntries(Object.entries(escalateRaw.routes).map(([keyword, refs]) => {
        if (!isNonEmptyString(keyword)) r.issues.push('escalate.routes keys must be a non-empty keyword');
        return [keyword, r.stringArray(refs, `escalate.routes.${keyword}`, [], false)];
      }));
    }
  }

  const budgetRaw =
    r.object(top.budget, 'budget', ['maxCalls', 'maxMinutes', 'maxCallSeconds', 'quotaFloorPercent']) ?? {};
  const budget = {
    maxCallSeconds: r.number(budgetRaw.maxCallSeconds, 'budget.maxCallSeconds', defaults.budget.maxCallSeconds!, { min: 30, max: 1800 }),
    maxCalls: r.number(budgetRaw.maxCalls, 'budget.maxCalls', defaults.budget.maxCalls, {
      min: 1,
      max: 200,
      integer: true,
    }),
    maxMinutes: r.number(budgetRaw.maxMinutes, 'budget.maxMinutes', defaults.budget.maxMinutes, {
      min: 0,
      max: 240,
      minExclusive: true,
    }),
    quotaFloorPercent: r.number(
      budgetRaw.quotaFloorPercent,
      'budget.quotaFloorPercent',
      defaults.budget.quotaFloorPercent,
      { min: 0, max: 100 },
    ),
  };

  const reproduceRaw =
    r.object(top.reproduce, 'reproduce', [
      'isolation',
      'image',
      'timeoutSeconds',
      'testGlobs',
      'testCommand',
      'allowInstallScripts',
    ]) ?? {};
  let isolation = defaults.reproduce.isolation;
  if (reproduceRaw.isolation !== undefined) {
    if (reproduceRaw.isolation === 'container' || reproduceRaw.isolation === 'interactive') {
      isolation = reproduceRaw.isolation;
    } else {
      r.issues.push('reproduce.isolation must be "container" or "interactive"');
    }
  }
  const reproduce: QuorumConfig['reproduce'] = {
    isolation,
    allowInstallScripts: false,
    testGlobs: r.stringArray(
      reproduceRaw.testGlobs,
      'reproduce.testGlobs',
      defaults.reproduce.testGlobs,
      false,
    ),
    testCommand: r.stringArray(
      reproduceRaw.testCommand,
      'reproduce.testCommand',
      defaults.reproduce.testCommand,
      false,
    ),
  };
  if (reproduceRaw.allowInstallScripts !== undefined) {
    if (typeof reproduceRaw.allowInstallScripts === 'boolean') reproduce.allowInstallScripts = reproduceRaw.allowInstallScripts;
    else r.issues.push('reproduce.allowInstallScripts must be a boolean');
  }
  if (reproduceRaw.image !== undefined) {
    reproduce.image = r.string(reproduceRaw.image, 'reproduce.image', '');
  }
  if (reproduceRaw.timeoutSeconds !== undefined) {
    reproduce.timeoutSeconds = r.number(reproduceRaw.timeoutSeconds, 'reproduce.timeoutSeconds', 0, {
      min: 1,
      integer: true,
    });
  }

  const julesRaw = r.object(top.jules, 'jules', ['enabled', 'repo', 'maxSessionsPerRun']) ?? {};
  let julesEnabled = defaults.jules.enabled;
  if (julesRaw.enabled !== undefined) {
    if (typeof julesRaw.enabled === 'boolean') julesEnabled = julesRaw.enabled;
    else r.issues.push('jules.enabled must be a boolean');
  }
  const julesRepo = r.string(julesRaw.repo, 'jules.repo', defaults.jules.repo);
  if (julesRaw.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(julesRepo)) {
    r.issues.push('jules.repo must look like "owner/name"');
  }
  if (julesEnabled && julesRepo === '') {
    r.issues.push('jules.repo is required when jules.enabled is true');
  }
  const jules = {
    enabled: julesEnabled,
    repo: julesRepo,
    maxSessionsPerRun: r.number(
      julesRaw.maxSessionsPerRun,
      'jules.maxSessionsPerRun',
      defaults.jules.maxSessionsPerRun,
      { min: 1, integer: true },
    ),
  };

  const qwenRaw = r.object(top.qwen, 'qwen', ['endpoint', 'model']) ?? {};
  const qwen = { endpoint: r.string(qwenRaw.endpoint, 'qwen.endpoint', defaults.qwen.endpoint),
    ...(qwenRaw.model === undefined ? {} : { model: r.string(qwenRaw.model, 'qwen.model', '') }) };

  if (r.issues.length > 0) throw new ConfigError(r.issues);

  const config: QuorumConfig = {
    context: { provider: contextProvider },
    base,
    checks,
    ...(setup === undefined ? {} : { setup }),
    tiers,
    escalate,
    budget,
    reproduce,
    jules,
    qwen,
  };
  if (author !== undefined) config.author = author;
  return config;
}
