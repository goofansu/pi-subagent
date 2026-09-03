# Phase B exit gate — supervisor decomposition by mechanism

**Status: closed.** Planned 2026-09-03 against the tree at the Phase A
close (`2fdabe3`), where `runtime/supervisor.ts` was 1,030 lines; verified
2026-09-04 on the commit carrying this verdict. Thirteen items, all PASS.
**Verified against:** [the roadmap](roadmap.md), Phase B;
[the freeze](freeze.md); the recipe *Extract a mechanism from the supervisor*
in [change-recipes.md](change-recipes.md); the Phase B spec and its six
tickets under `.scratch/v2-simplify-b-supervisor-decomposition/`.
**Inherits from [the Phase A gate](phase-a-exit-gate.md):** three
change-surface findings to settle (item 11 below), and two lessons — write
the ADR first, and answer the architecture challenge gate in every commit
that adds a runtime abstraction.

## How to read this

Same vocabulary as [the Phase A gate](phase-a-exit-gate.md): **PASS**,
**CARRIED**, **OPEN**, **NOT MET**, each with the evidence named. The
distinctive rule of this gate is item 2: **an existing runtime test that
changed is a failure**, because this phase forbids behaviour change and a test
is how behaviour is observed. New test files for new modules are expected.

## The deterministic gate

```
npm run check   →  exit 0
```

Re-run on the commit that closes this gate: **1,244 tests, 0 failures, 8
skipped** in the main lane, and **191 tests, 0 failures, 8 skipped** in the
conformance lane across all five rigs. `typecheck`, `lint`, and the Codex
protocol check are green. No live gate is required: no backend, host, or
model-facing text changed in this phase.

The phase added 25 tests to the main lane: eight for the admission lease, nine
for the Subagent records, six for the waiter ledger, and two boundary fixtures
for rule 21. `3454da5`'s message says 1,242, which understates by two — the
figure was taken before that commit's own two fixtures were written. The count
here is the one on the closing tree.

**Status:** PASS.

## The items

### 1. ADR-0034 was proposed before the first extraction, and is accepted

[ADR-0034](../adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)
names the two abstractions (the admission lease and the Subagent
records), what each **removes** — the clamped counter and its three release
sites; seven direct record mutations and a linear scan — what was rejected
(splitting by public tool; new Effect Layers; the name "registry"), and what
it costs (two more files to know about). It answers the architecture challenge
gate's three questions. Its status was *proposed* in the commit before
`runtime/admission.ts` existed and *accepted* in the gate's closing commit.

**Evidence to name:** the ADR's two status entries. *Proposed* in `96d210a`,
which is a documents-only commit landing before `runtime/admission.ts` existed
— the commit that created the module is `b70b946`, two commits later.
*Accepted* in the commit carrying this verdict, with the ADR's own note that
nothing from *Context* down was rewritten between the two.

One thing the ADR named and left open is now settled and is named there too:
the waiter ledger, `runtime/waiters.ts`, which the ADR deliberately refused to
decide in advance. See item 5.

**Status:** PASS.

### 2. Every existing runtime test passes without modification

```sh
git diff --name-only <phase-a-close>..<phase-b-close> -- 'extensions/subagent/runtime/*.test.ts'
```

returns only files that did not exist at the Phase A close:

```
extensions/subagent/runtime/admission.test.ts
extensions/subagent/runtime/subagent-records.test.ts
extensions/subagent/runtime/waiters.test.ts
```

Nothing else under `extensions/subagent/runtime/*.test.ts` was touched, so the
supervisor, lifecycle, races, stress, faults, bounds, backpressure, delivery,
repository, result-store, mailbox, arbitration, policy, and composition lanes
all observe the same behaviour they observed before the phase and all pass.
Every conformance scenario passes on all five rigs (191 tests, 8 skipped by
declared capability, 0 failures).

This is the item the phase is judged by, and it is the only mechanical answer
to "did the behaviour change". Two orderings inside the phase *were* changed
and both are argued in their commits rather than hidden: the Run fiber's
finalizer detaches the Run before releasing the lease, which is what makes the
records' one-active-Run assertion unreachable; and a resumed Subagent's phase
becomes `running` when the fork attaches its Run rather than a few steps
earlier, in which window a second resume is refused by the Subagent's
active-Run claim instead of by the phase check and answers the identical
outcome with the identical Subagent id.

**Status:** PASS.

### 3. Admission is its own module with lease semantics

