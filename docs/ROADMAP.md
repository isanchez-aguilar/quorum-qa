# Roadmap

## v1: review that you can trust
Feature and redesign modes, plus:
- codex and agy-gemini adapters;
- the verifier;
- dedupe;
- the origin label: introduced, pre-existing or improvement;
- markdown and SARIF reports;
- the ledger and the cache.

See the checklist in [PLAN.md](PLAN.md#v1-scope-ship-small).

## v1.x: more reviewers, less spend
- Working claude and qwen adapters.
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
- A GitHub Action that posts verified findings as a PR review.
- A precision dashboard per provider: real findings against false ones, cost and time.
- Suppression files, so known false positives stop coming back.
- A "ready for production?" report.
- Possibly a hosted or team edition (open-core).
