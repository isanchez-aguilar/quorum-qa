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
  "checks": [["pnpm", "typecheck"], ["pnpm", "test"]],
  "tiers": {
    "triage": ["agy:gemini-3.8-flash-medium", "qwen"],
    "review": ["agy:gemini-4-argon-high", "claude:sonnet"],
    "confirm": ["codex", "claude:opus"],
    "visual": ["agy:gemini-4-argon-high"]
  }
}
```

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

# Redesign review auditing feature parity and visual assets
node bin/quorum.js review --mode redesign --diff origin/main...HEAD --inventory docs/old-features.md --images shots/
```

## How a review works

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

- `0` = complete coverage with no failing BLOCKER
- `1` = a BLOCKER remains
- `2` = incomplete coverage with no BLOCKER, nothing to review, or tool/config/usage error

## Flags

| Command | Flag | Description |
|---|---|---|
| `review` | `--mode <feature\|redesign>` | Review mode |
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
| `review` | `--sarif <file>` | SARIF 2.1.0 output |
| `review` | `--json` | Print the full review result |
| `review` | `--no-cache` | Bypass cache reads and writes |
| `review` | `--no-checks` | Skip deterministic checks; use with untrusted changes |
| `review` | `--trust-head-config` | Use committed HEAD config (own repos only) |
| `doctor` | `--probe` | Run one read probe per provider (spends quota) |
| `doctor` | `--json` | Print the diagnostic check list as JSON |
| General | `--help` | Print this help |
| General | `--version` | Print the version |

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
