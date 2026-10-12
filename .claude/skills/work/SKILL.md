---
name: work
description: Run new work in ANY repository or notes folder through the generic pipeline — planner scopes it, implementer (and designer/writer) do it, tester breaks it, another provider reviews it, then a draft PR. Use for anything bigger than a one-file change in places that do not define their own /feature skill (a repo with its own /feature keeps using it). The owner asks in plain language; route it here yourself.
---

# /work — generic pipeline for new work

Say in one line that you are taking this route («Lo trato como trabajo tamaño M»).
Follow the repository's own `AGENTS.md`/`CLAUDE.md` over anything here.

## 0. Clarify

If the request reads two ways that lead to different work, ask with
AskUserQuestion (options, your recommendation first) before planning. Do not
ask what the code or docs already answer.

## 1. Plan

Size it. **S** (one file): do it in this session, skip to step 3.
**M/L**: launch the `planner` agent with the request and the repo path. If it
returns `## Blocking questions`, ask Isaac and resume it with SendMessage. For
**L**, show Isaac the plan and wait for his yes.

## 2. Do

Launch `implementer` lanes in parallel — one area per lane, never two lanes on
one file. Add `designer` first for a visible change and `writer` for docs or
notes. Pass `model` explicitly on every Agent call: `haiku` for searches and
mechanical edits, `sonnet` for implementation and docs; `opus` only when a
money or security judgement truly cannot be covered by another provider.
**Never `fable` without asking Isaac first.** Delegate in the order of the
model-selection playbook (Codex, then Antigravity, Jules, local Qwen, and Claude
subagents last). Mechanical, verifiable chunks may go to the local model with
`relaykit qwen --optional --task …` when the repo has the kit installed;
SKIPPED means do it yourself.

## 3. Break it

Launch `tester` on the result. Fix what it finds (implementer), then re-run the
failing checks.

## 4. Independent review

Branch, commit (English, with the attribution lines the session gives you),
push and open a **draft** PR. Then have a DIFFERENT provider review it
read-only with `.ai/prompts/review.md`, following the `cross-review` skill:
probe the sandbox, list every path, verify every cited line. Fix confirmed
findings and review again.

## 5. Close

Merge only when Isaac has authorized it. Report what changed, the commands you
ran with results, what was not verified, and the PR link. If the work touched
the AI setup, add the entry to «Registro de trabajo IA» in the `IA local` folder of Isaac's notes.
