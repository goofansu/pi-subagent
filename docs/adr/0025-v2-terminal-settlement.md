# 25. v2 terminal settlement

Date: 2026-09-02

## Status

Accepted for the v2 tree. Supersedes no earlier decision.

Carries forward:

- [ADR-0010](0010-run-endings.md) — the adapter boundary resolves to a
  domain-neutral ending (`answered`, `failed` with an optional fallback message,
  `cancelled`); exit codes and backend stop words never cross it, and a failed
  ending's message is a fallback that never replaces an observation-borne one.
  v2 keeps the union and the derivation rule. ADR-0010's shared executable
  One-shot protocol was already superseded by
  [ADR-0020](0020-run-settlement-through-harness-conformance.md).
- [ADR-0006](0006-completion-notifications-and-result-store.md) — the Result
  store is authoritative and independent of Notification delivery.
- [ADR-0020](0020-run-settlement-through-harness-conformance.md) — a Run settles
  exactly once, each adapter owns its ordering and Ending derivation, and the
  shared conformance surface enforces the observable contract. v2 keeps all
  three.
- The adapter's ordered engine alone settles its execution, and steering
  admission is independent of the ending. v2 keeps both, and generalizes the
  first from the one adapter that needed it to every adapter.
- [ADR-0018](0018-ordered-claude-query-conversation.md) — a provider Result is
  an adapter-local Turn checkpoint, not Run settlement, while earlier guidance
  is outstanding. v2 keeps this distinction for every backend.
- [ADR-0019](0019-backend-neutral-managed-release.md) — immutable independent
  Results and Notifications across resumed Runs, and idempotent close, both
  checked by the shared conformance surface. v2 keeps them.

This ADR supersedes nothing.

Uses the vocabulary of [ADR-0022](0022-v2-terminology-and-backend-field.md).

## Context

v1 settles a Run inside the dispatcher: the adapter's execution resolves to an
ending, the control gate closes, the lifecycle becomes terminal, and the Result
is whatever the mutable record holds at that instant. Delivery then stores it and
pushes a Notification.

Two things about that ordering are load-bearing and easy to lose in a rewrite.
First, the Result must not be observable before the Run's native cleanup has
finished, or a caller can read an answer while a provider process is still
writing files. Second, storing the Result and delivering the Notification are
different operations with different failure modes, and a delivery failure must
never touch the stored Result.

The backend spikes added a third: the Claude spike observed a cancelled Run that
produced **no observations at all** — no assistant frame, no result frame. A Run
can legitimately settle with nothing.

## Decision

### A Run settles exactly once

A Run has exactly one terminal transition, from active to one of `completed`,
`failed`, or `cancelled`. The transition is absorbing: nothing moves a terminal
Run to another state, and a second settlement attempt is a defect, not a
tolerated no-op that silently overwrites.

Cancellation requested before or during execution does not settle the Run;
cancellation is a *request*, and the Run settles `cancelled` only when its
execution and finalizers have finished. Cancelling twice is idempotent.

A Run may settle with **no observations**. That is a valid `cancelled` (or
`failed`) Run with empty output, not an error, and the core must never fabricate
an answer to fill it.

**A Run must be able to settle without the backend's cooperation.** A spike
killed a backend process mid-Run and observed no terminal frame at all, and a
later request that neither resolved nor rejected. An adapter therefore derives
an ending from whatever
evidence it owns — process exit, transport loss, its own bound on a request —
rather than waiting for a terminal frame the backend may never send. Waiting
forever is not a settlement policy.

### Terminal reconciliation happens before settlement

An adapter that has a terminal snapshot may reconcile its streamed projection
with it, once, as the last ordered observation of the Run. Reconciliation is
authoritative per field: a field present in the snapshot replaces its projected
value, a field absent from it retains the streamed value, and a tool left
unfinished is marked with the Run's terminal outcome.

An adapter with no terminal snapshot does not fabricate one. Its streamed
observations remain authoritative.

Reconciliation is part of the Run's own ordered reduction, so it is *not* a late
event mutating a terminal Run ([ADR-0024](0024-v2-observation-ordering.md)): it
happens strictly before the terminal transition.

### A Result cannot be ready before Run-scope finalizers finish

The order is fixed:

1. The native execution resolves to a neutral ending.
2. The Run Scope's finalizers run to completion — native cleanup, subscription
   release, mailbox closure.
3. The Run's observations, including any terminal reconciliation, are fully
   reduced.
4. The Run transitions to terminal and its immutable Result is stored.
5. Only then is the Result observable by `agent_result`, `agent_wait`, and the
   completion Notification.

A caller can never observe a Result while the work behind it is still running.

### Notification failure cannot change or lose a stored Result

Storing the Result and delivering the Notification are separate steps in that
order. Once stored, a Result is immutable and independent:

- A Notification that fails to push, is discarded by an interrupt, or never
  lands leaves the stored Result byte-for-byte unchanged.
- A Notification is never the carrier of the Result. It carries a bounded
  preview and a pointer to `agent_result` by Run id.
- Exactly one landing per Notification. A notice known to have been discarded is
  pushed again after the agent settles; a landed one is never re-pushed.
- A Notification emitted with no live Session is dropped, not queued for the
  next Session. A Result belongs to the conversation that asked for it.

## Consequences

Answers arrive slightly later than they could. A Run that has produced its
terminal text still waits for its finalizers before the Result is readable. That
is the point: the alternative is a caller acting on an answer while a child
process is still holding a lock or writing a file.

Because the Result is stored before the Notification is attempted, a session
that loses every Notification still has every Result addressable by Run id. The
model may not be *told*, but nothing is lost, and `agent_wait` still observes
terminality.

Making settlement absorbing rules out a "correct it afterwards" escape hatch. An
adapter that discovers, after settling, that its ending was wrong has no way to
say so — which forces the ending derivation to be right the first time and is
exactly what the shared conformance battery exists to check.

Allowing a Run to settle with no observations means presentation must have a
sentence for it. v1 already does (`the run finished without output`), and that
prose is reusable.

## Amendment — 2026-09-06

The wait for native execution immediately before step 1 is unbounded while the
Run is running, because a Run may legitimately run without a deadline. Once a
Cancel has requested interruption, that wait is bounded by the cleanup budget.
If the execution does not exit, the core constructs an interruption candidate
with the recorded Cancellation reason, applies the same Cleanup escalation as
a hung step-2 finalizer, and continues the settlement order above unchanged.
The abandoned execution fiber is not awaited by a later settlement step or by
closing the Run, Subagent, or Session Scope.
