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
