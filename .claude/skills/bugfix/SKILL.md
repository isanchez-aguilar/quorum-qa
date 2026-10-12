---
name: bugfix
description: Fix a bug, regression or pasted error in ANY repository with the short generic pipeline — reproduce it with a failing test first, fix the root cause minimally, tester breaks it again, another provider reviews it, draft PR. Use in places that do not define their own /fix skill (a repo with its own /fix keeps using it). The owner describes bugs in plain language; route them here yourself.
---

# /bugfix — generic pipeline for a bug

Say in one line that you are taking this route («Lo trato como bug»). The
repository's own rules win over anything here.

## 1. Reproduce first

Gather the evidence (error text, steps, logs — without secrets). Rank the likely
causes, then write the test that fails for the leading one. **No fix before a
failing test or an exact reproduction.** If it cannot be reproduced, say so and
ask Isaac for what is missing instead of guessing.

## 2. Root cause, minimal fix

Find why, not just where. Fix the cause with the smallest change; keep
unrelated refactors out. The failing test now passes; run the repository's
typecheck, linter and the tests of the touched area. Use `implementer`
(`model: sonnet`) for the fix when the session is busy; `opus` only for a hard
diagnosis. **Never `fable` without asking Isaac first.**

## 3. Break it again

Launch `tester` (`model: sonnet`) to look for the same bug's siblings: the other
callers, the boundary values, the error path.

## 4. Review and close

Branch, commit, push, draft PR, and a read-only review by a DIFFERENT provider
(Antigravity or Codex) with `.ai/prompts/review.md`, exactly as `/work` step 4
describes. Merge only with Isaac's authorization. Report the root cause, the
test that now guards it, the commands with results, and what is still
unverified.
