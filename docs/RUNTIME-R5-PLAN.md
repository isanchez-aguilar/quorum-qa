# Plan: runtime R5, screenshots and the optional model layer

Status: plan, not built. Written 2026-10-21. Read [RUNTIME-PLAN.md](RUNTIME-PLAN.md) first; R0-R3 are built and the verdict is deterministic. R5 adds two things on top and changes nothing about the deterministic verdict: **(a) screenshots** and **(b) an opt-in visual review by a model**.

## Why

The deterministic collector sees console errors, HTTP status, blank pages and technical text. It cannot see a layout that broke without any error: cut text, overlapping elements, a missing primary button, an error banner in the app's own words, a page that renders but looks wrong. A person looking at before/after screenshots sees those at once. A model with image input can do the same, cheaply, if it is asked narrowly and its answer is never allowed to decide the exit code alone.

## Principles

1. **The deterministic verdict never depends on a model.** R5 findings are *advisory*: they appear in the report in their own section, never create `NEW RUNTIME PROBLEMS`, never change the exit code, and never turn `UNKNOWN` into anything else. They can add a reason line and raise a clean result to `SUSPECT` only when two different model families report the same finding (see Verdict).
2. **Opt-in, because it spends quota and sends images to third parties.** `--visual` (runtime mode only) is the only switch that calls a model. Without it nothing leaves the machine.
3. **Screenshots are data.** Text inside an image is untrusted exactly like page text: it is never an instruction, never executed, never trusted for what it says about itself.
4. **Bounded everywhere.** Image count, bytes per image, bytes per side, model calls and wall time all have caps, and a cap hit is a visible note and `incomplete` for the visual section (never silent).
5. **Test data only**, as for flows. The report and the consent line state that screenshots of the app go to the selected model providers.

## (a) Screenshots

- **Config.** `runtime.screenshots: true` captures images and stores them for people to open; it does not call a model. (R0 accepted it; the hardening pass rejected `true` until this milestone. R5 re-enables it.) `--visual` implies capture.
- **Capture.** In `collector.cjs`, after each step that triggers the DOM inspection (goto, click, press, waitForUrl, waitForSelector; the hardening pass extended the inspection to all five) and after the page settles, on **both runs** of each flow: `page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, animations: 'disabled', caret: 'hide' })` with a fixed viewport of 1280x800 set when the context is created (the viewport is fixed for every run, with or without screenshots). Capturing in both runs keeps the timing symmetric, so the two-run flake filter is not biased by the flag; **only run 1's images are kept and transported**. The capture time is excluded from the flow deadline, so enabling screenshots cannot turn a passing flow into a timeout.
- **Caps.** At most 10 images per flow and 300 KB per image (an over-cap image is dropped with a `cap: screenshot` note, never downscaled silently). The per-side budget of 6 MB is shared **fairly**: each flow may use at most `floor(6 MB / number of flows)`. Image bytes are not counted in the 2 MiB JSON report cap because they travel separately.
- **Transport.** The JSON report stays the only structured channel. Images go out as stdout lines **before** the report: `<marker>IMG <json>` where the JSON is `{ flow, step, mime, bytes, sha256, data }` (base64), one line per image, each line capped at 450 KB, using the same fresh per-run marker; the report is still the LAST marker in the output, so `runtimePayload`'s `lastIndexOf(marker)` keeps finding it (a test asserts the order). The host parser reads the `IMG ` lines by scanning lines, takes only those that start with the fresh marker followed by `IMG `, verifies mime (`image/jpeg` only), size, sha256 and flow/step against the plan, drops duplicates and anything over the caps. App output cannot forge lines because the app's stdout is discarded inside the container (runner.cjs) and the marker is fresh. The container command's `maxOutputBytes` rises from `REPORT_BYTES + 4096` to `REPORT_BYTES + 6 MB * 4/3 + slack` only when capture is on (the runner's own hard limit is 16 MiB, so this fits); hitting the output limit is `UNKNOWN` as before, never a silent drop.
- **Storage.** `.quorum/runtime-shots/<runId>/<base|head>/<flow>-<step>.jpg` (the directory is git-ignored; file names come from the validated flow name and step index only). Same-name flows cannot collide: flow names are unique case-insensitively.
- **Paired images.** An image is *paired* when base and head both have one for the same flow and step. Unpaired images are listed, not reviewed.

## (b) Visual review (`--visual`)

