# What only the owner can do

Things an agent must not do on its own (AGENTS.md: "Ask Isaac before publishing to npm, and before making the repo public"). Each section says what the decision is, what the agent can prepare, and the exact steps that are yours. Checked on 2026-10-24.

## 1. Publish to npm

### Decide the name (do this first; a published name is hard to change)

| Name | Status on npm (2026-10-24) | Notes |
|---|---|---|
| `quorum` | **taken** (someone else's `0.0.0-1`) | not available |
| `quorum-qa` | free | the current working name in `package.json` |
| `@isanchez-aguilar/quorum` | free | scoped to your npm user; nobody can take it; the command is still `quorum` |
| `quorum-review` | free | alternative |

Recommendation: **`@isanchez-aguilar/quorum`**. A scoped name can never be squatted, and the binary users type stays `quorum`. If you prefer an unscoped name, `quorum-qa` is free today but can be taken by anyone until you publish.

Before choosing (from `docs/NAMING.md`): a quick trademark search (USPTO / IMPI, software class) and, if you want one, a `.dev` domain.

### What the agent can prepare (on a branch, for you to review; nothing is published)
- `package.json`: the chosen `name`, `version` `0.1.0`, remove `"private": true`, add `files` (only `bin/`, `dist/`, `LICENSE`, `NOTICE`, `README.md`), `repository`, `homepage`, `bugs`, `keywords`, and for a scoped name `"publishConfig": { "access": "public" }`.
- A `prepublishOnly` script that runs typecheck, tests and the build, so a broken package cannot be published.
- `npm pack --dry-run` output, to show exactly which files would ship (no `.quorum/`, no tests, no secrets).
- A CHANGELOG entry for 0.1.0.

### Your steps
1. Create an npm account if you do not have one, and turn on two-factor authentication (`npm profile enable-2fa auth-and-writes`).
2. On this machine: `npm login` (opens the browser; the agent never types your credentials).
3. Tell the agent the chosen name; review the branch it prepares; merge it.
4. Publish yourself: `npm publish` (scoped: `npm publish --access public`). npm asks for your 2FA code.
5. Check: `npx <name> --version` from an empty folder.

Later, optional: publish from a GitHub Action with npm provenance (`npm publish --provenance`) so each version is signed by the build that made it. That needs an npm automation token stored as a repository secret, which only you can create.

## 2. Make the repository public (optional, separate decision)
The repository is **private**. Making it public is not needed to publish to npm (the package can be public while the repo is private), but it is needed for npm provenance and for people to file issues. What the agent can check first: no secrets in the git history (a scan), only synthetic fixtures (AGENTS.md rule), LICENSE and NOTICE present (Apache-2.0). The switch itself is yours: GitHub → repository Settings → General → Danger Zone → Change visibility.

## 3. Jules: what it is and what is pending

**What it is.** Jules is Google's coding agent that runs in the cloud: you give it a GitHub repository and a task, it works on a copy of the repo in its own virtual machine, and returns a branch or a patch. Unlike the other providers Quorum uses (agy/Gemini, Codex, Claude, Qwen), **it writes code**. The `jules` CLI is installed on this machine.

**What Quorum would use it for** (`docs/PLAN.md`, "Jules: the async cloud lane"):
1. *Reproducing a BLOCKER in the cloud*: "write a test that fails because of this finding; do not fix the code". Quorum would pull the test without applying it, re-run it locally, and only then count it as evidence. Today reproduction already works locally in Docker, so this is an extra, not a gap.
2. *A cloud reviewer for the GitHub Action* (v3), for pushed PRs when no local machine is running.

**Why it is off.** AGENTS.md says providers are read-only, and Jules is not. It stays disabled (`jules.enabled: false`) until two things happen:
1. **Your explicit exception in AGENTS.md.** Suggested text, under "Providers run read-only":
   > Exception: Jules may write only inside its own cloud VM, for Quorum's reproduction lane. Its output is pulled without applying it (`jules remote pull`, never `--apply`), re-run locally before it counts as evidence, and limited to `jules.maxSessionsPerRun` sessions per run. Jules never reviews alone and never pushes to this repository.
2. **Pinning the exact commit.** The Jules CLI takes `--repo` but has no branch or commit flag, so Quorum cannot prove the session used the commit under review. Until that is solved, Jules output cannot be trusted as evidence for a specific change.

**Recommendation.** Nothing to do now. Local Docker reproduction covers the need. Revisit when the GitHub Action exists or when the Jules CLI can target a commit.

## 4. Other owner-only items
- Renew the Claude Code login (`claude`, then `/login`) so the Anthropic family can confirm findings again.
- Merging: per AGENTS.md, merges need your say-so; in this period you authorised the agent to merge its own reviewed PRs.
