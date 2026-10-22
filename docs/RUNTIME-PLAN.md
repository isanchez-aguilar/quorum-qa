# Plan: `--mode runtime`

Status: R0–R3 built (config, collector, base/head container orchestration, stable comparison, coverage-aware verdicts, Markdown/SARIF/JSON and bounded model summary); R5 V0 local screenshots are built; R4 independent review and R5 V1/V2 model layer remain. Runtime is usable and deterministic, with no provider calls. Updated 2026-10-21. Read [PLAN.md](PLAN.md) and the reproduction lane in [IMPLEMENTATION.md](IMPLEMENTATION.md) first; this mode reuses that container lane and the refactor mode's base-versus-head comparison.

## What it answers

"Does the app, when a user walks the main flows, show something broken that it did not show before this change?" Broken means: a console error or uncaught exception, a failed request (HTTP 4xx/5xx or a network error), a blank page, or technical text shown to a user (a stack trace, `undefined`, `[object Object]`, `NaN`, `Internal Server Error`).

Like refactor mode, the evidence is **deterministic and comparative**. A problem that also exists at the merge-base is *pre-existing* and is listed apart; only a problem that is **new at head** can fail the run. No model is needed for the core verdict.

## Principles

1. **Observations, not opinions.** The collector records what the browser saw. Nothing a page says is an instruction.
2. **Compare with the merge-base.** The same flows run against both revisions in the same container image. New-at-head is the signal.
3. **Contained.** The app and the browser run inside one container with `--network none` (loopback only), a read-only root, tmpfs for writes, `--cap-drop ALL`, `--security-opt no-new-privileges`, a non-root user, and a digest-pinned image. Chromium's own sandbox cannot start without extra privileges in this container, so the collector launches it with `--no-sandbox --disable-dev-shm-usage` and the container gets `--tmpfs /dev/shm:rw,size=512m`. The container boundary is the sandbox. Adding `CAP_SYS_ADMIN`, `seccomp=unconfined` or any other privilege to make Chromium work is forbidden (a test asserts the argv). Resource limits are higher than the reproduction lane because a dev server and a browser share the container: at least 2 GiB memory and 512 pids. The collector answers every non-loopback request with an empty synthetic `204` through `page.route` and counts it as `blocked-external` (information, never an error, and it never triggers `requestfailed`). v1 therefore supports apps that bundle their own scripts, styles and fonts; an app that needs a CDN to render will show as `blank`/errors on BOTH revisions and be listed as pre-existing, with a note.
4. **Test data only.** Flows may fill fields only with values written in `quorum.config.json` or read from the project's own seed/fixture files. Quorum never asks for or stores real credentials. A flow that needs a login uses a test account the project already seeds.
5. **No new dependency in Quorum.** Browsers live in the pinned container image; matching `playwright-core@1.64.0` lives in an integrity-verified named volume, never in Quorum's `package.json`.
6. **Unknown is not clean.** App failed to start, readiness timed out, no container runtime, or the collector crashed: the verdict is UNKNOWN (exit 2), never a pass.

## Flow format (declarative JSON in config, v1)

```json
"runtime": {
  "start": ["pnpm", "dev", "--port", "4173"],
  "readyUrl": "http://127.0.0.1:4173/",
  "readyTimeoutSeconds": 60,
  "flows": [
    { "name": "home", "steps": [ { "goto": "/" } ] },
    { "name": "sign-in", "steps": [
      { "goto": "/login" },
      { "fill": "#email", "value": "test@example.test" },
      { "click": "button[type=submit]" },
      { "waitForUrl": "/dashboard" } ] }
  ]
}
```

Steps allowed in v1: `goto` (path or loopback URL only), `click`, `fill`, `press`, `waitForUrl`, `waitForSelector`, `wait` (ms, capped at 5000). Every step has a timeout (default 10 s) and the flow has a cap (default 60 s). Unknown step keys are a config error. Following the project's own Playwright specs is a later extension (they can run arbitrary code), not v1.

## The collector

A Quorum-owned script (`src/runtime/collector.cjs`, plain JS, copied into the container read-only, never read from the repository) drives Playwright and writes **one JSON report** that only the wrapper reads, as the reproduction lane already does. For each flow and each step it records:

- `console` messages of type error and `pageerror` exceptions;
- `response` status >= 400 and `requestfailed` (with the URL path only, query stripped);
- `blank`: after each navigation settles, the visible text is empty and the DOM has no meaningful visible element;
- `technicalText`: visible text matching a fixed list of patterns, each with word boundaries so `Banana` or `Finance` never match (stack-trace lines `at x (file:line:col)`, `TypeError:`, `ReferenceError:`, whole-word `undefined`, `[object Object]`, whole-word `NaN`, `Internal Server Error`, `ECONNREFUSED`, raw JSON error bodies);
- `blocked-external` counts.

