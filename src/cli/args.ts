export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const REVIEW_MODES = ['feature', 'redesign', 'bughunt'] as const;

export interface ParsedFlags {
  help?: boolean;
  version?: boolean;
  mode?: (typeof REVIEW_MODES)[number];
  radius?: number;
  diff?: string;
  spec?: string;
  inventory?: string;
  images?: string;
  rules?: string;
  author?: string;
  since?: string;
  dryRun?: boolean;
  reproduce?: boolean;
  noHostPrompt?: boolean;
  allowUnproven?: boolean;
  probe?: boolean;
  json?: boolean;
  out?: string;
  sarif?: string;
  noCache?: boolean;
  noChecks?: boolean;
  trustHeadConfig?: boolean;
}

export interface ParsedArgs {
  // 'help' and 'version' when only that flag was given; '' when there is no command at all.
  command: string;
  flags: ParsedFlags;
  positionals: string[];
}

type BooleanFlag = 'help' | 'version' | 'dryRun' | 'reproduce' | 'noHostPrompt' | 'allowUnproven' | 'probe' | 'json' | 'noCache' | 'noChecks' | 'trustHeadConfig';
type ValueFlag = 'mode' | 'radius' | 'diff' | 'spec' | 'inventory' | 'images' | 'rules' | 'author' | 'since' | 'out' | 'sarif';

const BOOLEAN_FLAGS: Record<string, BooleanFlag> = {
  help: 'help',
  version: 'version',
  'dry-run': 'dryRun',
  reproduce: 'reproduce',
  'no-host-prompt': 'noHostPrompt',
  'allow-unproven': 'allowUnproven',
  probe: 'probe',
  json: 'json',
  'no-cache': 'noCache',
  'no-checks': 'noChecks',
  'trust-head-config': 'trustHeadConfig',
};

const VALUE_FLAGS: Record<string, ValueFlag> = {
  radius: 'radius',
  mode: 'mode',
  diff: 'diff',
  spec: 'spec',
  inventory: 'inventory',
  images: 'images',
  rules: 'rules',
  author: 'author',
  since: 'since',
  out: 'out',
  sarif: 'sarif',
};

function has(table: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedFlags = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (!token.startsWith('-')) {
      if (command === undefined) command = token;
      else positionals.push(token);
      continue;
    }

    if (!token.startsWith('--') || token.length === 2) {
      throw new UsageError(`Unknown option: ${token}`);
    }

    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

    if (has(BOOLEAN_FLAGS, name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`Option --${name} does not take a value.`);
      }
      const key = BOOLEAN_FLAGS[name] as BooleanFlag;
      flags[key] = true;
      continue;
    }

    if (has(VALUE_FLAGS, name)) {
      const key = VALUE_FLAGS[name] as ValueFlag;
      if (flags[key] !== undefined) {
        throw new UsageError(`Option --${name} was given more than once.`);
      }
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && next !== '-' && !(key === 'radius' && /^-\d/.test(next)))) {
          throw new UsageError(`Option --${name} needs a value.`);
        }
        value = next;
        i++;
      }
      if (value === '') {
        throw new UsageError(`Option --${name} needs a non-empty value.`);
      }
      if (key === 'mode') {
        if (!(REVIEW_MODES as readonly string[]).includes(value)) {
          throw new UsageError(
            `Unknown mode "${value}". Allowed modes: ${REVIEW_MODES.join(', ')}.`,
          );
        }
        flags.mode = value as (typeof REVIEW_MODES)[number];
      } else if (key === 'radius') {
        if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new UsageError('--radius must be an integer.');
        flags.radius = Math.min(200, Math.max(1, Number(value)));
      } else {
        flags[key] = value;
      }
      continue;
    }

    throw new UsageError(`Unknown option: --${name}`);
  }

  if (command === undefined) {
    if (flags.help) command = 'help';
    else if (flags.version) command = 'version';
    else command = '';
  }

  if (flags.mode === 'bughunt') flags.radius ??= 40;
  return { command, flags, positionals };
}
