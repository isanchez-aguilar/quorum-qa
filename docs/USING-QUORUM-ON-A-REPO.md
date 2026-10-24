# Using Quorum on a repository

Quorum reviews committed changes with your own provider CLI logins. Start with
general review: it looks for real defects in correctness, security, data loss,
concurrency, error handling, resource leaks and contracts between changed files.
It uses the same verification, confirmation, deduplication, budgets, suppressions
and reports as feature review, without requiring acceptance criteria.

## Install from source

Use Node 22, Git and pnpm. In your Quorum checkout:

```sh
pnpm install && pnpm build
npm link
```

Alternatively, skip linking and substitute `node <quorum-checkout>/bin/quorum.js`
for `quorum` in every command below. Run those commands from the repository you
want to review, not the Quorum checkout. Sign into the configured provider CLIs
with your own accounts; Quorum never asks for or stores API keys.

## Initialize the repository

From its root:

```sh
quorum init --dry-run
quorum init
```

The preview prints a proposed `quorum.config.json` and gitignore change without
writing files or running diagnostics. Init chooses the package manager from
`package.json`'s `packageManager`, then lockfiles in pnpm, npm, Yarn, Bun order.
With no lockfile it assumes npm and asks you to commit a package-lock before
using `npm ci`. Yarn 2+ uses `--immutable`; Yarn Classic uses `--frozen-lockfile`.
The proposal includes frozen setup, existing typecheck/lint/test scripts as argv
arrays, and default reviewer tiers. Build is detected but not added as a check.
A test script sets each setup/check timeout to 600 seconds. Without package.json,
setup and checks are empty; add the commands appropriate to your project.

Init refuses an existing config unless you pass `--force`. It preserves existing
gitignore entries and line endings, adding `.quorum/` only once. That directory
contains reports, caches and history with code quotes; keep it out of Git.
Review the generated tiers and commands before committing them.

Commit **both `quorum.config.json` and `.gitignore` on the base branch first**,
then create or update the branch to review from that base. A config added only
on the review branch is insufficient: Quorum reads it from the diff's merge-base
so a PR cannot inject its own check commands or weaken policy. Push or refresh
your chosen base ref yourself when needed. `--trust-head-config` is an explicit
opt-in for your own trusted committed HEAD, not the normal adoption path.

## Permissions and diagnostics

Init prints the exact permission rule computed by doctor, for example:

```text
read_file(/path/to/repository/.quorum/worktrees)
```

Add the printed string to `permissions.allow` in
`~/.gemini/antigravity-cli/settings.json`. On Windows doctor normalizes separators
and strips the drive prefix; copy its printed rule. Quorum never edits your home
settings. A covering deny rule may also need review.

Init ends with the same diagnostics as:

```sh
quorum doctor
```

Read each FAIL and its suggested fix; rerun doctor after fixing setup. Init can
exit 2 for failed diagnostics even though it successfully wrote the config.
Without `--probe`, doctor checks CLI availability, model listings, quota and
permissions, and may query the local model endpoint; it makes no inference calls.
`doctor --probe` does spend provider quota, so use it only when intended.

## Preview and run the first review

Commit the change to review, then:

```sh
quorum review --diff origin/main...HEAD --dry-run
quorum review --diff origin/main...HEAD
```

Use a different base ref if appropriate. The default mode is `general`.
`--mode feature --spec docs/spec.md` audits acceptance criteria;
`--spec docs/spec.md` alone still selects feature. Explicit feature mode requires
a spec containing Markdown checkboxes or a list under an acceptance heading.

The dry-run prints the checks, reviewer tiers, **review chunks** and **Max API
Calls**. Chunks are bounded pieces of diff/context; a first pass normally needs
one call per chunk, then fallback, confirmation or reproduction can add calls.
The automatic call ceiling is `clamp(3 × chunks, 12, 40)`; it is a maximum, not
a promise to spend that many calls. An explicit `budget.maxCalls` pins the ceiling
instead. Time limits, quota floors and confirmation reserves can stop work
earlier, yielding incomplete coverage. The preview makes no provider calls and
cannot know the eventual findings or exact final cost.