`runtime/admission.ts` owns the atomic admission state, the capacity claim,
the per-Subagent active-Run claim, the result reservation, the shutdown flag,
and the compensation when a reservation is refused after a claim. Its API is
`acquire` returning a lease or a typed rejection, `isShuttingDown`, and
`beginShutdown`; the lease has `bind`, `reserveResult`, and an idempotent
`release`. The supervisor holds no admission state and performs no admission
arithmetic; the `Ref.update` that added a Subagent to the running set after a
successful open is gone, replaced by `lease.bind`.

**Evidence to name:** `runtime/admission.test.ts`, eight cases at the module's
own API — two concurrent acquires against a capacity of one yield exactly one
lease; a resume acquire on a running Subagent is refused and spends no
capacity; shutting down is answered before already-running and before capacity;
a refused reservation releases the lease so its slot comes back, and releases
nothing in the store because a refused reservation is not one; a lease releases
the reservation it holds exactly once; a **second release cannot raise the
effective capacity**, which is the property the clamp was defending and the
one a "is it quiet" test would have missed; a bound Subagent leaves the running
set when its lease is released; `beginShutdown` is true for the first caller
only and every later acquire is refused.

`grep -n 'Ref' extensions/subagent/runtime/supervisor.ts` returns nothing: not
the import, not a call, not a mention. The `Ref.update` that added a Subagent
to the running set after a successful open is `lease.bind`, called between the
insert and the publish.

**Status:** PASS.

### 4. The Subagent records are their own module, and it is not called a registry

`runtime/subagent-records.ts` owns the record map and every mutation of a
record's phase, current Run, Run fiber, and conversation-lost flag, plus the
Run-id-to-Subagent index that replaces the linear scan. Invariant 2 is
asserted in `attachRun`. The supervisor reads records through it and assigns
no record field directly.

**Evidence to name:** `runtime/subagent-records.test.ts`, nine cases —
including `attaching a second Run to a Subagent that has one is a defect`,
which asserts the throw and then asserts that the first Run's handle is still
the one `byRun` answers with, and `a Subagent whose Run detaches goes idle, and
one that was closed stays closed`. Also: `byRun` answering nothing for a
settled or unknown Run, `markClosed` true for the first caller only, `all` in
insertion order, and a detach after `clear()` changing nothing — which is the
case that says why a mutation of an unknown Subagent is quiet rather than a
defect, since shutdown clears the records while a Run fiber's finalizer may
still be in flight.

`grep -nE 'record\.[a-zA-Z]+ = ' extensions/subagent/runtime/supervisor.ts`
returns nothing. The stronger fence is the type rather than the grep: the
public `SubagentRecord` makes `phase`, `conversationLost`, `run`, and
`runFiber` `readonly`, so a supervisor that assigned one would fail to
compile. The values handed out are the live records, so reads stay current.

The glossary has a *Subagent records* entry, and the historical *Registry*
entry now says in as many words that the word stays retired and why: the
section exists so an old plan can still be read, and naming a new thing
"registry" would make it say something untrue.

**Status:** PASS.

### 5. Waiter bookkeeping was decided, not deferred

**Decided: it moved.** `runtime/waiters.ts` (92 lines) owns the count of
waiters registered per Run and the store's `waiters` pin held on their behalf,
with `register(runId)` returning the release for that one waiter and
`releaseIfIdle(runId)` for settlement.

The one-screen measurement did not decide it; **boundary rule 21 did**. The
`waiters` map is a `new Map` in `runtime/supervisor.ts`, and the fence in item
9 forbids exactly that — so either the ledger left or the fence would have had
to carve out an exception for the one file it exists to cover. Two things
happened to `wait` as a result, and both were the point: its bookkeeping is a
`register`/release pair rather than eleven lines of increment-and-decrement
inside an `ensuring`, and the release is idempotent for the same reason the
admission lease's is — a place given up twice would free another waiter's and
take the pin with it while somebody was still entitled to read.

`terminalStatusOf` did **not** go with it. It is not waiter bookkeeping: it is
the derivation of a `WaitOutcome` from a stored Result and a snapshot, it
depends on nothing the supervisor holds, and it moved to a module-level
function in the same file — which is what the four other dependency-free
helpers there already are.

**Evidence to name:** `runtime/waiters.test.ts` — six cases, each asking when
the pin goes for a different ending of a wait: settlement with no waiters, one
waiter still holding, the last of three letting go, a release run three times,
two Runs' places kept apart, and the `unresolvedWaiters` probe back at zero.

**Status:** PASS.

### 6. The supervisor reads like orchestration

