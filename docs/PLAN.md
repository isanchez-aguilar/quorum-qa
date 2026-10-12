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
6. **Read-only providers.** No provider ever writes. A reviewer only returns JSON, and that includes the reproduction test, which comes back as text. Quorum itself writes that test into a disposable worktree and runs it. Each reviewer works in a disposable worktree of the head commit, never in the user's checkout. If that worktree is dirty after the call, the run is flagged and its findings are discarded. Jules is the one provider that writes (in its own cloud VM), so it stays off until Isaac amends AGENTS.md with an explicit exception (see Open decisions).
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
| Antigravity (`agy`) | `agy --model <id> --sandbox --output-format json --print=<prompt>`, optionally `--json-schema <finding schema>` and `--effort`. Not `--mode plan`, which makes it ask what to plan. Not a bare `-p`, which takes the next flag as the prompt. The prompt is an argument, so stay under Windows' ~32K command-line limit. | One CLI, three model families (see the catalog below). Plenty of Gemini quota, and it reads images (good for visual review). **Gemini often cites wrong line numbers and non-existent files**, which is why the verifier exists. Headless runs end on the first denied command, so the prompt must say "use ONLY file-read tools", and the user's agy settings must allow `read_file` for the repo (Quorum prints the rule; it never writes it). |
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

### Reproduction lane (v1)

A BLOCKER keeps its severity only if a test proves it. No provider writes anything:

1. The confirming reviewer returns the proposed test as JSON: `{ "path": "src/x.test.ts", "content": "...", "expect": "assertion text" }`.
2. Quorum checks the path. It must be a new file that matches the repo's test globs (default `**/*.test.*` and `**/*.spec.*`), inside the repo. Anything else is rejected.
3. Quorum creates a disposable `git worktree` at the head SHA and writes the file. Then it runs the configured test command for that one file, with a machine-readable reporter (vitest or jest JSON), **under isolation** (see below).
4. **Reproduced** means three things: the new test fails at head; the failure is an **assertion failure** in that test, not a compile error, an import error or a missing dependency; and the message matches `expect`. For an `introduced` finding, the same test must also pass in a worktree at the base SHA.
5. Otherwise the finding is downgraded to IMPORTANT, with the reason. Either way the worktree is deleted, and the test goes into the report, never into the user's checkout.

**The proposed test is untrusted code.** A worktree limits where the file is saved, not what the file does when it runs: `src/x.test.ts` can write anywhere with `node:fs` before its first assertion. So:

- **Reproduction is opt-in** (`--reproduce`), never part of a plain `quorum review`.
- **Default isolation is a container.** The test runs with Docker or Podman, with only the worktree mounted, `--network none`, a non-root user, the repo's own lockfile already installed in the image, and a time limit. The user's checkout and home are never mounted.
- **No container available:** Quorum does not run the test. It shows the test, and runs it only after the user confirms interactively for that one test. In CI with no container, reproduction is skipped and the finding is labelled "unproven", not downgraded.
- Node's permission model (`--permission`, `--allow-fs-write`) may become an extra layer later. It is not a boundary the plan relies on, because test runners spawn workers and child processes.
- **M6 includes an escape test:** a synthetic proposed test that tries to write outside the worktree, and to reach the network. It must fail inside the sandbox, and the run must be reported as rejected.

This needs only the reviewer adapters (agy and Codex), so it works in v1 with no extra provider.

### Jules: the async cloud lane

Jules is a coding agent that works on a copy of a GitHub repo in its own VM. It is not read-only, so it is never part of the reviewer quorum. It has two jobs that nothing else does well:

