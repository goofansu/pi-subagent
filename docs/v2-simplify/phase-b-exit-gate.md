# Phase B exit gate — supervisor decomposition by mechanism

**Status: not started.** Blocked on [the Phase A gate](phase-a-exit-gate.md)
closing, not for a technical dependency but because Phase A's vocabulary is
what Phase B's extracted modules are named in.
**Verified against:** [the roadmap](roadmap.md), Phase B;
[the freeze](freeze.md); the recipe *Extract a mechanism from the supervisor*
in [change-recipes.md](change-recipes.md).

## How to read this

Same vocabulary as [the Phase A gate](phase-a-exit-gate.md). The distinctive
rule of this gate is item 1: **a test that changed is a failure**, because this
phase forbids behaviour change and a test is how behaviour is observed.

## The deterministic gate

```
npm run check   →  exit 0
```

**Status:** OPEN.

## The items

### 1. Every existing runtime test passes without modification

`git diff <phase-a-close>..<phase-b-close> -- 'extensions/subagent/runtime/*.test.ts'`
is empty. New test files for the extracted modules are allowed; edits to
existing ones are not.

**Status:** OPEN.

### 2. Admission is its own module with lease semantics

`runtime/admission.ts` owns the atomic admission state, capacity claim, result
reservation, and the compensation when a reservation fails after a claim. Its
API is `acquire` returning a lease or a typed rejection, and the lease releases
exactly once. The supervisor calls it and no longer manipulates admission state
inline.

**Evidence to name:** the new module's unit test, including double release and
the reserve-after-claim failure path.

**Status:** OPEN.

### 3. The Subagent registry is its own module

`runtime/subagent-registry.ts` owns the Subagent record map and every mutation
of a record's phase, current Run, Run fiber, and conversation-lost flag. The
supervisor reads records through it and mutates them only through its API.
Invariant 2 (one active Run per Subagent) is asserted in the registry.

**Evidence to name:** the new module's unit test; a grep showing no direct
record-field assignment in `supervisor.ts`.

**Status:** OPEN.

### 4. Waiter bookkeeping was decided, not deferred

Either the waiter map and pin coupling moved to `runtime/run-control.ts` with
a test, or this gate records why they stayed and shows that `wait` in the
supervisor fits on one screen anyway.

**Status:** OPEN.

### 5. The supervisor reads like orchestration

`start`, `resume`, `cancel`, `wait`, and `shutdown` each read as a sequence of
named steps with no inline state manipulation, and each fits on one screen
(about sixty lines). The gate records the line count of each.

| Operation | Lines | One screen? |
| --- | ---: | --- |
| `start` | | |
| `resume` | | |
| `cancel` | | |
| `wait` | | |
| `shutdown` | | |

**Status:** OPEN.

### 6. No new Effect Layer

The extracted modules are plain scoped objects constructed by the supervisor.
`runtime/composition.ts` registers no new service.

**Status:** OPEN.

### 7. Nothing outside `runtime/` changed

**Status:** OPEN.

### 8. The race and stress lanes are the detector, and they are green

`runtime/races.test.ts` and `runtime/stress.test.ts` pass unmodified, and the
stress lane's leak probes end at zero.

**Status:** OPEN.

### 9. The change-surface table is re-measured

[change-surface.md](change-surface.md) has a Phase B row. R3 (backend-specific
Profile option) has not moved. R6 is the only row allowed to have grown.

**Status:** OPEN.

### 10. The recipes and the architecture note name the new modules

The *Extract a mechanism* recipe and architecture §1 and §4 mention admission
and the registry where they describe what the supervisor owns.

**Status:** OPEN.

## Verdict

To be written when verified.
