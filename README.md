# Quorum

Quorum runs several AI coding CLIs over a git diff and reports only findings verified against the repository code. It classifies each finding as introduced, pre-existing, or improvement, dropping reports with hallucinated files, drifted line numbers, or mismatched quotes. For blockers, it can optionally generate and execute reproduction tests in an isolated container.

## Status

Milestones M0 through M6 are implemented and merged (v1).

Verified on a real machine (Windows 11, agy 1.2.x, codex 0.160.0, Claude Code 2.1.285, a local Qwen server):
- `quorum doctor` and `quorum doctor --probe`
- End-to-end `quorum review --mode feature` smoke runs with real providers
- The reproduction lane and escape test under Docker Desktop (engine 29.8.1, Linux): a real BLOCKER was confirmed by a second model family and reproduced by a failing test
- Qwen: doctor probe against a real local server (one chat completion)
- Claude Code: CLI present; review blocked by an expired login on the test machine

Not verified:
- a full review through the Qwen or Claude adapters
- Linux and macOS hosts
- Podman
- npm and Yarn repositories
- Monorepos

## Requirements

- Node 22
- pnpm
- Git
- Your own logins for the providers you configure: Antigravity (`agy`), OpenAI Codex (`codex`) and optionally Claude Code (`claude`)
- Docker (optional, required for containerized `--reproduce`)
- A local OpenAI-compatible model server such as Qwen at `http://127.0.0.1:8080/v1` (optional, triage only; its findings never stand alone)

## Install from source

```sh
git clone https://github.com/isanchez-aguilar/quorum-qa.git
cd quorum-qa
pnpm install
pnpm build
node bin/quorum.js --help
```

### Claude Code plugin (optional)

The repo is also a Claude Code plugin marketplace with a `/quorum` skill. It runs `quorum doctor`, always shows a `--dry-run` plan first, and asks before spending provider quota:

```sh
claude plugin marketplace add isanchez-aguilar/quorum-qa
claude plugin install quorum@quorum
```

## Quick start

Add `quorum.config.json` to the repository root:

```json
{
  "setup": [["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]],
  "checks": [["pnpm", "typecheck"], ["pnpm", "test"]],
  "tiers": {
    "triage": ["agy:gemini-3.8-flash-low", "qwen"],
    "review": ["agy:gemini-4-argon-high", "claude:sonnet"],
    "confirm": ["codex", "claude:opus"],
    "visual": ["agy:gemini-4-argon-high"]
  }
}
```

Optional `setup` argv commands install dependencies in the fresh HEAD worktree before checks. A failed setup fails the checks phase and still permits review. Setup executes install scripts unless the command disables them; `--no-checks` skips both setup and checks. `budget.maxCallSeconds` defaults to 300 (30–1800), capped further by remaining run time.

`context.provider` defaults to `"git"`; set it to `"codegraph"` to add bounded, possibly stale symbol/caller context from an existing `.codegraph/` index and a shell-free CodeGraph executable on PATH (Quorum never creates or updates the index and falls back to git when unavailable).

Check provider and model availability:

```sh
node bin/quorum.js doctor
node bin/quorum.js doctor --probe
```

Review diffs:

```sh
# Plan the review and estimate budget without calling providers
node bin/quorum.js review --mode feature --diff origin/main...HEAD --spec docs/spec.md --dry-run

# Feature review against acceptance criteria
node bin/quorum.js review --mode feature --diff origin/main...HEAD --spec docs/spec.md

# Check business rules against code and UI copy
node bin/quorum.js review --mode contract --rules docs/business-rules.md --copy src/ui --diff origin/main...HEAD

# Hunt pre-existing bugs in unchanged code around the diff (default radius: 40 lines)
node bin/quorum.js review --mode bughunt --diff origin/main...HEAD --radius 40

# Compare tests, public exports and dependents without provider calls or logins
node bin/quorum.js review --mode refactor --diff origin/main...HEAD --deterministic-only

# Add the normal model cascade to the refactor evidence
node bin/quorum.js review --mode refactor --diff origin/main...HEAD

# Redesign review auditing feature parity and visual assets
node bin/quorum.js review --mode redesign --diff origin/main...HEAD --inventory docs/old-features.md --images shots/

# Propose rules from recurring verified findings, without calling a model
node bin/quorum.js rules propose --min 3 --days 90 --out proposed-rules.md
```

Review a proposal's examples and noise estimate, then manually add accepted entries
to `quorum.rules.json` at the repository root:

```json
{
  "rules": [
    { "id": "no-debug-call", "pattern": "console\\.log\\(", "message": "Remove debug output", "severity": "warning", "paths": ["src/**"] }
  ]
}
```

Rules run on added lines before models. They are read from the merge-base, so
deleting or weakening a rule in a PR does not bypass it. `--trust-head-config`
uses committed HEAD; `--no-checks` skips rules. Each pattern has a one-second
worker timeout; lines over 2000 characters are skipped with a note. Timeouts warn.
Error-severity matches exit 1; warnings do not change the exit code.