1. **Reproduce BLOCKERs (v1.x, only after the AGENTS.md exception).** For each verified BLOCKER, Quorum would open one Jules session: "write a test that fails because of this finding; do not fix the code; run it". It would pull the patch with `jules remote pull` (never `--apply`) and **re-run the test locally** through the v1 lane. The Jules log alone is never evidence. v1 does not need Jules (see [Reproduction lane](#reproduction-lane-v1)).
2. **Review a pushed PR without a local machine (v3).** In the GitHub Action, Jules can be a reviewer for repos that are connected to it, with its output passing through the same verifier.

Guardrails (lessons from running Jules by hand, and from the review of this plan):

- The repo comes from `quorum.config.json` (`jules.repo`). A task can't point Jules at another repo.
- **Pinning the exact commit is unsolved.** `jules new` takes `--repo`, but the installed CLI has no branch or SHA flag. A head SHA that exists on the remote doesn't prove the session used it. Before the Jules lane is built, the adapter must find a supported way to select the revision, and must verify it in the pulled patch (its base commit). If it can't, the Jules lane is refused, not trusted. Quorum never pushes for the user.
- Sessions that stop for approval or ask a question are reported as "needs attention" with their URL. Quorum never auto-approves a Jules plan.
- Each session is logged in the ledger with its id, so a re-run resumes polling instead of opening a duplicate.
- Jules's quota is not readable from the CLI. The config holds `jules.maxSessionsPerRun` (default 3), and preflight counts today's sessions from the ledger.

## Configuration

`quorum.config.json` at the repo root. Everything has a default except `checks`.

```json
{
  "base": "origin/main",
  "checks": [["pnpm", "lint"], ["pnpm", "typecheck"], ["pnpm", "test"]],
  "author": "claude",
  "tiers": {
    "triage":  ["agy:gemini-3.8-flash-medium", "qwen", "agy:gpt-oss-120b-medium"],
    "review":  ["agy:gemini-3.1-pro-high", "claude:sonnet"],
    "confirm": ["codex", "agy:claude-opus-5-5-high", "claude:opus"],
    "visual":  ["agy:gemini-3.1-pro-high"]
  },
  "escalate": { "focus": ["money", "auth", "permissions"], "belowConfidence": 0.7 },
  "budget": { "maxCalls": 12, "maxMinutes": 20, "quotaFloorPercent": 15 },
  "reproduce": { "isolation": "container", "testGlobs": ["**/*.test.*", "**/*.spec.*"], "testCommand": ["pnpm", "vitest", "run", "--reporter=json"] },
  "jules": { "enabled": false, "repo": "owner/name", "maxSessionsPerRun": 3 },
  "qwen": { "endpoint": "http://127.0.0.1:8080/v1" }
}
```

Each check is an argv array, not a string, so a config can't chain commands. Quorum runs it with `spawn` and no shell. **Windows:** tools like `pnpm` are `.cmd` shims, and Node can't spawn those without a shell. The runner resolves the program through `PATH` and `PATHEXT`. For a `.cmd` or `.bat` it runs `cmd.exe /d /s /c` with every argument quoted. It refuses any argument that contains cmd metacharacters (`& | < > ^ % !`, quotes or newlines). M2 tests this resolver.

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

The build-ready breakdown (types, algorithms, test tables, doctor checks) is in [IMPLEMENTATION.md](IMPLEMENTATION.md).

Each milestone is one PR with its tests. Automated acceptance always uses the fake provider. Real calls happen in only two places, and each needs Isaac's OK beforehand, with a call limit: M4's probes (at most 3 calls) and the v1 smoke run in M6 (at most 6 calls).

| # | Milestone | Done when |
|---|---|---|
| M0 | Skeleton: Node 22 + TS strict + vitest + ESM, `quorum` bin, config loader with schema validation | `quorum --help` runs; config tests pass |
| M1 | **Verifier** (file, line, quote with fuzzy nearby match) and **dedupe** | Table tests over synthetic fixtures, including the wrong-line-but-real-quote case and the non-existent-file case |
| M2 | Context builder from `git diff`, `origin` via `git blame`, deterministic checks runner with the Windows command resolver | Tests on a temporary git repo built in the test; resolver tests for `.cmd` shims and rejected metacharacters |
| M3 | Provider interface, a **fake provider** for tests, model catalog, tiers, cascade, budget, `--dry-run` | The whole pipeline runs end to end against the fake provider with zero quota |
| M4 | Real adapters: **agy** and **codex**, each running in a disposable worktree and checked for writes afterwards; `quorum doctor` (PATH, login, `agy models`, `/usage`, read probe, agy write-deny rule present) | Adapter tests on recorded outputs; `doctor` passes on Isaac's machine with at most 3 approved probe calls |
| M5 | Modes `feature` and `redesign`, markdown and SARIF reporters, ledger and cache | End to end against the fake provider |
| M6 | Reproduction lane (opt-in; Quorum writes the proposed test into a worktree and runs it in a container), plus `claude` and `qwen` adapter stubs | Lane tests: an assertion failure is kept, an import or compile failure is downgraded, a non-test path is rejected, `introduced` is checked at the base SHA, and the **escape test** can't write outside the worktree or reach the network; then the approved smoke run |

**v1 is done when** the whole pipeline passes its automated tests against the fake provider, and **one smoke run that Isaac approves** (at most 6 calls) of `quorum review --mode feature --diff <range>` works on a synthetic sample diff with at least one real provider.

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
| A reviewer tries to write or run commands | `agy --sandbox` still **allows writes to the workspace**, and `--mode plan` only changes the instructions, so flags aren't enough. Every reviewer runs in a disposable worktree of head. `doctor` refuses agy unless the user's agy settings (`~/.gemini/antigravity-cli/settings.json`) allow `read_file` on `.quorum/worktrees/` and deny write and shell tools. It prints the rules and never writes them. A run that leaves its worktree dirty is discarded. Codex uses `-s read-only`. |
| A proposed test is malicious or careless | Reproduction is opt-in and runs in a container with no network and only the worktree mounted. Without a container, it runs only after a per-test confirmation. M6 has an escape test. |
| Code leaves the machine | Every provider already sees code under the user's own terms. Jules needs the code pushed to GitHub, so it is opt-in per repo, and `doctor` says so |

## Open decisions (for Isaac)

1. **Name** before the first npm publish (see [NAMING.md](NAMING.md)).
2. **Jules exception.** Jules writes in its own VM, and AGENTS.md says providers are read-only. Jules stays off until Isaac adds an explicit, scoped exception to AGENTS.md (cloud VM only, never applied, re-run locally) and commit pinning is solved. v1 does not depend on it.
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
