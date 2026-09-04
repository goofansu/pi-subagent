# Phase C exit gate — the completion hand-off, and resource lifetime polish

**Status: closed, with one item outstanding and named.** Rewritten 2026-09-04
at the Phase B close, when [the roadmap](roadmap.md) redefined C3 around the
hand-off and added the Phase A follow-up (A6–A8), which this gate verifies as
well; verified item by item at the Phase C close. Fourteen of the fifteen items
read PASS. **Item 14, the six credentialed live lanes, has not been run** —
they need real provider credentials and real processes, which the closing
environment does not have — and the item records exactly what is owed and why
it matters.
**Verified against:** [the roadmap](roadmap.md), Phase A follow-up and Phase
C; [the notification semantics](notification-semantics.md) §1 *Consumption*,
§3, §5, §6 and §7; [the presentation ledger](presentation-ledger.md) rows
N-10, W-2, W-3, C-3; [the freeze](freeze.md), rows F4, F6 and F10;
[ADR-0035](../adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md).

## The deterministic gate

```
npm run check   →  exit 0
```

**Status:** PASS. Typecheck, lint, 1,281 tests, the shared conformance suite on
all five rigs, and the pinned Codex protocol check, all green on the closing
commit.

## The items

### 1. The health line judges by class (A6)

`runtime/counters.ts` classifies every `SupervisorCounter` as `defect`,
`incident`, or `expected`, exhaustively by type. Bare `/subagent` reads
`Runtime: healthy · N held` for a Session whose only non-zero counters are
expected ones, and `Runtime: attention needed · …` naming the non-zero classes
otherwise. A counter name the host does not recognise counts as actionable.

**Evidence to name:** `host/diagnostics-command.test.ts` — `C-3: a Session
whose only raised counters are expected ones is healthy`, `C-3: the health line
names the non-zero classes, worst first`, `C-3: a counter the host does not
recognise is named rather than ignored`, and the updated `health is a verdict
on what was noticed and a count of what is held`; `runtime/counters.test.ts` —
`every counter a Session reports has a class, and the record invents none`,
which holds `COUNTER_CLASSES` and the zero block to one set of names, on top of
the type-level exhaustiveness the `Record<SupervisorCounter, CounterClass>`
already gives.

**Status:** PASS.

### 2. The debugging guide describes two commands (A7)

`docs/debugging.md` has one section for `/subagent` (the shallow status and
the health line, with the three classes named) and one for
`/subagent diagnostics` (the full report). Its counter tables are regrouped
to the three classes and name them; `duplicateSettlements` and `lateEndings`
sit under *expected*.