`.quorum/findings.jsonl` contains local verified-finding history **including code
quotes**. Keep it local and git-ignored. It is capped at 5 MiB and retains the
newest half when full. `rules propose` requires findings from at least two runs
and two files; it never writes `quorum.rules.json` or calls a model. The default
90-day window and minimum of three can be changed; `--json` prints structured
proposals. Generated rules start as warnings and still need human review.

## How a review works

Refactor mode runs setup and the test command in separate merge-base and HEAD
worktrees. Optional `refactor` configuration accepts `testCommand` (an argv array)
and `timeoutSeconds` (default 600, range 30–3600). Without an explicit command,
the reproduction command supplies the suite runner with file-specific selectors
removed: positional test paths/names, `{file}`/`{testFile}`, `-t`,
`--testNamePattern`, `--testPathPattern(s)`, `--runTestsByPath`, and old
`--outputFile` destinations. Launcher prefixes and common suite options such as
`--config` are preserved; use an explicit command for custom launchers, for
example `"refactor": { "testCommand": ["pnpm", "vitest", "run"], "timeoutSeconds": 600 }`.
Both runners must write Vitest/Jest-compatible JSON; console prose is
never treated as test evidence. Configure setup to install each revision's own
dependencies. `--no-checks` is incompatible with refactor and exits 2.

Refactor reports **NOT EQUIVALENT** (exit 1), **SUSPECT** (exit 0),
**NO BEHAVIOUR CHANGE FOUND** (exit 0), or **UNKNOWN** (exit 2).
Tests and model review cannot prove equivalence. Test edits/removals and missing
test dependents remain suspect; tests fixed at HEAD are reported without implying
equivalence. `--allow-api-change` lists API breakage as an allowed note.
Use `--mutation` to sample changed source lines deterministically in the disposable
HEAD worktree. It adds up to `maxMutants` suite runs (default 8), with no provider
calls of its own. Combine it with `--deterministic-only` for zero provider quota.
Optional configuration: `"mutation": { "maxMutants": 8, "budgetSeconds": 300 }`
inside `refactor`; ranges are 1–25 mutants and 30–3600 seconds. Configuration
alone does not enable sampling. Survivors warn that tests do not pin the changed
code and yield SUSPECT, never NOT EQUIVALENT by themselves. Invalid mutants,
skips and budget exhaustion are notes only. This is lexical sampling, not proof
of equivalence; ambiguous syntax, interpolated templates and long lines may be
omitted.

- **Deterministic checks:** Configured linters, typecheckers, and test suites run first in a disposable worktree before calling any model.
- **Cascade:** Diff chunks go to a cheap triage model first. A finding escalates to the confirm tier when it is a BLOCKER, touches a focus area (money, auth, permissions), has low confidence, or comes only from a local model; unparseable answers go to the review tier.
- **Verifier:** Every finding must point at a real file inside the repo, and its quote must match the code (exactly, or near-exactly with the same operators, literals and identifiers). Anything else is dropped.
- **Dedupe:** Findings merge only on a strong textual match a few lines apart. Similar-looking findings are kept separate and marked as possibly related, and the confirm tier decides whether they are the same defect. Only independent agreement across model families raises confidence.
- **Coverage:** Quorum tracks reviewed files, skipped files, truncated hunks, and lost findings, failing closed if limits prevent full diff coverage.
- **Reproduction:** For confirmed blockers, `--reproduce` attempts to generate and run an isolated test that fails at HEAD and passes at base.

## Safety model

- **Read-only providers in disposable worktrees:** Reviewers run in isolated git worktrees under `.quorum/worktrees/` and never write to the working checkout.
- **Checkout guard:** Quorum snapshots `git status` and HEAD before and after provider calls, aborting immediately if working tree changes occur.
- **Config read from the merge-base:** `quorum.config.json` is loaded from the merge-base of the diff range to prevent untrusted PR branches from defining check commands. Use `--trust-head-config` only for your own repos.
- **Checks run the change's code:** Configured deterministic checks execute the reviewed revision's code in a disposable worktree; use `--no-checks` for untrusted changes.
- **Reproduction in an isolated container:** Untrusted reproduction tests execute inside Docker or Podman with a read-only root, read-only dependencies, dropped capabilities, and no network access.
- **Host execution only with confirmation:** Without a container, reproduction runs on the host only after an interactive per-test confirmation; `--no-host-prompt` defaults to no.

## Exit codes

- `0` = complete coverage with no failing BLOCKER or error-severity rule match
- `1` = a BLOCKER or error-severity rule match remains
- `2` = incomplete coverage without either, nothing to review, or tool/config/usage error

## Flags

