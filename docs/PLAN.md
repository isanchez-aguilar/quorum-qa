# Quorum — plan

> Working name: **Quorum** (package `quorum-qa`). The name is not final; see [NAMING.md](NAMING.md).

## The problem

AI coding CLIs (Claude Code, Codex, Antigravity with its Gemini, Claude and GPT-OSS models, Jules, local models) are good reviewers, but each one alone:

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
quorum doctor                        # which providers and models are usable right now, and their quota
quorum review --mode feature --diff origin/main...HEAD --spec docs/issue-123.md
quorum review --mode redesign --diff main...HEAD --inventory docs/old-features.md --images shots/
quorum review --since <sha>          # re-review only the fix diff
quorum review ... --dry-run          # print the plan (checks, providers, models, prompts) and spend nothing
```

## Principles

1. **Deterministic first, AI second.** Run lint, typecheck, a11y (axe), contrast checks and rule greps before any model. No model ever spends tokens on what a linter catches.
2. **Verify everything.** A finding whose file, line or quote can't be found in the code is dropped. A BLOCKER that can't be reproduced by a failing test is downgraded.
3. **Cheap model triages, expensive model confirms.** A flash-tier model (Gemini Flash, or Qwen when it runs locally) goes first. Only uncertain findings, or ones in money or auth code, escalate to a confirm-tier model (Codex, Claude Opus, Gemini Pro).
4. **Surgical context.** Send the diff, the touched symbols and their callers, never whole files.
5. **The user's own logins.** Every provider runs the vendor's own CLI with the user's subscription. Quorum never stores, asks for or proxies API keys.
6. **Read-only reviewers.** Reviewers never edit the user's checkout. Writing a reproduction test happens in a disposable place (a temporary git worktree, or Jules's cloud VM), and Quorum never applies a patch on its own.
7. **Independence is by model family, not by CLI.** Claude Opus through Antigravity is still Claude. If Claude wrote the change, a quorum of "Claude Code + agy Claude Opus" is not independent. Families: `anthropic`, `google`, `openai`, `local`.
8. **Measure the reviewers.** Every run appends to a ledger (findings, verified, rejected, time, cost), so you know which provider and which model earns its place.
9. **Never spend by surprise.** `--dry-run` shows the plan. A per-run budget (calls, minutes) caps it. A provider whose quota is low is skipped before it is called, not after it fails.

## Architecture (v1)

```
CLI ─► Planner ─► Deterministic checks (repo's own lint/tsc/axe via config)
          │
          ├─► Context builder (diff + touched symbols; pluggable: plain git, CodeGraph later)
          │
          ├─► Model catalog ─► tiers (triage | review | confirm | visual) → provider + model + family
          │
          ├─► Provider pool ──► adapters: codex | agy | claude | qwen | jules (async)
          │        └─ preflight: on PATH? logged in? model listed? read probe? quota → skip or fall back
          │
          ├─► Cascade: triage (cheap) ─► escalate (expensive) by uncertainty / focus
          │
          ├─► Verifier: file exists · line in range · quote near line · optional cross-family confirm
          │        └─ BLOCKER → reproduction lane (local worktree, or Jules) → failing test? keep : downgrade
          │
          ├─► Dedupe (file + nearby line + similar text; agreement across families raises confidence)
          │
          └─► Reporters: markdown · SARIF · (later) GitHub PR review comments
                  └─ Ledger (JSONL) · Cache (hash(file+prompt+model) → result)
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
  "provider": "agy",
  "model": "gemini-3.1-pro-high",
  "family": "google",
  "confidence": 0.0
}
```

`origin` comes from `git blame` against the review base. A flagged line that already existed before the base is **pre-existing**. `provider`, `model` and `family` are filled in by Quorum, never trusted from the model's own output.

### Provider adapters

| Provider | How it runs (user's own login) | Notes from real use |
|---|---|---|
| Codex | `codex exec -C <dir> -s read-only -o <out> -` (prompt on stdin) | Finds real money and permission bugs. Quota runs out fast, so save it for escalation. Its sandbox sometimes can't read a freshly created folder on the first try: probe first, retry once. |
| Antigravity (`agy`) | `agy -p "<prompt>" --sandbox --mode plan --model <id> --output-format json`, optionally `--json-schema <finding schema>` and `--effort` | One CLI, three model families (see the catalog below). Plenty of Gemini quota, and it reads images (good for visual review). **Gemini often cites wrong line numbers and non-existent files**, which is why the verifier exists. Headless runs end on the first denied command, so the prompt must say "use ONLY file-read tools", and the user's agy settings must allow `read_file` for the repo (Quorum prints the rule; it never writes it). |
| Claude Code | `claude -p --model <id>` with read-only tools only | Strong general reviewer. Use it as the triage-plus-fix partner, or as a reviewer when the change came from another family. |
| Local model (Qwen etc.) | OpenAI-compatible endpoint (e.g. llama.cpp at `127.0.0.1:8080`) | Free, but slow and with limited context. Use it for triage, mechanical checks and drafting test tables, never for final judgment. Optional: if it is not running, Quorum skips it. |
| Jules (async, cloud) | `jules new --repo <owner/name> "<prompt>"` → poll `jules remote list --session` → `jules remote pull --session <id>` (**never** `--apply`) | Runs in Google's cloud VM against the **pushed** branch, so it can actually run the test suite without touching the local checkout. It is slow (minutes) and has a daily task limit, so it is a lane, not a reviewer in the main loop. See [Jules](#jules-the-async-cloud-lane). |

**Independence rule:** the family that wrote a change should not be its only reviewer. When the author family is known (`--author claude`, or a commit trailer), the planner puts at least one other family in the quorum, or warns that it can't.

### Model catalog (agy models)

The models that agy offers change often, so Quorum never hardcodes them: `quorum doctor` reads `agy models` and validates the config against it. These were the models that `agy models` listed on 2026-10-11:

| Model ids | Family | Default tier in Quorum | Notes |
|---|---|---|---|
| `gemini-3.8-flash-{low,medium,high}` (also 3.7 and 3.6 flash) | google | **triage** | Cheapest and fastest. The first pass on every diff. Use the newest flash version that is listed. |
| `gemini-3.1-pro-{low,high}` | google | **review**, **visual** | The main Google reviewer and the image reviewer for `redesign`. |
| `claude-sonnet-5-5-{low,medium,high}` | anthropic | review | A second Anthropic seat when Claude Code's own quota is low. It does **not** add independence next to Claude Code. |
| `claude-opus-5-5-{low,medium,high}` | anthropic | confirm | Confirms escalated findings. Shares one quota with Sonnet inside agy, and a reset can be days away. |
| `gpt-oss-120b-medium` | openai | triage, second opinion | A third family available through the same login. It is useful as the tie-breaker when the Google and Anthropic reviewers disagree. |

Other providers in the catalog: Codex (openai, confirm), Claude Code (anthropic, review and confirm, with model chosen by `--model`) and Qwen (local, triage).

**Quota groups.** agy reports quota per model group, not per model, and `/usage` answers without spending inference. Preflight reads it once per run (from Git Bash it needs `MSYS_NO_PATHCONV=1`, or `/usage` becomes a path). A group below the configured floor is marked unavailable, and the cascade picks the next model in the same tier. Two models in one group never count as two budgets.

**Fable is never picked automatically.** If a Fable model appears in any catalog, Quorum lists it but does not route to it unless the config names it explicitly.

### Jules: the async cloud lane

Jules is a coding agent that works on a copy of a GitHub repo in its own VM. It is not read-only, so it is never part of the reviewer quorum. It has two jobs that nothing else does well:

1. **Reproduce BLOCKERs (v1.x).** For each verified BLOCKER, Quorum opens one Jules session: "write a test that fails because of this finding; do not fix the code; run it and report the output". Quorum pulls the patch and the log with `jules remote pull` (never `--apply`), and checks the log for a failing test that names the finding. Reproduced: the BLOCKER stays, with the test attached as evidence. Not reproduced or timed out: it is downgraded to IMPORTANT with a note. The local alternative (v1) does the same in a temporary `git worktree` with a write-capable provider, then deletes the worktree.
2. **Review a pushed PR without a local machine (v3).** In the GitHub Action, Jules can be a reviewer for repos that are connected to it, with its output passing through the same verifier.

Guardrails (lessons from running Jules by hand):

- The repo and branch come from `quorum.config.json` (`jules.repo`, `jules.branch`). A task can't point Jules at another repo.
- Jules only sees **pushed** commits. Before opening a session, Quorum checks that the head SHA is on the remote, and refuses otherwise. It never pushes for the user.
- Sessions that stop for approval or ask a question are reported as "needs attention" with their URL. Quorum never auto-approves a Jules plan.
- Each session is logged in the ledger with its id, so a re-run resumes polling instead of opening a duplicate.
- Jules's quota is not readable from the CLI. The config holds `jules.maxSessionsPerRun` (default 3), and preflight counts today's sessions from the ledger.

## Configuration

`quorum.config.json` at the repo root. Everything has a default except `checks`.

```json
{
  "base": "origin/main",
  "checks": ["pnpm lint", "pnpm typecheck", "pnpm test"],
  "author": "claude",
  "tiers": {
    "triage":  ["agy:gemini-3.8-flash-medium", "qwen", "agy:gpt-oss-120b-medium"],
    "review":  ["agy:gemini-3.1-pro-high", "claude:sonnet"],
    "confirm": ["codex", "agy:claude-opus-5-5-high", "claude:opus"],
    "visual":  ["agy:gemini-3.1-pro-high"]
  },
  "escalate": { "focus": ["money", "auth", "permissions"], "belowConfidence": 0.7 },
  "budget": { "maxCalls": 12, "maxMinutes": 20, "quotaFloorPercent": 15 },
  "reproduce": { "lane": "worktree", "provider": "claude:sonnet" },
  "jules": { "repo": "owner/name", "branch": "main", "maxSessionsPerRun": 3 },
  "qwen": { "endpoint": "http://127.0.0.1:8080/v1" }
}
```

Each check is one simple command, with no `&&`, `|`, `;` or redirections. Quorum runs it with `spawn` and no shell, so a config can't chain commands.

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
2. A cascade: flash-tier triage, then confirm-tier escalation only when needed.
3. Surgical context: diff and touched symbols, through a code-graph index when available.
4. Incremental re-review: `--since <sha>` reviews only the fix diff.
5. A cache keyed by `hash(file content + prompt + model)`.
6. A stable rules prefix, so vendor prompt caching kicks in.
7. JSON-only output (agy's `--json-schema` where available) and a per-run call and time budget.
8. Quota read before the call (agy `/usage`, Codex quota windows), so a nearly empty provider is skipped instead of failing mid-run.
9. Rule mining: recurring findings become lint rules.

## v1 milestones

Each milestone is one PR with its tests. No milestone needs provider quota except M4's probes.

| # | Milestone | Done when |
|---|---|---|
| M0 | Skeleton: Node 22 + TS strict + vitest + ESM, `quorum` bin, config loader with schema validation | `quorum --help` runs; config tests pass |
| M1 | **Verifier** (file, line, quote with fuzzy nearby match) and **dedupe** | Table tests over synthetic fixtures, including the wrong-line-but-real-quote case and the non-existent-file case |
| M2 | Context builder from `git diff`, `origin` via `git blame`, deterministic checks runner | Tests on a temporary git repo built in the test |
| M3 | Provider interface, a **fake provider** for tests, model catalog, tiers, cascade, budget, `--dry-run` | The whole pipeline runs end to end against the fake provider with zero quota |
| M4 | Real adapters: **agy** and **codex** working; `quorum doctor` (PATH, login, `agy models`, `/usage`, read probe) | `doctor` passes on Isaac's machine; at most a couple of probe calls, with Isaac's OK |
| M5 | Modes `feature` and `redesign`, markdown and SARIF reporters, ledger and cache | The "done" check below |
| M6 | Reproduction lane (local worktree), plus `claude`, `qwen` and `jules` adapter stubs behind the same interface | Lane tests against the fake provider; stubs report "not implemented" in `doctor` |

**v1 is done when** `quorum review --mode feature --diff <range>` runs on a sample diff in this repo with at least one real provider, and the verifier and dedupe tests pass.

## Testing strategy

- **No quota in tests, ever.** Every adapter takes an injected `run(command, args, stdin)` function. Tests pass a fake that returns recorded synthetic outputs. CI never calls a real CLI.
- **Fixtures are synthetic.** Sample repos are generated inside the test (`git init` in a temp dir), with no code from any real project.
- **Golden outputs per provider quirk:** Gemini's wrong line numbers, a missing file, prose around the JSON, a 429, Codex's first-run read failure, a Jules session that asks for approval.
- **Verifier and dedupe carry most of the coverage**, because a false positive that reaches the report is the product failing.

## Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Vendor CLIs change flags or output | One adapter per CLI, with a version check in `doctor`, and golden-output tests that fail loudly when the format drifts |
| Model ids change (agy lists new flash versions every few weeks) | Config ids are validated against `agy models` at preflight; a tier lists fallbacks |
| Quota shared across models | Budgets are per quota group, read from `/usage` |
| False independence (same family through two CLIs) | Family is part of the catalog; the planner checks it |
| A reviewer tries to write or run commands | Read-only flags per CLI, `--sandbox --mode plan` for agy, and a prompt that lists the allowed paths |
| Code leaves the machine | Every provider already sees code under the user's own terms. Jules needs the code pushed to GitHub, so it is opt-in per repo, and `doctor` says so |

## Open decisions (for Isaac)

1. **Name** before the first npm publish (see [NAMING.md](NAMING.md)).
2. **Jules in v1 or v1.x.** This plan puts the reproduction lane in v1 as a local worktree, and Jules in v1.x. The reason: v1 must work without pushing code anywhere.
3. **Default triage model:** Gemini Flash through agy (plenty of quota) or Qwen (free, but it must be running). The plan defaults to agy flash, with Qwen as the first fallback.
4. **Package manager:** pnpm (as CONTRIBUTING says) is assumed.

## Later

- GitHub Action that posts verified findings as a PR review (with Jules as an optional cloud reviewer).
- A precision dashboard per provider and per model: real vs false findings, cost, time.
- A per-repo false-positive suppression file.
- A "ready for production?" report: tests, visual baselines, migrations, open findings.
- Hosted or team edition (open-core) if it gets traction.

## Ground rules for this repo

- No code, prompts, config or secrets from any employer's or client's project. Examples must be synthetic.
- Ask before spending provider quota beyond a couple of probe runs.
- Apache-2.0, DCO sign-off, and the name reserved as a trademark (see TRADEMARKS.md).
