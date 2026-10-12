# AGENTS.md — Quorum

The contract for any coding agent working in this repository.

- **Read [docs/PLAN.md](docs/PLAN.md) first.** It holds the scope, the architecture and the v1 checklist.
- **Stack:** Node 22, TypeScript (strict), vitest, ESM. Keep dependencies few, and pin them to exact versions.
- **Language:** code, comments, docs and commits in English. The maintainer (Isaac) writes in Spanish; answer him in es-MX.
- **Every change ships with its tests.** The verifier and the dedupe are the core, so keep them well covered.
- **Providers run read-only, with the user's own CLI logins.** Never add code that stores or asks for API keys.
- **No third-party project code.** Never copy code, prompts, config or secrets from another project into this repo. Tests and examples use synthetic fixtures only.
- **Ask before spending quota.** Ask Isaac before any run that spends provider quota beyond a couple of probe calls, before publishing to npm, and before making the repo public.
- **Git:** one branch per change, never commit straight to `main`, and add a DCO `Signed-off-by` to every commit.
- **Licensing:** Apache-2.0 for code. A new source file needs no header; the LICENSE and NOTICE files cover it.

## Project in one sentence

Quorum runs several AI coding CLIs over a change and reports only the findings it has verified against the code. Status: planning, nothing is implemented yet (see [README.md](README.md)).

## Commands

There is no scaffold yet, so no command to run. Once it exists, `pnpm test` runs the suite (see *Before delivery*), and this section lists every command that matters then. Until then `git diff --check` is the check for a change: it catches whitespace errors and leftover conflict markers.

## Conventions

The rules at the top of this file are the conventions: strict TypeScript, ESM, vitest, exact-pinned dependencies, English in code, comments, docs and commits, and synthetic fixtures only. Test layout and style rules go here once the scaffold exists.

## Delegation

Try providers in this order, cheapest sufficient first (the playbook is `model-selection` in the Relaykit repo):

1. Codex: implementation, reviews and tests.
2. Antigravity's Claude models: edit-only tasks with every path listed; a headless run dies on the first denied command.
3. Gemini through Antigravity: reviews, visual checks and drafts; Flash for mechanical work.
4. Jules: bounded cloud tasks on their own branch.
5. Local Qwen (optional): mechanical work with an exact expected output.
6. Claude Code subagents last, on `sonnet` or `haiku` by default.

Opus only when a money or security judgement truly cannot be covered by another provider. Never Fable without Isaac's yes for that specific use. Whoever implements is never the only reviewer. This is the tool that reviews other people's code, so its own changes get a second provider's read-only review too.

## Before delivery

Run the typecheck and the tests of what you touched (`pnpm test` once the scaffold exists) and report each result; a check you did not run did not pass. Have a different provider review the change read-only with `.ai/prompts/review.md` (the `cross-review` skill has the procedure). Merge only when Isaac says so.

## Relaykit files

`.ai/project.json`, `.ai/prompts/review.md`, `GEMINI.md`, `.claude/agents/` and `.claude/skills/` came from `relaykit init --profile generic`. They are plain copies you may edit. The `generic` profile fits this project because it is a Node CLI with no UI; `opencode.json` (Qwen guardrails) was left out on purpose, and `relaykit init --dry-run` shows what a rerun would add.
