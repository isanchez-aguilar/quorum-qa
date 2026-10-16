# UI detail checks

A catalogue of small visual and interaction defects that **tests, type checks and
a quick glance at a screenshot all let through**, and that a real user notices on
the first day. Each one was found by hand on a real product (a mobile app and its
web twin). The point of this file is to turn them into checks that run before a
human has to look.

Everything here is a pattern. The product's code is not here, and every example
is synthetic.

## Why these slip through

- **A token assertion is not a pixel.** A test that says "the bar uses the glass
  colour token" passes while the bar paints a ghost rectangle. Worse, it pins
  the bug: the day someone fixes it, the test fails.
- **A full-frame screenshot hides 2-pixel problems.** A reviewer, human or model,
  scans for layout and misses a 12 px band or a 2 px height change. Cropping the
  edges and zooming 2x finds them.
- **A state is only seen if it is forced.** Loading, disabled, error, empty,
  forbidden, long text and large fonts never appear in a happy-path run.
- **One theme, one device.** Defects live in the other theme, on the tablet, or
  under the gesture-navigation inset.

## How to read the catalogue

| Field | Meaning |
|---|---|
| **Symptom** | What the user sees. |
| **Cause** | The usual code reason, so a linter can look for it. |
| **Detect** | The cheapest reliable way, tiered below. |
| **Pass** | An objective criterion, so a run can fail. |

### Detection tiers (cheapest first)

| Tier | What | Cost |
|---|---|---|
| **T0 static** | AST or text rules over the diff: a risky style combination, a component used without a required prop. | free |
| **T1 probe** | Measure the running app: bounding boxes in two states, pixel rows in a screenshot, contrast maths, a network response. Deterministic, no model. | free |
| **T2 visual model** | A vision model reviews **crops** of the screenshots (bars, edges, buttons) with a checklist, both themes, phone and tablet. Its findings are verified against T1 numbers. | tokens |
| **T3 human** | Taste and brand: whether it feels right. Only after T0 to T2 are clean. | the owner's time |

A defect found at T3 that a T0 or T1 rule could have caught is a **missing
rule**: add it here.

---

## A. Layout stability

### UI-01 The loading state changes the size of the control
- **Symptom:** a primary button grows a few pixels taller when its spinner
  appears (and shrinks back), so everything below it jumps. Related: a label swap
  ("Sign in" to "Signing in...") changes a non-full-width button's width.
- **Cause:** the spinner is taller than the label's line box, inside a container
  with `minHeight` and padding but no fixed height; or the spinner is added next
  to the label instead of reserving a slot.
- **Detect:** T1: measure the control's bounding box idle, then in its busy state
  (force `loading`), compare. T0: a spinner component rendered conditionally
  inside a button with no fixed-size slot.
- **Pass:** height delta <= 0.5 px; width delta = 0 for full-width and
  fixed-width buttons; for content-width buttons, the delta is only the label's.

### UI-02 Placeholder and skeleton heights differ from the content
- **Symptom:** the page jumps when the data arrives.
- **Detect:** T1: measure the container before and after the data resolves.
- **Pass:** cumulative layout shift of the region <= 0.02 (web); no visible jump
  (mobile: delta <= 2 px).

### UI-03 Helper and error text reflows the form
- **Symptom:** a validation message appears and pushes the primary button down.
- **Detect:** T1: bounding box of the submit button with and without an error.
- **Pass:** either the line is reserved (no delta) or the shift is intended and
  reviewed.

### UI-04 A toast or snackbar covers or pushes the primary action
- **Detect:** T1/T2: force the toast; check it does not overlap the last visible
  action or the keyboard.

## B. Surfaces, colour and insets

### UI-05 Translucent background plus elevation draws a ghost shadow (Android)
- **Symptom:** a bar or card has a lighter inner rectangle with a soft edge above
  it; the shadow shows **through** the see-through fill.
- **Cause:** `backgroundColor` with alpha < 1 on an element that also has
  `elevation` or a shadow, often inherited from a navigator's default
  (for example a tab bar with `elevation: 8`).
