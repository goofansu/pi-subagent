# 34. The supervisor delegates admission to a lease and Subagent state to a records module

Date: 2026-09-04

## Status

**Accepted** in the commit that closes the Phase B gate — the commit carrying
this entry. The acceptance criterion stated below is met: every test under
`extensions/subagent/runtime/` that existed before the phase passes with no
edits, and the conformance suite passes on every rig. `npm run check` is green.

The third module named at the gate, `runtime/waiters.ts`, is the waiter
decision this ADR deliberately left to a measurement.

**Amended by the phase's code review, in the same commit.** The records module
has an eleventh operation, `markRunning`, because a Subagent's phase moves when
its Run is admitted and attaching that Run's Scope is a later instant; the
sketch below lists ten. The gate's *Corrections* section records that and five
other findings, two of which are places the gate itself had described the old
code wrongly.

Everything from *Context* down is the text that was proposed, unchanged. The
sketches in it are what was decided, not an API reference; the gate is where
the shipped API is recorded.

**Proposed** in `96d210a`, written before `runtime/admission.ts` existed,
which is the Phase B discipline and the lesson the Phase A gate recorded: a
programme whose premise is deciding before coding should write its ADR first.

Supersedes nothing, and changes nothing any earlier decision decided.

Carries forward:

- [ADR-0023](0023-v2-scope-ownership.md) — nothing shorter-lived than the
  Session is an Effect Layer, so neither extracted module is one.
- [ADR-0025](0025-v2-terminal-settlement.md) — one terminal candidate wins and
  cleanup completes or is escalated before a Result is observable, which is
  why a Run fiber's exit is still the moment its lease is released.
- [ADR-0026](0026-v2-control-admission.md) — admission is synchronous and
  bounded and never blocks the caller's turn, which is why capacity stays a
  non-blocking reservation rather than becoming a semaphore.
- [ADR-0032](0032-reservations-evict-rather-than-refuse.md) — a Result-store
  reservation evicts rather than refusing, so the lease's `reserveResult` is
  still the step that can answer `at capacity`.

## Context

`runtime/supervisor.ts` is 1,030 lines and owns twelve mechanisms together:
admission and capacity, the Subagent records and their mutation, run forking,
resume, cancel, steer, waiter bookkeeping, result lookup, the default timeout,
cleanup escalation, shutdown, and delivery initiation. It is a legitimate
orchestration boundary — something has to sequence a start — carrying rather
more than orchestration.

Two of those mechanisms have invariants of their own, and in both cases the
invariant is currently enforced by each caller being careful rather than by
the thing that owns the state.

