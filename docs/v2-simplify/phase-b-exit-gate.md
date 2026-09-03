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

Either the `waiters` map and `releaseWaiterPinIfIdle` moved to
`runtime/waiters.ts` with a unit test, or this gate records the line count of
`waitOne` after B1 and B2 and why it stayed. The `wait` row of item 6 is the
measurement.

**Status:** OPEN.

### 6. The supervisor reads like orchestration

`start`, `resume`, `cancel`, `wait`, and `shutdown` each read as a sequence of
named steps with no inline state manipulation, and each fits on one screen
(about sixty lines). Line counts at the Phase A close are the "before" column.

| Operation | Before | After | One screen? |
| --- | ---: | ---: | --- |
| `start` | 105 | | |
| `resume` | 70 | | |
| `cancel` (with `cancelOne`) | 37 | | |
| `wait` (with `waitOne`, `terminalStatusOf`) | 100 | | |
| `shutdown` (with `closeSubagent`) | 40 | | |
| whole file | 1,030 | | |

`start` is the one that may need a named validation step (Profile, backend,
depth) extracted to fit; if so, that step is a pure function in the
supervisor, not a new module.

**Status:** OPEN.

### 7. No new Effect Layer

The extracted modules are plain objects constructed inside `makeSupervisor`.
`runtime/composition.ts` did not change and registers no new service.

**Status:** OPEN.

### 8. Nothing outside `runtime/` changed in production code

`git diff --name-only` under `extensions/subagent/` shows only `runtime/*`
and `boundaries.test.ts`.

**Status:** OPEN.

### 9. The supervisor holds no state of its own, and it is fenced

Boundary rule 21: `runtime/supervisor.ts` contains no `Ref.make`, `new Map`,
or `new Set`. Negative fixture present and failing the checker on purpose.
The `stages` trace array is documented as the exception and is not covered.

**Status:** OPEN.

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

**Status:** OPEN.

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
