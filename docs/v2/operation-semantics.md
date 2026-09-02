# v2 public operation semantics

**Status:** Specified. No v2 code implements this yet; M1 and M2 do.
**Audience:** model authors calling the tools, and maintainers implementing them.
**Vocabulary:** Subagent, Run, Result, Notification, Control, BackendAgent,
backend — as defined in `CONTEXT.md` and
[the v2 roadmap](roadmap.md).

This document decides, once and before implementation, what a caller observes
from every public operation in every edge case. Each section ends with a
**Difference from v1** note, because M0 changes no v1 behaviour: where v1
already behaves this way the note says so, and where v2 will differ the
difference is recorded here rather than fixed in the frozen tree. The
compatibility matrix cites this document from every cell it marks as an
intentional change.

The eight sections below are the eight operation-semantics bullets of roadmap
milestone M0.

---

## 1. Failed start admission allocates nothing

`agent_start` and `agent_resume` admit before they allocate. Admission is the
single synchronous decision point for everything that can be decided without
provider I/O; everything that happens after it belongs to a public Run.

When admission fails:

- **No public Run is created.** The caller receives a typed rejection, not a
  Run id, and nothing appears in `/agents` or the active widget.
- **No identifier is ever reused.** Identifiers that were allocated and then
  released stay spent for the life of the Session. A caller holding a Run id
  or Subagent id can always trust that it means one thing.
- **Everything reserved is released.** The Run Scope, the global capacity
  reservation, the one-active-Run claim on the Subagent, and any retained
  native resource opened during preparation are all released before the
  rejection returns. A failed start leaves no BackendAgent alive.
- **No Notification is emitted**, because no Run existed to complete.

Rejection reasons a caller can observe from `agent_start`: unknown agent,
invalid profile, at capacity, shutting down, delegation-depth exceeded,
`backend unavailable`.
From `agent_resume`: unknown Subagent, Subagent already running, resume
unsupported by the backend, Conversation loss, at capacity, shutting down.

### `agent_start` awaits the backend opening

`agent_start` has one step that admission cannot decide, because it is the one
step that talks to a provider: opening the Subagent's BackendAgent. The call
therefore returns only after that open has either succeeded or failed, and it
is bounded by an **open budget** so a backend that hangs while opening cannot
hold the caller.

`backend unavailable` is what the caller observes when the open fails or
exceeds its budget. It carries the backend's redacted diagnostic and **no Run
id**, and everything above still holds: no public Run, no Notification,
capacity and result reservations released, the Subagent Scope closed, and the
identifiers that were allocated left spent. A caller never holds an id for work
that never began.

`agent_resume` has no such outcome, because resume reuses the BackendAgent its
Subagent already holds and opens nothing.

See [ADR-0030](../adr/0030-v2-backend-open-failure.md).

**Difference from v1.** v1 already creates no Run and reuses no identifier when
`agent_resume` is rejected (`subagents.ts` returns before dispatch; `runs.ts`
keeps `issuedIds` spent until Session reset). v1 has no global capacity, so it
has no at-capacity rejection at all, and `agent_start` throws on an unknown
agent rather than returning a typed outcome. v2 makes at-capacity a typed
rejection and folds the unknown-agent throw into the same typed shape.

v1 `agent_start` also **returns before any provider work**: it creates the Run
and dispatches it, and a backend that cannot start is discovered later and
reported as that Run failing. v2 returns after the open instead, so a start
that could never have run is a rejection rather than a Run with a Result and a
Notification for work that never happened. This is an intentional change, and
the reason it is worth the wait is recorded in ADR-0030.

---

## 2. Start and resume admission are atomic

Admission enforces two invariants in one indivisible step, before any provider
I/O:

1. **Global capacity.** The Session admits at most a configured number of
   active Runs across all Subagents.
2. **One active Run per Subagent.** A Subagent that is already running rejects a
   second Run.

Concurrent calls therefore have exactly one winner. The loser learns
immediately.

At capacity the operation is **rejected immediately**. Nothing is queued,
nothing is retried, and no Run is created that a later capacity release would
start. A caller that wants the work done retries the call itself.

Admission performs no provider I/O, so a rejection costs no provider quota and
opens no native conversation.

