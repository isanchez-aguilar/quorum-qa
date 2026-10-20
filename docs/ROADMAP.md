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
- [x] A pluggable context provider: opt-in CodeGraph touched symbols and callers supplement the plain diff (decision 19).

## v2: more modes
- [x] **Precision:** confirm single-source IMPORTANT findings from the triage tier in batches of up to five using remaining budget (decision 22). Rejections are reported separately; unanswered findings carry a visible single-model tag.
- **refactor (parts 1–2 done, decisions 25–26):** tests at merge-base and head, public API surface diff, blast radius and model review; `--deterministic-only` needs no provider calls. Opt-in `--mutation` now samples changed source lines with no provider quota (up to 8 extra suite runs by default); survivors yield SUSPECT. `refactor.mutation` sets maxMutants (1–25) and budgetSeconds (30–3600, default 300); only the flag enables it.
- [x] **bughunt:** pre-existing bugs near the diff, reported separately, with bounded HEAD windows and independent BLOCKER confirmation.
- **contract (done):** code compared against business-rules clauses and UI copy, with direct imports, verified evidence, Rules coverage and SARIF.
- **runtime (R0 built; R1-R5 planned, docs/RUNTIME-PLAN.md):** Config/flow validation, dry-run and the synthetic fixture are available. Playwright collection of console errors, 4xx/5xx responses, blank pages and technical text shown to users remains planned.
- [x] **rule-mining:** recurring verified findings become proposed lint rules; human-accepted rules run deterministically on added lines using trusted-base configuration (decision 24).

## v3: team use
- A GitHub Action that posts verified findings as a PR review, with Jules as an optional cloud reviewer.
- A precision dashboard per provider and per model: real findings against false ones, cost and time.
- Suppression files, so known false positives stop coming back.
- A "ready for production?" report.
- Possibly a hosted or team edition (open-core).
