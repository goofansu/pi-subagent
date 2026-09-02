# 30. `Backend.open` has a typed failure channel

Date: 2026-09-02

## Status

Accepted for the v2 tree, implemented in M2.

Amends [ADR-0028](0028-v2-backend-contract.md). That ADR named two deliberate
absences in the backend contract. The first — no cancellation object — stands
unchanged. The second — no error channel — was two rules stated as one, and
this ADR separates them: an **execution** still has no error channel, and
**`open`** now has one.

Carries forward:

- [ADR-0023](0023-v2-scope-ownership.md) — a BackendAgent is Subagent-scoped
  and may begin life unopened in the provider sense. That state is why
  ADR-0028's deferral looked safe.
- [ADR-0025](0025-v2-terminal-settlement.md) — a Run settles exactly once, and
  a Result and a Notification belong to a Run that existed.
- [ADR-0029](0029-v2-effect-schema.md) — the redacted diagnostic this failure
  carries is a domain type with a schema declaration beside it.

## Context

ADR-0028 deferred the question with this reasoning: a backend whose provider
I/O fails while opening can report it through its first execution's `failed`
ending, and the unopened-BackendAgent state makes that natural.

M2 is where that answer had to become code, and it does not survive contact
with [operation semantics section
1](../v2/operation-semantics.md#1-failed-start-admission-allocates-nothing),
which says a failed start creates no public Run, allocates nothing, and emits
no Notification.

Follow the deferred answer through. `agent_start` admits, allocates a
`SubagentId` and a `RunId`, opens the BackendAgent — which fails — and then, in
order to report the failure at all, must:

1. publish a public Run, because a `failed` ending needs a Run to be an ending
   *of*;
2. settle it, storing an immutable Result;
3. emit a completion Notification for it.

The caller receives a Run id. The widget shows a Run. `agent_result` returns a
result. A Notification arrives. All of it describes work that never started —
no provider was ever reached, no prompt was ever sent, no token was ever spent.
That is a Run in every observable sense, for something that did not happen.

The alternative inside the deferral is worse: swallow the open failure, hand
back a BackendAgent that is not open, and let the first execution discover it.
Then the failure is reported one layer further from its cause, and the Run that
carries it is still a Run for work that never started.

The deferral was also load-bearing for a third thing nobody wanted: an open
that *hangs* had no bounded answer at all. `agent_start` would block on a
provider's latency with no way out, which contradicts admission being
synchronous and free of provider I/O.

Two further facts settled the shape of the fix:

- **Resume never opens.** It reuses the BackendAgent its Subagent already
  holds. So this is a change to `StartOutcome` only.
- **An open failure is provider text.** It is usually the provider's own error
  string — a connection refused, an authentication failure, a spawn error —
  which is exactly the class of value [ADR-0024](0024-v2-observation-ordering.md)
  keeps adapter-local.

## Decision

### `open` may fail, with one redacted diagnostic and nothing else

```ts
readonly open: (
  profile: Profile,
  subagent: SubagentContext,
) => Effect.Effect<BackendAgent, BackendOpenFailure, Scope.Scope>;

interface BackendOpenFailure {
  readonly diagnostic: RunDiagnostic;
}
```

The diagnostic has category `backend-failure` and a message the adapter has
already redacted and bounded. There is deliberately nowhere to put a cause, an
exit code, a retry hint, or a provider payload: an adapter that wants to record
what really happened logs it adapter-locally. The contract's shape test asserts
the field list, and a type-level test asserts there is no second field.

### An execution still has no error channel

ADR-0028's rule holds where it was actually about something: the *core* decides
when a Run is terminal and what its Result says, so a backend failure during an
execution is a `failed` ending rather than a failed Effect. An adapter that
fails its Effect anyway, or dies, is classified by the caller as failed with a
redacted `backend-failure` diagnostic and its partial observations retained.

The difference is that an execution has a Run to report through and an open
does not.

### `StartOutcome` gains `backend unavailable`

```ts
| { readonly outcome: "backend unavailable"; readonly diagnostic: RunDiagnostic }
```

It carries no Run id and no Subagent id, because there is no Run and the
caller must never hold an id for work that never started.

`ResumeOutcome` is unchanged.

### Start is three steps, and returns after the third

1. **Admission** — synchronous, atomic, and free of provider I/O: shutting
   down, unknown agent, invalid Profile, delegation depth, the global capacity
   reservation, the guaranteed result reservation, and the allocation of a
   `SubagentId` and a `RunId`.
2. **Open** — the BackendAgent is opened inside the new Subagent Scope, under a
   bounded **open budget** on the runtime clock.
3. **Publication** — the Run is published to the repository and its Run fiber
   is forked.

`agent_start` returns after step 3, so a caller receives either ids for a Run
that exists or a typed rejection. This is a difference from v1, which returns
before any provider work; it is recorded in the operation-semantics document.

### What a failed or timed-out open releases

On failure, and on exceeding the open budget:

- the Subagent Scope is closed, releasing anything the adapter acquired before
  it failed;
- the capacity reservation and the result reservation are released;
- nothing is published to the repository;
- no Notification is sent;
- **the identifiers stay spent**, because no identifier is ever reused;
- `backend unavailable` is returned.

An open that exceeds the budget is interrupted and then treated exactly as an
open failure, with a diagnostic saying the budget was exceeded. There is one
release path, not two.

## Consequences

Operation semantics section 1 now holds for opens as well as for admission.
Nothing observable is created for work that never started.

`agent_start` can block for as long as the open budget and no longer. That is a
real change from v1, and it is the price of the guarantee above: a caller that
holds a Run id holds one for a Run whose backend is open.

The fakes gain three script controls — fail open with a reason, hang open until
interrupted, and hang in the execution scope's finalizer — because open
failure, the open budget, and cleanup escalation are otherwise untestable.

The wider lesson, which is the same one ADR-0029 recorded a day earlier: a
deferral is only as good as the case it was checked against. ADR-0028 checked
"a backend that cannot reach its provider" and found an answer. It did not
check that answer against the document that had already decided what a failed
start may create.
