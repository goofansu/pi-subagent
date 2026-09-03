# Phase A exit gate — notification semantics and UX

**Status: closed.** Verified against the phase's production code as of
`6060430`, the last commit that changed any, and the deterministic gate re-run
on the commit that carries this verdict. The commits after `6060430` are
documents only, which is why a live gate run on that code is a run on the
closing code.
**Verified against:** [the roadmap](roadmap.md),
Phase A; [the notification semantics](notification-semantics.md);
[the presentation ledger](presentation-ledger.md).
**Closing this gate unlocks:** the 2.0 stable release from the notification
side. The three release items the v2 roadmap left open (live gates on the
cutover build, the Codex Desktop coexistence record, the soak) are separate
and unchanged.

## How to read this

Each item is **PASS**, **CARRIED**, **OPEN**, or **NOT MET**, with the same
meanings as [the M7 gate](../v2/m7-exit-gate.md), and every one names what
was actually run. Items are written now, before the work, so the work is
judged against a list it did not write.

## The deterministic gate

```
npm run check   →  exit 0
```

| Step | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | `Checked 224 files. No fixes applied.` |
| `npm test` | 1,214 tests, 1,206 pass, 0 fail, 8 skipped |
| `npm run test:conformance` | 191 tests, 183 pass, 0 fail, 8 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.153.0` |

The eight skips in each lane are capability-declared conformance skips, the
same eight as before the phase.

**Status:** PASS.

## Two rules this phase broke, recorded rather than quietly fixed

**The commit rule.** `docs/contributing.md` §Commits: *"A commit that changes
user-visible text says which compatibility-matrix cell it affects."* Four
commits change user-visible text and cite only presentation-ledger rows and
their ticket: `2d6269f`, `143dea1`, `5712226`, and `e0714c6`. `6060430` is the
one that does it right. The cells they affect, so the information exists and
is attributable:

| Commit | Matrix cell |
| --- | --- |
| `2d6269f` | Completion Notification → *Expected outcome* (the header and identity block), *The Run label*; `agent_start` and `agent_resume` → the description field's copy |
| `143dea1` | Completion Notification → *Completed Run*, *Failed Run*, *Cancelled Run*, *The pointer* |
| `5712226` | Completion Notification → *Accounting*, *every row* (backend independence) |
| `e0714c6` | Completion Notification → *Collapsed transcript line* |

The messages are not being rewritten: this document and
[the change-surface measurement](change-surface.md#method-so-this-can-be-repeated)
cite those hashes as evidence, and rewriting them would invalidate the
measurement they are the evidence for. The rule's purpose — a reader can tell
which cell moved — is met by the table above and by the matrix's own
**[Phase A]** markers. The rule itself was broken four times, and a future
phase should not read this as permission.

**The vocabulary rule, briefly.** `docs/contributing.md` §Vocabulary makes
`CONTEXT.md` load-bearing: "code using a different word for the same thing is
a bug in the naming". This phase made *label* the product word for a Run's
description across the domain, the notice, the host payload, the renderer, and
both tool schemas, and the glossary did not gain the entry until this gate was
being written. It has one now, and it says which of the two words is which:
the field a caller fills in is `description`, because that is what the tool
schema has always called it, and every surface that shows it calls it the
label. The `handedOff` rename got its glossary block in the same commit as the
code; the label rename did not, and should have.

**The architecture challenge gate, commit-wise.** `docs/contributing.md` asks
for its three questions "in the commit message or in an ADR" for a change that
adds an abstraction to, or changes a decision in, generic runtime code or the
domain. The three domain commits answer them in neither; ADR-0033 answers all
three and arrives in ticket 09, because the spec put the ADR there. Satisfied
across the phase, not commit by commit. A phase that decides its ADR before
its code — which this programme's whole premise is — should write the ADR
first as well.

## The commits

| Ticket | Commit | What it did |
| --- | --- | --- |
| 01 | `6cb9604` | delivery says "handed off"; boundary rule 19 and the glossary |
| 02 | `2d6269f` | the label bound at admission; the header and identity block |
| 03 | `143dea1` | availability, the universal pointer, the four sections |
| 04 | `5712226` | `NotificationAccounting`; no backend identity; boundary rule 20 |
| 05 | `e0714c6` | the collapsed line and the host payload |
| 06 | `6060430` | the `/subagent` namespace and the `/agents` alias |
| 07 | `1991b68` | the architecture map, the recipes, the simplification rule |
| 08 | `87c56fc` | the change-surface baseline and its three findings |
| 09 | this commit | ADR-0033, the matrix rows, the confirmed ledger, this verdict |

## The items

### 1. The delivery module does not say "landed"

`runtime/delivery.ts` exposes `handedOff()` and keeps `DeliveryState.handedOff`;
no inflection of *land* appears in the file. A boundary rule in
`boundaries.test.ts` enforces it and has a negative-case fixture that the
checker fails on purpose. The push sink's `hasLanded`, `landed()`, and
`onLanding` are unchanged. `CONTEXT.md` defines handed off, landed, lost after
hand-off, and exhausted.

**Evidence.** `DeliveryState.handedOff`, `handedOff()`, and the local named
`handedOff` in `runtime/delivery.ts`; `exhausted()` unchanged. Boundary rule
19 scans `runtime/delivery.ts` **and its test** for
`/\b(un)?land(ed|ing|ings|s)?\b/i`, with two fixtures: `the delivery module
saying "landed" is rejected, and the push sink saying it is not` — which
writes out the sink's whole landing API to prove the rule does not fire on it
— and `delivery's own three states are not landing vocabulary`. The push
sink's `hasLanded`, `landed()`, `unlanded()`, and `onLanding` are untouched;
`git diff` on `host/push-sink.ts` across the phase is empty. `CONTEXT.md`
defines all four terms, each naming the component that decides it, and the
Notification entry points at them.