`start`, `resume`, `cancel`, `wait`, and `shutdown` each read as a sequence of
named steps with no inline state manipulation, and each fits on one screen
(about sixty lines). Line counts at the Phase A close are the "before" column.

| Operation | Before | After | One screen? |
| --- | ---: | ---: | --- |
| `start` | 105 | 72 | at 72, over the guide |
| `resume` | 70 | 50 | yes |
| `cancel` (with `cancelOne`) | 37 | 38 | yes |
| `wait` (with `waitOne`, and before with the ledger and `terminalStatusOf`) | 112 | 46 | yes |
| `shutdown` (with `closeSubagent`) | 48 | 45 | yes |
| `makeSupervisor`'s whole body | 805 | 701 | — |
| whole file | 1,030 | 1,037 | — |

Counted from each operation's own `const` (or the first line of its doc
comment where it has one) to the line that closes it, comments and blanks
included. Two of the planned "before" figures were re-measured by that
convention and corrected upward: `wait`'s group is 112 lines rather than 100
and `shutdown`'s is 48 rather than 45, both at `2fdabe3`. The planned figures
were read rather than counted, and the correction is recorded here rather than
quietly applied. Two named steps were extracted, both closures inside the supervisor
and neither a module, as the roadmap allows: `resolveStart` (39 lines) is
every rejection a start can earn before it costs anything — unknown agent,
invalid Profile, unknown backend, delegation depth — and `resolveResume` (33)
is the same for a resume, including the two Conversation checks. Four
dependency-free helpers moved to module level beside `openFailure`, which was
already there: `subagentContextFor`, `runIdentityFor`, `terminalStatusOf`, and
the `ForkedRun` value the fork takes.

**`start` is 72 lines and the guide says about sixty.** It is nine named steps
— refuse if shutting down, resolve, acquire, spend identifiers, reserve, open,
insert and bind, publish, fork — with no state manipulated inline, and
eighteen of those seventy-two lines are the comments that say why the order is
the order. Splitting it further was tried on paper and rejected: the two
candidate halves are "everything that can refuse" and "everything that
commits", and the order across that seam is precisely what this phase exists
to make readable, so hiding half of it behind a name would cost the thing the
item is asking for. The line count is recorded rather than met, per the
spec's own note that it is a proxy.

**The whole file grew by seven lines**, and that is the honest number.
`makeSupervisor`'s body — the orchestration — lost 104 lines to the three new
modules; the module-level declarations above it gained about as many, in the
two resolved-request types, the four helpers, and the header that now says
where admission lives. The phase's criterion was never that the file be
shorter.

**Status:** PASS, with `start`'s line count recorded as over the guide.

### 7. No new Effect Layer

All three extracted modules are plain objects constructed inside
`makeSupervisor`: `makeAdmission` returns `Effect<RunAdmission>` because it
holds a `Ref`, and `makeSubagentRecords` and `makeWaiterLedger` are plain
functions. None imports `Layer`, and boundary rule 5 would reject it if one
tried — `LAYER_MODULES` names the composition module and the six services it
wires, and none of the three is on that list.

**Evidence to name:** `git diff --stat 2fdabe3..HEAD --
extensions/subagent/runtime/composition.ts` is empty.
`runtime/composition.test.ts` is unmodified and green.

**Status:** PASS.

### 8. Nothing outside `runtime/` changed in production code

`git diff --name-only 2fdabe3..HEAD -- 'extensions/**'` shows seven files:
`runtime/admission.ts`, `runtime/admission.test.ts`,
`runtime/subagent-records.ts`, `runtime/subagent-records.test.ts`,
`runtime/waiters.ts`, `runtime/waiters.test.ts`, `runtime/supervisor.ts`, and
`boundaries.test.ts`. Filtering out tests leaves four production modules, all
under `runtime/`.

Documents changed as the tickets required: this gate, the roadmap,
[the change surface](change-surface.md), [the recipes](change-recipes.md),
[the architecture note](../architecture.md),
[the contributor rules](../contributing.md) (the boundary-rule count),
[the glossary](../../CONTEXT.md), and ADR-0034.

**Status:** PASS.

### 9. The supervisor holds no state of its own, and it is fenced

Boundary rule 21 is in `boundaries.test.ts`: `runtime/supervisor.ts` contains
no `Ref.make`, `new Map`, or `new Set`. A content scan rather than an import
check, for the same reason rule 19 is one — nothing is imported to construct a
`Map`, and the thing prevented is a state holder appearing rather than a
dependency being added.

