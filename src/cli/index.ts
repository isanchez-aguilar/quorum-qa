import { review, type ReviewDependencies } from './review.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config/index.js';
import { runDoctor } from '../doctor/index.js';
import { parseArgs, UsageError } from './args.js';
import { proposeRules, renderRuleProposals } from '../rules/mining.js';
import { atomicWrite } from '../storage/index.js';
import { suppressCommand } from '../suppressions/commands.js';
import { init } from './init.js';

export const EXIT_OK = 0;
export const EXIT_BLOCKERS = 1;
export const EXIT_ERROR = 2;

export interface CliIo {
  isTTY?: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDependencies extends ReviewDependencies {
  homedir?: string;
  repoRoot?: string;
  loadConfig?: typeof loadConfig;
  runDoctor?: typeof runDoctor;
}

const defaultIo: CliIo = {
  isTTY: process.stderr.isTTY === true,
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

export const USAGE = `Usage: quorum <command> [options]

Commands:
  init      Generate repository configuration and .gitignore entry
  review    Run a quorum of AI reviewers over a change
  doctor    Check which providers and models are usable
  rules propose  Propose deterministic rules from recurring verified findings (no model calls)
  suppress add --from <report.json> --finding <n> --reason <text> [--expires YYYY-MM-DD]
  suppress list [--from <report.json>]  List active/expired/unused suppressions
  suppress remove <id>       Remove a working-tree suppression (no model calls)

Options for review:
  --verbose                Print completion timing even when stderr is not a terminal
  --mode <general|feature|redesign|bughunt|contract|refactor|runtime>  Review mode
                            Default: general; --spec alone selects feature
  --deterministic-only      Refactor evidence only; no provider calls or logins
  --mutation               Refactor only: sample changed lines; up to maxMutants extra suite runs (default 8)
  --allow-api-change        List breaking API changes without failing refactor review
                            Any textual signature change is breaking, including compatible
                            widening or an added optional parameter; review compatibility
  --radius <n>              Unchanged lines around hunks (bughunt; default 40, clamped 1-200)
  --diff <range>             Git range to review, e.g. origin/main...HEAD
  --spec <file>              Spec with the acceptance criteria (feature)
  --inventory <file>         Inventory of the old features (redesign)
  --images <dir>             Screenshots to review (redesign)
  --rules <file>             Business rules (required for contract); design rules otherwise
  --copy <file-or-dir>       UI copy (contract; 50 files, 64 KiB each, no symlinks)
  --author <name>            Who wrote the change: claude, codex, gemini, qwen
                             or a family (anthropic, openai, google, local)
  --since <sha>              Re-review only the changes since this commit
  --dry-run                  Print the plan and spend nothing
  --format json              Runtime only: print comparison and verdict as JSON
  --strict-flows             Runtime only: fail when a flow breaks at head
  --visual                   Runtime only: capture and send screenshots to visual providers (advisory)
  --reproduce                Try to reproduce BLOCKERs with a failing test
  --allow-unproven           Waive BLOCKERs only without cross-family confirmation
                             Cross-family BLOCKERs fail even when reproduction is unproven
  --no-host-prompt           Never authorizes host execution; automatic "no" (unproven)
  --out <report.md>          Markdown output (default .quorum/reports/<runId>.md)
  --sarif <file>             SARIF 2.1.0 output
  --json                    Print the full review result
  --no-cache                Bypass cache reads and writes
  --no-checks               Skip deterministic checks; use with untrusted changes
  --sequential-checks       Finish checks before triage (budget.sequentialChecks: true)
  --trust-head-config       Use committed HEAD config (own repos only)

Options for doctor:
  --probe                    Run one read probe per provider (spends quota)
  --json                     Print the diagnostic check list as JSON

Options for init:
  --dry-run                  Print proposed configuration; change nothing
  --force                    Replace an existing quorum.config.json
  Detects package manager/scripts, ignores .quorum/, and runs doctor without probes.
  Prints the agy read permission; never edits home settings. Commit the config and
  .gitignore on the base branch before review (trusted merge-base configuration).

Options for rules propose:
  --min <n>                  Minimum findings (default 3; range 2-50)
  --days <n>                 History window (default 90; range 1-3650)
  --out <file.md>            Save the Markdown proposals
  --json                     Print proposals as JSON

Files:
  quorum.rules.json          Accepted deterministic rules; read from the trusted config commit
  quorum.suppress.json       Reviewed false positives; trusted base (HEAD with --trust-head-config)
  .quorum/findings.jsonl     Local verified-finding history, including code quotes (never commit)

General:
  --help                     Print this help
  --version                  Print the version

--diff <sha>...HEAD trusts config at the merge-base of the range you chose.
Call budget defaults to clamp(3 x review chunks, 12, 40); budget.maxCalls pins it (1–200).
Runtime and refactor --deterministic-only keep the default of 12. Quota floors still apply.
Triage concurrency: budget.concurrency (1–6, default 3; 1 restores sequential triage).
Checks overlap triage by default; confirmation waits for their evidence.
Sensitive chunks with no surviving triage findings get a review-tier pass within remaining
budget, preserving confirmation reserve (escalate.sensitiveSecondPass: true; false disables).
Coverage reports sensitive chunks and second passes; budget omissions only warn.
Windows checks use a short per-user worktree when needed; doctor paths.length diagnoses risk.
Checks execute the reviewed change's code in a disposable worktree.
Setup/check timeout: budget.checkTimeoutSeconds (integer 30–3600, default 120), per command.
Timeouts report TIMED OUT, make coverage INCOMPLETE and suggest raising that limit.
Refactor and runtime retain their own timeouts.
--spec, --inventory and --rules require regular non-symlink files, at most 256 KiB each.
Feature specs accept Markdown checkboxes or a list under a heading containing "acceptance".
Suppressions use file and quote, not line; changed code stops matching. Reasons require 10–500
characters. Finding numbers are 1-based: findings, then unconfirmed, in review --json output.
Suppressed findings remain visible in Markdown/JSON and history, excluded from verdict/SARIF.
Reproduced two-family BLOCKERs cannot be suppressed. Commit the file for future reviews.

Exit codes: 0 = complete coverage with no failing BLOCKER or error-severity rule match;
1 = a BLOCKER or error-severity rule match remains;
2 = incomplete coverage with no BLOCKER or error-severity rule match (a timed-out check counts), nothing to review,
or tool/config/usage error.
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
    const { command, flags, positionals } = parseArgs(argv);

    if (command === 'doctor' && flags.dryRun && flags.probe) throw new UsageError('--dry-run cannot be combined with --probe: a dry run never calls a provider');
    if (flags.dryRun && (!['review', 'init'].includes(command) || flags.help || flags.version)) throw new UsageError('--dry-run is only supported by review and init.');

    if (flags.help || command === 'help') {
      io.out(USAGE);
      return EXIT_OK;
    }
    if (flags.version || command === 'version') {
      io.out(`${packageVersion()}\n`);
      return EXIT_OK;
    }

    if (flags.force && command !== 'init') throw new UsageError('--force requires init.');

    if (command !== 'suppress' && ['from', 'finding', 'reason', 'expires'].some(key => flags[key as keyof typeof flags] !== undefined)) {
      throw new UsageError('--from, --finding, --reason and --expires require suppress.');
    }

    if (flags.mutation && (command !== 'review' || flags.mode !== 'refactor')) throw new UsageError('--mutation requires refactor mode.');
    if (flags.strictFlows && (command !== 'review' || flags.mode !== 'runtime')) throw new UsageError('--strict-flows requires runtime mode.');
    if (flags.visual && (command !== 'review' || flags.mode !== 'runtime')) throw new UsageError('--visual requires runtime mode.');
    switch (command) {
      case 'init':
        return await init(flags, positionals, io, dependencies);
      case 'suppress': {
        const root = path.resolve(dependencies.repoRoot ?? process.cwd());
        io.out(await suppressCommand(positionals, flags, root, new Date((dependencies.now ?? Date.now)()).toISOString().slice(0, 10)));
        return EXIT_OK;
      }
      case 'rules': {
        if (positionals.length !== 1 || positionals[0] !== 'propose') throw new UsageError('Use quorum rules propose.');
        for (const key of Object.keys(flags)) {
          if (!['min', 'days', 'out', 'json'].includes(key)) throw new UsageError(`Option ${key} is not supported by rules propose.`);
        }
        if (flags.out && !/\.md$/i.test(flags.out)) throw new UsageError('--out for rules propose must be a Markdown (.md) file.');
        const root = path.resolve(dependencies.repoRoot ?? process.cwd());
        const proposals = await proposeRules(root, { min: flags.min, days: flags.days, runner: dependencies.gitRunner,
          ...(dependencies.now ? { now: new Date(dependencies.now()) } : {}) });
        const markdown = renderRuleProposals(proposals) + '\n';
        if (flags.out) await atomicWrite(path.resolve(root, flags.out), markdown, root);
        io.out(flags.json ? JSON.stringify(proposals, null, 2) + '\n' : markdown);
        return EXIT_OK;
      }
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