**Difference from v1.** v1 enforces one active Run per Subagent exactly this
way, with the synchronous `admittingRun` claim as the linearization point.
v1 has **no global capacity limit** — that is the deliberate decision in
[ADR-0001](../adr/0001-unbounded-subagent-concurrency.md). Adding a global
capacity with immediate rejection is an intentional v2 change.

---

## 3. Cancellation is idempotent and distinguishes request from terminal

`agent_cancel` takes Run ids and answers about **request admission**, never
about whether the Run has already stopped.

- The first cancel of an active Run is **admitted**: the request was recorded,
  the Control mailbox closed, and cancellation forwarded to the Run Scope.
- A repeated cancel of the same Run is **idempotent**: it changes nothing, does
  not re-forward, does not produce a second Notification, and does not turn an
  admitted request into an error.
- A cancel of a Run that has already settled reports **already terminal** with
  the Run's terminal status. Its stored Result stands unchanged.
- A cancel of an unknown Run id reports **unknown Run**.

Terminal cancellation is a separate, later fact. The Run reaches its terminal
`cancelled` state only after Run-scope finalizers finish and its observations
are reduced; that is when the completion Notification arrives and when
`agent_result` returns partial output. A caller that needs to know the Run has
actually stopped waits for the Notification or calls `agent_wait`.

Cancelling a Run does **not** close its Subagent. The Subagent returns to idle
and remains resumable if its backend still holds the Conversation.

**Difference from v1.** v1 behaves this way. `runs.cancel` skips Runs that
already carry a cancellation reason or are terminal, and `delivery.cancel`
partitions ids into `cancelled`, `alreadySettling`, `finished`, and `unknown` —
the same request-versus-terminal distinction under different names. v2 keeps
the semantics and renames the outcomes to the vocabulary above.

---

## 4. Closing a Subagent with an active Run is cancel-and-await-cleanup

There is **no new model tool** for closing a Subagent. Closing happens through
the existing host and session surface: Session shutdown closes every Subagent.

The policy when a Subagent with an active Run is closed is
**cancel-and-await-cleanup**, in this order:

1. The Subagent is marked closed. From this instant it admits no new Run, and no
   late settlement can move it back to idle.
2. Its active Run is cancelled, exactly as `agent_cancel` would.
3. The close waits for the Run Scope's finalizers and the BackendAgent's native
   cleanup to finish.
4. The Subagent Scope closes, releasing the BackendAgent and everything beneath
   it.

The cancelled Run still settles exactly once, with partial output, and still
stores its Result. Whether that Result is observable afterwards depends on
whether the Session is also shutting down — see section 5.

**Difference from v1.** v1 behaves this way for the only close it has.
`subagents.shutdown()` marks every Subagent closed first, then cancels active
Runs, then awaits every adapter's `close()`. v1 has no way to close one
Subagent independently of the Session, and v2 M0 introduces none.

---

## 5. Shutdown rejects new work as soon as it begins

Session shutdown has one observable instant at which it begins. From that
instant, and before any cleanup work runs:

- `agent_start` and `agent_resume` are rejected with **shutting down**. No Run
  is created.
- Controls (`agent_steer`) are rejected with **shutting down**. Nothing is
  admitted to any mailbox.
- `agent_cancel` on an active Run is redundant but harmless: shutdown is already
  cancelling it.
- `agent_wait` returns rather than blocking past shutdown.

Shutdown is **idempotent**: a second shutdown is a no-op, not an error, and
never double-cancels or double-closes.

Shutdown then cancels every active Run, closes every Subagent by the
cancel-and-await-cleanup policy of section 4, drops every Notification that has
not landed, clears the Result store, and forgets every local Subagent and Run
identity. The next Session's model did not start these Runs and has no context
in which to act on their answers, so their Results do not survive.

**Difference from v1.** v1 rejects new work at shutdown, but by a different
mechanism and slightly later: `subagents.shutdown()` marks records closed
synchronously, which makes `resume` return `unknown subagent`, and
`delivery.shutdown()` clears pending state, which makes `steer` return
`unknown run`. v2 makes shutting-down its own typed outcome rather than
reporting it as an unknown identifier. Everything else — cancel, drop unlanded
Notifications, clear the store, forget identities — v1 already does.

---

## 6. Aborting `agent_wait` stops only that waiter

`agent_wait` observes terminality. It never owns a Run.

