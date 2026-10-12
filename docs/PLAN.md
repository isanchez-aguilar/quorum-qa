# Quorum — plan

> Working name: **Quorum** (package `quorum-qa`). The name is not final; see [NAMING.md](NAMING.md).

## The problem

AI coding CLIs (Claude Code, Codex, Gemini through Antigravity, local models) are good reviewers, but each one alone:

- invents things, most often line numbers, files, and quotes that aren't in the code;
- runs out of quota at the worst moment;
- spends expensive tokens on things a linter would catch for free;
- doesn't say whether a bug is new or was already there;
- gets re-run on everything after every fix.

Orchestrating several of them by hand works, and finds real bugs that no single one finds. But it costs hours of copy-paste prompts, quota juggling and manual verification.

## The product

A CLI, with a later GitHub Action, that runs a **quorum of AI reviewers** over a change and reports only **verified** findings:

- each one classified as **introduced**, **pre-existing** or **improvement**;
- each one with evidence;
- for blockers, a failing test that proves it.

```
quorum review --mode feature --diff origin/main...HEAD --spec docs/issue-123.md
quorum review --mode redesign --diff main...HEAD --inventory docs/old-features.md --images shots/
quorum review --since <sha>          # re-review only the fix diff
```

## Principles

1. **Deterministic first, AI second.** Run lint, typecheck, a11y (axe), contrast checks and rule greps before any model. No model ever spends tokens on what a linter catches.
2. **Verify everything.** A finding whose file, line or quote can't be found in the code is dropped. A BLOCKER that can't be reproduced by a failing test is downgraded.
3. **Cheap model triages, expensive model confirms.** Qwen or Gemini Flash go first. Only uncertain findings, or ones in money or auth code, escalate to Codex, Claude Opus or Gemini Pro.
4. **Surgical context.** Send the diff, the touched symbols and their callers, never whole files.
5. **The user's own logins.** Every provider runs the vendor's own CLI with the user's subscription. Quorum never stores, asks for or proxies API keys.
6. **Read-only reviewers.** Reviewers never edit. Fixes are a separate, explicit step.
7. **Measure the reviewers.** Every run appends to a ledger (findings, verified, rejected, time, cost), so you know which provider earns its place.

## Architecture (v1)

```
CLI ─► Planner ─► Deterministic checks (repo's own lint/tsc/axe via config)
          │
          ├─► Context builder (diff + touched symbols; pluggable: plain git, CodeGraph later)
          │
          ├─► Provider pool ──► adapters: codex | agy (gemini) | claude | qwen
          │        └─ preflight: on PATH? logged in? probe can read the folder? quota/429 → next provider
          │
          ├─► Cascade: triage (cheap) ─► escalate (expensive) by uncertainty / focus
          │
          ├─► Verifier: file exists · line in range · quote near line · optional cross-provider confirm
          │        └─ BLOCKER → "write a failing test" → reproduced? keep : downgrade
          │
          ├─► Dedupe (file + nearby line + similar text; agreement raises confidence)
          │
          └─► Reporters: markdown · SARIF · (later) GitHub PR review comments
                  └─ Ledger (JSONL) · Cache (hash(file+prompt) → result)
```

### Finding schema (strict JSON, no prose)

```json
{
  "severity": "BLOCKER | IMPORTANT | OPTIONAL",
  "origin": "introduced | pre-existing | improvement",
  "file": "src/x.ts",
  "line": 42,
  "trigger": "what input or state causes it",
  "impact": "what goes wrong for the user",
  "evidence_quote": "exact code text at or near the line",
  "fix": "minimal fix",
  "provider": "codex",
  "confidence": 0.0
}
```

`origin` comes from `git blame` against the review base. A flagged line that already existed before the base is **pre-existing**.

### Provider adapters

