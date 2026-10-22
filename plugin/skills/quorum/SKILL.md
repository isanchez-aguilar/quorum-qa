---
name: quorum
description: Review a change with Quorum, which runs several AI reviewers (Gemini through Antigravity, Codex, Claude Code, a local model) over a git diff and reports only findings verified against the code. Use when the user asks for a multi-model review, a review "with Quorum", a feature-parity check of a redesign, or wants a BLOCKER proven with a failing test.
argument-hint: "[feature|redesign|bughunt|contract|refactor|runtime] [diff range]"
---

# /quorum

Quorum is a command-line tool. This skill runs it and explains its report; it never replaces it with your own review.

## 1. Find the CLI

Use `quorum` if it is on PATH. Otherwise ask the user where Quorum is checked out, and use `node <checkout>/bin/quorum.js` (after `pnpm install` and `pnpm build` there). Never install it globally without asking.

## 2. Check the setup (no quota)

For model review, run `quorum doctor` in the repository to review. Skip provider diagnostics for `--mode runtime` without `--visual`, which makes no provider calls; runtime needs Docker and the pinned Playwright image. A FAIL line comes with a fix; show it to the user. The repository needs a committed `quorum.config.json`: Quorum reads it from the merge-base of the range, never from the change itself.

`quorum doctor --probe` spends one call per provider. Run it only if the user agrees.

## 3. Plan before spending

Pick the mode from what the user asked:

- `--mode feature --spec <file>`: the spec must have acceptance criteria as Markdown checkboxes or a list under a heading that contains "acceptance".
- `--mode redesign --inventory <file>`, optionally with `--images <dir>` and `--rules <file>`.
- `--mode runtime --diff <base>...HEAD`: runs the configured flows against the merge-base and the head in locked-down containers and reports problems that are NEW at head (console errors, 5xx, blank pages, technical text). Exit 1 means new problems, 0 clean or suspect, 2 unknown (never read 2 as clean). `--dry-run` validates the runtime config and prints the app/flow plan without field values; `--strict-flows` makes a newly broken flow fail. Runtime executes the change's code, so it rejects `--no-checks`; the first run downloads a 3.6 GB image.
- Runtime-only `--visual` captures screenshots and sends paired JPEGs to the named visual-tier providers. Always show `--visual --dry-run` first: maximum calls/images, allowed families and recipients. It spends quota and exposes screenshot pixels; use test data only and obtain the user's approval for those recipients. `runtime.visual.maxCalls` (1–40, default `min(2 × flows, 40)`) and `allowedFamilies` (default all; `['local']` excludes cloud models) only configure the feature, never enable it. `--visual` implies capture; `runtime.screenshots: true` alone stays local.

The default range is the config's base `...HEAD`; pass `--diff <range>` or `--since <sha>` when the user names one. Pass `--author <name>` when you know which model wrote the change (`claude` if it was you), so Quorum picks reviewers from other model families.

Always run the same command with `--dry-run` first and show the user the plan: models, calls, budget and quota. **A real review spends the user's provider quota. Run it only after the user says yes.**

## 4. Run it safely

- The configured checks run the change's own code in a disposable worktree. For a change from someone the user doesn't trust, add `--no-checks`.
- `--reproduce` asks a model for a failing test and runs it in a container with no network. Without Docker it is reported as unproven. Never answer yes to a host-execution prompt on the user's behalf; `--no-host-prompt` makes that an automatic no.
- Don't add `--allow-unproven` unless the user asks; it waives BLOCKERs that no second model family confirmed.

## 5. Report what Quorum said

- Exit code: `0` complete with no BLOCKER, `1` a BLOCKER remains, `2` incomplete coverage, nothing to review, or a tool or config error.
- Read the Markdown report (the path is printed, by default under `.quorum/reports/`). Show BLOCKERs first with their file:line, evidence and reproduction status, then IMPORTANT findings.
- Always mention the Coverage section when it says INCOMPLETE, and any "Unconfirmed" findings, as Quorum reports them. Don't upgrade, downgrade or invent findings, and don't present an incomplete run as clean.
- Runtime visual findings are advisory and unverified. Two different families flagging the same pair can raise a clean verdict to SUSPECT, still exit 0. Never treat them as NEW RUNTIME PROBLEMS or override UNKNOWN. Report unpaired images, incomplete visual flows and both independent claims. Without `--visual`, the report says `Visual review: off`.
- If the user wants fixes, that is a separate step: Quorum's reviewers never edit code.
