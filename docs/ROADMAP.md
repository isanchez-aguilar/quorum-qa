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
- [x] Working claude and qwen adapters.
- [x] When a chunk was reviewed only by a local model, escalate it to a non-local reviewer within budget, instead of only marking coverage incomplete (decision 17).
- A thin `/quorum` skill that runs the CLI from a Claude Code session, packaged with it as a plugin. **Done:** `plugin/` and `.claude-plugin/marketplace.json`, validated with `claude plugin validate`.
- **Jules as a cloud reproduction lane**, only once AGENTS.md has an explicit exception for it and the exact commit can be pinned. Its test is pulled without applying it, and re-run locally before it counts as evidence.
- [x] The cascade policy, configurable per focus (money, auth, a11y, copy).
- Incremental re-review (`--since`) and the cache, both on by default.
- A `ui-detail` check pack for the redesign mode: deterministic probes (pixel rows, bounding-box deltas, touch targets, contrast, payload and artifact greps) before a vision model reviews crops. See [UI-DETAIL-CHECKS.md](UI-DETAIL-CHECKS.md).
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