**Admission** (contributing invariant 12: once shutdown begins, new work is
rejected) keeps its state in one `Ref` that is read and modified from five
places. One of those five is `start`, which adds the Subagent to the running
set *after* the backend has opened — admission state mutated outside the
admission functions, because a Subagent's id does not exist until its backend
does. Three separate sites release what a Run claimed (a refused reservation,
a failed open, the Run fiber's exit), and each has to remember which of a
capacity slot and a Result-store reservation it is holding. The capacity
counter is clamped at zero with a comment explaining that the clamp should
never fire, because with three release sites nobody can prove it will not.

**The Subagent records** (contributing invariant 2: one Subagent owns at most
one active Run) are a plain `Map` whose records are mutated by seven
assignments at six call sites — `phase` three times, `run` twice, `runFiber`
once, `conversationLost` once. The rule that a Subagent has at most one active
Run is therefore true of the code without being stated anywhere in it. Finding
which Subagent owns a given in-flight Run is a linear scan over every record
the Session has ever created.

None of this is incorrect. The Phase A change-surface measurement showed the
seams the architecture claims: a notice-wording change touches one module, a
widget column one, a fourth backend nothing generic. What that metric cannot
show is *reading* cost, and the supervisor is where reading cost concentrates.
A maintainer who needs to change how a Run is admitted has to read all twelve
mechanisms to find the five places that matter.

## Decision

Extract the two mechanisms that have their own invariants into their own
modules under `runtime/`. Each is a plain object the supervisor constructs
inside its own construction, with the supervisor's lifetime. Neither is an
Effect Layer.

### Admission is a lease

`runtime/admission.ts` owns the atomic admission state — the shutting-down
flag, the active-Run count, and the set of Subagents with a Run in flight —
and every operation on it.

```ts
interface RunAdmission {
  /** One atomic step: shutting down, already running, at capacity, or a lease. */
  acquire(subagentId?: SubagentId): Effect<AdmissionOutcome>;
  isShuttingDown(): Effect<boolean>;
  /** True for the first caller only. */
  beginShutdown(): Effect<boolean>;
}

interface AdmissionLease {
  /** A start binds its Subagent once the open has succeeded and the id exists. */
  bind(subagentId: SubagentId): Effect<void>;
  /** The result reservation; a refusal releases the lease and says so. */
  reserveResult(runId: RunId): Effect<boolean>;
  /** Returns the capacity slot and any reservation still held. Idempotent. */
  release(): Effect<void>;
}
```

A resume's Subagent is claimed inside the `acquire` itself, because its id is
known; a start's is bound afterwards, because until the open succeeded there
was no Subagent. The lease is what makes those two paths one mechanism rather
than two.

**What it removes.** The capacity counter clamped at zero, because a lease
cannot release twice — the clamp guarded a bug the design now makes
impossible. The three release sites that each had to remember what they were
holding, because a lease releases everything it holds in one call. The
`Ref.update` in `start` that added a Subagent to the running set after the
open, which is admission state mutated outside admission, replaced by
`lease.bind`.

### The Subagent records own every mutation

`runtime/subagent-records.ts` owns the map from Subagent id to record and
every mutation of a record's phase, current Run, Run fiber, and
conversation-lost flag.

```ts
interface SubagentRecords {
  insert(facts: SubagentFacts): SubagentRecord;
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

The record's mutable fields are `readonly` on the public type, so a supervisor
that assigns one fails to compile rather than failing a grep. The values
handed out are the live records, so a caller that reads `record.run` after the
module attached one reads the attachment.

**What it removes.** Seven field assignments at six call sites. The linear
`recordOf` scan, replaced by an index from Run id to Subagent id maintained by
`attachRun` and `detachRun` — which answers exactly what the scan answered,
for the same reason: only an in-flight Run has an owner. And the silence
around invariant 2, which `attachRun` now asserts where the record lives: a
second Run attached to a Subagent that has one is a defect, not an overwrite.

### The release stays a call, in this phase

The lease is released by a call at the three places the claim is released
today. Converting the Run fiber's release into a Run Scope finalizer —
`Effect.acquireRelease(admission.acquire(...), lease => lease.release())` — is
Phase C1, and the lease is shaped for it now so that it is a one-line change
then. Deciding the shape once is the point of doing it this way round.

## Alternatives rejected

**Split the supervisor by public operation** into `StartService`,
`WaitService`, and so on. This multiplies the surface without removing a
mechanism: each service would still need admission state and the records, so
either they share a mutable thing — which is the shape ADR-0004 removed — or
the same state is enforced in more places than it is today. The supervisor's
problem is not that it has six operations; it is that it has twelve
mechanisms.

**New Effect Layers for the extracted pieces.** ADR-0023's rule is that
nothing shorter-lived than the Session is a Layer, and the boundary test
enforces it by confining `Layer` to the composition module and the services it
wires. These two modules have exactly the supervisor's lifetime, and a Layer
would say they had their own — the beginning of the drift ADR-0023 exists to
stop. They are plain objects.

**"Registry" as the name of the records module.** The glossary lists
*Registry* as a retired 1.x term: it was `SubagentRuns`, which held
live-display Runs and handed out write access to them, and it was replaced by
the `RunRepository`, which is the only writer of Run snapshots and hands out
no write access at all. The historical-terms section exists so that a plan, an
ADR, or a commit message written in the old words is still readable; reviving
a retired word for a new thing would make that section lie. The glossary
already calls these the supervisor's records, so that is what the module is
called.

**A ledger for waiter bookkeeping, decided in advance.** Whether the `waiters`
map follows the other two out of the supervisor is decided *after* the
extractions, by measuring what is left, and recorded in the gate either way.
Deciding it here would be deciding it without the measurement.

## Consequences

**What it costs.** Two more files a maintainer has to know exist, and one more
indirection between reading `start` and reading how capacity is counted. That
is the trade this ADR is making: a question about capacity, the running set,
or shutdown admission has one file to answer it, and a question about what a
Subagent's state can be has one file to answer it, at the price of those
questions no longer being answered by the file that raises them.

**What it does not change.** Every outcome of every public operation, in every
edge case, as the outcome unions in `domain/outcomes.ts` decide them. The order of steps inside `start` and `resume`: admission before
identifiers, identifiers before the reservation, the reservation before the
open, the open before publication, publication before the fork. Cleanup
escalation, the default timeout, delivery initiation, and settlement. The
store, the repository, delivery, the backends, the host, and the façade.

**One property is gained rather than fixed.** An idempotent
`lease.release()` also drops a Result-store reservation the lease still holds,
which closes in principle a path where a reservation could outlive a Run that
settled without committing. No such path exists — settlement always commits
before it publishes — and the store's reservation removal is already a no-op
once a commit has consumed it. So this is a property the design now has, not a
bug it repairs, and it is recorded that way on purpose.

**The architecture challenge gate**, the four questions a structural change
has to answer:

- *What does this delete?* A clamped counter and the reason it was clamped;
  three release sites that each had to remember what they held; one mutation of
  admission state performed outside admission; seven record field assignments
  at six call sites; and a linear scan over every record in the Session.
- *Is it provider-neutral?* Yes, and unchanged in that respect: neither module
  can name a backend, both are exercised by the existing conformance suite on
  every rig through the supervisor, and each gets a unit test at its own
  API against no provider at all.
- *What breaks if it is wrong?* Two Runs are admitted where the policy allows
  one, or a Subagent runs two Runs at once, or a Run is admitted whose result
  could never be stored. All three are things a test must hold rather than a
  review: the new modules' unit tests assert them at the module's own API, and
  `runtime/races.test.ts` and `runtime/stress.test.ts` remain the detector for
  ordering under contention.

**The acceptance criterion.** Every existing test under
`extensions/subagent/runtime/` passes with no edits, and the conformance suite
passes on every rig. A test that has to change means the behaviour changed,
which this phase forbids — so an extraction that needs a test edit goes back
rather than taking the edit.