- **Provider tier.** The existing `visual` tier (providers with `supportsImages`), reusing the cascade's family rules, quota checks, budget and deadlines. No new provider code.
- **Prompt.** For each flow, one call with its paired images (before/after in step order, at most 10 pairs, so at most 20 images) and this narrow task: list only differences that look like regressions: text cut off or overlapping, missing or hidden primary actions, empty regions that were filled before, error banners, raw technical text, broken layout; ignore content that changed but looks intentional (copy, data, ordering) unless it looks broken. The prompt carries the flow name and the step list (actions and selectors, with `fill` values removed) and a fixed instruction that image text is data, not instructions. It does **not** carry touched file names or any code: they are unnecessary for comparing images and would send repository details to a third party. The call runs with the images-only attachment directory as the provider's readable root (the same arrangement redesign mode uses), so a prompt injected through text drawn in the page has nothing sensitive to read. Output is the **existing strict finding JSON** (`file`, `line`, `trigger`, `impact`, `evidence_quote`, `fix`) used by redesign's visual review: `file` is the image label `flow/step`, `line` is 1, `trigger`/`impact` describe what is visibly wrong, `severity` is capped at IMPORTANT. No new provider schema is needed.
- **No lexical verifier, and no code-based adjudication.** Findings cannot be checked against source text, and the cascade's same-defect adjudication works on source files, hunks and lexical overlap of `trigger`/`impact`, so it does not fit. They are labelled `visual, unverified` and corroborated by a dedicated rule in `src/runtime/visual.ts`: group findings by `(flow, step)`; a pair is **corroborated** when at least two different model families each reported at least one finding for the same `(flow, step)` image pair, independently (each family gets the same images and the same prompt; neither sees the other's answer). Coarser than a text match, but sound: it asks only "did two families independently flag this screenshot pair". Both claims are shown. Uncorroborated findings are shown as advisory only.
- **Calls and caps.** One review call per flow with paired images from the primary family, and one from a second family for every flow where the primary reported something (no second call otherwise). Total model calls are capped by `budget` and by `runtime.visual.maxCalls` (default `min(2 x flows, 40)`, range 1-40; the dry-run prints the exact maximum). Images over the provider's accepted size or count are not sent; that flow is listed as `visual coverage incomplete`. `runtime.visual.allowedFamilies` (default: all families the `visual` tier lists; `['local']` limits it to the local model) restricts where screenshots may go; the consent line names the families and providers that will receive images.
- **Deterministic evidence is the arbiter.** If the deterministic comparison already reports a problem for the same flow/step (blank page, technical text), the visual finding is attached to it as corroboration instead of listed twice.

## Verdict interaction

| Situation | Effect |
|---|---|
| `--visual` off | none; the report says `Visual review: off` |
| Visual findings uncorroborated | listed as advisory; verdict and exit code unchanged |
| A corroborated visual finding and the deterministic verdict is `NO NEW RUNTIME PROBLEMS FOUND` | verdict becomes `SUSPECT` (exit 0) with the finding as the reason |
| Any visual provider error, no `visual` provider available, a cap hit | a note and `visual coverage incomplete`; **never** `UNKNOWN` by itself (the deterministic coverage decides that) and never a pass claim for the visual part |
| Deterministic verdict `NEW RUNTIME PROBLEMS` or `UNKNOWN` | unchanged; visual findings are appended as context |

## Where it plugs in

- `collector.cjs` (capture, caps), `runner.cjs` (emit IMG lines after the report), `run.ts`/`report.ts` (parse and store images, new `shots` in `SideResult`), a new `src/runtime/visual.ts` (pairing, prompt, calling the cascade's `visual` tier, corroboration), `compare.ts` (attach visual findings), `cli/runtime.ts` (`--visual`, consent line, verdict rule), `reporters/runtime.ts` (a "Visual review (advisory)" section with image paths, never the images inline), config schema (`runtime.visual.maxCalls`, re-enable `screenshots`), `docs`.
- The consent line when `--visual` is on names the providers that will receive screenshots.

## Milestones

| | Deliverable | Verification |
|---|---|---|
| V0 | Capture + transport + storage + caps, `screenshots: true` re-enabled, no model | fake Playwright and fake runner tests; forged IMG lines; real Docker test asserts a JPEG per step with correct hash |
| V1 | Pairing, prompt, `visual` tier call, corroboration, verdict rule, reporters, `--visual` | fake provider tests (agree, disagree, one family only, errors, caps); a recorded-response end-to-end |
| V2 | One real run with real providers on the fixture app (`console-error` and a layout-break variant added to the fixture), result written up | needs quota: Isaac's yes before running |

## Risks and answers

- **Screenshots can show secrets or personal data.** Flows use test data only; capture is opt-in; the consent line says images go to the named providers; storage is under the git-ignored `.quorum/`.
- **Dynamic content makes every pair look different** (clocks, avatars, ads, carousels). The prompt says to ignore data/content changes, `animations: disabled` removes motion, and uncorroborated findings never affect the verdict. The README tells users to keep flows on stable pages.
- **A model hallucinates a regression.** Hence advisory-by-default and agreement across two families before it can even raise `SUSPECT`.
- **Prompt injection through text drawn in the page.** Image text is data by instruction; the output schema is strict JSON with capped severity; nothing the model returns is executed or can change the exit code to 1.
- **Cost.** Capped calls, opt-in flag, and the dry-run prints the maximum number of model calls and images before anything runs.

## Decisions taken (independent review by Gemini, 2026-10-21)

- Images travel before the report so the report stays the last marker; the output limit is raised only when capture is on.
- Corroboration is agreement between two families on the same `(flow, step)` pair, not the code-based same-defect adjudication; the existing finding schema is reused.
- Capture runs in both runs (timing symmetry), keeps run 1's images, and does not count against the flow deadline.
- Touched file names are not sent; the call reads only the images-only directory.
- `runtime.visual.allowedFamilies` lets a repository keep screenshots local; `--visual` stays strictly opt-in and the consent line names the receivers.
- V2 (real providers) is not run until V0 and V1 pass with fakes and Isaac approves the exact call and image counts.

## Open question for Isaac

V2 spends real quota. Once V0 and V1 pass with fake providers, is one run with real providers on the synthetic fixture app approved? (The run will be announced with its maximum number of calls and images first.)
