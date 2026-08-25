# Runtime Invariants

These invariants define the correctness contract of the subagent runtime.

## INV-1 — Run identity is stable

A run ID identifies exactly one subagent run within the current session.

A run ID is never reused for another run.

## INV-2 — Successful spawn means running

If `subagent({ action: "spawn" })` succeeds, the run has been admitted
and is actually running.

There is no hidden queued state.

If the concurrency limit is reached, `spawn` fails instead.

## INV-3 — Terminal states are final

A run may transition from `running` to:

- `completed`
- `failed`
- `cancelled`

Once terminal, it never becomes `running` again.

## INV-4 — Results are durable and repeatable

Once a terminal result is stored, calling `result()` does not consume it.

The same result may be retrieved repeatedly until the runtime's documented
retention boundary is reached.

## INV-5 — Await is observational

`await()` only waits for runs to become terminal.

It does not consume results, claim delivery ownership, or otherwise change
the result's availability.

## INV-6 — Cancellation is idempotent

Cancelling the same run multiple times is safe.

Cancelling an already-terminal run does not change its terminal state.

## INV-7 — Concurrency is bounded

The number of simultaneously running subagents never exceeds the configured
concurrency limit.

## INV-8 — Shutdown cleans up running work

When the parent session shuts down, every running subagent is asked to stop
and is eventually cleaned up.

## INV-9 — Results do not depend on notifications

A failure to send or land a follow-up notification cannot destroy,
consume, or invalidate a completed result.

Follow-up is notification only; the result store is authoritative.

## INV-10 — Presentation does not own runtime state

TUI rendering and notification state may observe the runtime, but they do not
determine whether a run is running, terminal, cancelled, or has a result.