| Provider | How it runs (user's own login) | Notes from real use |
|---|---|---|
| Codex | `codex exec -C <dir> -s read-only -o <out> -` (prompt on stdin) | Finds real money and permission bugs. Quota runs out fast, so save it for escalation. Its sandbox sometimes can't read a freshly created folder on the first try: probe first, retry once. |
| Antigravity (Gemini) | `agy -p "<prompt>" --sandbox --mode plan --model gemini-3.1-pro-high --output-format json` | Plenty of quota, and it reads images (good for visual review). **Often cites wrong line numbers and non-existent files**, which is why the verifier exists. Headless runs end on the first denied command, so the prompt must say "use ONLY file-read tools". |
| Antigravity (Claude / GPT-OSS models) | same CLI, `--model claude-opus-…` | Shares one quota per model family, which can reset in hours or in days. Detect 429 and route to the next provider. |
| Claude Code | `claude -p` with read-only tools | Strong general reviewer. Use it as the triage-plus-fix partner, or as a reviewer when the change came from another provider. |
| Local model (Qwen etc.) | OpenAI-compatible endpoint (e.g. llama.cpp at `127.0.0.1:8080`) | Free, but slow and with limited context. Use it for triage, mechanical checks and drafting test tables, never for final judgment. |

**Independence rule:** the provider that wrote a change should not be its only reviewer.

## Review modes

| Mode | v1? | What it does |
|---|---|---|
| `feature` | ✅ | `--spec <file or issue URL>` → acceptance criteria → check the diff meets each one → list criteria with no test → propose test cases. |
| `redesign` | ✅ | `--inventory <old-features.md>` → **feature-parity audit** (every old feature must exist in the new UI). `--images <dir>` → visual review: cut text, overlap, contrast in both themes, small touch targets, one primary action per screen. `--rules <rules.md>` → glossary and copy rules checked as text. |
| `refactor` | roadmap | Behaviour equivalence: run tests at base and head, diff the public API surface, mutation-test the touched code, report the blast radius. Any behaviour change is suspect. |
| `bughunt` | roadmap | Look for **pre-existing** bugs in unchanged code near the diff, and report them separately. |
| `contract` | roadmap | Check the code against the business-rules docs and against UI copy. Example: a message saying "charge $455" when the server never applies the deposit. |
| `runtime` | roadmap | Drive the app with Playwright and collect console errors, 4xx/5xx, blank pages, and technical error text shown to users. |
| `rule-mining` | roadmap | When the same finding appears 3 or more times, propose a lint rule, so it never costs tokens again. |

## Token-saving strategy

1. Deterministic checks first (free).
2. A cascade: cheap triage, then expensive escalation only when needed.
3. Surgical context: diff and touched symbols, through a code-graph index when available.
4. Incremental re-review: `--since <sha>` reviews only the fix diff.
5. A cache keyed by `hash(file content + prompt + model)`.
6. A stable rules prefix, so vendor prompt caching kicks in.
7. JSON-only output and a per-run token or time budget.
8. Rule mining: recurring findings become lint rules.

## v1 scope (ship small)

- [ ] CLI skeleton (`quorum review`), config file `quorum.config.(json|ts)`
- [ ] Adapters: **codex** and **agy-gemini** working; **claude** and **qwen** stubs
- [ ] Preflight (PATH, login, read probe, quota detection, fallback)
- [ ] Deterministic step runs the repo's configured commands and includes their results
- [ ] Context builder from `git diff` (plain)
- [ ] Modes `feature` and `redesign` (text and images)
- [ ] Verifier (file, line, quote) and dedupe, with **vitest tests**
- [ ] BLOCKER → failing-test request (best effort; downgrade if not reproduced)
- [ ] `origin` via `git blame`
- [ ] Reporters: markdown and SARIF
- [ ] Ledger (JSONL) and cache
- [ ] README: setup, "your own logins", license, roadmap

**Done when** `quorum review --mode feature --diff <range>` runs on a sample diff in this repo with at least one real provider, and the verifier and dedupe tests pass.

## Later

- GitHub Action that posts verified findings as a PR review.
- A precision dashboard per provider: real vs false findings, cost, time.
- A per-repo false-positive suppression file.
- A "ready for production?" report: tests, visual baselines, migrations, open findings.
- Hosted or team edition (open-core) if it gets traction.

## Ground rules for this repo

- No code, prompts, config or secrets from any employer's or client's project. Examples must be synthetic.
- Ask before spending provider quota beyond a couple of probe runs.
- Apache-2.0, DCO sign-off, and the name reserved as a trademark (see TRADEMARKS.md).
