# The change-surface measurement

**Status:** method decided; baseline **measured at the Phase A gate** from
this phase's own diffs and one throwaway branch, and to be re-measured at
every phase gate. The estimated column below is **superseded** by the measured
table.
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

## Baseline, estimated — **superseded**

**Superseded by [the measured table](#measured) at the Phase A gate.** Kept
because a wrong estimate is worth being able to see: the notes after the
measured table say which of these readings was wrong and why.

Estimated by reading the tree at `2.0.0-rc.2` and listing which modules each
change would have to touch today. **This column was a reading, not a
measurement**, and the Phase A ticket that measured it replaced these figures
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

Each cell reads `generic / total`. A cell that exceeds its target is a gate
failure for that phase, not a note.

| Gate | R1 | R2 | R3 | R4 | R5 | R6 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Phase A | **0 / 2** | **0 / 3** | **0 / 3** | **0 / 1** | **0 / 8–12** | **9 / 14** | R1, R2 and R4 meet their targets; R3 exceeds by one module. See the module lists and the findings below. |
| Phase B | — | — | — | — | — | — | |
| Phase C | — | — | — | — | — | — | |

The tree at the gate holds **103 production modules**, of which **23 are
generic lifecycle** — thirteen under `runtime/` and the ten named `domain/`
files.

### Method, so this can be repeated

Base commit: `124fd50` (`docs(v2-simplify): the simplification programme,
decided before code`), the commit before Phase A's first.

```sh
# per-ticket, for R1, R2 and R6's control reading
git diff --name-only <before>..<after>
# then classify: production = *.ts under extensions/subagent/, excluding
# *.test.ts and everything under testing/; generic = runtime/* plus the ten
# named domain files.
```

R3 and R4 were made on a throwaway branch off `1991b68`, measured the same
way, and the branch was deleted. R5 and R6 are written module lists, checked
against [the recipes](change-recipes.md).

### R1 — change the wording of a completion notice

**0 / 2.** Target 0 / ≤ 2. **Meets.** Measured from ticket 03
(`143dea1`), which rebuilt the notice as four sections, labelled and quoted
the preview, and gave every status the availability sentence and the pointer.

- `domain/notification.ts`
- `presentation/notification-text.ts`

The wording *alone* is one module: `domain/notification.ts` moved only because
the pointer needs `resultAvailability`, which is an R2-shaped change riding in
the same ticket. A pure reword after this phase is **0 / 1**, and boundary
rule 20 is what keeps it there — `presentation/notification-text.ts` may
import only from `domain/` and `presentation/`.

### R2 — add a field to the completion notice

**0 / 3.** Target 1 / ≤ 4. **Meets, and better than target.** Measured from
ticket 04 (`5712226`), which replaced the Result's whole `UsageSnapshot` and
its `model` with a bounded `NotificationAccounting`.

- `domain/notification.ts`
- `presentation/notification-text.ts`
- `presentation/run-card.ts` — because the card prints the same four figures
  and now reads them through the same domain conversion

Zero generic, where the target allowed one: the estimate assumed a notice
field is a `domain/notification.ts` change and that file is not on the generic
list. The estimate's "1 generic" was wrong about which list
`domain/notification.ts` is on.

Ticket 02 (`2d6269f`) also added notice fields — `label` and `durationMillis`
— and measures **2 / 8**. That is not R2's number: eight modules is a notice
field *plus* a new domain bound applied at admission, and the two generic
modules are both the bound's. Decomposed:

| Part | Modules | Generic |
| --- | --- | ---: |
| the notice fields | `domain/notification.ts`, `presentation/notification-text.ts`, `presentation/status.ts` | 0 |
| the label bound at admission | `domain/result.ts`, `domain/text.ts`, `application/subagents.ts`, `runtime/supervisor.ts`, `host/tool-schemas.ts` | 2 |

See finding 2 below: "add a bound enforced at admission" is a representative
change this table does not have a row for, and it is the more expensive half.

### R3 — add a Profile option that one backend understands

**0 / 3.** Target 0 / ≤ 2. **Exceeds by one module.** Measured on the
throwaway branch by adding a Claude-only boolean option
(`includePartialMessages`) that the SDK understands and no other backend does.

- `backend/claude/profile.ts` — declares the field in `ownFields`, reads it
- `backend/claude/options.ts` — applies it to the Query's options
- `backend/profile-fields.ts` — a `readOwnFields` hook, so a bad value earns a
  Profile diagnostic instead of throwing inside the adapter later

The third module is the finding. See finding 1.

### R4 — add a display-only column to the widget

**0 / 1.** Target 0 / ≤ 2. **Meets, and better than target.** Measured on the
throwaway branch by adding a tool-count column to the widget row.

- `presentation/rows.ts`

`host/widget.ts` did not move: the widget passes rows to `renderRunRows` and
the row decides its own columns, and the snapshot already carries `tools`.
The estimate said two because it assumed the host would have to change; it
does not, for a column the snapshot carries.

### R5 — add a fourth backend that supports resume and steering

**0 / 8–12.** Target: the backend tree plus composition plus the backend set.
**Meets.** A written module list, checked against
[the "Add a backend" recipe](change-recipes.md#add-a-backend).

| Module | Why |
| --- | --- |
| `backend/<name>/backend.ts` | the `Backend`: id, capabilities, `open` |
| `backend/<name>/agent.ts` | the `BackendAgent` and its retained conversation |
| `backend/<name>/execution.ts` | one Run's execution, controls, terminal bundle |
| `backend/<name>/translate.ts` | provider events → domain observations |
| `backend/<name>/profile.ts` | Profile validation and the model rule |
| `backend/<name>/probe.ts` | what the adapter is still holding |
| `backend/<name>/index.ts` | the four things the composition root may name |
| `host/production-backends.ts` | registration and the probe block |
| up to four more under `backend/<name>/` | a transport, a reader, a protocol, a process, if the provider needs them — Codex needs all four and has eleven modules; Claude has ten, Pi twelve |

**Nothing generic.** `runtime/composition.ts` does not move: it takes a list
of backends and knows none of them by name. `domain/ids.ts` does not move
either — `BackendId` is a branded string and deliberately not an enum. The
only generic-code mention of any backend's name anywhere is
`host/production-backends.ts`, which is the registration seam and is the one
module on the list outside the adapter tree.

Not counted, and expected: a conformance file under `testing/`, a live smoke
script under `scripts/`, and the matrix's proof tables.

### R6 — change terminal lifecycle

**9 / 14.** The control row: this is *allowed* to be expensive, and the number
is here so the others can be read against something. A written module list for
adding a terminal phase, checked against
[the recipe](change-recipes.md#change-terminal-lifecycle).

Generic (9): `domain/phases.ts` (the phase), `domain/endings.ts` (the ending
that produces it), `domain/reduce-run.ts` and `domain/reconcile-run.ts` (how
a projection absorbs it), `domain/result.ts` (the terminal status),
`runtime/arbitration.ts` (which candidate wins), `runtime/run-scope.ts` (the
settlement path), `runtime/supervisor.ts` (the operations that report it), and
`runtime/repository.ts` (the legal transitions).

Not generic (5), and all of them surfaces that name a status:
`domain/notification.ts`, `presentation/status.ts`, `presentation/rows.ts`,
`presentation/notification-text.ts`, `host/notification-message.ts`.

Nine generic modules against R4's zero and R1's zero. That ratio — a
lifecycle change is expensive and every other representative change is not —
is the whole point of the metric.

## Findings

Recorded rather than softened, per the Phase A gate's item 11.

**Finding 1 — R3 exceeds its target by one module (`0 / 3` against `0 / ≤ 2`).**
A backend-owned Profile option cannot be validated without a hook in
`backend/profile-fields.ts`, because that module owns the one `try` per field
that turns a bad value into a Profile diagnostic instead of an exception
inside the adapter. The alternative — validating in the adapter — would give
the adapter its own diagnostic path and is worse. The honest reading is that
the target was set one too low: the shared module is a *parameterisation*
point rather than a place backend knowledge accumulates, and the option's
vocabulary still never leaves `backend/claude/`. The Phase B gate should
either raise R3's target to three or record the same finding again.

**Finding 2 — the table has no row for "add a bound enforced at admission",
and it is more expensive than any row it has.** Phase A's label bound touched
five modules, two of them generic, because a bound applied where tool input
becomes a request has to be declared in the domain, applied in the façade, and
carried through the supervisor to reach the Run's diagnostics. Every future
bound on caller-supplied input will cost the same. The Phase B gate should add
it as R7 with a target, measured from Phase A's own decomposition above as the
baseline.

**Finding 3 — two estimates were wrong, both in the safe direction.** R2's
estimate claimed one generic module and the measurement found none, because
`domain/notification.ts` is not on the generic-lifecycle list. R4's estimate
claimed two modules and the measurement found one, because the widget passes
rows through and does not lay them out. Neither error changed a verdict.
