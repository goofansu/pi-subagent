# 4. Shared mutable run record

Date: 2026-08-24

## Status

Superseded by [ADR-0005](0005-executor-reports-facts.md).

## Context

A run exists as one mutable `SingleResult`, written by three hands: the
dispatcher creates it and settles its lifecycle, the executor streams a dozen
fields into it as NDJSON events arrive, and the settle helpers in `run.ts`
overwrite its outcome fields at the end. Presentation reads the failure text
back in the priority order the executor populates (`errorMessage`, then
`stderr`, then the transcript), with nothing but convention keeping the two
sides in agreement.

The shape buys cheap live progress: the executor mutates and calls `emit()`,
which carries no payload, and the widget reads the shared record at render
time. No event plumbing, no copies, and single-threaded execution means no
races.

The cost is an executor interface far larger than its type. An executor must
resolve rather than reject on failure or abort, must never set `status` (a
runtime throw in `settleResultLifecycle` is the only enforcement), and must
populate outcome fields in the order presentation expects. These invariants
live in doc comments. Write-ordering bugs are a real class here, not a
hypothetical: `settleAborted`'s own comment records one — a stream frame set
`errorMessage`, the child recovered, and a later cancellation named a cause
that was not what ended the run. The fix was a rule in a third module.

The deepening is known: move ownership of the event fold (`applyPiJsonEvent`)
to the dispatcher, so the executor reports events across the seam instead of
writing the record, the dispatcher becomes the record's only writer, and
delivery and the registry read a settled outcome. Activity would be computed
on the executor's side and stored as a plain field, which also removes the
registry's import of the pi message wire format (`deriveActivity`).

## Decision

The record stays shared and mutable for now. The deepening is deferred, not
rejected: its payoff is insurance against a bug class that has struck once,
while its churn lands in the most-touched file (`pi-agent.ts`) and in every
stand-in executor across the test suites.

## Consequences

The executor contract remains enforced by documentation and one runtime
throw, and the failure-text priority remains duplicated knowledge between
`pi-agent.ts` and `presentation.ts`.

Re-open this decision — and do the deepening as part of that change, when the
churn buys its way in — on either trigger:

- a run displays or reports something wrong and the diagnosis crosses two of
  the record's three writers, or
- an outcome field is added to `SingleResult`.

Do not re-suggest the deepening cold in future architecture reviews; cite one
of the triggers.