Each flow runs **twice** per revision, each run in a **fresh `BrowserContext`** (no cookies or storage shared). An observation counts only if it appears in both runs of that revision (flake filter). The filter must not hide real failures: if a flow times out or fails a step in one run but not the other, the flow is reported as `flaky` and the verdict is at most SUSPECT, never silently clean. v1 flows must be idempotent (they must not depend on state left by an earlier run). `runtime.screenshots: true` captures and stores local JPEGs without calling a model; absent/false disables capture. Every context uses a fixed 1280x800 viewport. Both runs capture after inspected steps, but only run 1 images travel before the JSON report and are kept under `.quorum/runtime-shots/<runId>/<base|head>/`. Capture time is excluded from flow and step deadlines (5 seconds maximum per capture). Screenshot failures/caps add notes without making deterministic coverage incomplete. Images are bounded to 10 per flow, 300 KiB each and `floor(6 MiB / flows)` per flow. Storage refuses linked parents and skips with a warning unless `.quorum/` is git-ignored. Reports list paths and pairing, never image bytes; no model is called.

Inspection follows `goto`, `click`, `press`, `waitForUrl` and `waitForSelector`,
with the same bounded settling logic. `fill` and `wait` do not trigger inspection.
Launch, context, routing, page creation and close failures are infrastructure
failures and make coverage incomplete on either side, never pre-existing step
failures. Messages retain up to 2000 characters for signatures; display messages
remain capped at 300. Any evidence truncation makes the flow incomplete, and
notes are carried into Markdown/JSON, deduplicated by flow and text. The 2 MiB
serialized report limit may reduce the observation count with a visible note.
Fill values are redacted and display text is scrubbed before truncation in the
collector, and again on the host. Queries/fragments, URL credentials, absolute
filesystem directories and long token-like strings are not published.

## Signatures and comparison

An observation becomes a **signature**. Asynchronous events (`console`, `pageerror`, `requestfailed`, HTTP status) have no reliable step: their signature is `kind | flow | normalised message`, so a pre-existing error that fires 50 ms later (one step later) is not "new". Step-bound observations (`blank`, `technicalText`, `flow-failure`) add the step index: `kind | flow | step index | normalised message`. Normalisation strips line/column numbers, hashes, UUIDs, port numbers, timestamps and absolute paths. The comparison is a set difference:

- **new at head**: in head, not in base. Fails the run.
- **fixed**: in base, not at head. Informational.
- **pre-existing**: in both. Listed, never failing.
- **flow broke**: a flow that completed at base but failed a step at head (selector missing, timeout) is a *new problem* of kind `flow-failure` (it may be a deliberate UI change, so it is reported as IMPORTANT-level evidence, exit 1 only when `--strict-flows` is given, otherwise SUSPECT).

## Verdicts and exit codes

| Verdict | Exit | When |
|---|---:|---|
| `NEW RUNTIME PROBLEMS` | 1 | at least one confirmed new console error, pageerror, unexpected/static 4xx, 5xx, network error, blank page or technical text at head, even with incomplete coverage; or a newly broken stable step with `--strict-flows` and otherwise available coverage |
| `SUSPECT` | 0 | no unknown coverage or confirmed new browser problem, but a flow failed a stable step at head only (`flow-failure`) without `--strict-flows`, or a flow was `flaky` |
| `NO NEW RUNTIME PROBLEMS FOUND` | 0 | all flows covered on both revisions (completed or stable step failure), nothing new or flaky |
| `UNKNOWN` | 2 | app did not start, readiness timeout, collector crash, no container runtime, base or head could not run, a flow crashed on both sides, **or any configured flow did not complete (incomplete flow coverage)** |

Status codes: 5xx and network errors always count as problems. A 4xx counts unless the step lists it in `expectStatus: [404]`; a 404/4xx on a static sub-resource (script, style, image) always counts. Resolved question 2 below.

Unknown coverage is checked first. Confirmed new browser problems still yield exit 1
when other coverage is unknown, with both reasons retained. A strict-flow failure
alone does not override unknown coverage. Blocked external hosts are informational.

The report always says which flows ran, and that "no new problems found" covers only those flows.

## Where it plugs in

