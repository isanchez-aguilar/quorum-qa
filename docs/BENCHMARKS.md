# Synthetic benchmarks

The suite measures detection of eight seeded defects and noise on four clean
changes. All projects are dependency-free synthetic JavaScript. Ground truth is
kept outside the reviewed repository and is never supplied to reviewers.

## Run

Build first with `pnpm build`, then inspect the plan without calling a provider:

```sh
node bench/run.mjs --dry-run
node bench/run.mjs --cases missing-await,control-feature --dry-run --repeat 2
node bench/run.mjs --mode feature --dry-run
```

The plan lists initial review chunks and the maximum call budget per case and in
total. Actual calls depend on availability, retries and conditional confirmation;
the initial count is not a guaranteed minimum. Dry-run never invokes providers
and writes no results. It does create and remove temporary Git repositories.

Only after obtaining permission to spend provider quota, run:

```sh
node bench/run.mjs --config quorum.config.json --repeat 3 --out .quorum/bench/baseline
node bench/compare.mjs .quorum/bench/baseline/summary.json .quorum/bench/candidate/summary.json
```

Omitting `--cases` selects all cases, sorted by ID. `--repeat` defaults to 1.
The twelve bundled cases default to `general`; `--mode general|feature`
overrides the case mode. Specifications are retained and supplied only in
feature mode. Compare runs using the same mode.
`--config` defaults to the repository's `quorum.config.json`. The harness copies
tiers, budget and escalation settings; it forces Git context, empty setup and
checks, and base `main`. It never installs dependencies. Each repetition gets a
fresh temporary repository with two commits, and review uses `--no-cache`.
`--timeout-ms` sets the per-review timeout (default 1,320,000 ms / 22 minutes).
The existing process runner terminates the process tree at the deadline.

Normal runs write `summary.json` (including reports and effective input config)
and `summary.md`, and print the tables. Default output is
`.quorum/bench/<timestamp>/`. These are the only persistent harness writes;
temporary repositories, reports and ledgers are removed even after failure.
No raw process logs are saved. CLI exit 2 signals a failed benchmark run;
valid reviews exiting 0 or 1 are scored normally.

## Read the numbers

- A hit requires equal normalized relative paths (slashes and dot segments are
  normalized, case is preserved) and a line within the truth range plus or minus
  three lines, inclusive. Class labels document the seed; matching does not
  judge finding prose or class. A nearby unrelated finding can therefore count
  as a hit: inspect reports before drawing conclusions.
- TP counts truth items hit at least once; FN counts missed truth items. FP
  counts individual findings matching no truth. Duplicate hits do not add TP;
  duplicate false findings each add FP. One finding may hit overlapping truths.
- Recall is TP / (TP + FN). Precision is TP / (TP + FP), using the truth-based
  TP definition above. Totals pool counts across cases and repetitions.
- All reported includes `findings` and `unconfirmed` at OPTIONAL or higher.
  Confirmed includes only explicit `confirmed: true` or evidence from a different
  family in `confirmationFamilies`. Merely being in `findings` is insufficient.
- The best severity per truth is retained. Severity accuracy is the fraction
  of hit truths reaching `minSeverity`; misses reduce recall instead. Tables
  also show the number reaching the threshold. Overstated severity is not
  penalized by this threshold metric.
- Rejected-would-be-TP counts rejected-on-confirmation findings matching truth;
  rejectedTruthItems counts distinct affected truths. Neither grants TP. A
  rejection can overlap a surviving hit, so it is a recall-loss diagnostic,
  not necessarily an additional FN.
- False findings per control is control FP / control case executions.
  Undefined ratios are JSON `null` / Markdown `n/a`, never perfect scores.
- Calls sum `ledgerDraft.callsUsed`, including retries. Crashes without a report
  have unknown calls, not zero; totals show both known calls and unknown runs.
  Wall time measures the CLI invocation through parsing, excluding Git setup
  and cleanup. Exit-code distribution retains null for exceptions/timeouts.
- Failed reviews stay in the denominator and are visibly marked error/timeout;
  missing reports yield no hits. A failed control is not evidence of quiet
  behavior: check failedRuns and coverage in saved reports before comparing
  noise. Incomplete provider coverage can also occur in a valid report.

Compare prints B minus A for every aggregate numeric metric, including exit
buckets; undefined deltas stay `n/a`. Positive recall/precision/severity deltas
are improvements; positive noise, calls and time mean increases. Compare the
same selected cases, repeat counts, configuration and runtime environment.
Small samples and model nondeterminism make individual runs noisy.

## Add a case

Create `bench/cases/<id>/base/` and `head/` with complete snapshots (1–4 files,
no dependencies), plus `spec.md` with 2–4 checkbox acceptance criteria describing
intended behavior without revealing the seed. Use this metadata structure:

```json
{
  "id": "example",
  "title": "Describe the intended change",
  "kind": "seeded",
  "mode": "general",
  "spec": "spec.md",
  "truth": [
    { "file": "index.mjs", "lines": [8, 8], "class": "pagination", "minSeverity": "IMPORTANT" }
  ]
}
```

Truth lines refer to head, are one-based and inclusive. Use short ranges at the
defect; `minSeverity` is IMPORTANT or BLOCKER. Controls use `kind: "control"`
and an empty truth array. Reserved harness files (`quorum.config.json`,
`.gitignore`, `spec.md`, `.git`) must not appear in snapshots. New cases should
make a nonempty diff and remain syntactically valid. The correct-feature control
also contains a Node test runnable with `node --test` from its head directory.

Update the expected case counts in `tests/unit/bench-cases.test.ts`, run
`pnpm typecheck` and `pnpm test`, then inspect the dry-run plan. Tests use only
injected fake runners and synthetic reports. JavaScript syntax is checked with
Node's parser (`--check`); no fixture code runs during syntax validation.