`runtime/delivery.test.ts`'s diff is the rename plus two comments that said a
notice "lands" where they meant the push was accepted — which the fence
requires, since it covers the test file.

**One deviation from the item as written:** the item says the rule applies to
`runtime/delivery.ts`. It applies to the test as well, because the reading a
maintainer takes away is as much in a comment as in a name.

**Status:** PASS.

### 2. The Run label is bounded at admission and recorded when shortened

A description of 10 KB with newlines yields a Run whose label is one line of at
most 200 bytes, whose Result carries a diagnostic saying the label was
shortened, and whose Result stays within the byte budget with every removable
section cut. The tool schemas' description fields state the bound.

**Evidence.** `RUN_LABEL_MAX_BYTES = 200`, `boundRunLabel`, and
`labelShortenedDiagnostic` in `domain/result.ts`, beside `RunIdentity`.
Applied in `Subagents.start` and `Subagents.resume`, which is where a decoded
tool input becomes a supervisor request. The diagnostic travels on the request
and is emitted through the Run's own observation intake.

`runtime/bounds.test.ts`: `a label past its byte bound is collapsed to one
line, cut, and recorded` drives a 10 KB multi-line description through the
façade and asserts no newline, exactly 200 bytes, agreement with
`boundRunLabel`, and the diagnostic on the stored Result naming the bytes
removed; `a label within its bound is stored whole and records nothing`; `a
maximal label leaves a result inside its byte budget once everything removable
is cut`. `host/tool-schemas.test.ts`: `T1: the label's bound is stated on both
description fields`.

**Status:** PASS.

### 3. Every terminal notice points at `agent_result` with the exact argument shape

Completed, failed, and cancelled notices all end with a pointer of the form
`Call agent_result with {"id":"…"}.` prefixed by the availability sentence.
The cancelled golden that asserted no pointer is replaced.

