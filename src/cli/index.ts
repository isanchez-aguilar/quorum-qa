import { review, type ReviewDependencies } from './review.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config/index.js';
import { runDoctor } from '../doctor/index.js';
import { parseArgs, UsageError } from './args.js';

export const EXIT_OK = 0;
export const EXIT_BLOCKERS = 1;
export const EXIT_ERROR = 2;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDependencies extends ReviewDependencies {
  repoRoot?: string;
  loadConfig?: typeof loadConfig;
  runDoctor?: typeof runDoctor;
}

const defaultIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

export const USAGE = `Usage: quorum <command> [options]

Commands:
  review    Run a quorum of AI reviewers over a change
  doctor    Check which providers and models are usable

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
  --allow-unproven           Waive unconfirmed non-local BLOCKERs (M6: unproven reproduction)
                             Confirmed BLOCKERs always fail in M5
  --out <report.md>          Markdown output (default .quorum/reports/<runId>.md)
  --sarif <file>             SARIF 2.1.0 output
  --json                    Print the full review result
  --no-cache                Bypass cache reads and writes
  --no-checks               Skip deterministic checks; use with untrusted changes
  --trust-head-config       Use committed HEAD config (own repos only)

Options for doctor:
  --probe                    Run one read probe per provider (spends quota)
  --json                     Print the diagnostic check list as JSON

General:
  --help                     Print this help
  --version                  Print the version

--diff <sha>...HEAD trusts config at the merge-base of the range you chose.
Checks execute the reviewed change's code in a disposable worktree.
--spec, --inventory and --rules require regular non-symlink files, at most 256 KiB each.
Feature specs accept Markdown checkboxes or a list under a heading containing "acceptance".

Exit codes: 0 = complete coverage with no failing BLOCKER; 1 = a BLOCKER remains;
2 = incomplete coverage with no BLOCKER, nothing to review, or tool/config/usage error.
`;

function packageVersion(): string {
  // Same depth from src/cli and from dist/cli.
  const file = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

export async function main(
  argv: string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {},
): Promise<number> {
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
        return await review(flags, io, dependencies);
      case 'doctor': {
        const repoRoot = dependencies.repoRoot ?? process.cwd();
        let config;
        try { config = await (dependencies.loadConfig ?? loadConfig)(path.join(repoRoot, 'quorum.config.json')); }
        catch (error) {
          if (!(error instanceof ConfigError) || !error.message.includes('file not found:')) throw error;
        }
        const checks = await (dependencies.runDoctor ?? runDoctor)(config, {
          repoRoot,
          probe: flags.probe ?? false,
        });
        if (flags.json) {
          io.out(`${JSON.stringify(checks, null, 2)}\n`);
        } else {
          for (const check of checks) {
            io.out(`[${check.status}] ${check.id}: ${check.message}\n`);
            if (check.fix) io.out(`  Fix: ${check.fix}\n`);
          }
        }
        return checks.some((check) => check.status === 'FAIL') ? EXIT_ERROR : EXIT_OK;
      }
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
