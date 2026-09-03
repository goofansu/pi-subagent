# Phase B exit gate — supervisor decomposition by mechanism

**Status: not started.** Planned 2026-09-03 against the tree at the Phase A
close (`2fdabe3`), where `runtime/supervisor.ts` is 1,030 lines.
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

**Status:** OPEN.

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

**Evidence to name:** the ADR's two status entries and their commits.

**Status:** OPEN.

### 2. Every existing runtime test passes without modification

```sh
git diff --name-only <phase-a-close>..<phase-b-close> -- 'extensions/subagent/runtime/*.test.ts'
```

returns only files that did not exist at the Phase A close. Every conformance
scenario passes on all five rigs.

**Status:** OPEN.

### 3. Admission is its own module with lease semantics

`runtime/admission.ts` owns the atomic admission state, the capacity claim,
the per-Subagent active-Run claim, the result reservation, the shutdown flag,
and the compensation when a reservation is refused after a claim. Its API is
`acquire` returning a lease or a typed rejection, `isShuttingDown`, and
`beginShutdown`; the lease has `bind`, `reserveResult`, and an idempotent
`release`. The supervisor holds no admission state and performs no admission
arithmetic; the `Ref.update` that added a Subagent to the running set after a
successful open is gone, replaced by `lease.bind`.

**Evidence to name:** the new module's unit test — two concurrent acquires
against a capacity of one produce one lease; a refused reservation releases
the lease; a second release is a no-op; `beginShutdown` is true once; an
acquire after it is `shutting down` — and a grep showing `Ref` is no longer
imported by the supervisor.

**Status:** OPEN.

### 4. The Subagent records are their own module, and it is not called a registry

`runtime/subagent-records.ts` owns the record map and every mutation of a
record's phase, current Run, Run fiber, and conversation-lost flag, plus the
Run-id-to-Subagent index that replaces the linear scan. Invariant 2 is
asserted in `attachRun`. The supervisor reads records through it and assigns
no record field directly.

**Evidence to name:** the new module's unit test, including the assertion
firing on a second attach and `detachRun` leaving a closed Subagent closed;
a grep showing no `record.<field> =` assignment in the supervisor; the
glossary's *Subagent records* entry and its note that *Registry* stays
retired.

**Status:** OPEN.

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

The extracted modules are plain objects constructed inside `makeSupervisor`.
`runtime/composition.ts` did not change and registers no new service.

**Status:** OPEN.

### 8. Nothing outside `runtime/` changed in production code

`git diff --name-only` under `extensions/subagent/` shows only `runtime/*`
and `boundaries.test.ts`.

**Status:** OPEN.

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

`runtime/races.test.ts` and `runtime/stress.test.ts` pass unmodified; the
stress lane's leak probes end at zero after its cycles, including rejected
starts, failed opens, and refused reservations.

**Status:** OPEN.

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

Each of the two extraction commits states, in its message, what the
abstraction is, what it removes, and what would have to be true for it to be
wrong — the three questions in
[contributing.md](../contributing.md#the-architecture-challenge-gate). Phase A
answered them once, in the ADR, and recorded that a phase which decides its
ADR first should also answer them commit by commit.

**Status:** OPEN.

### 13. The recipes, the architecture note, and the glossary name the new modules

The *Extract a mechanism* recipe names admission and records as done and
points at the waiter decision; architecture §1 and §4 say the supervisor
delegates admission and records; the glossary has *Admission lease* and
*Subagent records* entries, each added in the same commit as its code.

**Status:** OPEN.

## Verdict

To be written when verified.