**Evidence.** `presentation/notification-text.test.ts`: `N-1`, `N-2`, `N-4`,
`N-5`, `N-7`, and `a cancelled Run with nothing to show says so and still
points at the record` are the per-status goldens; `the pointer says how much
is there for each of the three availabilities` is the per-availability one;
`every terminal status ends with the availability sentence and the exact call`
asserts the pointer is last for all three; `availability describes the stored
Result rather than the Run's success` asserts the derivation. The golden that
asserted a cancelled notice has no pointer is replaced by `N-7`, which asserts
it has one.

The pointer is a *section* of the text rather than something a status branch
appends, so no status can be the one that forgets it.

**Status:** PASS.

### 4. The notice carries the label, the duration, and bounded accounting, and not the backend

`RunNotification` has `label`, `durationMillis`, `resultAvailability`, and
`accounting`, and has no `backendId`, `description`, `usage`, or `model`. The
backend-independence golden still passes and is now structural.

**Evidence.** `domain/notification.ts` declares `label`,
`resultAvailability`, `durationMillis`, and optional `accounting`, and no
`backendId`, `description`, `usage`, or `model`. `N-8: the notice is identical
whichever backend ran the Run` now asserts the three notices are **one value**
and that `"backendId" in notice` is false, so the property the test proves is
one the type also guarantees. `N-9: the accounting a notice carries is only
what the line prints` asserts the four figures and the model and nothing else;
`a pathological model name is bounded where the accounting is built` asserts
the 100-byte bound.

**Status:** PASS.

### 5. The preview is labelled and quoted

A completed notice's body reads `Preview from the subagent:` followed by the
preview in straight double quotes. The preview bound is still 500 bytes.