- Aborting the calling turn, or the wait's own signal, ends **only that wait**.
  The Run continues, still settles exactly once, still stores its Result, and
  still emits its completion Notification.
- A wait that gives up returns the ids that are still running as a normal
  outcome, not an error. A still-running result means the wait ran out of
  patience, not that the Run broke.
- A timeout behaves identically to an abort: only the waiter stops.
- Repeated waits on the same ids return the same lifecycle state. Waiting is not
  consuming: it does not release a Result, suppress a Notification, or change
  the Result store.
- Waiting on an unknown id reports it as unknown rather than blocking forever.

**Difference from v1.** v1 behaves this way. `withDeadline` resolves rather than
rejects on timeout or abort and touches nothing else; `wait` reads the Result
store and the pending map without mutating either.

---

## 7. A full control mailbox returns an immediate typed outcome

Every active Run owns one **bounded** Control mailbox. `agent_steer` admits
into it synchronously and never blocks the caller's turn.

Outcomes:

| Outcome | Meaning |
| --- | --- |
| `accepted` | The complete message entered this Run's bounded mailbox. Nothing more. |
| `mailbox full` | The mailbox is at its bound. The message was not admitted; nothing was truncated or dropped silently. |
| `invalid` | The text is empty, whitespace-only, or over the per-message byte bound. |
| `unsupported` | This Run's backend declared no steering Control. |
| `mailbox closed` | The Run is settling, cancelled, or shutting down; admission is closed. |
| `already <status>` | The Run is terminal. Its terminal status is named. |
| `unknown Run` | No Run in this Session has ever had this id. |

`accepted` is a statement about the local mailbox only. It does **not** mean the
adapter dequeued the message, the provider accepted it, or a model consumed it.
Only authoritative provider evidence of the guidance becomes an observation on
the Run. A caller must not retry on `accepted`, and must not resend in a loop.

Mailbox closure rejects new Controls. Cancellation discards admissions that were
never sent.

**Difference from v1.** v1 behaves this way, with the same bounds
(`CONTROL_MAX_PENDING = 16`, `CONTROL_MAX_MESSAGE_BYTES = 16 KiB`,
`CONTROL_MAX_PENDING_BYTES = 64 KiB`). v1 spells the outcomes
`queue full`, `not steerable`, and `unsupported`; v2 renames `queue full` to
`mailbox full` and `not steerable` to `mailbox closed` so that the name says
which fact it reports.

---

## 8. An evicted Result returns a distinct typed outcome

The Result store is bounded by a total character budget. When the budget is
exceeded, the **oldest** stored outputs are evicted first; the newest Result is
never evicted. Eviction removes the output, never the entry: the Run id remains
addressable with its terminal status and its owning Subagent.

`agent_result` therefore has four distinct outcomes, and a caller can tell them
apart:

| Outcome | Meaning |
| --- | --- |
| the Result | The Run settled and its output is retained. |
| `ResultExpired` | The Run settled, but its output was evicted to keep the store bounded. The Run's identity and terminal status are still reported. |
| `RunNotTerminal` | The Run exists and is still active. Its Notification will arrive on its own. |
| `unknown Run` | No Run in this Session has ever had this id. |

`ResultExpired` is a distinct typed outcome, **not** an unknown-Run error. A
spent identifier and a wrong identifier are different mistakes and get different
answers.

Requesting a Result does not consume, pin, or reorder it. Reading a Result never
changes what eviction does next.

**Difference from v1.** v1 already distinguishes these four cases, but not as
typed outcomes: an evicted Result is a normal successful read whose body is the
sentence "This run's full output was evicted to bound result-store memory."
(`presentation.ts`, `formatResultBody`), and a not-yet-terminal Run is a
sentence from `formatAgentResultUnavailable`. v2 makes `ResultExpired` and
`RunNotTerminal` typed outcomes that the presentation layer renders, rather than
prose the caller has to read. The store's budget, oldest-first eviction order,
and newest-survives rule are unchanged.

---

## What this document does not decide

- Which backend supports which operation. That is the
  [compatibility matrix](compatibility-matrix.md).
- How scopes own each other, how observations are ordered, when a Run settles,
  how Controls are admitted internally, and how usage is normalized. Those are
  ADR-0023 through ADR-0027.
- Any wire, transport, or provider vocabulary. None appears above by design.
