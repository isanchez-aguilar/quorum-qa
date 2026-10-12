import { readFileSync } from 'node:fs';
import { ConfigError } from '../config/index.js';
import { parseArgs, UsageError } from './args.js';

export const EXIT_OK = 0;
export const EXIT_BLOCKERS = 1;
export const EXIT_ERROR = 2;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

export const USAGE = `Usage: quorum <command> [options]

Commands:
  review    Run a quorum of AI reviewers over a change (not implemented yet)
  doctor    Check which providers and models are usable (not implemented yet)

Options for review:
  --mode <feature|redesign>  Review mode
  --diff <range>             Git range to review, e.g. origin/main...HEAD
  --spec <file>              Spec with the acceptance criteria (feature)
  --inventory <file>         Inventory of the old features (redesign)
  --images <dir>             Screenshots to review (redesign)
  --rules <file>             Glossary and copy rules
  --author <name>            Who wrote the change: claude, codex, gemini, qwen
                             or a family (anthropic, openai, google, local)
  --since <sha>              Re-review only the changes since this commit
  --dry-run                  Print the plan and spend nothing
  --reproduce                Try to reproduce BLOCKERs with a failing test
  --allow-unproven           Unproven BLOCKERs do not fail the run

General:
  --help                     Print this help
  --version                  Print the version

Exit codes: 0 no BLOCKER remains, 1 a BLOCKER remains, 2 tool or config error.
`;

function packageVersion(): string {
  // Same depth from src/cli and from dist/cli.
  const file = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const { command, flags } = parseArgs(argv);

    if (flags.help || command === 'help') {
      io.out(USAGE);
      return EXIT_OK;
    }
    if (flags.version || command === 'version') {
      io.out(`${packageVersion()}\n`);
      return EXIT_OK;
    }

    switch (command) {
      case 'review':
      case 'doctor':
        io.err(`quorum ${command}: not implemented yet (M3/M4)\n`);
        return EXIT_ERROR;
      case '':
        io.err(USAGE);
        return EXIT_ERROR;
      default:
        io.err(`Unknown command: ${command}\n\n${USAGE}`);
        return EXIT_ERROR;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`quorum: ${error.message}\nRun "quorum --help" for usage.\n`);
      return EXIT_ERROR;
    }
    if (error instanceof ConfigError) {
      io.err(`quorum: ${error.message}\n`);
      return EXIT_ERROR;
    }
    io.err(`quorum: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}