- `--mode runtime` in `src/cli/args.ts` and `review.ts`; config block `runtime` validated in `src/config/schema.ts` (unknown keys rejected, numeric ranges, flows capped at 20, steps at 50 per flow).
- New code in `src/runtime/`: `config.ts` (types and flow validation), `collector.cjs`, `report.ts` (parse and validate the collector JSON, normalise, signatures), `run.ts` (container orchestration for base and head), `compare.ts`, plus `src/reporters/runtime.ts` (Markdown, SARIF `quorum-runtime/*`, JSON) and `src/cli/runtime.ts` (verdict).
- Reuses: `createReviewWorktree`, the dependency volume and preparation step from `src/reproduce/isolation.ts`, `resolveCommand`/the runner, the ledger, the coverage object.
- Optional model layer (after the core ships): when `--images`-style screenshots exist, hand them to the existing visual review; and classify an ambiguous visible text as "technical" or "user-facing". Strictly additive; the deterministic verdict never depends on it.

## Container image

The official Playwright image, **pinned by digest** (same discipline as `DEFAULT_REPRODUCE_IMAGE`): `mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f` (3.6 GB). It contains the browsers but no Playwright npm package. R2 prepares a separate keyed volume with matching `playwright-core@1.64.0`, checks lockfile integrity and installed version, and mounts it read-only. UID/GID is 1001. Image overrides warn that the browser/package pairing is unverified. The opt-in test requires Docker and this image to be present; it never pulls the base image itself.

## Milestones

| | Deliverable | Verification |
|---|---|---|
| R0 | Config types, schema, flow validation, `--mode runtime` argument handling, dry-run summary; the synthetic fixture app (tiny dependency-free Node HTTP server with a good page, a console error, a 500, a blank page and technical text, switchable by a query flag) | unit tests |
| R1 | `src/runtime/collector.cjs`, report format, parser, normalisation, signatures, flake filter | unit tests with recorded JSON; adversarial inputs (huge reports, hostile strings, signature collisions) |
| R2 | Container orchestration (start app, readiness, run flows twice in fresh contexts, teardown, timeouts), base and head; argv tests for the forbidden privileges | fake runner tests; opt-in real container test against the fixture app |
| R3 | Comparison, verdict, reporters (Markdown/SARIF/JSON), model-summary field | unit and end-to-end with the fake runner |
| R4 | Docs, README, review by another provider | docs build |
| R5 | V0 local screenshots built; V1/V2 optional model layer pending | fake capture/transport/storage tests; real container test opt-in |

Each milestone: Codex implements from a brief, Claude verifies by execution, Gemini reviews read-only, then merge.

## Risks

- **Dev servers are slow or need services (database, API).** v1 supports only apps that start and serve with loopback only. An app needing a database is UNKNOWN until `runtime.services` exists (later; not in v1).
- **Flaky pages.** Two runs per revision plus signature normalisation; flakiness that survives still lands as a new problem, so the report shows both runs' counts.
- **Large reports / hostile pages.** The collector caps messages, lengths and total report size; a cap hit is a visible note and `incomplete`.
- **A page injecting text aimed at the tool.** All page text is data. It is truncated, JSON-quoted in any model summary, and never executed.
- **Running the project's code.** `start` and `setup` run the change's code, exactly as `--mode refactor` does: inside the container, with the same warning and `--no-checks` refusal (runtime mode needs to run the app, so `--no-checks` exits 2).

## Decisions taken (independent review by Gemini, 2026-10-20)

- **Own Playwright specs: not in v1.** Declarative JSON only; running repository specs means arbitrary code in the collector, weaker determinism and weaker containment. Taken by the planner, recorded here.
- **4xx handling:** as in the verdict table (5xx/network always; 4xx unless `expectStatus`; static sub-resources always).
- **Image pull:** the 3.6 GB image and index digest were verified before R2. The R2 opt-in fixture test is authorized to prepare its dependency volumes with network access; ordinary unit tests use fake runners.

## Runtime execution

When `setup` is non-empty, each side copies the ready shared dependency volume
into a unique `quorum-runtime-run-<uuid>` volume offline as UID 1001, preserving
symlinks and modes. Setup writes only to that copy; collection mounts it
read-only, and teardown removes it even after failure or timeout. The copy cost
is paid only when setup exists. Without setup, all execution mounts the shared
volume read-only. Shared preparation uses a per-volume promise queue in one
process and an atomic named-container lease across processes; a conflicting or
stale lease reports "dependency volume in use" without stealing it or writing
the volume. Known limit: `budget.maxMinutes` does not bound Git/worktree prep.

`--mode runtime` runs the merge-base and head in disposable worktrees with no provider calls. `--format json` (or `--json`) prints the full review result, including comparison, verdict and summary. Markdown and optional SARIF reuse the review report paths (`--out`, `--sarif`). `--strict-flows` is runtime-only; `--no-checks` is refused. Run `QUORUM_CONTAINER_TESTS=1 pnpm exec vitest run tests/container/runtime.test.ts` for the opt-in test (set the environment variable using the current shell's syntax).