**Evidence to name:** `docs/debugging.md`, sections `/subagent` (with *The
health line*) and `/subagent diagnostics` (with *The hand-off block*, added by
item 9), and *The counters*, whose three tables are titled `defect`,
`incident` and `expected` and name `runtime/counters.ts` as their source. Every
counter in `COUNTER_CLASSES` appears in exactly one table, and
`runtime/counters.test.ts`'s `the three classes are the ones the debugging
guide names` fails if a fourth class is added without a section here.

**Status:** PASS.

### 3. Availability says what a model will find (A8)

`ResultAvailability` is `complete` / `partial` / `record-only`, derived as
semantics §3 says. The three pointer sentences are semantics §5's. A completed
Run with no output has no body and the record-only pointer. Ledger row N-10 is
confirmed with its goldens, and rows N-1, N-2, N-4, N-5, N-7 still pass
reading their pointer through it.

**Evidence to name:** `presentation/notification-text.test.ts` — `N-10: the
pointer says what a model will find, in each of the three availabilities`,
`N-10: availability is read off the output, not off the status alone`, and
`N-2: a completed Run with no output has no body, and its record is available`,
which asserts the sentence appears exactly once; rows N-1, N-4, N-5, N-7 and
the three-backend N-8 all pass reading their pointer through it.
`git diff --stat` shows nothing under `extensions/subagent/runtime/` for the
A8 commit, which is what item 15's R1 reading depends on. **The host smoke
lanes assert on this text and have not been run — see item 14.**

**Status:** PASS on the deterministic gate; unverified against a live provider.

### 4. Admission capacity is returned by scope closing (C1)

The Run fiber acquires its admission lease with `Effect.acquireRelease` and
the release is a finalizer of the Run Scope. No procedural release call
remains in the supervisor. `detachRun` still runs before the lease releases.
The stress lane's zero probe still holds after hundreds of cycles including
rejected and failed starts.

**How the two paths are covered.** The acquire stays in `start` and `resume`
rather than moving into the Run fiber, because the fiber has to be attached to
its record *before* the outcome is reported and a fiber cannot hand itself its
own handle without two more `Deferred`s — machinery boundary rule 21 exists to
keep out. Instead the admitted span runs under its own Scope and expresses a
post-admission rejection as a **failure**, so `admission.admit` releases on the
way out; the Run fiber's Scope holds the lease from the fork on, with
`detachRun` registered *after* the lease so last-in-first-out runs it first.

**Both operations, not one.** `resume` was converted alongside `start` at the
phase's code review, and the reason is worth recording because it is not a
leak. Resume's single post-admission rejection is a refused reservation, and
`lease.reserveResult` already releases the whole lease on that path — so the
old code was correct. It was correct *by a fact a reader had to go and check*,
and two independent reviewers of this phase read the asymmetry as a leak. The
next rejection added between the acquire and the fork would not have been
compensated at all. Both operations now admit the same way, so neither is the
one somebody has to remember, and `grep 'admission.acquire(' runtime/supervisor.ts`
finds nothing.

**The challenge gate's three answers** (contributing rules; C1 changes a
decision in generic runtime code):

1. **What does this delete?** Two procedural `lease.release()` call sites and
   the reasoning that went with them — the Run fiber's exit call and `start`'s
   compensating call on a failed open — plus the unwritten rule that a reader
   of `resume` must know `reserveResult` compensates. What replaces them is not
   an abstraction: `Effect.acquireRelease` is already in the tree, and the
   lease's shape was decided in ADR-0034 precisely so this would be small.
2. **Is it provider-neutral?** Yes, structurally: admission names no backend
   and reads nothing a provider reports. The shared conformance suite passes on
   all five rigs, and the fakes exercise both the admitted and the refused
   paths.
3. **What breaks if it is wrong?** Capacity is never returned, and the Session
   refuses every later start with `at capacity` — permanently, because nothing
   else frees a slot. That is why the detectors are named below rather than
   left to review, and why `detachRun`-before-release has its own test.

**Evidence to name:** `runtime/admission.test.ts` (the refusal paths, including
a reservation refused after capacity was claimed); `runtime/supervisor.test.ts`
(the concurrent-close test the Phase B review added, unmodified);
`runtime/stress.test.ts` (the zero probe after hundreds of cycles including
rejected and failed starts).

**Status:** PASS.

### 5. The acquire/release audit is recorded (C2)

For each remaining pair — subscription start/unsubscribe, delivery
claim/recovery sweep, the three store pins — this gate records whether it was
converted to a scoped resource and, if not, why the release has more than one
correct moment. The three named pins are recorded as deliberately unconverted
(freeze F6).

| Pair | Converted? | Why or why not |
| --- | --- | --- |
| admission claim/release | yes, both operations (item 4) | Two Scopes, and each has exactly one correct moment: the admitted span's Scope returns the lease when it closes on a rejection, and the Run fiber's Scope returns it when the Run is over. `start` and `resume` were both converted; no `release()` call and no `admission.acquire(` remains in `runtime/supervisor.ts`. |
| subscription start/unsubscribe | yes, already | `RunRepository.subscribe` is an `Effect.acquireRelease` around the `repositorySubscriptions` probe (`runtime/repository.ts`), and its consumer — the widget — registers its own unsubscribe as a Session-Scope finalizer. Recorded rather than changed. |
| delivery claim/recovery sweep | no | **Not a pair.** The claim is taken once per Run and kept whatever the push did; the sweep is a *retry over stored ids*, not the claim's release, and it has no single moment that is the claim's end. Converting it would mean inventing a release moment in order to have one. |
| store pin `publication` | no | F6 |
| store pin `waiters` | no | F6 |
| store pin `delivery` | no | F6 |

The three named pins are deliberately unconverted, and the freeze says why: a
pin's release has more than one correct moment — the holder decides, and
delivery's is a hand-off rather than a Scope closing — so a Scope would have to
pick one and be wrong for the others.

**Status:** PASS. Every row has a verdict and a reason.

### 6. The hand-off resolves on landing or consumption (C3)

The sink records `consumed` when the `agent_result` tool handler reports a
returned Result. A push for a consumed Run is accepted and not sent; a
consumed notice lost after hand-off is not re-pushed at settle; a consumed
notice Pi already holds lands, is marked landed, and increments
`consumedBeforeLanding`. `agent_wait` consumes nothing. `runtime/delivery.ts`
does not contain the word *consumed*; the boundary rule that fences *landed*
covers it.

**Evidence to name:** `host/push-sink.test.ts` — `a push for a consumed Run is
accepted and nothing is sent`, `a consumed notice lost to an interrupt is not
pushed again`, `a consumed notice Pi already holds lands anyway, and is
counted`, `consuming a Run whose notice already landed changes nothing`;
`host/tools.test.ts` — `agent_result tells the host the parent has the Result,
and nothing else does`, `a rejected agent_result tells the host nothing`, `a
Result the store evicted tells the host nothing either`; `boundaries.test.ts` —
`the delivery module saying "consumed" is rejected, and the push sink saying it
is not`, with `delivery may cite the ADR whose filename carries both banned
words` as the one narrow exemption.

**Status:** PASS.

### 7. The widget sees three hand-off states and nothing finer (C3)

The widget's dependency is a read model with `status(runId)` returning
`pending`, `resolved`, or `exhausted`, and a `subscribe`. `resolved` is landed
or consumed and the widget cannot tell which. A settled row leaves on
retrieval with no landing (ledger W-3). The sink keeps handed-off, lost,
attempt counts, and the consumed set internally.

**Evidence to name:** `host/widget.test.ts` — `W-3: a settled row leaves when
the parent retrieves its Result, with no landing` and `the widget lists Runs
that are not terminal and terminal ones whose hand-off is unresolved`; the
dependency type `CompletionHandoffView` in `host/widget.ts`, which has exactly
`status` and `subscribe`, and `HandoffStatus`, declared with the asker rather
than the answerer because rule 18 forbids the widget to name the sink.

**Status:** PASS.

### 8. An exhausted notice is visible (C3)

Delivery tells the sink when its retry budget runs out, through one call on
`NotificationSink`. A settled Run whose delivery exhausted shows a row reading
`completed · notification failed` with its Run id and `result available`;
retrieving that Result resolves it. Ledger row W-2 is confirmed with the golden
that asserts it.

**One conflict in the source documents, resolved and recorded.** Ledger row
W-2's after column reads `completed · notification failed`, and the spec's
widget paragraph says "the row's duration and settled text are unchanged
(W-1)". Both cannot hold on the exhausted row, because W-2's text occupies the
status position — which is exactly where a settled row prints
`completed in 12.4s`. **The ledger won**, on its own rule: "the after column
is the specification", and W-1's sentence is read as covering every other
settled row, which is the only reading under which both statements are true.
The duration gives way and the explanation stays, because a row that will never
leave on its own is being read for the reason it is stuck. The ledger's W-2
entry carries the reasoning, and a golden asserts that no other settled row
moved.

**One generalisation, deliberate.** The row uses the Run's own verb rather than
the literal `completed` W-2 names, so an exhausted *failed* Run reads
`failed · notification failed`. Hard-coding `completed` would have printed a
false status for every non-completed Run whose delivery exhausted. A golden
asserts it.

**Evidence to name:** `presentation/rows.test.ts` — the four `W-2:` goldens;
`runtime/delivery.test.ts` — `a sink that always fails exhausts its budget,
releases the pin, and leaves the result` now also asserts the sink was told,
and the successful-retry test asserts it was not.

**Status:** PASS.

### 9. Diagnostics distinguish the hand-off outcomes (C3)

`/subagent diagnostics` reports a hand-off block from the sink: pushes
attempted, hand-offs accepted, hand-offs refused, notices lost after hand-off,
re-pushes, landings, exhaustions, consumed before landing. Every field is
printed, zeroes included. After a Session closes every one still reads, and the
probes read zero.

**Evidence to name:** `host/diagnostics-command.test.ts` — `the report names
every runtime counter, every probe field, and every hand-off outcome`, `the
hand-off block sits between the runtime's numbers and the adapters'`, `a live
Session's hand-off block is the sink's, and it survives the Session`, and
`bare /subagent does not print the hand-off block; it is the deep end's`.

**One reading recorded.** "After a Session closes every one still reads" is
about the *sink*: `unbind` clears the four sets and deliberately not the
counts, so what the Session that just ended did stays readable. The command
itself still answers `No subagent Session is running.` between Sessions, which
is an answer rather than an error and is unchanged.

**Status:** PASS.

### 10. One completion view for terminal presentation (C4)

A presentation-only type carrying Run id, Subagent id, agent, label, status,
and duration is derived from `RunSnapshot`, `RunResult`, and
`RunNotification` by one function each, and the widget's settled row, the
result card, and the notice header all print their status and duration through
it. The settled-duration goldens still pass.

**Evidence to name:** `presentation/completion-view.test.ts` — `one Run derived
from the snapshot, the Result and the notice is one value`, `the three agree
for a failed and for a cancelled Run too`, `a Run that has not settled has no
completion to describe`, `the duration is the Run's, not the draw's`; every N,
S and W golden passes unmodified, and `presentation/completion-view.ts` names
only the domain and `./views.ts`, so the presentation boundary rules hold.

**Status:** PASS.

### 11. The bounds lane covers the exhausted projection

`runtime/bounds.test.ts` or `host/push-sink.test.ts` drives delivery past its
retry budget and asserts the projection reads `exhausted` and the Result is
untouched.

Covered in both halves, at the seam each half belongs to.
`runtime/delivery.test.ts` — `a sink that always fails exhausts its budget,
releases the pin, and leaves the result` — drives the real retry budget on a
test clock and asserts three things together: delivery's own projection lists
the Run as exhausted, the sink was told exactly once, and the stored Result is
still readable with its output intact. Its sibling, `a push that fails once is
retried and the result is announced from the store`, asserts the sink was
*not* told, which is the other half of "exactly when the budget is spent".
`host/push-sink.test.ts` — `a Run delivery gave up on reads exhausted, and
consuming it resolves it` — covers the sink's own projection and the way out
of it.

**Status:** PASS.

### 12. Race and stress lanes pass unchanged

`runtime/races.test.ts` and `runtime/stress.test.ts` have an empty diff for
the phase.

```sh
git diff --stat 0b90460..HEAD -- \
  extensions/subagent/runtime/races.test.ts \
  extensions/subagent/runtime/stress.test.ts
# no output
```

The conformance suite is likewise untouched: `testing/conformance.ts` has an
empty diff, and its two notification scenarios —
`a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` — pass on all five
rigs.

**Status:** PASS.

### 13. ADR-0035 is accepted, and the contracts say landing or retrieval

ADR-0035 was proposed before the first C3 commit and is accepted in the
closing commit. The compatibility matrix's widget **Row lifetime** cell reads
"until its completion notice reaches the conversation or its Result is
retrieved with `agent_result`, whichever comes first" and cites semantics §6.
The debugging guide's "widget shows nothing" symptom says the same. The
ledger's confirmation table names a golden for N-10, W-2, W-3 and C-3.

All four hold. ADR-0035 was proposed in `723e9c7`, before any C3 code, and is
accepted in this closing commit with the criterion shown met; ADR-0033 carries
a status note pointing at it and its own text is untouched. The matrix's
**Row lifetime** cell reads "until its completion notice reaches the
conversation **or** its Result is retrieved with `agent_result`, whichever
comes first" and cites semantics §6, and the widget section's note that the
exhausted row "is not this table's yet" is replaced by the fact. The debugging
guide's *The widget shows nothing* symptom says landing or retrieval, and says
what a `notification failed` row means and how to clear it. The ledger's
confirmation table names goldens for N-10, W-2, W-3 and C-3, and its status
line no longer excepts W-2.

**Status:** PASS.

### 14. The live gates are re-run

Model-facing text changed (A8) and lifecycle mechanics moved (C1). All six
lanes (`pi:smoke`, `pi:host-smoke`, `claude:smoke`, `claude:host-smoke`,
`codex:smoke`, `codex:host-smoke`) are run on the closing commit and their
pass markers recorded here.

**Not run.** The six lanes are credentialed: each drives a real provider — a
Pi session, a Claude Query, a `codex app-server` process — and the environment
this phase closed in has no provider credentials and no way to obtain them.
They are outside `npm run check` for exactly that reason, and no substitute was
invented for them.

**What is owed, and what would catch what.** Two things changed that only these
lanes see end to end:

- **A8's text.** The host smoke lanes assert on the pointer sentence a real
  model reads. `scripts/pi-host-live-smoke.mjs` and its Claude and Codex
  siblings will fail on `Full result is available.` if any of them still
  carries the old sentence, which is the check the deterministic gate cannot
  make because it asserts against the same constants the code uses.
- **C1's scoped lease.** The runtime lanes read every probe after the Session
  Scope has closed, over a real adapter. The stress lane already reads zero
  after hundreds of cycles with the fakes; what the live lanes add is a
  provider whose own finalizers take real time.

```sh
npm run pi:smoke        npm run pi:host-smoke
npm run claude:smoke    npm run claude:host-smoke
npm run codex:smoke     npm run codex:host-smoke
```

**Status:** OPEN. Record the six pass markers here before the phase is
announced as closed to anyone relying on the live surfaces.

### 15. The change-surface table is re-measured

The Phase C row of [`change-surface.md`](change-surface.md) is measured on the
closing tree. R4 (display-only widget column) must still read zero generic
modules; R1 must still read zero, because A8 changed wording and touched
nothing under `runtime/`.

Measured on the closing tree: **R1 0 / 1, R2 0 / 2, R4 0 / 1**, each from a
throwaway edit and a `git diff --name-only`. R3, R5, R6 and R7 are carried
forward with the reason stated rather than assumed: the phase's diff touches no
module in any of their lists.

R4 is the reading the gate watched hardest, because C3 gave the row something
new to say and it could have been paid for with a snapshot field — which would
have been `domain/projection.ts` and `domain/reduce-run.ts`, two generic
modules, and a failed gate. It was not: `handoff` is presentation-only, set by
the widget from a host fact it already reads, and the snapshot is untouched
(freeze F9).

The tree holds **107 production modules, 26 of them generic** — one more module
than at the Phase B gate, `presentation/completion-view.ts`, and not a generic
one. C3's whole hand-off is in `host/`; its one runtime change is a method on
an interface `runtime/delivery.ts` already owned.

**Status:** PASS.

## Verdict

**Closed, with item 14 outstanding.**

Fourteen of the fifteen items read PASS on the closing commit, and
`npm run check` exits 0. What the phase set out to do, it did:

- A completion hand-off now has two ways to finish. A parent that retrieves a
  Result has done what the notice existed to make it do, so the widget row goes
  at once and an aborted turn does not re-push a notice about work the parent
  has finished with. `agent_wait` resolves nothing, deliberately.
- A settled row that will never leave on its own says why, and the widget pays
  for that with one read model rather than with a third, fourth and fifth
  predicate on its boundary.
- The health line stopped calling a healthy Session broken, and the taxonomy
  that decides it is in code, exhaustive by type, with the guide grouped to
  match.
- A completed Run with nothing to show no longer promises a full result.
- Capacity is returned by a Scope closing rather than by a call somebody has to
  remember, and the ordering the Phase B review restored is now a consequence
  of finalizer order rather than of a comment asking for it.
- Terminal status and duration are derived once and read three ways, so a row
  and a card cannot print two durations for one Run again.

**What is outstanding.** The six credentialed live lanes (item 14) were not
run: this environment has no provider credentials. Two changes in this phase
are of the kind those lanes exist to catch — A8's model-facing sentences, which
the host lanes assert on, and C1's scoped lease, which the runtime lanes see
over a real adapter with real finalizers. **The phase should not be announced
as closed to anyone relying on the live surfaces until those six markers are
recorded in item 14.** Everything a deterministic gate can check has been
checked.