- **Detect:** T0: translucent fill and elevation on the same element, including
  library defaults. T1: sample one pixel row across the width of the bar region.
- **Pass:** row uniform within +/-2 per channel; no alpha < 1 fill on an
  elevated surface.

### UI-06 The system-inset strip does not match the bar above it
- **Symptom:** the strip under the gesture-navigation handle is another shade
  (lighter or darker) than the bar, or is inset from the sides.
- **Detect:** T1: sample the bottom-most row at x = 0, W/2, W-1 and the bar row
  just above.
- **Pass:** all within +/-2.

### UI-07 Double safe-area: a dead band under the content
- **Symptom:** cards are hard-clipped a few dozen pixels above a bar, leaving a
  strip of page colour with no content. It is exactly the bottom inset.
- **Cause:** a screen wraps its content in a safe-area view that includes the
  bottom edge, inside a navigator whose bar already accounts for it.
- **Detect:** T0: a safe-area view with default edges inside a tab or stack that
  has its own bar. T1: scroll to the end; measure the gap between the last
  content pixel row and the bar.
- **Pass:** content scrolls under or flush to the bar (gap 0 while scrolling,
  then the intended end padding).

### UI-08 Theme parity
- **Symptom:** a screen is fine in one theme and unreadable, borderless or
  glaring in the other.
- **Detect:** T0: hard-coded colours outside the token set. T1: contrast maths
  per text/background pair in both themes. T2: screenshots of every screen in
  both themes.
- **Pass:** AA contrast for text (4.5:1 body, 3:1 large and for UI controls); no
  literal colour values; borders visible in both themes.

### UI-09 Disabled and muted states are too faint
- **Detect:** T1: contrast of the label **after** the disabled opacity is applied.
- **Pass:** disabled text >= 3:1, and still distinguishable from enabled.

## C. Touch and input

### UI-10 Touch targets
- **Detect:** T1: bounding box of every pressable, including icon buttons, chips,
  badges and the controls inside list rows.
- **Pass:** >= 44 x 44 pt (iOS) / 48 x 48 dp (Android) including padding.

### UI-11 Keyboard
- **Symptom:** the focused field or the sticky action is hidden behind the
  keyboard; the wrong keyboard type; "next" does not move to the next field.
- **Detect:** T1: focus each field with the keyboard up and check it is inside
  the visible viewport. T0: numeric fields without a numeric keyboard type.

### UI-12 Double submit
- **Symptom:** pressing Enter twice, or tapping fast, sends two requests.
- **Detect:** T1: fire the action twice within 100 ms against a slow stub and
  count requests.
- **Pass:** exactly one request; the control exposes a busy state.
- **Seen in the wild:** a creation sheet that stays open until the server
  answers had no in-flight guard; one tap on «Save» left two records and a
  balance higher by the amount twice. Unit tests of the sheet never tapped
  twice; a functional pass (create, then count what exists) found it at once.
  The guard must be a **ref**, not state: two taps inside one frame both read
  the state as «not submitting».

### UI-13 Accessible names and states
- **Detect:** T0: an icon-only pressable without an accessible label; a badge
  count not announced; a busy control without the busy state.

## D. Text and numbers

### UI-14 Truncation, long values, large fonts
- **Detect:** T1: render with the longest realistic name, the widest amount for
  the narrowest supported width (for example a 7-digit amount with cents on a
  360 dp phone), and font scale 1.3 and 2.0.
- **Pass:** no unintended ellipsis on a primary value; nothing overlaps; tab
  labels fit at the maximum tab count.

### UI-15 Copy consistency
- **Detect:** T0/T2: the busy label's tense and wording match the product
  glossary ("Signing in..." vs "Loading..." for the same action); no technical
  error text shown to the user.

### UI-16 Zero, empty, negative and dates
- **Detect:** T1: zero amounts, empty lists, negative values, a date at 23:30
  local time versus UTC.

## E. Responsive

