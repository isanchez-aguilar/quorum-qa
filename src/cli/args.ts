export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const REVIEW_MODES = ['feature', 'redesign'] as const;

export interface ParsedFlags {
  help?: boolean;
  version?: boolean;
  mode?: (typeof REVIEW_MODES)[number];
  diff?: string;
  spec?: string;
  inventory?: string;
  images?: string;
  rules?: string;
  author?: string;
  since?: string;
  dryRun?: boolean;
  reproduce?: boolean;
  allowUnproven?: boolean;
}

export interface ParsedArgs {
  // 'help' and 'version' when only that flag was given; '' when there is no command at all.
  command: string;
  flags: ParsedFlags;
  positionals: string[];
}

type BooleanFlag = 'help' | 'version' | 'dryRun' | 'reproduce' | 'allowUnproven';
type ValueFlag = 'mode' | 'diff' | 'spec' | 'inventory' | 'images' | 'rules' | 'author' | 'since';

const BOOLEAN_FLAGS: Record<string, BooleanFlag> = {
  help: 'help',
  version: 'version',
  'dry-run': 'dryRun',
  reproduce: 'reproduce',
  'allow-unproven': 'allowUnproven',
};

const VALUE_FLAGS: Record<string, ValueFlag> = {
  mode: 'mode',
  diff: 'diff',
  spec: 'spec',
  inventory: 'inventory',
  images: 'images',
  rules: 'rules',
  author: 'author',
  since: 'since',
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
        if (next === undefined || (next.startsWith('-') && next !== '-')) {
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

  return { command, flags, positionals };
}
