# The README demo

`quorum-demo.svg` is an animated SVG built from a real run of `quorum-qa` 0.1.1, not from mocked output.

## What was run
The run used a synthetic repository: a small refunds module with one seeded bug, where a partial-refund guard checks the paid amount instead of the refundable balance. The commands were:

```sh
quorum review --diff main...HEAD --author claude --dry-run
quorum review --diff main...HEAD --author claude
```

The real review took 26 s and 2 provider calls. It found the bug as a BLOCKER, verified it against the code, and was reviewed by two model families (Google and OpenAI). It exited with 1.

## What the animation changes
- It shows excerpts. Lines left out are marked `…`.
- The 26 s wait is shown sped up, with a note saying so.
- The report is Markdown, so `<` appears as written instead of as `&lt;`.

## Regenerating
1. Record a session: `node record.mjs <repo> session.json -- "<command>" ...`. It runs each command and stores the output with timings.
2. Edit `script.json` from that output.
3. Render: `node render.mjs script.json quorum-demo.svg`.

The renderer needs no dependencies. It uses CSS keyframes only, with no scripts and no external fonts, so GitHub plays it inline.