### UI-17 Tablet and landscape
- **Symptom:** a sticky bar stretches the full width; a column is 1200 px wide;
  a floating action button overlaps the last row; a KPI row wraps badly.
- **Detect:** T2/T1: tablet portrait and landscape screenshots; max content
  width.

### UI-18 The last item is reachable
- **Detect:** T1: scroll to the end; the last item's bottom edge must be above
  the floating action button and sticky bars.
- **Pass:** bottom padding >= action height + margin.

### UI-19 Small phones, notches and cutouts
- **Detect:** T1: 320-360 dp width; a display cutout; nothing under the status bar.

## F. State coverage

### UI-20 Every screen has all its states
- **States:** loading, empty, error, offline, forbidden (403).
- **Detect:** T1: force each state from a stub and screenshot it.
- **Pass:** each renders a real UI, not a blank page or a raw error.

### UI-21 Hiding in the UI is not redaction
- **Symptom:** a role is not meant to see a value (cost, margin), the control is
  hidden, but the value is still in the network response, the exported file or a
  local cache.
- **Detect:** T1: sign in as the restricted role and **grep the responses and
  exports** for the field, not just the DOM.
- **Pass:** the value is absent from the payload; the UI never fires the
  requests that would answer 403; no error toast for a card the role was never
  meant to have.

### UI-21b An optimistic permission default is a leak for data
- **Symptom:** a client assumes «allowed» while the role is still loading (so a
  button does not blink), and for one beat draws a cost, or requests an endpoint
  that exists only for people who may see costs.
- **Detect:** T1: hold the role request open (stub it pending) and screenshot /
  list the requests fired. T0: a permission helper with an «unknown → allow»
  branch that is also used for data, not just for controls.
- **Pass:** controls may be optimistic; data-gating permissions are denied until
  the role is known, and no restricted request fires while pending.

### UI-21c A permission that resolves late must not erase what it hides
- **Symptom:** a form is seeded while a field is hidden (empty); the permission
  arrives and the field appears, still empty; the next save sends «null» and
  erases the stored value the person never saw.
- **Detect:** T1: mount the form with the permission denied, flip it to granted,
  save an unrelated field, assert the payload does not carry the field (or
  carries the stored value). Also granted → denied.
- **Pass:** a hidden field is never sent; when it appears it is reseeded from
  the stored value; absent is never serialised as null.

### UI-22 Stale state after a role, permission or account change
- **Detect:** T1: change the permission, refresh, check caches, drafts and
  persisted forms do not keep the old data.

## G. Motion

### UI-23 Spinners and animation
- **Detect:** T1: reduced-motion setting honoured; a spinner that never stops
  after a failed request; an animation that restarts on every re-render.

## H. Web specifics

### UI-24 Focus, hover, zoom, autofill
- **Detect:** T1: a visible focus ring on every interactive element; 200% zoom
  without horizontal scroll; browser autofill does not recolour inputs to an
  unreadable pair; a `<button>` paints its own text colour.

## I. Platform specifics (native)

### UI-25 Back and status bar
- **Detect:** T1: the system back gesture from every screen and sheet; status bar
  style matches the theme (light icons on dark, dark on light).

---

## J. Verification gaps (not visual, found the same week)

These are process holes: the check that would have caught a real problem did not
exist. Each should become a gate.

### V-01 The shipped artifact points at the right environment
- **Gap:** a build embedded the development API address because a bundler cache
  inlined environment variables from an earlier build.
- **Check:** T1: after building, **grep the artifact** for the expected URLs and
  fail if the other environment's URL is present. Build with the cache reset.

### V-02 Every PR branch compiles on its own
- **Gap:** a PR was missing a file in a shared package because the staging
  command listed only some directories; stacked PRs hid it because the shared
  file existed in the branch below.
- **Check:** T1: in a fresh worktree of the PR head (not the working checkout),
  install and type-check. T0: warn when changed files import a path that is
  modified but unstaged.

