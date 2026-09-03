# Simplification roadmap: fewer concepts, better completion notices

**Status: Phase A closed; B, C, and D proposed.**
[The Phase A gate](phase-a-exit-gate.md) is closed, with item 14 carried and
three change-surface findings for Phase B to settle. This is the plan that
follows
[the v2 roadmap](../v2/roadmap.md), which delivered the rewrite and is now
history. It answers the one definition-of-done clause the rewrite did not meet
(less lifecycle machinery than v1, per [the deletion ledger](../v2/deletion-ledger.md))
and acts on the completion-notification findings of the post-M7 architecture
review.

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
| Add a backend-specific Profile option          |                                 0 |                              ≤ 2 |
| Add a display-only widget column               |                                 0 |                              ≤ 2 |
| Add a fourth backend                           |                                 0 |                  backend tree + composition |
| Change terminal lifecycle                      |            allowed to be expensive |                allowed to be expensive |

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

**Planned** (2026-09-03), after Phase A closed. The spec and its six tickets
are under the local tracker at `.scratch/v2-simplify-b-supervisor-decomposition/`,
as every milestone's have been; the gate is
[`phase-b-exit-gate.md`](phase-b-exit-gate.md).
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

### Phase C — Resource lifetime polish

**Why.** Effect reduces machinery only when paired acquire/release calls
become scoped resources. The repository already does this for subscriptions
and resource probes; Phase C extends it where it removes compensation logic,
and stops where a pair carries domain meaning.

#### C1. Admission as a scoped lease

Replace the procedural release in the Run fiber with
`Effect.acquireRelease(admission.acquire(...), lease => lease.release())`, so
capacity is returned by the Run Scope closing rather than by a call the
supervisor has to remember. This is the second half of B1.

#### C2. Audit the remaining pairs

For each of `claim/releaseClaim` (gone after C1), subscription
start/unsubscribe, delivery claim/recovery sweep, and the per-holder store
pins: convert to a scoped resource if and only if the release has exactly one
correct moment and that moment is a scope closing. The store's three named
pins fail that test on purpose and stay as they are.

#### C3. A notice-state projection for the widget

The widget in `host/widget.ts` receives `hasLanded` and `onLanding`. That is
a good boundary; keep its size. When exhausted delivery becomes visible (the
sink today lets a settled row sit forever if the retry budget runs out, with
no explanation), do not grow the interface to
`hasExhausted`/`wasRepushed`/`getAttempts`. Replace it with one read model:

```ts
interface NoticeStateReader {
  status(runId: RunId): "pending" | "landed" | "exhausted";
  subscribe(listener: () => void): () => void;
}
```

The sink keeps handed-off, lost, and attempt counts internally. The widget
row for an exhausted notice reads `completed · notification failed` with the
Run id and `result available`, so the human no longer sees a mysteriously
permanent row. Diagnostics gain separate counters for hand-off failures, lost
hand-offs, re-pushes, landings, and exhaustions.

#### C4. One `RunCompletionView` for terminal presentation

Terminal facts are readable from `RunSnapshot`, `RunResult`, and
`RunNotification`, each for a good reason, and presentation can pick the wrong
one. The last such divergence was widget timing versus result timing, fixed
by carrying `settledAt` on the snapshot. Add a small presentation-only type
(run id, subagent id, agent, label, status, duration) with one derivation
from each source, and route status wording, duration wording, and
agent/label formatting through it and through the existing `runPhaseTone`,
`runPhaseVerb`, and `formatTurns` helpers. No new service.

#### Phase C exit gate

Verified item by item in [`phase-c-exit-gate.md`](phase-c-exit-gate.md).

- Race and stress lanes (`runtime/races.test.ts`, `runtime/stress.test.ts`)
  pass unchanged; bounds lane (`runtime/bounds.test.ts`) gains a case for the
  exhausted-notice projection.
- A widget test shows an exhausted notice rendering as such.
- `npm run check` green; host smoke re-run because the widget changed.

### Phase D — Long-session concerns, on evidence only

Nothing here is on the path to 2.0. Each item waits for the release-candidate
soak ([soak.md](../v2/soak.md)) or real usage to show the need, and each gets
its own ADR when picked up.

- **Terminal Run compaction.** The repository keeps every Run snapshot until
  Session shutdown and the push sink keeps every landed id in a `Set`. Both
  are bounded only by Session length. Compact a terminal Run to a tombstone
  (Run id, Subagent id, terminal status, enough to distinguish
  `ResultExpired` from unknown) once its notice has landed and its Result has
  expired or been consumed.
- **Notification-consumption lease.** Delivery releases its store pin when
  the hand-off succeeds, so a notice can land and `agent_result` can already
  say `ResultExpired`. A bounded lease held from notice construction through
  landing, released on the first `agent_result` read or the parent's next
  settle, with a byte and count budget so an idle parent cannot pin the
  store forever. This is a store policy change and needs an ADR.
- **Fan-out batching at the host.** Up to `maxActiveRuns` notices can land
  close together, each a follow-up that can trigger a parent turn. Keep
  `RunNotification` one-per-Run and immutable; add a host-only envelope that
  accumulates while the parent is active, sends once when it settles, sends
  immediately when the parent is idle and one Run finishes, orders failures
  first, and treats the envelope landing as every contained id landing. This
  lives entirely in `host/`, and that placement is itself the test that
  delivery aggregation has stayed out of settlement.

## 5. Sequencing and the 2.0 release

| Phase | When                                     | Relationship to 2.0                                                                 |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| A     | Before 2.0 stable                        | Changes model-facing text; do it before the matrix freezes it. Blocks stable.       |
| B     | First minor after 2.0                    | Behaviour-preserving; no reason to hold the release for it.                         |
| C     | After B                                  | C1 depends on B1. C3 and C4 are independent and can interleave with B.              |
| D     | When the soak or usage shows a need      | Not scheduled.                                                                      |

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
