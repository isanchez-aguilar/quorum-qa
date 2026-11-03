# Changelog

All notable changes to Quorum are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0, a minor version may change
configuration or report formats; each such change is listed here.

## [0.1.0] — first public release

### Review
- `quorum review` runs a cascade of AI reviewers over a git diff (every mode except `runtime` without `--visual` and `refactor --deterministic-only`, which call no model):
  - Gemini through Antigravity (`agy`), Codex, Claude Code and an optional local Qwen server.
  - The stages are triage, review and confirmation by a different model family.
  - It reports only findings whose evidence is verified against the code.
- Modes: `general` (the default), `feature` (acceptance criteria from a spec), `redesign`, `bughunt`, `contract`, `refactor` and `runtime` (locked-down Playwright containers that compare base and head).
- Sensitive chunks (money, auth, permissions) get a second review from another family when triage finds nothing.
- An optional reproduction lane proves a BLOCKER with a failing test in a container with no network.
- Exit codes:
  - `0`: complete with no failing BLOCKER or error-severity rule match; for refactor and runtime, also NO BEHAVIOUR CHANGE FOUND, NO NEW RUNTIME PROBLEMS FOUND or the advisory SUSPECT;
  - `1`: a BLOCKER or error-severity rule match, refactor NOT EQUIVALENT, or NEW RUNTIME PROBLEMS;
  - `2`: incomplete coverage (including a check timeout), refactor or runtime UNKNOWN, nothing to review, or a tool or config error.
  - A failed repository check never changes the exit code.

### Setup and operation
- `quorum init` detects the package manager, scripts and default branch, and writes `quorum.config.json`.
- `quorum doctor` checks providers, logins, permissions, the container runtime and Windows path length.
- Repository checks run in a disposable worktree, in parallel with triage. Each check has a timeout, and a check that a task runner replayed from its cache is labelled as cached.
- `--dry-run` shows models, calls and budget before anything is spent. The call budget scales with the size of the diff.
- Reports come as Markdown, JSON and SARIF 2.1.0.
- `quorum suppress` records reviewed false positives.
- `quorum rules propose` mines recurring verified findings into deterministic rules.
- Model output that was dropped is kept in the report and on disk instead of being lost.

### Safety
- Providers run read-only: the cloud CLIs use your own logins, and Qwen is a local server you run. Quorum never asks for or stores API keys.
- Configuration is read from the merge-base by default, so a pull request cannot change the commands that review it. `--trust-head-config` reads it from HEAD instead, for your own repositories only.
- A checkout guard aborts the run if anything writes to your working tree.
