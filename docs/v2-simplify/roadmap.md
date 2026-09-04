# Simplification roadmap: fewer concepts, better completion notices

**Status: Phases A, B and C closed, and the Phase A follow-up with them; D
proposed.**
[The Phase A gate](phase-a-exit-gate.md) is closed, with item 14 carried and
three change-surface findings that
[the Phase B gate](phase-b-exit-gate.md) settled; the Phase B gate is closed,
with all thirteen items PASS;
[the Phase C gate](phase-c-exit-gate.md) is closed with fourteen of fifteen
items PASS and item 14 — the six credentialed live lanes — outstanding and
named, because the closing environment had no provider credentials. That is
the same item Phase A carried, and it is the one thing owed before the phase
is announced to anyone relying on the live surfaces. This is the plan that
follows
[the v2 roadmap](../v2/roadmap.md), which delivered the rewrite and is now
history. It answers the one definition-of-done clause the rewrite did not meet
(less lifecycle machinery than v1, per [the deletion ledger](../v2/deletion-ledger.md))
and acts on the completion-notification findings of the post-M7 architecture
review.

**Revised 2026-09-04, after the Phase B close.** The architecture re-review of
the two closed phases found two things Phase A left wrong — the bare
`/subagent` health verdict treats every counter as a symptom, and a completed
Run with no output announces a "full" result — and proposed a model in which
a completion notice is a *hand-off* that either landing **or** the parent's
own `agent_result` call resolves. Checking that proposal against Pi's queue
API changed its shape: a follow-up Pi has already queued cannot be withdrawn
by an extension, so the part of the proposal that suppresses a queued notice
is a host hold-buffer and belongs with Phase D's envelope, while the part that
resolves the widget row and stops re-pushes is Phase C's. [The Phase A
follow-up](#phase-a-follow-up--a6-a7-a8) and [Phase C](#phase-c--the-completion-hand-off-and-resource-lifetime-polish)
below are rewritten accordingly; Phase D's two delivery items are merged into
one; nothing in Phases A and B is reopened. **What follows Phase C is not
Phase D**: it is [the 2.0 close](../v2/release-close.md) — the soak, the
coexistence record, the release, and the reading of Phase D's decision rules
against the soak's numbers.

**Strategy:** a controlled simplification programme inside the shipped
architecture, not a second rewrite.
**Delivery model:** four phases, each gated, each leaving `npm run check`
green and every invariant in [contributing.md](../contributing.md) intact.

## The documents in this directory

This roadmap is the plan. The rest of the directory is what the plan decides
up front, and what each phase leaves behind when it closes.

| Document | What it is | When it is written |
| --- | --- | --- |
| [`freeze.md`](freeze.md) | The invariant freeze: what a simplification may not change, and the check that enforces each item. | Now, before any code. |
| [`change-surface.md`](change-surface.md) | The metric that replaces lines of code, its method, and the baseline. | Method now; baseline measured in Phase A. |
| [`notification-semantics.md`](notification-semantics.md) | What a model reads and a human sees for every terminal status, and the delivery-state vocabulary. Decided once, before implementation. | Now. |
| [`presentation-ledger.md`](presentation-ledger.md) | Every notice and summary text this programme changes: before, after, and why. | Rows now; confirmed against the goldens when Phase A closes. |
| [`change-recipes.md`](change-recipes.md) | For each representative change, the files expected to move, the files that must not, and the tests to run. | Now; kept current by every phase. |
| [`phase-a-exit-gate.md`](phase-a-exit-gate.md), [`phase-b-exit-gate.md`](phase-b-exit-gate.md), [`phase-c-exit-gate.md`](phase-c-exit-gate.md) | Each phase's gate, item by item, with the evidence that closes it. | Items now; verdicts when the phase closes. |

Phase D has no gate document because it is not scheduled; each item in it gets
an ADR when the soak or real usage calls for it.

## 1. Objective

Make the common changes cheap without weakening the invariants that make the
runtime trustworthy. The measure is not lines of code. The measure is **how
many unrelated modules have to change together** for a representative task.

The programme succeeds when a contributor can do both of these without reading
the supervisor:

1. *"Show the task label in the completion notification."* Touches the
   notification projection, the notification formatter, and their tests.
   Nothing under `runtime/` or `backend/`.
2. *"Add a fourth backend that supports resume and steering."* Touches
   `backend/<name>/*`, composition and backend-set registration, a conformance
   adapter, and a live gate. Zero generic lifecycle modules.

Both are already close to true. The work below closes the gap and then fences
it so it stays closed.

## 2. What does not move

These are the properties a simplification may not trade away. Every one is
already enforced by something in `check`; the programme adds to that list and
removes nothing from it.

- The thirteen invariants in [contributing.md](../contributing.md#the-invariants-a-change-may-not-break),
  verbatim.
- The scope nesting Session → Subagent → Run → native execution, and the
  decision that Runs and BackendAgents are not Effect Layers
  ([ADR-0023](../adr/0023-v2-scope-ownership.md)).
- One terminal candidate wins, arbitration is pure, cleanup completes or is
  escalated before the Result is observable ([ADR-0025](../adr/0025-v2-terminal-settlement.md)).
- Storage precedes notification; delivery reconstructs the notice from the
  stored Result; `agent_result` is authoritative
  ([ADR-0006](../adr/0006-completion-notifications-and-result-store.md)).
- `RunRepository` and `ResultStore` stay separate. One answers *what does this
  Run look like now*, the other *what immutable output exists for it*. Merging
  them would save a service and destroy the read/write boundary.
- The three named pin holders on the store (`publication`, `waiters`,
  `delivery`) stay named. Their release timing is domain meaning, not
  bookkeeping to hide behind a generic scope.
- The generic capability set stays at `resume`, `steer`,
  `terminalTranscriptSnapshot`. A capability enters the core only when it
  changes generic lifecycle semantics. MCP, shell, browser, images, and the
  like remain provider-native.
- Backend vocabulary does not escape adapters; presentation depends only on
  domain projections.

[`freeze.md`](freeze.md) carries this list with the check that enforces each
item, and is the document a reviewer points at.

One rule is added to [contributing.md](../contributing.md) in Phase A and
governs the whole programme:

> A simplification is successful only if it removes a concept or a reason for
> unrelated files to change together, without weakening an existing invariant.
> Moving correctness from a test into a comment is not a simplification.

## 3. The measurement

Lines of code is the wrong metric here; the ledger already shows v2 is larger
than v1 by every honest count, and most of that is conformance infrastructure
and Codex protocol handling that should stay.

The metric is **change surface**: the number of production modules a
representative change touches, split into generic lifecycle modules
(`runtime/*`, `domain/*` excluding presentation-only types) and everything
else. Record the baseline in Phase A by doing each change on a branch and
counting, then keep the table in this document current.

| Representative change                          | Target: generic lifecycle modules | Target: total production modules |
| ---------------------------------------------- | --------------------------------: | -------------------------------: |
| Change completion-notice wording               |                                 0 |                              ≤ 2 |
| Add a field to the completion notice           |                                 1 (`domain/notification.ts`) |          ≤ 4 |
| Add a backend-specific Profile option          |                                 0 |                              ≤ 3 |
| Add a display-only widget column               |                                 0 |                              ≤ 2 |
| Add a fourth backend                           |                                 0 |                  backend tree + composition |
| Change terminal lifecycle                      |            allowed to be expensive |                allowed to be expensive |
| Add a bound enforced at admission              |                               ≤ 2 |                              ≤ 5 |

A pull request that adds a Claude-only Profile option and touches
`supervisor.ts`, `repository.ts`, `result-store.ts`, and `delivery.ts` is
leaking, and the reviewer can say so by pointing at this table. The method,
the estimated baseline, and the measured figures live in
[`change-surface.md`](change-surface.md); this table is the target column.

## 4. Phases

Phases are ordered by risk, lowest first, and by dependency: A fixes
vocabulary that B and C would otherwise refactor around; D is deferred until
real usage demands it.

### Phase A — Notification semantics and UX

**Closed.** [The exit gate](phase-a-exit-gate.md) records every item's status
and its evidence, and
[ADR-0033](../adr/0033-notification-vocabulary-pointer-and-label-bound.md) is
the decision record.

**Why first.** It has the best ratio of mental-model payoff to risk, and it
changes model-facing text. That text is frozen by
[the compatibility matrix](../v2/compatibility-matrix.md) and
[the presentation ledger](../v2/presentation-ledger.md) when 2.0 goes stable, so
changing it once before the stable line is cheaper than changing it twice.
No lifecycle behaviour changes in this phase.

What the notices say, state by state, is decided in
[`notification-semantics.md`](notification-semantics.md) before any of it is
implemented, and every sentence that changes is a row in
[`presentation-ledger.md`](presentation-ledger.md). The items below say what
moves and why; those two documents say exactly what it becomes.

#### A1. Reserve *landed* for the one place that knows it

Today `runtime/delivery.ts` calls a successful sink push `landed`, keeps a set
named `delivered` documented as "ids that actually landed", and exposes
`delivered()`. The Session push sink in `host/push-sink.ts` is explicit that a
push is a hand-off, not a landing; landing is `message_start` carrying the
notice, and an aborted turn can lose a handed-off notice. The behaviour is
correct because the sink owns real landing separately. The vocabulary is a
latent defect because a reader of `delivery.delivered()` will eventually make
the wrong decision.

Rename, with no behaviour change:

| In `runtime/delivery.ts`             | Becomes                          |
| ------------------------------------ | -------------------------------- |
| `DeliveryState.delivered`            | `DeliveryState.handedOff`        |
| `const landed = yield* push(...)`    | `const handedOff = ...`          |
| `delivered()`                        | `handedOff()`                    |
| doc comment "ids that actually landed" | "ids the sink accepted; landing is the sink's to report" |

The exact vocabulary, to be written into [CONTEXT.md](../../CONTEXT.md):

- **handed off** — `sendMessage` accepted the custom message.
- **landed** — `message_start` carried that message. Terminal.
- **lost after hand-off** — an aborted host turn discarded it; re-pushed once
  when the parent settles.
- **exhausted** — the retry budget (default three attempts, one second apart,
  in `runtime/policy.ts`) ended without a successful hand-off.

Who knows what:

```text
CompletionDelivery   pending / handed-off / exhausted
SessionPushSink      handed-off / lost / landed
widget               landed or not, exhausted or not — nothing finer
ResultStore          nothing about notification state
```

Fence it: add a boundary rule to `boundaries.test.ts` that the word *landed*
(and its inflections) does not appear in `runtime/delivery.ts`, with the
negative-case fixture the file requires. This is the repository's existing
style of enforcing vocabulary, applied to the one place where the vocabulary
is currently wrong.

#### A2. Bound the Run label at admission, and carry a label rather than a description

`RunNotification` copies `description` and `model` from the Result with no
bound of its own, and the `agent_start` / `agent_resume` schemas in
`host/tool-schemas.ts` accept an unrestricted string for the description. The
push sink retains the whole `RunNotification` until landing resolves, and
Result bounding never removes identity fields, so a large description is the
one input that can carry a Result past its byte target after everything
removable has been cut.

- Add `RUN_LABEL_MAX_BYTES` (160–256; pick 200 and record it) to
  `domain/bounding.ts`. Apply it at decode in `domain/decoding.ts` as a
  truncate-and-record bound, consistent with invariant 11.
- In `domain/notification.ts`, replace `description` with
  `label: boundOneLine(result.description, RUN_LABEL_MAX_BYTES)` and give
  `model` a small defensive bound.
- Drop `backendId` from the notice. Nothing that formats a notice reads it,
  and its absence is what makes the compatibility claim "two backends, same
  sentence" structurally true rather than merely tested.
- Replace the raw `UsageSnapshot` on the notice with a presentation-oriented
  `NotificationAccounting` (input, output, cost, turns, model). The formatter
  then stops knowing the full usage schema; the conversion happens once in
  `toRunNotification`.
- Add `durationMillis`, the Run's settled instant less its started instant,
  taken from the stored Result so the notice, the widget's settled row, and
  the result card print one number.

#### A3. Every terminal notice points at `agent_result`, with availability

`presentation/notification-text.ts` gives completed and failed notices the
result pointer and deliberately withholds it from cancelled ones. Cancelled
Runs can carry partial output, and a cancellation may come from a timeout or
Session shutdown rather than an explicit call the parent just made. The
special case is a rule the parent model has to remember.

- Add `resultAvailability: "full" | "partial" | "metadata-only"` to
  `RunNotification`, derived in `toRunNotification` from the stored Result.
- Restructure `formatNotificationText` as header, status body, pointer,
  accounting. Status decides only the body. All three statuses get the same
  pointer line.
- The pointer gives the exact argument shape:
  `Call agent_result with {"id":"run-…"}.` prefixed by
  `Full result is available.` or `Partial result is available.`
  **Superseded by [A8](#phase-a-follow-up--a6-a7-a8)**, which renames the three
  values and rewrites the three sentences; the shipping text is there and in
  [semantics §5](notification-semantics.md#pointer). This bullet is what Phase
  A decided, kept because a roadmap records what each phase decided.
- Label the preview as subagent-produced data and quote it, so delegated
  output is not presented in the voice of orchestration instructions:

  ```text
  Preview from the subagent:
  "Found two redirect-validation gaps in callback handling…"
  ```

- Show the label in the header. The collapsed summary in
  `presentation/renderers.ts` currently spends its width on both ids and a
  character count; replace it with agent, label, status verb, elapsed, cost.
  Ids move to the expanded view where they are used for tool calls.

Target shapes, collapsed and expanded:

```text
reviewer · audit auth redirects · completed in 41.2s
```

```text
Subagent "audit auth redirects" completed in 41.2s.

Agent: reviewer
Run: run-k3f9-2
Subagent: subagent-k3f9-1

Preview from the subagent:
"Found two redirect-validation gaps in callback handling…"

Full result is available. Call agent_result with {"id":"run-k3f9-2"}.

3 turns · 12.3k in / 4.5k out · $0.0421
```

The golden tests in `presentation/notification-text.test.ts` and the
presentation ledger are updated together, and the ledger records this as an
intentional break.

#### A4. Command namespace

`/subagent` is already registered by `host/diagnostics-command.ts` and prints
the diagnostic counters; `/agents` in `host/agents-command.ts` lists Profiles.
Converge on one operator namespace:

```text
/subagent               shallow status: profile count, running, completed,
                        runtime health, one line per profile, and the two
                        subcommands
/subagent profiles      what /agents does today
/subagent diagnostics   what bare /subagent does today
```

Keep `/agents` as an alias through 2.0 and remove it in the first minor after,
so the compatibility matrix's row can say when. Bare `/subagent` is kept
deliberately shallow so new counters land in `diagnostics` without a redesign.

#### A5. Documentation that makes the map fit on one screen

- A compact block diagram at the top of [architecture.md](../architecture.md):
  host → application → supervisor → {repository, store → delivery → sink}
  → backends, with a "writes / reads / host-only" legend under it.
- [`change-recipes.md`](change-recipes.md): for each representative change in §3, the files
  expected to change, the files that must not, the tests to run, and the
  invariants involved. This is the §3 table in operational form.
- The vocabulary from A1 in [CONTEXT.md](../../CONTEXT.md).
- The governing rule from §2 in [contributing.md](../contributing.md).

#### Phase A exit gate

Verified item by item in [`phase-a-exit-gate.md`](phase-a-exit-gate.md).

- `npm run check` green; the six live gates re-run because model-facing text
  changed and the host smoke asserts on it.
- Boundary rule for *landed* in `runtime/delivery.ts` present with its
  negative fixture.
- Compatibility matrix and presentation ledger updated; each text change
  recorded as intentional.
- Change-surface baseline recorded in §3.
- An ADR (next number is 0033) recording the notification vocabulary and the
  decision that every terminal notice carries a pointer.

Expected files: `domain/notification.ts`, `domain/bounding.ts`,
`domain/decoding.ts`, `presentation/notification-text.ts`,
`presentation/renderers.ts`, `runtime/delivery.ts` (rename only),
`host/tool-schemas.ts`, `host/agents-command.ts`,
`host/diagnostics-command.ts`, `boundaries.test.ts`, docs.
Must not change: `runtime/supervisor.ts`, `runtime/run-scope.ts`,
`runtime/result-store.ts`, `runtime/repository.ts`, `backend/*`.

**What the phase actually touched**, against the list above. `domain/result.ts`
and `domain/text.ts` moved instead of `domain/bounding.ts` and
`domain/decoding.ts`, because the label's bound belongs beside `RunIdentity`
and its one-line helper beside the other one-line bounds.
`application/subagents.ts` moved, because the façade is where a decoded tool
input becomes a request and therefore where a bound at admission goes.
`presentation/status.ts` and `presentation/run-card.ts` moved, because the
notice's verb and the card's accounting come from the shared dictionaries.
And `runtime/supervisor.ts` — on the must-not-change list — moved by 41 lines
so the diagnostic recording a shortened label reaches the Run's projection
through the observation intake every other diagnostic uses; a second channel
would have been worse.
[Item 15 of the gate](phase-a-exit-gate.md#15-no-runtime-behaviour-changed)
records that as a deviation with the diff. `run-scope.ts`,
`result-store.ts`, `repository.ts`, and every file under `backend/` are
untouched.

#### Phase A follow-up — A6, A7, A8

Three corrections to what Phase A shipped, found by the re-review. They are
not a reopened gate: the Phase A gate's verdicts stand, and these are
verified at the Phase C gate, whose live lanes cover the one text change.
They come first because A8 changes model-facing text and the window for that
closes at 2.0 stable, and because A6 and A7 are the cheapest fixes in the
programme.

**A6. The health line judges only what is actionable.** Bare `/subagent`
reads `Runtime: healthy` when the sum of every counter is zero and
`Runtime: N counted` otherwise. [The debugging guide](../debugging.md#the-counters)
already classifies the counters three ways — must be zero, expected to rise,
each one means something specific — so a Session with twenty late events and
two reconciliation differences is running exactly as designed and is told it
is not healthy. The taxonomy moves from prose into code: `runtime/counters.ts`
gains one classification, `Record<SupervisorCounter, CounterClass>`, with
classes **defect** (`duplicateCommits`, `conflictingCommits`,
`unreadableResults`, `seamDecodeFailures`, `queueOverflows`), **incident**
(`cleanupEscalations`, `deliveryFailures`) and **expected**
(`duplicateSettlements`, `lateEvents`, `lateObservations`, `lateEndings`,
`reconciliationDifferences`, `evictions`). The record is exhaustive by type, so
a counter added without a class does not compile. The health line reads
`Runtime: healthy · 4 held` when no defect or incident counter is non-zero,
and `Runtime: attention needed · 1 defect · 2 incidents · 4 held — /subagent
diagnostics` otherwise, naming only the non-zero classes. Expected counters
are not summed into the shallow status; that is what `/subagent diagnostics`
is for. A counter name the host does not recognise is treated as actionable,
so the structural `CountBlock` cannot hide one. Two counters change class
against the guide's current tables and the guide is corrected in A7:
`duplicateSettlements`, whose own description says two endings racing is
normal, and `lateEndings`, documented as normal on cancellation.

**A7. The debugging guide describes two commands.** Its `/subagent` section
still shows the counters-and-probes report, which since A4 is
`/subagent diagnostics`. The section splits: `/subagent` is the shallow
status and its health line, with the three classes named; `/subagent
diagnostics` is the full report. The counter tables are regrouped to the
three classes A6 encodes, and each table names its class. The "widget shows
nothing" symptom is rewritten by Phase C, not here.

**A8. Availability says what a model will find.** `resultAvailability` is
`full` for every completed Run, because it describes the stored Result rather
than the output, so a completed Run with empty output reads `No output was
produced.` followed by `Full result is available.` The semantics were
coherent and the sentence misleads: to a model, "full result" means an answer
is waiting. The three values become **`complete`** (completed, non-empty final
output), **`partial`** (anything else with a non-empty final output or
transcript) and **`record-only`** (nothing readable). The pointer sentences
become `The result is available.`, `Partial output is available.`, and `No
output was produced. The Run record is available.`, each followed by the
exact `agent_result` call. Because the record-only sentence now says no
output was produced, the completed-with-no-output body says nothing, as the
cancelled body already does; the sentence is said once. Availability still
describes the stored Result — a completed Run whose output was cut by
bounding is `complete` — and the rule that every terminal notice carries a
pointer is unchanged. [The semantics document §3 and §5](notification-semantics.md#3-result-availability)
carry the decided text; [ledger row N-10](presentation-ledger.md#n-10--availability-vocabulary-phase-a-follow-up-a8)
records the change; the host smoke lanes, which assert on this text, are
re-run at the Phase C gate.

### Phase B — Supervisor decomposition by mechanism

**Why.** `runtime/supervisor.ts` is 1,030 lines at the Phase A close (994
when this roadmap was written; the label's admission path added the rest) and
owns admission and
capacity, Subagent records and their mutation, run forking, resume, cancel,
steer, wait and waiter bookkeeping, result lookup, default timeout, cleanup
escalation, shutdown, and delivery initiation. It is a legitimate
orchestration boundary carrying too many mechanisms. The test for this phase
is that the file afterwards **reads like orchestration**, not that it is
shorter.

**What not to do.** Do not split by public tool into `StartService`,
`WaitService`, and so on. That multiplies the surface. Do not introduce new
Effect Layers; the extracted pieces are plain scoped objects the supervisor
constructs. Each extraction is behaviour-preserving and lands as its own
commit with the existing supervisor, lifecycle, race, and stress tests
unchanged.

**Closed** (2026-09-04). [The exit gate](phase-b-exit-gate.md) records every
item's status and its evidence, and
[ADR-0034](../adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)
is the decision record. Three mechanisms left the supervisor rather than the
two planned: admission as a lease, the Subagent records, and — B3's deferred
decision, made — the waiter ledger. Every runtime test that existed before the
phase passes with no edits.

The spec and its six tickets are under the local tracker at
`.scratch/v2-simplify-b-supervisor-decomposition/`, as every milestone's have
been.
Two lessons from the Phase A gate are built in: **the ADR is written first**
([ADR-0034](../adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md),
proposed in the first ticket and accepted at the gate), because the
contributor rules require one for a new generic runtime abstraction and the
architecture challenge gate's three questions are easier to answer before the
code than after; and **every commit answers the challenge gate** in its
message, since Phase A satisfied it across the phase rather than commit by
commit and said so.

**What the supervisor owns today, by mechanism.** Reading the 1,030-line file
at the Phase A close:

| Mechanism | Where it lives now | Lines, roughly |
| --- | --- | ---: |
| Admission: the `AdmissionState` ref, `claim`, `releaseClaim`, `reserveResult`, the late running-set add after a successful open, and the shutdown flag | scattered through `start`, `resume`, `steer`, `forkRun`'s finalizer, and `shutdown` | 140 |
| Subagent records: the `Map`, seven direct field mutations (`phase` ×3, `run` ×2, `runFiber`, `conversationLost`), and the linear `recordOf` scan | `start`, `resume`, `forkRun`, `closeUnderCleanupBudget`, `closeSubagent`, `shutdown`, `recordOf` | 60 |
| Waiter bookkeeping: the `waiters` map, `releaseWaiterPinIfIdle`, `terminalStatusOf` | `wait` | 100 |
| Run mechanics: `forkRun`, `settled`, `closeUnderCleanupBudget`, `armDefaultTimeout`, `openSubagent` | their own functions | 300 |
| The six operations and shutdown | their own functions | 350 |

The first two are mechanisms with their own invariants (invariant 12 for
admission, invariant 2 for records) that the supervisor currently enforces at
each call site. They leave. The third is decided at B3. The last two are
orchestration and stay.

#### B1. Extract admission, as a lease

The admission state and every operation on it move to `runtime/admission.ts`.
The public shape:

```ts
interface RunAdmission {
  /** One atomic step: shutting down, already running, or capacity. */
  acquire(subagentId?: SubagentId): Effect<AdmissionLease | AdmissionRejection>;
  isShuttingDown(): Effect<boolean>;
  /** True for the first caller only. */
  beginShutdown(): Effect<boolean>;
}
interface AdmissionLease {
  /** A start binds its Subagent once the open has succeeded and the id exists. */
  bind(subagentId: SubagentId): Effect<void>;
  /** The result reservation; a refusal releases the lease and says so. */
  reserveResult(runId: RunId): Effect<boolean>;
  /** Returns capacity and any reservation still held. Idempotent. */
  release(): Effect<void>;
}
```

What this removes, which is what an ADR for a new runtime abstraction must
name: the counter clamped at zero "in case anything ever released twice"
(a lease releases once by construction); the three separate release sites
(reserve failure, open failure, fiber exit) that each had to remember what
was held; and the `Ref.update` in `start` that adds the Subagent to the
running set after the open, which today is admission state mutated outside
admission. The result-store's reservation removal is already idempotent, so
a lease releasing at fiber exit after a committed result is a no-op on every
path that exists.

The release stays a call in this phase. Making it a Run Scope finalizer is
Phase C1, and it is a one-line change once the lease exists.

#### B2. Extract the Subagent records

The `Map<SubagentId, SubagentRecord>` and every mutation of a record move to
`runtime/subagent-records.ts`. **Not "registry"**: the glossary lists
*Registry* as a retired 1.x term for `SubagentRuns`, replaced by the
RunRepository, and reviving it for a new thing would be exactly the naming
bug the vocabulary rule describes. The glossary already calls these "the
supervisor's records".

```ts
interface SubagentRecords {
  insert(record: SubagentRecord): void;
  get(id: SubagentId): SubagentRecord | undefined;
  /** The Subagent whose Run this is, if that Run is in flight. */
  byRun(runId: RunId): SubagentRecord | undefined;
  attachRun(id: SubagentId, handle: RunHandle): void;
  attachFiber(id: SubagentId, fiber: Fiber<unknown, never>): void;
  /** The Run is over: idle, unless the Subagent was closed meanwhile. */
  detachRun(id: SubagentId): void;
  markConversationLost(id: SubagentId): void;
  /** True for the first caller only; a closed Subagent admits nothing. */
  markClosed(id: SubagentId): boolean;
  all(): readonly SubagentRecord[];
  clear(): void;
}
```

What it removes: seven field assignments at six call sites, and the linear
scan in `recordOf` (an index from Run id to Subagent id, maintained by
`attachRun` and `detachRun`, gives the same answer for the same reason: only
an in-flight Run has an owner). Invariant 2 is asserted in `attachRun`: a
second Run attached to a Subagent that has one is a defect, not a silent
overwrite. The assertion never fires today, which is the point of stating it
where it can be read.

#### B3. Waiter bookkeeping, decided by the one-screen test

After B1 and B2, measure `wait`. If `waitOne` with its ledger fits on one
screen (about sixty lines) and reads as steps, the `waiters` map and
`releaseWaiterPinIfIdle` stay and the gate records why. If not, they move to
`runtime/waiters.ts` as a ledger with `register(runId)` returning its own
release, and `releaseIfIdle(runId)` for settlement. Either outcome passes;
not deciding does not.

**Decided: they moved**, and B4 rather than the measurement is what decided
it — the `waiters` map is a `new Map` in `runtime/supervisor.ts`, which B4's
rule forbids, so the alternative was a carve-out in the one file the rule
exists to cover. `runtime/waiters.ts` has the shape above.
[The gate's item 5](phase-b-exit-gate.md) records it.

#### B4. Fence it

A boundary rule: `runtime/supervisor.ts` holds no state of its own — no
`Ref.make`, no `new Map`, no `new Set`. The contributor rules name "maps,
flags, `Promise.race`, or `AbortController` turning up in generic runtime
code" as the early signal of the old architecture returning; this rule makes
the first of those a failing test for the one file where it would hide best.
Negative fixture as every rule has. The `stages` trace array the conformance
suite reads is a test hook and is not covered.

#### B5. Settle the Phase A findings before measuring

Three findings came out of [the change-surface baseline](change-surface.md#findings)
and Phase B settles them before it measures its own row:

1. **R3's target rises to `0 / ≤ 3`.** `backend/profile-fields.ts` is a
   parameterisation point — the one `try` per field that turns a bad value
   into a Profile diagnostic — and not a place backend knowledge accumulates.
   A hook there is the honest cost of a backend-owned option.
2. **R7 is added: "add a bound enforced at admission", target `≤ 2 / ≤ 5`.**
   Phase A's label bound is the baseline at `2 / 5`. Phase B does not aim to
   lower it; a bound applied where input becomes a request has to be
   declared, applied, carried, and recorded, and that is four places by
   nature.
3. The two safe-direction estimate errors need no action; the estimated
   column is already marked superseded.

#### Phase B exit gate

Verified item by item in [`phase-b-exit-gate.md`](phase-b-exit-gate.md).

- ADR-0034 proposed before the first extraction and accepted at the gate.
- Every test in `runtime/*.test.ts` passes without modification. A test that
  has to change is a behaviour change, which this phase forbids.
- `start`, `resume`, `cancel`, `wait`, and `shutdown` in `supervisor.ts` each
  read as a sequence of named steps with no inline state manipulation, and
  the gate records each one's line count.
- Boundary rule for a stateless supervisor present, with its fixture.
- Change-surface findings settled, then the Phase B row measured; R3 must not
  have moved.

Expected files: `runtime/supervisor.ts`, new `runtime/admission.ts`, new
`runtime/subagent-records.ts`, possibly `runtime/waiters.ts`, unit tests for
the new modules, `boundaries.test.ts` for the fence, one ADR, the glossary,
and this directory's documents. Must not change: any production file outside
`runtime/`, and any existing test under `runtime/`.

### Phase C — The completion hand-off, and resource lifetime polish

**Why.** Two reasons, one old and one new. The old one: Effect reduces
machinery only when paired acquire/release calls become scoped resources. The
repository already does this for subscriptions and resource probes; C1 and C2
extend it where it removes compensation logic and stop where a pair carries
domain meaning. The new one: a completion notice exists to make the parent
fetch the Result, and today the runtime treats it as an artifact every settled
Run must land, so a parent that fetched the Result on its own still has a row
in the widget waiting for a landing and, after an aborted turn, gets the notice
re-pushed. C3 gives the hand-off a second way to resolve.

**What Pi allows, which decided the shape.** While the parent is streaming,
the sink's `sendMessage(…, { deliverAs: "followUp", triggerTurn: true })`
goes into Pi's own follow-up queue (`AgentSession.sendCustomMessage` →
`agent.followUp`). The extension API exposes `hasPendingMessages()` and nothing
that removes one queued message; `clearQueue()` is on the session object, not
the extension API, and would discard the user's queued messages with ours. So
a notice that has been handed off will land whatever the parent does, and
"the parent called `agent_result`, so the notification is suppressed" is
achievable only for a notice the host has not yet handed to Pi. Delivery pushes
at settlement, which makes that window milliseconds wide except after a push
failure or a lost hand-off. Widening it means the host holding notices while
the parent is active and handing them over when it settles — which is exactly
the batching envelope Phase D already describes. So: Phase C makes
consumption resolve everything that is ours to resolve (the widget row, the
re-push, a push not yet accepted) and counts how often a notice lands after
its Result was already consumed; Phase D's envelope, when the count or the
soak calls for it, is what turns that count into suppression.

#### C1. Admission as a scoped lease

Replace the procedural release in the Run fiber with
`Effect.acquireRelease(admission.acquire(...), lease => lease.release())`, so
capacity is returned by the Run Scope closing rather than by a call the
supervisor has to remember. This is the second half of B1. The ordering the
Phase B code review restored — `detachRun` before the lease releases, so a
concurrent close still finds the Run's fiber — is a property the finalizer
order must keep, and the test that caught it is the detector.

#### C2. Audit the remaining pairs

For each of `claim/releaseClaim` (gone after C1), subscription
start/unsubscribe, delivery claim/recovery sweep, and the per-holder store
pins: convert to a scoped resource if and only if the release has exactly one
correct moment and that moment is a scope closing. The store's three named
pins fail that test on purpose and stay as they are (freeze F6).

#### C3. The completion hand-off resolves on landing or consumption

The sink today knows a notice as unlanded, lost, or landed. It gains
**consumed**: the parent retrieved this Run's Result through `agent_result`.
The rule, which [ADR-0035](../adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)
records:

> A terminal Run's hand-off is **unresolved** until its completion notice
> lands **or** its Result is retrieved with `agent_result`, whichever comes
> first. `agent_wait` does not resolve it: it reports that a Run is terminal
> and deliberately does not return the answer, so a parent waiting on a
> fan-out must still be pointed at each Result.

What consumption does inside the sink, and nothing else:

- A push for a consumed Run is accepted and not sent. Delivery sees a
  hand-off, releases its pin, and stops; the semantics document's meaning of
  *handed off* — the host accepted the message — is kept, with the host's
  acceptance including the decision not to send.
- A consumed notice that was lost after hand-off is not re-pushed when the
  parent settles.
- A consumed notice that Pi already holds lands anyway; the sink marks it
  landed as today and counts it as **consumed before landing**. That counter
  is Phase D's evidence.
- Consumption is recorded at the host boundary, in the `agent_result` tool
  handler, when the application answered with a Result. It is not recorded by
  `ResultStore.read`, which delivery and diagnostics also call, and it is not
  a store pin: pins answer "may this output be evicted?", consumption answers
  "does the parent still need to be oriented toward it?", and F6 keeps the
  pin holders as they are.

The widget's dependency changes from two functions about landing to one read
model about the hand-off, and it is the same read model the exhausted state
was going to need:

```ts
interface CompletionHandoffView {
  status(runId: RunId): "pending" | "resolved" | "exhausted";
  subscribe(listener: () => void): () => void;
}
```

`resolved` is landed or consumed, and the widget does not learn which. A row
stays while its Run is not terminal or its hand-off is `pending` or
`exhausted`; an exhausted row reads `completed · notification failed` with the
Run id and `result available`, so a settled row that will never leave on its
own says why; consuming an exhausted Run's Result resolves it and the row
goes. The sink learns of exhaustion from delivery, through one call on the
`NotificationSink` interface made when the retry budget runs out, so the whole
hand-off state has one owner. The sink keeps handed-off, lost, attempt counts,
and the consumed set internally.

`/subagent diagnostics` gains a hand-off block from the sink: pushes attempted,
hand-offs accepted, hand-offs refused, notices lost after hand-off, re-pushes,
landings, exhaustions, and consumed before landing.

**What does not move.** Delivery's pin is still released on hand-off (Phase D
revisits that). Storage still precedes notification and `agent_result` is
still authoritative (F4). The conformance scenarios for
notification-follows-storage and retry-cannot-alter-settlement are untouched.
`CompletionDelivery` does not learn the word *consumed*; the fence on
*landed* extends to it.

**What was considered and rejected.** Recording consumption in
`Subagents.result` — the application layer would then know a host surface
exists. Making `ResultStore.read` consumption — internal reads would suppress
notices. A consumption pin on the store — a second meaning for a mechanism
whose three holders are frozen by name. Consuming on `agent_wait` — a parent
that waits for fan-out terminality would silence the pointers it needs.
Suppressing a handed-off notice — Pi has no API for it.

#### C4. One `RunCompletionView` for terminal presentation

Terminal facts are readable from `RunSnapshot`, `RunResult`, and
`RunNotification`, each for a good reason, and presentation can pick the wrong
one. The last such divergence was widget timing versus result timing, fixed
by carrying `settledAt` on the snapshot. Add a small presentation-only type
(run id, subagent id, agent, label, status, duration) with one derivation
from each source, and route status wording, duration wording, and
agent/label formatting through it and through the existing `runPhaseTone`,
`NOTICE_VERB`, and `formatTurns` helpers. No new service.

#### Phase C exit gate

Verified item by item in [`phase-c-exit-gate.md`](phase-c-exit-gate.md),
which also verifies the Phase A follow-up.

- Race and stress lanes (`runtime/races.test.ts`, `runtime/stress.test.ts`)
  pass unchanged; the bounds lane gains a case for the exhausted projection.
- A widget test shows an exhausted notice rendering as such, and one shows a
  settled row leaving on consumption with no landing.
- A push-sink test shows a consumed notice is not re-pushed after an aborted
  turn, and a push for a consumed Run is accepted without a send.
- The health line is asserted for a Session with only expected counters
  raised (healthy) and one with an incident (attention needed).
- The presentation goldens for the three pointer sentences replace the old
  three, and the ledger's confirmation table names them.
- `npm run check` green; all six live lanes re-run, because model-facing text
  changed (A8) and lifecycle mechanics moved (C1).
- ADR-0035 accepted; the compatibility matrix's widget row-lifetime cell and
  the debugging guide's "widget shows nothing" symptom say landing *or*
  retrieval.

### Phase D — Long-session concerns, on evidence only

Nothing here is on the path to 2.0. Each item waits for the release-candidate
soak ([soak.md](../v2/soak.md)), real usage, or the counter named beside it,
and each gets its own ADR when picked up. **Each item has a decision rule,
written here before the numbers exist**, and [the 2.0 close](../v2/release-close.md)
applies the rules to the soak's log and marks every item *scheduled* or
*deferred* with the reading that decided it.

- **Terminal Run compaction.** The repository keeps every Run snapshot until
  Session shutdown and the push sink keeps every landed id in a `Set`. Both
  are bounded only by Session length. Compact a terminal Run to a tombstone
  (Run id, Subagent id, terminal status, enough to distinguish
  `ResultExpired` from unknown) once its hand-off has resolved and its Result
  has expired or been consumed. **Decision rule:** *scheduled* if any soak
  Session's `/subagent` Run summary shows a hundred or more terminal Runs, or
  a shutdown entry records a widget redraw or a notice that was visibly slow;
  otherwise *deferred*, re-read at the first 2.x minor.
- **Delivery's pin held through landing.** Delivery releases its store pin
  when the hand-off succeeds, so a notice can land and `agent_result` can
  already say `ResultExpired`. A bounded pin held from notice construction
  through landing, released on landing or consumption or the parent's next
  settle, with a byte and count budget so an idle parent cannot pin the
  store forever. This is a store policy change and needs an ADR. It is *not*
  Phase C's consumption: that resolves a hand-off, this keeps output
  evictable or not. **Decision rule:** *scheduled* on the first soak entry in
  which `agent_result` answered `ResultExpired` for a Run whose notice had
  landed in the same Session — a pointer that lied; otherwise *deferred*,
  re-read whenever `evictions` is non-zero in a shutdown entry.
- **Hold while active: one envelope for batching and suppression.** Up to
  `maxActiveRuns` notices can land close together, each a follow-up that can
  trigger a parent turn, and Phase C shows that a notice handed to Pi while
  the parent is active cannot be withdrawn if the parent fetches the Result
  first. One host-only mechanism answers both: accumulate notices while the
  parent is active, and when it settles drop the consumed ones and send the
  rest once; when the parent is idle and one Run finishes, send immediately.
  Keep `RunNotification` one-per-Run and immutable; order failures first;
  treat the envelope landing as every contained id landing. This lives
  entirely in `host/`, and that placement is itself the test that delivery
  aggregation has stayed out of settlement. **Evidence:** the
  `consumedBeforeLanding` count Phase C adds, read from the soak and from
  dogfood Sessions; if it stays near zero, the envelope is batching alone and
  waits for the soak's fan-out numbers. **Decision rule:** *scheduled* if
  `consumedBeforeLanding` is non-zero in a third or more of the soak's
  shutdown entries, or three or more in any one; or if two or more shutdown
  entries record three or more notices landing in one parent turn. Otherwise
  *deferred*, re-read at the first 2.x minor.

## 5. Sequencing and the 2.0 release

| Phase | When                                     | Relationship to 2.0                                                                 |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| A     | Closed                                   | Changed model-facing text before the matrix freezes it.                             |
| A follow-up | Closed 2026-09-04, with C           | A8 changed model-facing text before 2.0 stable. A6 and A7 were corrections and held nothing. |
| B     | Closed 2026-09-04                        | Behaviour-preserving; held no release. Every pre-existing runtime test passes unmodified. |
| C     | Closed 2026-09-04                        | The widget's row-lifetime cell and the notice's pointer cell changed, both before stable. The six live lanes are owed: see the gate's item 14. |
| 2.0 close | After C: [release-close.md](../v2/release-close.md) | The soak on the Phase C build, the coexistence record, the end-state test, the Phase D decision, the programme close, the release. |
| D     | Only if a decision rule fires at the 2.0 close | Not scheduled. Each scheduled item's ADR is its phase's first ticket. |

The three outstanding release items from [the v2 roadmap](../v2/roadmap.md)
(live gates on the cutover build, the Codex Desktop coexistence record, the
soak log) are unchanged by this programme except that Phase A's text changes
require the live gates to be re-run after it, not before.

## 6. Risks

| Risk                                                                  | Mitigation                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A rename in Phase A masks a behaviour change                          | A1 lands as a commit whose test diff is empty apart from the new boundary rule.                                     |
| Supervisor extraction changes ordering under contention               | Phase B forbids test edits; races and stress lanes are the detector.                                               |
| "Simplification" moves an invariant from a test into prose            | The §2 rule in contributing.md; reviewers ask which test enforces the property after the change.                    |
| Notice redesign breaks a parent model's learned habit                 | Pointer text keeps the tool name and adds the exact argument shape; the ledger records the break.                   |
| Phase D items get pulled forward "while we are in there"              | Each needs an ADR and a soak finding. Neither exists yet.                                                           |
| Comment density hides the invariant comments among historical ones    | Alongside A5, keep invariant and why-not-obvious comments in source, move history to ADRs and the change recipes.   |
| Consumption grows into a second pin, or leaks into the runtime          | It is a set in the sink and a call at the tool boundary, nothing else. The *landed* fence extends to *consumed* in `runtime/delivery.ts`; F6 keeps the pin holders named. |
| The re-review's "suppressed notification" is promised and cannot be kept | The roadmap states what Pi allows. C3 promises the row, the re-push, and the count; suppression is Phase D's envelope, on that count. |

## 7. The end-state test

When the programme is done, hand a new contributor these two requests and
read their plan before they touch anything.

> "Add `gemini` as a backend that supports resume and steering."

They should list `backend/gemini/*`, the backend set and composition
registration, a conformance adapter, and a live gate. They should not list a
new Run phase, new `ResultStore` logic, new delivery logic, new widget
semantics, or a supervisor branch on the backend's name.

> "Show the task label in the completion notification."

They should list `domain/notification.ts`,
`presentation/notification-text.ts`, and the presentation tests. They should
not list the supervisor, a backend, or the store.

If both are true, the evolvability that the review scored at seven is at nine,
whether or not the line count moved. The optimisation is fewer reasons for
unrelated files to change together, and that is what every phase above is for.

## 8. When the programme closes

The code got simpler and this directory got larger. When Phase C closes, the
documents split into what a contributor needs and what happened, so that a
future backend author does not read the simplification's history to
understand the product.

| Permanent, kept current | Historical, frozen at the close |
| --- | --- |
| [`architecture.md`](../architecture.md), [`contributing.md`](../contributing.md), [`debugging.md`](../debugging.md) | this roadmap |
| the ADRs | `freeze.md`, `change-surface.md` (the method stays in `contributing.md`; the measurements are history) |
| [`change-recipes.md`](change-recipes.md) | the three phase gates, `presentation-ledger.md` |
| [`notification-semantics.md`](notification-semantics.md) §2–§6, which the compatibility matrix cites | `notification-semantics.md` §1's before/after tables and §8 |

Historical documents gain a one-line banner saying so and pointing at the
permanent one that superseded them. Nothing is deleted. This split is item E6
of [the 2.0 close](../v2/release-close.md).
