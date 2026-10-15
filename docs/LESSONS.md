# Lessons from orchestrating AI reviewers by hand

These come from months of running cross-provider reviews on a real product: new features, a full UI redesign module by module, and changes that move money. The product's code is not here; these are the patterns.

## What the reviewers are good and bad at
- **Codex:** found real money and permission bugs that the others missed. In one review, Codex found two money blockers in an idempotency change that another model had approved with no findings. Its quota runs out fast, so spend it once per change, scoped to the risky diff, at medium reasoning effort.
- **Gemini (via Antigravity):** has plenty of quota and reads screenshots, so it suits visual and accessibility review. It **cites wrong line numbers** (lines past 5000 in files 600 lines long) and **sometimes names files that don't exist**. Every finding must be verified against the code.
- **Claude models inside Antigravity:** they share one quota per model family, and once it ran out the reset was 72 hours away.
- **Antigravity is one login with several families:** Gemini Flash and Pro, Claude Sonnet and Opus, and GPT-OSS. The model list changes every few weeks, so read it (`agy models`) instead of hardcoding it. Its `/usage` reports quota per model group without spending inference.
- **Jules:** it runs in the cloud on the pushed branch, so it can run the test suite without touching the local checkout. It is slow, it sometimes stops to ask for approval, and the CLI doesn't show its quota. Pin the repo and branch in config, pull its patch without applying it, and never approve its plan automatically.
- **Local model:** it was good for mechanical test tables, fixtures and draft copy. Its output was accepted verbatim when it got the first case as a template. It is not for judgment.

## Failure modes the tool must handle
- A sandbox can't read a freshly created folder on the first try, and a failed run still costs quota. **Probe first.**
- A headless agent run ends at the first denied shell command. Prompts must say "use only file-read tools" and list every path.
- An AI finding can still be real when its line number is wrong. **Verify the quote, not just the line.**
- "Approved, no findings" from one provider means little. Agreement across independent providers means more.

- **A token assertion pins a visual bug.** A test saying "the bar uses the glass colour" passed for weeks while the bar painted a ghost shadow, and would have failed the fix. Probe pixels, not tokens.
- **A full-frame screenshot hides small defects.** A 2 px height change and a 12 px band were invisible at full frame and obvious in a 2x crop of the bar. Review crops.
- **A background CLI waits on stdin.** A headless run hung until stdin was redirected from /dev/null; another reported success having edited nothing. Verify with the diff.
- **A shipped build can point at the wrong environment.** A bundler cache inlined the development URL into a production build. Grep the artifact.

See [UI-DETAIL-CHECKS.md](UI-DETAIL-CHECKS.md) for the catalogue these became.

## Process that worked
1. Inventory every existing feature **before** a redesign, then prove each one survives. This caught gaps.
2. Render screenshots, get the owner's approval, and **only then** write tests.
3. One independent review per module for the money and permissions diff, plus a visual review per screen set.
4. Turn findings that keep coming back into lint rules. They never cost tokens again.
5. After fixes, re-review only the fix diff.
6. Keep a ledger of real findings against false ones per provider. It decides which subscriptions are worth paying for.
