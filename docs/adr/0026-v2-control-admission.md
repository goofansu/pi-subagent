# 26. v2 control admission

Date: 2026-09-02

## Status

Accepted for the v2 tree. Supersedes no earlier decision.

Carries forward:

- [ADR-0012](0012-ordered-codex-steering.md) — an accepted admission is ordered
  before its offer returns; only the adapter's ordered engine may initiate
  native steering; cancellation-first closes admission before a later Control
  can be sent. v2 keeps all three, generalized to every backend.
- [ADR-0018](0018-ordered-claude-query-conversation.md) — one correlated Control
  is provider-visible at a time, and only provider echo or correlation reports
  the neutral user observation.
- [ADR-0019](0019-backend-neutral-managed-release.md) — Control capability is
  declared per prepared Run and checked by the shared conformance surface.
- [ADR-0010](0010-run-endings.md) — a Control's fate never reaches the neutral
  ending vocabulary. Admission, delivery, and rejection are separate from how a
  Run ends, and v2 keeps them separate.
- [ADR-0020](0020-run-settlement-through-harness-conformance.md) — settlement
  closes admission rather than draining it, and the shared conformance surface
  is what proves each adapter honours that. v2 keeps both.

This ADR supersedes nothing.

Uses the vocabulary of [ADR-0022](0022-v2-terminology-and-backend-field.md), and
matches [operation semantics §7](../v2/operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome)
and [§5](../v2/operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins)
exactly.

## Context

`agent_steer` is called from inside a model's turn. If admission could block —
on a provider round trip, on a queue with no bound, on a lock — a steering call
would hold the caller's turn hostage to a backend's latency.

v1 answered this with a bounded, synchronous, single-consumer Control source and
a strict rule that `accepted` means only that the text entered the local
mailbox. That rule is easy to erode: `accepted` reads like a promise, and every
backend has *some* moment that feels like confirmation. v2 states the boundary
as a decision.

## Decision

### One bounded mailbox per Run

Each active Run owns exactly one Control mailbox, created with its Run Scope and
closed with it. The mailbox is **bounded** on three axes, carried forward from
v1 unchanged:

| Bound | Value |
| --- | --- |
| Pending admissions | 16 |
| Bytes per message | 16 KiB of UTF-8 |
| Total pending bytes | 64 KiB |

A mailbox is never shared between Runs and never becomes reusable Subagent
state. A Control admitted to one Run can never reach the Subagent's next Run.

### Admission is synchronous and never blocks

`agent_steer` returns an outcome immediately, in the caller's turn, without
awaiting any provider work. The outcomes are exactly those in
[operation semantics §7](../v2/operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome):
`accepted`, `mailbox full`, `invalid`, `unsupported`, `mailbox closed`,
`already <status>`, `unknown Run`.

Validation of the text precedes identity lookup, so malformed text gets one
answer whether or not the Run id exists.

A **full mailbox returns `mailbox full`**. It does not block, does not drop an
older admission to make room, and does not truncate the new message. The caller
decides what to do; the caller must not retry in a loop.

### Local acceptance never implies provider confirmation

`accepted` means one thing: the complete message synchronously entered this
Run's bounded mailbox and reached its single consumer. It does **not** mean the
adapter dequeued it, a provider accepted it, or a model consumed it.

Only **authoritative provider evidence** that the guidance was consumed becomes
a neutral observation on the Run. Local admission, native request acceptance,
and provider echo without correlation do not. An adapter that cannot correlate a
Control to provider evidence reports no observation for it and fabricates
nothing.

Consequently a Control may be admitted and never appear in the transcript. That
is honest, not a bug.

### Ordering

An accepted admission receives its ingress order during the synchronous offer,
before the offer returns — the same ordering point as any other occurrence
entering the adapter ([ADR-0024](0024-v2-observation-ordering.md)). Controls are
delivered to the backend in FIFO order.

Cancellation and admission share that ordering point. A Control admitted before
a synchronously later cancellation is ordered before it; a cancellation ordered
first closes the mailbox before any later Control can be admitted.

### Closure rejects new Controls

The mailbox closes when the Run settles, when cancellation is admitted, or when
Session shutdown begins — whichever comes first. From that instant every offer
returns `mailbox closed`, and admissions that were never sent to the backend are
discarded. Settlement does not wait for the mailbox to drain.

Once shutdown begins, Controls are rejected as **shutting down** before any
mailbox is consulted
([operation semantics §5](../v2/operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins)).

## Consequences

A model can steer a Run without any risk of stalling its own turn, and it always
gets an answer it can act on. The price is that `accepted` is a weaker promise
than it sounds, which has to be said in the tool description as well as here —
v1's `agent_steer` description already does, and that prose is worth porting
verbatim.

Bounding at 16 pending admissions means a model that steers in a tight loop is
told to stop rather than being allowed to build an unbounded backlog. That is
the intended behaviour: a full mailbox is feedback, not a failure.

Refusing to report an observation for an uncorrelated Control means the
transcript can be missing guidance that was genuinely delivered. That is
deliberate — the alternative is a transcript that claims a model saw something
it may not have.

Because the mailbox dies with its Run, a Control offered in the window between a
Run settling and the caller learning about it is rejected rather than applied to
the next Run. That is the correct outcome, and it is why the outcome names the
Run's terminal status rather than saying "unknown".
