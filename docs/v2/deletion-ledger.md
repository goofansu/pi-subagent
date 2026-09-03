# The deletion ledger

**Status:** Final. **Date:** 2026-09-03. **Milestone:** M7, tickets 07 to 09.

The roadmap's last M7 deliverable: *"Record the final deletion ledger: which old
abstractions and cleanup mechanisms no longer exist."*

This is that record, plus the one measurement the definition of done asks for —
and the honest answer to it, which is not the one the roadmap expected.

The deletion commit is `4e67a2ef6259cd3f5a82efeec7db1350ef0542cb`, recorded in
[the closed freeze policy](freeze.md#the-deletion). Vocabulary is mapped in
[the glossary's historical terms](../../CONTEXT.md#historical-terms).

---

## Abstractions that no longer exist

Seven, each with what replaced it and — more usefully — what the replacement
does *not* have to do.

### `SubagentManager` → the Subagent Scope

**What it was.** `subagents.ts`, 267 lines. It owned Subagent identity, the
Profile association, the prepared adapter, the lifecycle, and the active-Run
relationship, as a `Map` plus the code to keep the map honest.

**What replaced it.** A **Subagent Scope** per Subagent, holding its
BackendAgent, and a record in the supervisor. Ownership is a resource lifetime
rather than a map entry.

**What the replacement does not have to do.** Remember to remove an entry.
Decide what "closed" means separately from "not in the map". Order its own
teardown — closing the Scope closes the BackendAgent, and closing the Session
Scope closes every Subagent Scope, in reverse acquisition order.

→ [ADR-0023](../adr/0023-v2-scope-ownership.md)

### `SubagentRuns` (the registry) → `RunRepository`

**What it was.** `runs.ts`, 266 lines. It held live-display Runs and handed out
*write access* to them: a `TrackedRun` with mutable fields four modules could
reach. [ADR-0004](../adr/0004-shared-mutable-run-record.md) is the decision it
came from, and the cost it names is exactly what happened — no single place knew
what a Run currently looked like.

**What replaced it.** `RunRepository`, the **only writer** of Run snapshots. It
hands out no write access at all: the reducer fiber and the settlement
coordinator call methods, and adapters, delivery, and presentation only read.
Snapshots are immutable values published through a `SubscriptionRef`.

**What the replacement does not have to do.** Reconcile four writers. Decide
whose write wins. It also gained something the registry could not have had: the
**spent-identifier set**, so identifier allocation and "no identifier is ever
reused" are the same fact.

→ [ADR-0004](../adr/0004-shared-mutable-run-record.md) (historical),
[ADR-0024](../adr/0024-v2-observation-ordering.md)

### The dispatcher → the façade, the supervisor, and presentation

**What it was.** The orchestration in `index.ts` (470 lines, mixed with the host
registrations) plus `runner.ts` (144). One caller talking to lifecycle,
presentation, and delivery directly.

**What replaced it.** Three seams. `Subagents` — the **façade** — maps a decoded
tool input plus the Session facts to a supervisor request and hands the outcome
to presentation; it has no fields and holds no state. The **supervisor** owns
lifecycle. **Presentation** owns prose and reads no service.

**What the replacement does not have to do.** Know two of the three things it
used to. The boundary test enforces the split in both directions.

### `Executor` → the backend contract's `execute`

**What it was.** The per-Run provider driver behind
[ADR-0005](../adr/0005-executor-reports-facts.md) and
[ADR-0007](../adr/0007-harness-seam-with-neutral-facts.md), with `Fact` as the
vocabulary crossing the seam.

**What replaced it.** `execute` on the backend contract: it emits
**observations** and returns a **terminal bundle** — an ending plus an optional
reconciliation. The bundle is a *report*, and the core performs the terminal
transition.

**What the replacement does not have to do.** Settle its own Run. An adapter
that could settle could settle twice, which is why the return value is evidence
rather than a decision.

→ [ADR-0028](../adr/0028-v2-backend-contract.md)

### `ControlSource` → the Control mailbox in the Run Scope

**What it was.** `control-source.ts`, 196 lines: a per-Run Control lifecycle
with its own gate, its own subscriber, and its own pending budget with
acknowledgement releasing it once.

**What replaced it.** A **bounded queue** in the Run Scope, closed by the Scope.
Three bounds — pending count, bytes per message, total pending bytes — and a
full one refuses immediately with a typed outcome.

**What the replacement does not have to do.** Close its own gate. Track whether
a subscriber exists. Release a budget on acknowledgement: taking from the queue
*is* the release. A pending Control cannot leak into the next Run because the
queue goes with the Run Scope.

→ [ADR-0026](../adr/0026-v2-control-admission.md)

### The delivery module → `CompletionDelivery` plus the Session push sink

**What it was.** `delivery.ts`, 453 lines. It owned the pending map, the result
store, the notification state machine *including landing*, `wait`, `steer`
routing, cancel routing, and shutdown.

**What replaced it.** Three things with one job each. `ResultStore` owns
storage, reservations, pins, and eviction. `CompletionDelivery` reads what was
stored and pushes it, deduplicating by Run id. The **Session push sink** owns
landing, through four host events.

**What the replacement does not have to do.** Be the router for three unrelated
operations. `wait`, `steer`, and `cancel` are the supervisor's, where the Run's
lifetime is.

→ [ADR-0006](../adr/0006-completion-notifications-and-result-store.md)

### Session lifecycle → Scope nesting

**What it was.** `session-lifecycle.ts`, 126 lines of hand-ordered shutdown:
mark every Subagent closed, forward cancellation to active Runs, close idle and
active adapters, drop unlanded notifications, clear the store, release display
state, forget identities — in that order, by hand.

**What replaced it.** Nothing, which is the point. Closing the Session Scope
releases everything beneath it in reverse acquisition order. The order is the
nesting.

**What the replacement does not have to do.** Be correct about an order
somebody wrote down. A new resource acquired inside a Scope is released by that
Scope without anybody adding a line to a teardown function.

→ [ADR-0023](../adr/0023-v2-scope-ownership.md)

### `Attempt` orchestration → adapter-internal, and not a core type

**What it was.** A documented domain term: one disposable provider attachment
executing one Run against a Conversation, with per-provider rules about when it
began, when it ended, and what it owned.

**What replaced it.** Nothing in the core. It appears in no core signature.
Adapters may use the word for native execution details and retries, which is
where the concept belongs — the core's unit is a Run and an adapter execution.

### The one-shot protocol remnants → `resume` as a first-class operation

**What they were.** [ADR-0003](../adr/0003-one-shot-children.md) decided
children were one-shot, and the code carried the consequences: a Run was the
whole of a child's life, and continuation was retrofitted around it.

**What replaced them.** A retained BackendAgent per Subagent, and `resume` as a
public operation that starts a new Run on the same Conversation, with declared
capabilities so `unsupported` is answered without calling the provider.

→ [ADR-0003](../adr/0003-one-shot-children.md) (historical),
[ADR-0014](../adr/0014-controlled-agent-resume.md)

---

## Cleanup mechanisms that no longer exist

The abstractions are the headline; these are what the rewrite was actually for.

| Mechanism | Where it was | What replaced it |
| --- | --- | --- |
| **`AbortController` in generic lifecycle code** | v1's runner and delivery | Fiber interruption. The core names neither abort word, and the boundary test enforces it. The Claude adapter may name them, because the SDK takes a controller and offers no other cancellation surface. |
| **`Promise.race` for "whichever happens first"** | v1's three adapters — the Pi agent and attempt, and the Claude attempt. Never in generic lifecycle code: v1's own core did not use it. | `Deferred` plus arbitration in the core, and Effect's own combinators in the adapters. No production module names it now; the two remaining occurrences are both in test doubles, which is the right place for a hand-written race. The point of arbitration is that which ending wins is a pure function of the candidates rather than a scheduling accident, decided in one place and tested alone. |
| **`setTimeout` for budgets** | v1's wait deadline and cleanup | `Effect.timeout` against the runtime `Clock`, which a test replaces with `TestClock`. A timer is the one thing no clock can replace, so timers are forbidden outright. |
| **Pending-cleanup state** | v1 tracked Run-local provider cleanup as state, because a Run was not finished until it finished | The Run Scope's finalizers. "A Result cannot be ready before cleanup finishes" is Scope ordering rather than a flag. |
| **Hand-ordered shutdown** | `session-lifecycle.ts` | Scope nesting, as above. |
| **The landing state machine inside delivery** | v1's `notifications` map with a `knownLost` flag per entry | The same four events, moved to the Session push sink, where landing is a host fact rather than a delivery concern. Delivery is done when a push succeeds — correctly, because it stored the Result first. |
| **`release(id)` as display bookkeeping** | v1's registry, called by delivery when a notice landed | The widget reads a **predicate**. Nothing has to be told to forget a row; the row's lifetime is derived from two facts the system already had. |

**Measured, in the generic lifecycle code specifically** — v1's eight lifecycle
modules against the thirteen in `runtime/`:

| | v1 | now |
| --- | --- | --- |
| `AbortController` | 1 (`runner.ts`) | **0** |
| `AbortSignal` | 4 (`runner.ts`, `delivery.ts`, `run.ts`) | **0** |
| `setTimeout` | 2 (`delivery.ts`) | **0** |
| mutable `let` bindings | 21 | **9** |

`Promise.race` is not in that table because it was never in v1's generic
lifecycle either — it was adapter-local in both, and counting it as a win would
be counting a number that did not move.

---

## The definition of done's last clause: not met

The roadmap's final clause is:

> The final codebase contains less lifecycle machinery than v1, not merely
> Effect-shaped versions of the same machinery.

**It is not met on any count that can be constructed honestly, and this section
is that measurement rather than a metric chosen to pass it.**

Comment lines are excluded throughout, because this codebase's commentary is
dense and counting it would flatter the larger tree.

### Generic lifecycle code

| | v1 | now |
| --- | --- | --- |
| modules | 8 | 13 |
| code lines | 1,370 | 2,163 |

v1's eight are `subagents.ts`, `runs.ts`, `runner.ts`, `control-source.ts`,
`delivery.ts`, `session-lifecycle.ts`, `run.ts`, `composition.ts`. The current
thirteen are everything under `runtime/` that is not a test.

### The whole extension

| | v1 | now |
| --- | --- | --- |
| files | 55 | 208 |
| production files / code lines | 32 / 8,162 | 131 / 20,115 |
| test files / code lines | 23 / 19,249 | 77 / 21,328 |

### Where the growth is

| Directory | Production code lines |
| --- | --- |
| `testing/` | 8,072 |
| `backend/codex/` | 2,254 |
| `runtime/` | 2,163 |
| `domain/` | 1,794 |
| `host/` | 1,557 |
| `backend/claude/` | 1,286 |
| `backend/pi/` | 1,234 |
| `presentation/` | 1,128 |
| `backend/` (contract) | 266 |
| `application/` | 202 |

### What is actually true

Three things, and they are worth separating from the clause they fail:

1. **The generic runtime is larger and does more.** It contains things v1 had
   no equivalent of, not restatements of things it had: thirteen counters and a
   seven-field probe (`counters.ts`), every bound as one configuration value
   (`policy.ts`), a bounded intake that applies backpressure
   (`observation-intake.ts`), reservations, pins and eviction in the store, and
   arbitration as a pure function. Each of those is a property v1 did not have
   rather than a shape v1's code already had.

2. **The mechanisms the clause is *about* are gone.** "Effect-shaped versions
   of the same machinery" would look like an `AbortController` wrapped in an
   Effect, a `Promise.race` renamed, a teardown function with `Effect.gen`
   around it. The table above is the measurement, and every count that
   represents hand-managed lifetime went to zero. The seven abstractions above
   are gone rather than translated.

3. **The tree is three times the size mostly because of the two things the
   roadmap asked for and did not count.** `testing/` is 8,072 lines — 40% of
   production code — and it is the shared conformance kit, five rigs, two fake
   backends, and three stand-in providers that let thirty-seven scenarios run
   against every backend with no skips. Codex is 2,254 lines because it is a
   process, a JSON-RPC protocol, a reader and a signal ladder, where v1's Codex
   integration was smaller and less complete. Neither is lifecycle machinery,
   and neither is waste.

**The honest verdict:** the rewrite did what it was for — one ownership model,
one ordered projection path, exactly-once settlement, truthful bounds, three
backends behind one contract — and it is a bigger codebase than what it
replaced. The clause as written asked for a number that would not come out, and
saying so is worth more than finding a denominator that makes it.

---

## What survived the deletion

Not everything went, and what stayed is worth naming because each item was
somebody's judgement rather than an oversight:

- **`tools/import-specifiers.ts`** — the specifier reader, resolver, and tree
  walker. Neutral repository tooling that belonged to neither implementation,
  which is why M0 moved it out of v1's boundary test in the first place. It has
  its own tests, because a checker with a broken parser is a checker that
  passes.
- **`npm run codex:protocol:check`** — about the installed `codex` CLI rather
  than about either implementation.
- **`npm run codex:retained-release:check`** — the same, re-pointed at the
  current gate's marker and evidence during M7 ticket 02, with a test that a
  record carrying the old marker is rejected.
- **The vendored protocol snapshot** in `docs/codex-protocol/`.
- **Eighteen of twenty-one boundary rules.** The three that went guarded "a
  rewrite must not inherit the machinery it replaces", and there was nothing
  left to inherit from. Two more kept their property and lost their vehicle, so
  they were re-aimed rather than deleted.
- **The vocabulary ban on the tree**, deliberately, with its job restated: it
  used to keep v1's word out of v2, and now it keeps the product's vocabulary
  singular.
- **Every ADR.** None is deleted. The ones whose subject module is gone carry a
  status note pointing here.
- **The migration's own record** — the roadmap, the milestone exit gates, the
  spikes, the v1 inventory, the freeze policy, and
  [the presentation ledger](presentation-ledger.md), which is the last
  comparison anyone will be able to make between the two implementations.
