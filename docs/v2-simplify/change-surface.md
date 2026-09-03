# The change-surface measurement

**Status:** method decided; baseline **estimated** from reading the tree, to
be **measured** in Phase A and re-measured at every phase gate.
**Why this document exists:** the v2 definition of done asked for less
lifecycle machinery than v1 and [the deletion ledger](../v2/deletion-ledger.md)
found more by every honest count. That count was the wrong instrument. This is
the replacement, and the roadmap's evolvability claims are made in its units.

## The metric

**Change surface** is the number of production modules a representative change
touches, split into two counts:

- **Generic lifecycle modules** — everything under `runtime/`, and the parts
  of `domain/` that the runtime reads: ids, phases, observations, reduce-run,
  reconcile-run, result, result-bounding, endings, usage, outcomes. A change
  that touches one of these is a change to how every Run lives, whatever it
  was meant to do.
- **Total production modules** — every non-test `.ts` file under
  `extensions/subagent/`, including `domain/`, `presentation/`, `host/`,
  `application/`, `profiles/`, and `backend/`.

Tests, fixtures, and documents are not counted. They are expected to change
with every change and counting them would reward writing fewer tests.

A module is "touched" if the diff modifies it. A rename-only diff counts; the
metric is about what a reviewer has to read, and a reviewer reads a rename.

## Why this and not lines

Lines reward deletion and punish proof. The rewrite grew because it added a
conformance kit, a Codex protocol layer, and tests that drive every bound past
its limit, and every one of those should stay. What the review actually
faulted was that a contributor must understand settlement, arbitration,
projections, pins, delivery claims, landing, and host turns before making a
safe cross-cutting change. That is a statement about coupling, and coupling is
what change surface measures: **how many unrelated files change together.**

## The representative changes

Six changes, chosen because each one is something the product will actually
need, and together they exercise every seam the architecture claims to have.

| # | Representative change | Seam it exercises |
| --- | --- | --- |
| R1 | Change the wording of a completion notice. | Presentation depends on projections only. |
| R2 | Add a field to the completion notice (say, the Run's duration). | Domain projection → formatter; nothing in the runtime should notice. |
| R3 | Add a Profile option that only one backend understands. | Backend-owned Profile validation; the generic parser knows three fields. |
| R4 | Add a display-only column to the widget. | Repository read model → rows; the supervisor is not involved. |
| R5 | Add a fourth backend that supports resume and steering. | The backend contract; zero generic lifecycle change. |
| R6 | Change terminal lifecycle (say, a new terminal phase). | Allowed to be expensive; this row is the control. |

## Targets

| # | Generic lifecycle modules | Total production modules |
| --- | ---: | ---: |
| R1 | 0 | ≤ 2 |
| R2 | 1 (`domain/notification.ts`) | ≤ 4 |
| R3 | 0 | ≤ 2 |
| R4 | 0 | ≤ 2 |
| R5 | 0 | backend tree + composition + backend set |
| R6 | expensive | expensive |

## Baseline, estimated

Estimated by reading the tree at `2.0.0-rc.2` and listing which modules each
change would have to touch today. **This column is a reading, not a
measurement**, and the Phase A ticket that measures it replaces these figures
with counts taken from real diffs. Where a figure already meets its target
the programme's job is to fence it; where it does not, the phase that fixes it
is named.

| # | Estimated generic | Estimated total | Modules that would move today | Meets target? |
| --- | ---: | ---: | --- | --- |
| R1 | 0 | 1–2 | `presentation/notification-text.ts`; `presentation/renderers.ts` if the collapsed summary moves too. | Yes. Phase A fences it (notification text depends on `RunNotification` alone). |
| R2 | 1 | 3–4 | `domain/notification.ts`, `presentation/notification-text.ts`; `host/notification-message.ts` and `presentation/renderers.ts` if the summary shows it. | Yes, at the edge. Phase A's slimmer notice makes the host payload independent of the notice's shape. |
| R3 | 0 | 2 | `profiles/*` schema and the owning `backend/<name>/*` validator. | Yes. Nothing to do but keep it so. |
| R4 | 0 | 2 | `presentation/rows.ts`, `host/widget.ts`; more if the snapshot needs a field, which is `domain/projection.ts` and `domain/reduce-run.ts` and would break the target. | Yes for a column the snapshot already carries. Phase C4's shared completion view keeps it there for terminal facts. |
| R5 | 0 | backend tree + `runtime/composition.ts` + `host/production-backends.ts` + a conformance adapter | The M5 and M6 ports were adapter-local plus fixtures; nothing since has added a backend branch to the runtime. | Yes. Fenced by the provider-confinement boundary rules. |
| R6 | many | many | `domain/phases.ts`, `domain/reduce-run.ts`, `domain/result.ts`, `runtime/arbitration.ts`, `runtime/run-scope.ts`, `runtime/supervisor.ts`, presentation status helpers. | Expected. |

The reading says the seams the roadmap cares about already hold. What does
not hold is inside the counts: R1 and R2 are cheap in modules but expensive in
reading, because the notice copies the whole usage schema and the formatter
has three structural branches, and any change to the supervisor is expensive
in reading because one 994-line module owns admission, registry, control, and
waiter bookkeeping together. The change-surface metric will not show that
second kind of cost; the Phase B gate's "reads like orchestration" criterion
is what does.

## How to measure

Once per phase gate, for each representative change:

1. Make the change on a throwaway branch, as small as it can honestly be. For
   R5 and R6 a written plan listing the modules is acceptable; nobody builds a
   backend to measure a number.
2. `git diff --name-only <base>` and count production modules by the two
   definitions above.
3. Record the two counts and the module list in the table below. Delete the
   branch.

For R1 and R2 in Phase A, the programme's own commits are the measurement:
the tickets that reword the notice and add the label and duration *are* R1
and R2, and their diffs are counted directly.

## Measured

| Gate | R1 | R2 | R3 | R4 | R5 | R6 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Phase A | — | — | — | — | — | — | Not yet measured. |
| Phase B | — | — | — | — | — | — | |
| Phase C | — | — | — | — | — | — | |

Each cell reads `generic / total`. A cell that exceeds its target is a gate
failure for that phase, not a note.