**Evidence.** `N-1: a completed notice labels and quotes the preview, then
points at the full result` asserts the exact text, `Preview from the
subagent:` then `"done"`. `N-3: a long answer is previewed rather than
delivered` asserts `byteLength(notice.preview) === 500` unchanged. Both rows
are confirmed in [the ledger](presentation-ledger.md#confirmation).

**Status:** PASS.

### 6. The collapsed summary identifies the work

The transcript's collapsed line reads agent, label, verb with duration, and
cost when non-zero; it carries no id and no character count. The expanded text
carries both ids.

**Evidence.** `presentation/renderers.test.ts`: `S-1: a collapsed notice names
the agent, the task, the outcome, and the cost` asserts `reviewer · audit auth
redirects · completed in 41.2s · $0.042` plus the hint; `S-2: a failed and a
cancelled summary read the same way, with the verb changed` asserts both with
the cost omitted; `a collapsed notice carries no id and no character count`
asserts the absences directly; `the whole collapsed line is fitted to its
width, and the label is what gives` asserts at five widths that the line never
exceeds the width and never contains a newline while the agent, outcome, cost
and hint all survive; `a line too narrow for any label drops the label whole,
not into a gap`; `a label is capped even when the line has room to spare`.
`host/notification-message.test.ts`: `S-1: the ids are in the expanded text,
where a tool call needs them` asserts the collapsed line has neither id and
the expanded text has both. Rows S-1 and S-2 are confirmed in the ledger.

**Status:** PASS.

### 7. The operator namespace is `/subagent`

Bare `/subagent` prints the shallow status; `/subagent profiles` is the
Profile list; `/subagent diagnostics` is the counters and probes; `/agents`
still works and produces the same list. The compatibility matrix's `/agents`
row says when the alias goes.

**Evidence.** `host/diagnostics-command.test.ts`: `C-1: bare /subagent prints
the shallow status and no counters` — which asserts every runtime counter's
name is *absent* — `C-1: the status names every Profile with the backend it
names`, `C-1: the status counts Runs in the shared phase vocabulary`, `a
Session with no Profiles still says where to put one`, `a Session with no
runtime says so and still says where to put a Profile`, `health is a verdict
on what was noticed and a count of what is held`, `C-2: /subagent profiles
opens the same flow /agents opens`, `an unknown subcommand names the two that
exist`, and `the report names every runtime counter and every probe field`
against `/subagent diagnostics`. `host/agents-command.test.ts` passes
unmodified, including `the agents command registers itself once, with a
description`. The matrix's `/agents` section records the alias and says it goes
in the first minor after 2.0.

**Two notes on the item as written.** The status reports the probe as a
*count* rather than judging it: a live Session holds a fiber per Run and a
repository subscription for its widget on purpose, and the probe only has to
read zero once the Session Scope has closed, which is a leak test's assertion
and not something an operator can check from inside a running Session. And
`DIAGNOSTICS_COMMAND_NAME` was renamed `SUBAGENT_COMMAND_NAME`, because the
command is now a namespace root; the file keeps its name, since this document
and the roadmap both cite it.

**Status:** PASS.

### 8. Notification text depends on `RunNotification` alone, and it is fenced

A boundary rule forbids `presentation/notification-text.ts` from importing
anything outside `domain/` and `presentation/`. Negative fixture present.

**Evidence.** Boundary rule 20, with `the notification formatter naming
anything but the domain and presentation is rejected` — a fixture in which the
formatter imports a runtime module *and* a Pi package, and both are rejected,
the second because this rule is narrower than the presentation rule above it.
The real tree holds it: `the real tree holds every rule`.

**Status:** PASS.

### 9. Every ledger row is confirmed

Each row of [the presentation ledger](presentation-ledger.md) names the golden
that now asserts its after column. No row is left "not yet" except W-2, which
is Phase C's.

**Evidence.** [The confirmation
table](presentation-ledger.md#confirmation) names a golden and a file for
N-1 … N-9, S-1, S-2, C-1, C-2, T-1, and W-1. W-2 is Phase C.

**Two rows landed differently from their drafted after column, both because
of fixture values rather than code**, and the ledger says which:

- The draft assumed the presentation fixtures would gain a description of
  `look at the thing`; they already had `look around`, and a Run that settles
  12,400 ms after it starts. The after columns use the fixtures' own values,
  because changing the fixture would have moved every widget and card golden
  for no gain. The spec's Further Notes anticipated exactly this.
- The draft sketched `cancelled in 60s`; the shared duration formatter
  switches to minutes at exactly sixty seconds, so it reads `1m 0s`. The
  notice uses the shared formatter rather than a second one, which was the
  decision; the sketch was written without checking it.

**And four places where the semantics document contradicted itself or the
host API, each resolved and each corrected in the document rather than
silently worked around.** A row that lands differently from its after column
is a defect in one or the other, and the gate says which; here the defect was
in the decided text three times out of four.

1. **The accounting line's order.** Its worked examples illustrated the line
   turns-first —
   `3 turns · 12.3k in / 4.5k out · $0.0421` — while its own sentence says
   the order and grammar are the *existing* `formatNotificationAccounting`,
   which is cost-first, and user story 9 asks for the line unchanged so a
   habit learned on the release candidate still holds. Unchanged wins; the
   illustrations were the defect.
2. **The header's verb.** §5 said the verb comes "from the existing
   `runPhaseVerb` dictionary". It cannot: `runPhaseVerb` answers `cancelled`,
   because it labels a widget column, and a sentence needs `was cancelled`
   since a Run does not cancel itself. `presentation/status.ts` gained a
   second dictionary keyed by the terminal phases alone. This is a concept the
   decided document did not name, which is why it is recorded here.
3. **"Truncated to the terminal width".** There is no terminal width to
   truncate to — Pi's `MessageRenderOptions` carries the expansion state and
   the output padding and nothing else. The collapsed line is fitted to
   `NOTICE_SUMMARY_WIDTH`, eighty columns, a convention rather than a
   measurement, and it is a parameter so that the day Pi hands a renderer a
   width there is one call site to change. What the criterion actually asked
   for — the line never wraps and the label is what gives — is delivered and
   asserted at five widths, plus the give-way case where the label goes whole
   rather than leaving `· ·` behind. **The deviation is that the width is a
   default and not the terminal's**, and it is a limit of the host API rather
   than a choice.
4. **§6's collapsed-line examples** read `completed in 41s` and `cancelled in
   60s`; the shared `formatDuration` produces `41.2s` and `1m 0s`. Corrected
   in the document, since a second formatter for one line would be a second
   answer to the same question.

**Status:** PASS.

### 10. The compatibility matrix cites this phase

The Notification, widget, and `/agents` rows cite
[notification-semantics.md](notification-semantics.md) for every cell Phase A
changed, and the proof tables name the new goldens.

**Evidence.** In `docs/v2/compatibility-matrix.md`: the Completion
Notification section's preamble cites the semantics document and ADR-0033, and
every cell the phase changed is marked **[Phase A]** and cites the section
that decided it — expected outcome, completed, failed, cancelled, the pointer,
the Run label, accounting, the collapsed line, and the delivery states. Its
proof table gained eight rows naming the goldens from tickets 03, 04, 05, and
06. The widget section says it is unchanged by Phase A and points at
semantics §6 for the state Phase C adds; its settled-duration cell records
that the notice now reads the same figure, and its proof row names the golden.
The `/agents` section records the alias, cites semantics §8, states the
removal version, and names the goldens for both entry points.

**Status:** PASS.

### 11. The change-surface baseline is measured

[change-surface.md](change-surface.md) has a Phase A row with all six cells
filled from real diffs or, for R5 and R6, from a written module list, and the
estimated column is marked superseded.

**Measured.** R1 `0 / 2`, R2 `0 / 3`, R3 `0 / 3`, R4 `0 / 1`, R5 `0 / 8–12`,
R6 `9 / 14`, against a tree of 103 production modules of which 23 are generic
lifecycle. R1 and R2 are counted from tickets 03 and 04; R3 and R4 from a
throwaway branch off `1991b68`, since deleted; R5 and R6 from written module
lists checked against the recipes. The method section records the base commit
(`124fd50`) and the commands, so the Phase B gate can repeat it. The estimated
baseline is marked superseded and kept.

**Findings**, recorded rather than softened:

1. **R3 exceeds its target by one module** (`0 / 3` against `0 / ≤ 2`). A
   backend-owned Profile option needs a hook in `backend/profile-fields.ts`,
   because that module owns the one `try` per field that turns a bad value into
   a Profile diagnostic rather than an exception inside the adapter. The
   option's vocabulary still never leaves `backend/claude/`. The reading is
   that the target was one too low; the Phase B gate either raises it to three
   or records this again.
2. **The table has no row for "add a bound enforced at admission", and it is
   more expensive than any row it has.** Phase A's own label bound touched five
   modules, two of them generic. Every future bound on caller-supplied input
   will cost the same. The Phase B gate should add it as R7 with a target,
   using Phase A's decomposition as the baseline.
3. **Two estimates were wrong, both in the safe direction.** R2's estimate
   claimed one generic module and there are none; R4's claimed two total and
   there is one. Neither changed a verdict.

**Status:** PASS, with three findings carried to the Phase B gate.

### 12. The architecture note has its map, and the recipes exist

[architecture.md](../architecture.md) opens with the compact block diagram and
its writes/reads/host-only legend. [change-recipes.md](change-recipes.md) has
a recipe for each representative change. contributing.md carries the freeze
rule.

**Evidence.** `docs/architecture.md` has a `## The map` section above section
1, with the block diagram and a three-part legend: who writes, who reads, and
what only the host knows. `change-recipes.md` has a recipe for each of R1–R6
plus four more, every file name in it exists in the tree, and the recipes
Phase A changed are updated — including a new one for adding or changing an
operator command. `contributing.md` has `## The simplification rule` above the
boundary rules, linking [the freeze](freeze.md). Every relative link and
anchor in `docs/v2-simplify/` resolves, and `npm run lint` is clean.

**Status:** PASS.

### 13. ADR-0033 is accepted

An ADR records the delivery-state vocabulary, the decision that every terminal
notice carries a pointer with availability, and the Run label bound.

**Evidence.**
[`docs/adr/0033-notification-vocabulary-pointer-and-label-bound.md`](../adr/0033-notification-vocabulary-pointer-and-label-bound.md),
status Accepted, with the three decisions, seven rejected alternatives
including the two that matter most — a comment instead of a boundary rule, and
refusing a start over its description length — the architecture challenge
gate's three questions answered, and a proof table. It is cited from
`CONTEXT.md`'s delivery-state block, [the freeze](freeze.md) rows F4 and F10,
[the semantics document](notification-semantics.md), and the compatibility
matrix's Notification section, which is how ADRs are indexed in this tree.

**Status:** PASS.

### 14. The live gates are re-run on this build

Model-facing text changed and the host smoke lanes assert on it. All six
(`pi:smoke`, `pi:host-smoke`, `claude:smoke`, `claude:host-smoke`,
`codex:smoke`, `codex:host-smoke`) are run on the commit that closes this
gate and their pass markers recorded here.

**Results**, all run on the phase's production code:

| Lane | Marker | Notes |
| --- | --- | --- |
| `pi:smoke` | `PI_LIVE_SMOKE_FAIL` | Five failures, **all pre-existing**: the same five names fail on `124fd50`, the commit before the phase. See below. |
| `pi:host-smoke` | `PI_HOST_LIVE_SMOKE_PASS` | |
| `claude:smoke` | `CLAUDE_LIVE_SMOKE_PASS` | Every check, including `every settled Run produced exactly one notification` (five Runs) and `no notification carries a provider identity`. |
| `claude:host-smoke` | `CLAUDE_HOST_LIVE_SMOKE_PASS` | |
| `codex:smoke` | `CODEX_LIVE_SMOKE_FAIL` | Eight failures, **all pre-existing**: the same eight names fail on `124fd50`. See below. |
| `codex:host-smoke` | `CODEX_HOST_LIVE_SMOKE_PASS` | |

**The two failing lanes, recorded rather than re-run into silence.**

`pi:smoke` fails `start returns the answer`, `resume runs on the retained
conversation`, `a resumed Run is charged only for its own work`, `steering
reaches the answer`, and `a Run past its default timeout is cancelled with
reason timeout`. Every one of them is about what the live Pi model *said* or
about the default timeout, and the identical five fail on `124fd50`.

`codex:smoke` fails `start settles completed`, `start returns the answer`,
`resume answers from the first Turn's retained root`, `a resumed Run is
charged only for its own work`, `steering reaches the answer`, `an interrupted
Turn leaves the process, the root, and the Subagent alive`, and two
stored-thread inspections that report their own precondition unmet — *no
stored thread was available for the positive control* and *not inspected*. The
identical eight fail on `124fd50`.

**What passes in both failing lanes is what this phase changed.** Both report
`every settled Run produced exactly one notification`, naming every Run id,
and `no notification carries a provider identity` — on the new notice text,
with the new payload, and with `backendId` no longer on the notice at all.
Both report every runtime and adapter probe clear after closure.

**A correction to this item as written.** It says the six lanes must be re-run
because "the host smoke lanes assert on notice text". They do not:
`scripts/pi-host-live-smoke.mjs` asserts a clean exit, that `agent_start` and
`agent_result` were called, and that the subagent's answer marker reached the
transcript. Re-running all six was still right — they drive the real text path
end to end, and the runtime lanes do count notifications — but the reason
recorded here is the accurate one.

**Status:** CARRIED. The two failures are pre-existing and attributable to the
live environment and the provider, not to Phase A; they belong to the release
items the v2 roadmap left open, where the live gates on the cutover build are
already tracked.

### 15. No runtime behaviour changed

The diff of Phase A touches `runtime/delivery.ts` for the rename only, and
touches no other file under `runtime/` and nothing under `backend/`. Every
runtime test passes unmodified apart from the rename.

**Evidence.** `git diff --name-only 124fd50..HEAD` under
`extensions/subagent/runtime/` and `extensions/subagent/backend/` returns four
files and no backend file at all:

| File | Why |
| --- | --- |
| `runtime/delivery.ts` | the rename and the fence's vocabulary, +43/−19, no behaviour |
| `runtime/supervisor.ts` | the label's admission path, +41/−2 |
| `runtime/delivery.test.ts` | the rename and two comments |
| `runtime/bounds.test.ts` | the new label lane |

**Nothing under `backend/`.** No adapter changed.

The supervisor's whole diff is: an `AdmissionDiagnostics` type, an optional
`diagnostics` field on `StartRequest` and `ResumeRequest`, a defaulted
parameter on `forkRun`, a loop emitting those diagnostics through the Run's
own intake in the `onStarted` callback, and the two call sites passing the
field. No lifecycle branch, no new state, no change to admission order.

**Deviation from the item as written.** The item says only
`runtime/delivery.ts` changes under `runtime/`. Ticket 02's own acceptance
criterion is the narrower and correct one — "nothing under the runtime
directory other than what the label's admission path requires" — and the
supervisor is what that path requires: the diagnostic recording a shortened
label has to reach the Run's projection, and the observation intake is where
every diagnostic already does. A second channel would have been worse.

**Every runtime test passes unmodified** apart from the rename in
`delivery.test.ts` and the three new tests in `bounds.test.ts`. The two
conformance scenarios that are the proof no lifecycle behaviour moved —
`a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` — pass for all
five rigs, unmodified.

**Status:** PASS.

## Verdict

**The gate is closed**, with one item carried and three findings recorded.

| Item | Status |
| --- | --- |
| The deterministic gate | PASS |
| 1. Delivery does not say "landed" | PASS |
| 2. The Run label is bounded and recorded | PASS |
| 3. Every terminal notice points at `agent_result` | PASS |
| 4. The notice carries the label, duration, and accounting, not the backend | PASS |
| 5. The preview is labelled and quoted | PASS |
| 6. The collapsed summary identifies the work | PASS |
| 7. The operator namespace is `/subagent` | PASS |
| 8. Notification text is fenced to `RunNotification` | PASS |
| 9. Every ledger row is confirmed | PASS |
| 10. The compatibility matrix cites this phase | PASS |
| 11. The change-surface baseline is measured | PASS, three findings |
| 12. The map, the recipes, and the rule | PASS |
| 13. ADR-0033 is accepted | PASS |
| 14. The live gates are re-run | **CARRIED** |
| 15. No runtime behaviour changed | PASS |

**What closes it.** Every model-facing sentence and every human-facing line
this phase decided is asserted by a named golden, and every ledger row names
the golden. Two boundary rules turned two prose rules into failing tests, each
with a fixture that violates it on purpose. The label bound joined the bounds
lane. Nothing under `backend/` moved, and under `runtime/` only the delivery
module and the label's admission path did.

**What is carried.** Item 14. Two of the six live lanes fail, with identical
failure sets on the commit before the phase, so the failures are the live
environment's and the providers' rather than this phase's. What they assert
about notifications passes in both. This belongs with the release items the v2
roadmap left open, where live gates on the cutover build are already tracked;
it is not a reason to hold this phase.

**What the next gate inherits.** The three change-surface findings under item
11: R3's target is one too low, the table has no row for a bound enforced at
admission and that is the more expensive change, and two of the estimates were
wrong in the safe direction. Phase B should settle all three before measuring
again.

**Two corrections to this document's own text**, both recorded above rather
than quietly fixed: item 14's premise that the host smoke lanes assert on
notice text is wrong — they assert a clean exit, the two tool calls, and the
answer marker — and item 15's claim that only `runtime/delivery.ts` may change
is narrower than ticket 02's own criterion, which admits the label's admission
path. The items were written before the work, which is what made both visible.
