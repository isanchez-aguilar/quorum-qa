# Roadmap

## v1: review that you can trust
Feature and redesign modes, plus:
- codex and agy adapters (agy covers the Gemini, Claude and GPT-OSS models it lists);
- `quorum doctor` and `--dry-run`, so nothing is spent by surprise;
- the model catalog with tiers, families and quota groups;
- the verifier;
- dedupe;
- the origin label: introduced, pre-existing or improvement;
- the BLOCKER reproduction lane in a temporary local worktree;
- markdown and SARIF reports;
- the ledger and the cache.

See the milestones in [PLAN.md](PLAN.md#v1-milestones).

## v1.x: more reviewers, less spend
- Working claude and qwen adapters.
- **Jules as the cloud reproduction lane:** one session per BLOCKER writes and runs a failing test on the pushed branch. Quorum pulls the result and never applies it.
- The cascade policy, configurable per focus (money, auth, a11y, copy).
- Incremental re-review (`--since`) and the cache, both on by default.
- A pluggable context provider: a code-graph index such as CodeGraph instead of the plain diff.

## v2: more modes
- **refactor:** the tests at base and at head, a diff of the public API surface, mutation testing on the touched code, and the blast radius.
- **bughunt:** pre-existing bugs near the diff, reported separately.
- **contract:** code compared against business-rules docs and against UI copy.
- **runtime:** Playwright flows that collect console errors, 4xx/5xx responses, blank pages and technical text shown to users.
- **rule-mining:** a recurring finding becomes a proposed lint rule.

## v3: team use
- A GitHub Action that posts verified findings as a PR review, with Jules as an optional cloud reviewer.
- A precision dashboard per provider and per model: real findings against false ones, cost and time.
- Suppression files, so known false positives stop coming back.
- A "ready for production?" report.
- Possibly a hosted or team edition (open-core).