| Command | Flag | Description |
|---|---|---|
| `review` | `--mode <feature\|redesign\|bughunt\|contract\|refactor\|runtime>` | Review mode (runtime: deterministic base/head comparison, no provider calls) |
| `review` | `--deterministic-only` | Refactor evidence without provider calls |
| `review` | `--mutation` | Refactor only: up to maxMutants extra suite runs (default 8); survivors yield SUSPECT |
| `review` | `--allow-api-change` | List refactor API breakage without failing for it |
| `review` | `--radius <n>` | Bughunt lines before/after each hunk; default 40, clamped to 1-200 |
| `review` | `--diff <range>` | Git range to review, e.g. origin/main...HEAD |
| `review` | `--spec <file>` | Spec with the acceptance criteria (feature) |
| `review` | `--inventory <file>` | Inventory of the old features (redesign) |
| `review` | `--images <dir>` | Screenshots to review (redesign) |
| `review` | `--rules <file>` | Glossary and copy rules |
| `review` | `--author <name>` | Who wrote the change: claude, codex, gemini, qwen or a family (anthropic, openai, google, local) |
| `review` | `--since <sha>` | Re-review only the changes since this commit |
| `review` | `--dry-run` | Print the plan and spend nothing |
| `review` | `--reproduce` | Try to reproduce BLOCKERs with a failing test |
| `review` | `--allow-unproven` | Waive BLOCKERs only without cross-family confirmation. Cross-family BLOCKERs fail even when reproduction is unproven |
| `review` | `--no-host-prompt` | Never authorizes host execution; automatic "no" (unproven) |
| `review` | `--out <report.md>` | Markdown output (default .quorum/reports/<runId>.md) |
| `review` | `--strict-flows` | Runtime only: newly broken stable steps fail with exit 1 |
| `review` | `--format json` | Runtime only: full comparison and verdict as JSON (also `--json`) |
| `review` | `--sarif <file>` | SARIF 2.1.0 output |
| `review` | `--json` | Print the full review result |
| `review` | `--no-cache` | Bypass cache reads and writes |
| `review` | `--no-checks` | Skip deterministic checks; use with untrusted changes |
| `review` | `--trust-head-config` | Use committed HEAD config (own repos only) |
| `doctor` | `--probe` | Run one read probe per provider (spends quota) |
| `doctor` | `--json` | Print the diagnostic check list as JSON |
| General | `--help` | Print this help |
| General | `--version` | Print the version |

## Runtime review (R0–R3)

`quorum review --mode runtime --dry-run` validates the trusted config's `runtime`
block and prints the start argv, readiness URL, flow/step counts, timeouts, image
and resource limits. It never prints fill values. `start`, `readyUrl` and `flows`
are required only in runtime mode; a block alone does not select the mode.
See [RUNTIME-PLAN.md](docs/RUNTIME-PLAN.md) for the declarative flow format.
Use synthetic test data and idempotent flows.

`quorum review --mode runtime --diff main...HEAD` runs each configured flow twice
at merge-base and head inside the pinned Playwright container. It compares stable
observations deterministically, with no provider calls. New browser problems
produce **NEW RUNTIME PROBLEMS** (exit 1); pre-existing problems and blocked
external hosts are informational. A newly broken step or flaky flow produces
**SUSPECT** (exit 0). Use runtime-only `--strict-flows` to make newly broken steps
fail with exit 1. Unavailable or incomplete evidence produces **UNKNOWN** (exit 2),
unless a confirmed new problem already requires exit 1; both reasons are listed.
**NO NEW RUNTIME PROBLEMS FOUND** (exit 0) names only the covered flows.

Markdown is printed and saved with `--out <report.md>` (default
`.quorum/reports/<runId>.md`); `--sarif <file>` adds SARIF. `--json` or runtime-only
`--format json` prints the full result, including `runtime.comparison`, verdict,
reasons and a bounded JSON model summary. Fill values are redacted from evidence.
The app must work offline with loopback services; flows must be idempotent.
`--no-checks` is incompatible because runtime mode must run the app.
`--spec`, `--inventory`, `--images`, `--rules`, `--deterministic-only`,
`--allow-api-change` and `--mutation` are rejected in runtime mode.

## Your logins, not ours

Quorum calls each vendor's own CLI, signed in with your own subscription. It never stores, requests or proxies API keys.

## License

[Apache-2.0](LICENSE). "Quorum" as a project name is reserved; see [TRADEMARKS.md](TRADEMARKS.md). Contributions are accepted under the DCO; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs

- [Plan](docs/PLAN.md): the problem, architecture, modes, token strategy and v1 scope
- [Roadmap](docs/ROADMAP.md)
- [Lessons from real use](docs/LESSONS.md)
- [Implementation](docs/IMPLEMENTATION.md)
- [UI detail checks](docs/UI-DETAIL-CHECKS.md): small visual and interaction defects tests miss, as checks with a pass criterion
- [Naming](docs/NAMING.md)
