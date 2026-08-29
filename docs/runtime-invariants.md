# Runtime Invariants

These invariants define the correctness contract of the subagent runtime.

## Harness seam

Runs are one-shot and backend-neutral. A profile names a harness (default
`pi`); the registry resolves it before dispatch. Pi, Claude, and Codex harness
adapters alone know provider wire messages and translate them into `Fact`
records. The dispatcher,
fold, registry, presentation, and widget consume only those facts.
Input/output/cache counters, turns, and cost on a fact are additive deltas and
the fold sums them. Usage turn deltas are nonnegative finite integers;
`contextTokens` is a latest-value gauge, so the fold
replaces it with the newest reported context size rather than adding it.
Claude emits provisional deltas for unique assistant message ids whose parent
tool-use id is nullish; a missing parent is root-compatible, while a non-null
parent is a sidechain. It reconciles a usable terminal `num_turns` only by
raising the emitted count. Missing message ids contribute no provisional delta,
while a missing, non-finite, negative, or fractional terminal total contributes
zero. Provisional progress is durable if cancellation or backend failure
prevents a terminal result, or if a terminal result reports a lower total.
Claude refusal-fallback `supersedes` and `retracted_message_uuids` do not
decrement prior Facts; the resulting bounded overcount is an accepted
consequence of additive accounting.
Cancellation crosses the seam only as an `AbortSignal`; each adapter owns its
child-specific stop mechanism. Backend
`aborted` is normalized at the seam: the domain records lifecycle `cancelled`
and its reason, never an `aborted` stop reason.

## INV-1 — Run identity is stable

A run ID identifies exactly one subagent run within the current session.

A run ID is never reused for another run.

## INV-2 — Successful start means running

If `agent_start` succeeds, the run has been admitted and is actually running.

There is no hidden queued state.

If the concurrency limit is reached, `agent_start` fails instead.

*Status: the no-queue half holds today. The fail-at-limit half is a target —
the current runtime is deliberately uncapped (ADR-0001); enforcing a limit
re-opens that decision and needs its own ADR.*

## INV-3 — Terminal states are final

A run may transition from `running` to:

- `completed`
- `failed`
- `cancelled`

Once terminal, it never becomes `running` again.

## INV-4 — Results are durable and repeatable

Once a terminal result is stored, calling `agent_result` does not consume it.

The same result may be retrieved repeatedly until the runtime's documented
storage boundary is reached or the session shuts down.

Retrieval is observational: it does not consume the result, pin it, or affect
eviction priority. Storage lifetime is bounded by the store's memory budget,
never by whether the model happened to retrieve a result.

## INV-5 — Wait is observational

`agent_wait` waits for named runs to become terminal and returns their
lifecycle state — id, agent, terminal phase — and nothing else: no preview,
no output, no error text.

It does not consume results, affect result retention, suppress notifications,
or claim delivery ownership.

## INV-6 — Cancellation is idempotent

Requesting cancellation of the same run multiple times is safe.

Cancelling an already-terminal run does not change its terminal state.

## INV-7 — Concurrency is bounded

The number of simultaneously running subagents never exceeds the configured
concurrency limit.

*Status: target — the current runtime is deliberately uncapped (ADR-0001).
Do not regression-test this invariant until the limit exists.*

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

## INV-11 — Terminal runs retain their output

A terminal run retains whatever useful output it produced, subject to the
documented retention boundary.

Terminal status determines how that output is labeled on retrieval, not
whether it is retained:

- `completed` — the complete final output, returned as-is
- `failed` — output produced before the failure, labeled as such
- `cancelled` — output produced up to cancellation, labeled as such

A retrieved partial output must be impossible to mistake for a finished
answer. A run that produced no output says so; an empty "partial output"
section is never manufactured.

## Notification constraints

A completion notification is orientation, not result delivery: it says what
finished, how it finished, and enough to decide whether `agent_result` is
worth calling.

Notification delivery is retried when the host lets a lost push be detected.
That retry is reliability for orchestration, not part of result correctness:
a lost notification never implies lost work (INV-9).

The delivery state machine is:

```text
pending --push--> awaiting-landing --landed--> delivered
                    |
                 known-lost
                    |
                    +--retry--> awaiting-landing
```

An interrupt marks every queued, unlanded notice `known-lost`. A landing that
races that mark wins and makes the notice `delivered`; otherwise agent settle
retries it. Session shutdown moves every unlanded notice to `delivered` without
pushing and releases its run.

### N1 — Notifications are bounded independently of result size

The notification's preview budget is its own constant, not the whole-report
emergency cap.

### N2 — Notifications are inference-free

Constructing a notification performs no model inference and no additional
agent execution. The preview is a deterministic truncation of the run's own
output.

### N3 — Failure notifications are diagnostic

A failed run's notification contains enough failure information (the primary
error message) to diagnose the common case without retrieving the full
result.