Measured mid-size reviews have taken about **3–5 minutes and 14–22 calls**;
the repository's own test suite usually dominates wall time. These are observed
ranges, not guarantees or currency prices. Larger diffs, slow tests, retries,
confirmation and provider response times change them. Calls use your provider
subscriptions; inspect the plan and quota before the real run.

Setup/check commands execute the reviewed code in disposable worktrees. For
untrusted changes, use `--no-checks`. Reproduction is separate opt-in work via
`--reproduce`; it may require Docker and additional calls. Neither is needed
to start a general review.

## Read the report

Markdown prints to stdout and is saved under `.quorum/reports/` by default.
Use `--out report.md`, `--sarif report.sarif`, or `--json` as needed.

- Confirmed findings have passed evidence checks and independent model
  confirmation. Confirmation is not an executable proof; check reproduction
  status for BLOCKERs. Origins distinguish introduced, pre-existing and improvement.
- **single model, not confirmed** means verification found matching code but
  independent agreement was unavailable. Read the unconfirmed sections too.
- **Rejected on confirmation** lists candidates another family rejected; they
  do not remain active findings.
- **Suppressed (N)** preserves reviewed false positives and their reasons. They
  are excluded from verdicts and SARIF; protected reproduced two-family BLOCKERs
  cannot be suppressed.
- **Coverage INCOMPLETE** means some work was skipped, truncated, lost, timed out
  or could not receive the required review. Do not read an empty report as clean.

Exit 0 means complete coverage without a failing BLOCKER or error-severity rule
match; IMPORTANT findings may still be present. Exit 1 means a failing BLOCKER
or error-severity rule match remains. Exit 2 means incomplete coverage without
an exit-1 condition, nothing to review, or a tool/config/usage error. Failed
deterministic checks are shown in the report; check timeouts make coverage
incomplete. General review has no acceptance-criteria table or unmet-criterion
audit.

## Record a verified false positive

Inspect the actual code before suppressing anything. Save a full JSON report,
then select the finding's 1-based index (findings followed by unconfirmed):

```sh
quorum review --diff origin/main...HEAD --json > report.json
quorum suppress add --from report.json --finding 1 --reason "Reviewed: the caller already validates this input."
quorum suppress list
```

Add `--expires YYYY-MM-DD` for a time limit. These suppression commands make no
provider calls. Review and commit `quorum.suppress.json` on the trusted base for
future reviews. Matching follows file and quote, so line moves survive while
changed code can cause the finding to return. Do not commit the JSON report if
its code excerpts should remain local.

## Privacy and local-only repositories

The selected triage/review/confirm providers receive bounded diff chunks, relevant
code/context, supplied rules/specifications and findings needed for confirmation.
Default tiers can send code to Google through agy, OpenAI through Codex or agy,
and Anthropic through Claude Code or agy. A fallback may receive code even when
the first reviewer failed. Providers operate in read-only disposable worktrees
and can read repository code to verify evidence; bounded prompts are not a
guarantee that only the diff is accessible. Screenshot modes can send images.

Do not use the default cloud tiers on repositories whose code must never leave
the machine. Configure **all four tiers** with only local Qwen; omitted tiers
inherit remote defaults. Remove any remote `escalate.routes` as well:

```json
{
  "checks": [],
  "tiers": {
    "triage": ["qwen"],
    "review": ["qwen"],
    "confirm": ["qwen"],
    "visual": ["qwen"]
  },
  "qwen": { "endpoint": "http://127.0.0.1:8080/v1" }
}
```

Use a locally hosted endpoint and inspect the dry-run recipients. Local-only
review cannot provide independent non-local confirmation: findings stay
unconfirmed and coverage can be incomplete. That limitation is preferable to
sending restricted code to cloud reviewers. Keep reports, caches and finding
history local; they contain source excerpts.