**Evidence to name:** `a supervisor constructing a reference, a map, or a set
is rejected` writes all three into a fixture supervisor and requires all three
violations; `the supervisor's trace array is the documented exception, and
another runtime module may hold state` requires none, from a fixture holding
the `stages` array and an `admission.ts` with a reference and a set in it —
which is the second half of the rule's meaning: the state is not forbidden,
it belongs to the module whose invariant it carries. `the real tree holds
every rule` covers the working tree. The one construction left in the
supervisor is `const stages: string[] = []`, documented in the rule's own
comment as the exception and as a test hook nothing reads back.

**Status:** PASS.

### 10. The race and stress lanes are the detector, and they are green

`runtime/races.test.ts` and `runtime/stress.test.ts` are byte-identical to
their Phase A versions (item 2's diff is empty for both) and pass. The stress
lane's leak probes end at zero after its cycles, which is what would catch a
leaked lease: its cycles include rejected starts, failed opens, and refused
reservations, and those are exactly the three paths where a lease is released
by a call rather than by a Run ending.

**Evidence to name:** the lanes were re-run repeatedly rather than once,
because an ordering change under contention is not reliably a first-run
failure. `races`, `stress`, `faults`, `lifecycle`, `backpressure`, and
`bounds` were run five times over after the admission extraction, five times
after the records extraction, and three times after the ledger extraction —
65 tests, 0 failures, every time.

**Status:** PASS.

### 11. The Phase A findings are settled, then the Phase B row is measured

In [change-surface.md](change-surface.md): R3's target is `0 / ≤ 3` with the
parameterisation-point rationale; R7 "add a bound enforced at admission" exists
with target `≤ 2 / ≤ 5` and baseline `2 / 5` from Phase A; then the Phase B
row is measured by the recorded method. R3 must read `0 / 3` or better. R6 is
the only row allowed to have grown, and it should not have: the extraction
adds two generic modules to the tree but a terminal-lifecycle change touches
neither.

**All three Phase A findings are settled**, each keeping its original text with
the decision recorded under it. R3's target rose to `0 / ≤ 3` on the
parameterisation-point argument the finding itself makes, not on a second
measurement. R7 exists in all three tables at `≤ 2 / ≤ 5`. Finding 3 needed no
action and says so.

**The Phase B row, measured:**

| R1 | R2 | R3 | R4 | R5 | R6 | R7 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 / 1 | 0 / 2 | 0 / 3 | 0 / 1 | 0 / 8–12 | 9 / 14 | 2 / 5 |

Every cell meets its target, so item 11 records no new finding. **R3 read
`0 / 3` with the same three modules** — it did not move. **R6 did not grow**,
and the reason is the reading the gate wanted: adding a terminal Run phase
touches none of the three new modules, because admission counts Runs and knows
no phase, the records hold a *Subagent* phase that a terminal *Run* phase does
not affect, and the ledger counts readers.

The phase's own cost is in the tree rather than in a row: 103 production
modules became 106, and 23 generic became 26. That is recorded under the
measured table, because no representative change touches one of the three and
the metric is about what changes together.

**Evidence to name:** the Phase B row and the seven per-row sections in
[change-surface.md](change-surface.md); the method block there, which names
the base commit `3454da5`, the throwaway branch
`throwaway/phase-b-change-surface`, and the commands. R1 through R4 were each
made on that branch one at a time with `npx tsc --noEmit` run on each, and the
branch was deleted. R5, R6, and R7 are written module lists.

**Status:** PASS.

### 12. Every commit that added an abstraction answers the challenge gate

Each extraction commit states, in its message, what the abstraction is, what
it deletes, whether it is provider-neutral, and what breaks if it is wrong —
the three questions in
[contributing.md](../contributing.md#the-architecture-challenge-gate). Phase A
answered them once, in the ADR, and recorded that a phase which decides its
ADR first should also answer them commit by commit.

**Three** commits rather than two, because the waiter decision came out as an
extraction:

| Commit | Abstraction |
| --- | --- |
| `b70b946` | `refactor(v2-simplify-b): admission is a lease, and the supervisor holds none of it` |
| `73a1181` | `refactor(v2-simplify-b): the Subagent records own every mutation` |
| `3454da5` | `refactor(v2-simplify-b): the supervisor reads like orchestration, and is fenced` |

Each names its deletions concretely rather than as "simplification", answers
neutrality with the conformance suite on all five rigs, and answers "what
breaks" with the test that holds it. ADR-0034 answers the same three questions
for the phase.

**Status:** PASS.

### 13. The recipes, the architecture note, and the glossary name the new modules

The *Extract a mechanism from the supervisor* recipe now opens with a table of
the three mechanisms that left, the invariant each carries, and its unit test;
it records the waiter decision and points here for what decided it; and it says
that a fourth extraction is no longer a judgement call, because boundary rule
21 means a mechanism needing state cannot be added to the supervisor at all.
The recipes' status line reads *Current as of Phase B*.

Architecture §1 gains **"The supervisor owns the order things happen in, and no
state"**, naming all three modules, what each owns, and rule 21, under the
Layer rule it depends on. §4 extends the Control-admission argument to Run
admission: one atomic step, nothing queued, nothing allocated by a rejection,
and a lease holding all three claims. Both point at ADR-0034. §10's boundary
table gains rule 21's row, and its count reads twenty-one rules in nineteen
rows.

The glossary has *Admission lease* and *Subagent records*, each added in the
same commit as its code (`b70b946` and `73a1181`), the *Reservation* entry now
says the lease releases one that a commit has not consumed, and the historical
*Registry* entry says the word stays retired.

**Status:** PASS.

## Verdict

**The gate is closed.** Thirteen items, all PASS, and `npm run check` green on
the closing commit.

What the phase changed: three mechanisms left `runtime/supervisor.ts` for
modules that own the invariant each carries — admission as a lease
(invariant 12), the Subagent records (invariant 2), and the waiter ledger
(invariant 13) — each a plain object with the supervisor's lifetime, each with
a unit test at its own API, each landing as its own behaviour-preserving
commit that answers the architecture challenge gate. Boundary rule 21 makes
the outcome permanent.

What it did not change: any outcome of any public operation, in any edge case.
The evidence is item 2, and it is mechanical — every runtime test that existed
before the phase passes with no edits, and the conformance suite passes on all
five rigs.

**Two things are worth carrying rather than declaring finished.**

*`start` is 72 lines against a sixty-line guide.* It reads as nine named steps
with no state manipulated inline, which is the substantive criterion, and item
6 records why splitting it further was rejected: the seam would fall between
"everything that can refuse" and "everything that commits", and the order
across that seam is what the phase exists to make readable. A later phase that
finds a better decomposition should take it; a later phase that adds a tenth
step to `start` should look here first.

*The file grew by seven lines.* `makeSupervisor`'s body lost 104 to the three
modules and the module-level declarations above it gained about as many. The
phase's criterion was never that the file be shorter, and the honest number is
recorded rather than framed.

## What Phase C inherits

**C1's finalizer conversion is ready, and it is the one-line change it was
promised to be.** The lease exists, its `release` is idempotent, and the Run
fiber's release is a single call inside `Effect.ensuring`. Converting it to
`Effect.acquireRelease(admission.acquire(...), (lease) => lease.release())` is
the whole of C1 — with one thing to preserve that this phase discovered:
**the release must stay ordered after `records.detachRun`.** The Subagent's
active-Run claim is what stops a resume being admitted, so a release that
happened first would let the next Run reach `attachRun` while this one still
looked in flight, and the records' invariant-2 assertion would fire on a path
that is legal today. Whatever C1 does with the scope, that order is load
bearing.

**C2's audit of the remaining acquire/release pairs** has one fewer pair to
consider: `claim`/`releaseClaim` is gone, replaced by the lease. Two new pairs
arrived and both already pass C2's own test — a release with exactly one
correct moment — without being scopes: the lease's, whose moment is the Run
fiber's exit, and the waiter ledger's, whose moment is a wait ending however
it ends. The ledger's release is *handed to* its holder rather than paired
with a second call, which is the shape C2 is looking for expressed without a
scope.

**The change-surface baseline for Phase C** is the Phase B row, measured from
`3454da5` by the method recorded in
[change-surface.md](change-surface.md#method-so-this-can-be-repeated), with
seven cells and no findings. The tree holds 106 production modules, 26 of them
generic. R3's target is settled at `0 / ≤ 3` and R7 exists at `≤ 2 / ≤ 5`, so
Phase C measures against decided targets rather than inherited ones. C3 will
move R1 and R4's rows, because it changes the widget and adds a notice-state
projection; R6 is the row to watch again if C4's `RunCompletionView` lands, and
it should *fall*.

**No live gate was owed by this phase** and none is owed by it now: no
backend, host, or model-facing text changed. Phase C3 changes the widget and
will owe `pi:host-smoke`.