### V-03 The deployed database matches the migration journal
- **Gap:** a development database was missing four migrations and the first
  money flow answered 500.
- **Check:** T1: at deploy, compare applied migrations to the journal and fail on
  drift.

### V-04 Tests that pin the defect
- **Gap:** an assertion `bar.background === glassToken` existed, so the visual
  bug was protected by a test.
- **Check:** when a visual bug is fixed, search the tests for assertions of the
  old value and list them in the review. Prefer a probe (UI-05) to a token
  assertion.

### V-05 Review on the real thing, with real data
- **Gap:** screens approved from component tests and generated mocks.
- **Check:** T2: a device or emulator with seed data, native density, both
  themes, phone and tablet, the edges cropped at 2x.

### V-07 Mirrored files and script guards when CI is off
- **Gap:** an agent file was edited and its mirror for another tool was not; a
  script guard (which CI would have run) failed only at the local gate, after a
  PR had already merged.
- **Check:** T0/T1: run the repository's script guards on every PR locally when
  hosted CI is unavailable, and make the mirror a generated file or a test.

### V-08 Tests written blind
- **Gap:** a model that could not run commands added tests for its own change:
  14 mobile tests and 10 type errors failed on first run (wrong copy, a mock
  factory referencing an out-of-scope import, a fixture missing a required
  field, an assertion on text the component does not render).
- **Check:** never accept «tests added» from a run that could not execute them;
  run the touched suites and the type check, and budget a fix pass. Failures of
  this kind are the tests, not the feature: read each before changing code.

### V-09 Green is not reviewed
- **Gap:** about 8,000 web tests and 2,800 mobile tests were green when an
  independent model of another family read the UI diff and found six real
  defects (an unknown-role window, a late permission erasing a value, a draft
  keeping a figure, a stale export choice, a retry carrying revoked data, an
  undo after revocation). No test modelled those transitions.
- **Check:** for a permission change, ask the reviewer for TRANSITIONS
  (unknown→known, denied→granted, granted→revoked) and for what persists
  (drafts, caches, in-flight confirmations), not just for the steady state.

### V-10 A functional pass after the visual one
- **Gap:** screens approved from screenshots and component tests; the first
  real create-then-count on a device found a double creation.
- **Check:** for each money or record flow, drive it on the real build with
  seed data and **count the result** (records, balances), not just look at it:
  create once and expect one; pay once and expect one payment; receive stock
  and expect the cost and margin to move; open the shared link and expect a
  page. Clean the test records afterwards.

### V-06 Headless agent runs
- **Gap:** a coding CLI run in the background hung waiting on standard input; a
  run reported success while it had edited nothing.
- **Check:** pass `/dev/null` as stdin; after every delegated run, verify with
  `git status` and the diff, not with the run's own summary.

---

## Proposed check pack: `ui-detail`

Run with the redesign mode's visual review:

```
quorum review --mode redesign --images shots/ --pack ui-detail
```

1. **Probes first (T1, free).** Pixel-row uniformity on bars and edges (UI-05,
   UI-06), bounding-box delta between two states of the same control (UI-01,
   UI-03), touch-target sizes (UI-10), contrast pairs in both themes (UI-08,
   UI-09), payload grep for a restricted field (UI-21), artifact grep (V-01).
2. **Crops, not frames (T2).** The model receives zoomed crops of the top 10 %,
   the bottom 20 %, every button and every bar, with the checklist above, in both
   themes and on a tablet. Its findings must quote a probe number or be marked
   unverified.
3. **Verify.** A finding without a measurable pass/fail is an OPTIONAL
   suggestion at most.
4. **Rule mining.** A defect found by a human at T3 becomes a new UI-nn entry.

## Using it as an agent

For a repository without Quorum, the same catalogue works as a QA agent or skill:
input is a list of screens and a running app (emulator or browser); the agent
runs the probes it can, captures both themes and the tablet, crops the edges,
and reports BLOCKER / IMPORTANT / OPTIONAL with the screenshot crop and the
measured number as evidence. It never edits code.
