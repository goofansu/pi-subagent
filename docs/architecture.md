# Architecture

**What this is:** how `pi-subagent` is built, in the terms the code uses. It
replaces the two documents the migration retired — the runtime-invariants list
and the harness definition-of-done — and it is written so that a newcomer can
read one document and then read the code.

**What it is not:** a decision record. Every claim here cites the ADR that
decided it, and the ADR is where the alternatives and the cost live.

**The one-sentence version:** a thin Pi-native control and presentation layer
for retained native coding agents. Pi, Claude, and Codex keep their own models,
tools, configuration, continuation, and conversation semantics. A small Effect
supervisor owns Subagent and Run lifetimes, normalises backend observations into
one bounded read model, and delivers progress and immutable results through a
central UI.

The vocabulary is in [`CONTEXT.md`](../CONTEXT.md). This document assumes it.

---

## The map

One picture before the thirteen sections, so that a contributor planning a
change knows which box it lands in without reading the supervisor first.

```text
                            ┌──────────────────────────────┐
   the model's tool calls ──▶│  host/  (the Pi boundary)    │
   the operator's commands ─▶│  tools · commands · widget   │
                            │  renderers · push sink       │
                            └───────────┬──────────────────┘
                                        │ six functions
                            ┌───────────▼──────────────────┐
                            │  application/  Subagents     │
                            │  the façade; owns no state   │
                            └───────────┬──────────────────┘
                                        │ requests / outcomes
                            ┌───────────▼──────────────────┐
                            │  runtime/  SubagentSupervisor│
                            │  admission · Scopes · Runs   │
                            └──┬─────────────┬─────────────┘
                               │             │
              ┌────────────────▼──┐   ┌──────▼───────────────┐
              │ RunRepository     │   │ ResultStore          │
              │ the live index    │   │ immutable terminal   │
              └────────┬──────────┘   └──────┬───────────────┘
                       │                     │ reads what was stored
                       │              ┌──────▼───────────────┐
                       │              │ CompletionDelivery   │
                       │              │ pending · handed off │
                       │              │ · exhausted          │
                       │              └──────┬───────────────┘
                       │                     │ push
                       │              ┌──────▼───────────────┐
                       │              │ SessionPushSink      │
                       │              │ handed off · lost    │
                       │              │ after hand-off ·     │
                       │              │ landed               │
                       │              └──────┬───────────────┘
                       │                     ▼
                       │                the conversation
                       │
                       └─▶ presentation/  rows · cards · notices · prose
                           pure functions over domain projections

              ┌───────────────────────────────────────────────┐
   beneath    │ backend/  pi · claude · codex                 │
   the        │ one adapter per provider, behind one contract │
   supervisor │ provider vocabulary never leaves this tree    │
              └───────────────────────────────────────────────┘

                 domain/  the meaning everything above shares
                 ids · phases · observations · projection ·
                 result · notification · bounds. No machinery.
```

**Who writes.** The supervisor writes the repository, through the Run's
reducer, and nothing else does. Settlement writes the store, once per Run.
Delivery writes neither: it reads the store and releases a pin. The sink
writes nothing at all — it holds a bounded notice until the notice lands.

**Who reads.** Presentation reads domain projections and never a service.
The widget reads the repository's published index and the sink's landing
predicate. `agent_result` reads the store. Delivery reads the store. The
façade reads the repository for agent names and the supervisor for
everything else.

**What only the host knows.** Whether a message reached the conversation
(*landed*), whether a turn was aborted, what the terminal width is, what the
theme is, and what time it is. Everything below `host/` is told these or does
without them: the runtime takes a clock, presentation takes a width and a
theme, and delivery is told nothing about landing at all — which is why it
has no word for it.

---

## 1. Ownership is Scope nesting

Four lifetimes, each strictly inside the last:

```
Session Scope                    one per Pi Session
└── Subagent Scope               one per Subagent; owns its BackendAgent
    └── Run Scope                one per Run
        └── native execution     one per adapter execution
```

Closing a Scope releases everything beneath it, in reverse acquisition order.
That is the whole of the shutdown story: there is no order to write by hand and
no list of things to remember to close, because the nesting *is* the order.
Closing the Session Scope cancels every active Run, awaits its cleanup, closes
every BackendAgent, and forgets every local identity.

**Nothing shorter-lived than the Session is a Layer.** Six session-long
services are — `BackendCatalog`, `ProfileCatalog`, `RunRepository`,
`ResultStore`, `SubagentSupervisor`, `CompletionDelivery` — and a Subagent, a
BackendAgent, a Run, a Query, a Turn, or a subscription is not. The boundary
test enforces it by confining `Layer` to the composition module and the service
modules it wires.

**The supervisor owns the order things happen in, and no state.** What it used
to hold, three modules now own, each carrying one invariant and each a plain
object the supervisor constructs with its own lifetime — no Layer, for the
reason above. The **admission lease** (`runtime/admission.ts`) owns the
shutting-down flag, the active-Run count, and the running Subagents, and hands
one atomic `acquire` either a typed refusal or a lease that releases
everything it holds exactly once. The **Subagent records**
(`runtime/subagent-records.ts`) own every Subagent's phase, current Run, Run
fiber, and conversation-lost flag, and assert that one Subagent owns at most
one active Run where the record lives. The **waiter ledger**
(`runtime/waiters.ts`) owns how many callers registered at a settlement have
yet to read it, and the Result-store pin held on their behalf. Boundary rule
21 keeps the supervisor stateless: no `Ref.make`, `new Map`, or `new Set` in
that file, so a fourth mechanism cannot quietly live there.

→ [ADR-0034](adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)

The native execution scope nests *inside* the Run Scope but can close
independently, because a provider turn may end without ending the Run.

**Three documented exceptions**, all in [ADR-0023](adr/0023-v2-scope-ownership.md):
a fake or adapter enforces "closed means closed" through its own state rather
than by trusting a provider to reject work after disposal; the Codex reader is
Subagent-scoped rather than Run-scoped, because its stdout outlives every Run;
and a Codex frame for an unknown or settled Turn is a *routing* decision the
adapter makes rather than a consequence of the event source being gone.

→ [ADR-0023](adr/0023-v2-scope-ownership.md)

## 2. Observations are ordered and lossless within a Run

A backend does not mutate anything. It **emits observations** — one union of
ten kinds — into a bounded intake, and one reducer fiber per Run folds them in
accepted order into an immutable projection.

- **Ordered.** Accepted order is the order the reducer applies. A backend whose
  Turn and steering share one connection has to order them itself before
  emitting; the Codex adapter's Subagent-scoped reader is where that happens.
- **Lossless.** The intake is bounded and **waits**. A semantic observation is
  never silently dropped: a chatty backend is slowed to the reducer's pace,
  which is the honest answer when the alternative is buffering without bound.
- **Conflated where conflation is the meaning.** Activity is display-only and
  the latest value wins, so a hundred progress reports grow nothing.
- **Neutral.** Provider wire objects never cross the boundary. The observation
  union is one schema declaration, decoded at the backend seam with excess
  properties rejected, so an unlisted key at any depth is a rejection rather
  than a silent strip — which is what makes the no-provider-vocabulary rule
  enforced rather than merely stated.

Only `reduceRun` writes a projection, and it is a pure function that *reports*
what it did — `applied`, `applied-with-truncation`, `ignored-late`,
`ignored-invalid` — rather than logging, so the runtime decides what becomes a
diagnostic.

→ [ADR-0024](adr/0024-v2-observation-ordering.md),
[ADR-0029](adr/0029-v2-effect-schema.md)

## 3. A Run settles exactly once, and a Result follows cleanup

Four things can each decide a Run is over at the same moment: the bundle an
execution returned, an interruption, a defect, and an `ending` already reduced
from the stream. So settlement is two pieces:

- the **settlement coordinator** captures exactly one terminal *candidate* into
  a `Deferred`. A later candidate increments `duplicateSettlements` and changes
  nothing.
- **arbitration** is the pure function deciding which candidate the Run
  actually had. A reduced ending wins; a returned bundle wins over a
  cancellation request that arrived afterwards; an interruption that took
  effect first yields `cancelled` with the *first* recorded reason; a defect
  yields `failed` with a redacted `backend-failure` diagnostic.

**Sealing** closes the intake at the moment the candidate is captured. Anything
emitted afterwards is a counted late event and a no-op — which is what lets the
contract promise that `emit` never fails, even for an adapter emitting from its
own finalizer.

**A Result cannot become ready before the Run Scope's finalizers finish.** The
terminal snapshot is published *after* cleanup and after ordered reduction, so
a caller who sees a Run as terminal can retrieve its Result. **Terminal
reconciliation** — a backend's authoritative snapshot, applied as the last
ordered observation — may heal streamed drift without double-counting: present
fields replace, absent fields retain, usage replaces rather than adds, and
replaying it is a no-op.

**A hung finalizer is bounded.** Past the cleanup budget the core escalates: a
`cleanup-escalation` diagnostic on the Run, the BackendAgent closed out from
under it, its Conversation marked lost so a later resume is honest, and
settlement continuing with the observations it has.

→ [ADR-0025](adr/0025-v2-terminal-settlement.md),
[ADR-0030](adr/0030-v2-backend-open-failure.md)

## 4. Controls are bounded and truthful

A Control is steering text, offered while a Run is active, into a **bounded
per-Run mailbox**. Four stages are kept apart and none is inferred from
another:

| Stage | Who says it | What it means |
| --- | --- | --- |
| **admitted** | the mailbox | the complete text is in the queue |
| **submitted** | the adapter | it was written to the provider |
| **confirmed** | the provider | authoritative evidence came back |
| **rejected** | either | it will not be delivered |

`accepted` is the *first* of those and the outcome says so every time, because
a caller who reads it as confirmation retries in a loop. Only confirmation
becomes a user observation in the transcript.

The mailbox **refuses rather than blocks**: a full one answers immediately with
a typed outcome, because a caller must never be blocked by a Control. It is
bounded three ways — pending count, bytes per message, total pending bytes —
and closed by the Run Scope, so a pending Control cannot leak into the next
Run.

Admitting a *Run* follows the same rule for the same reason, and one module
owns it. `runtime/admission.ts` decides shutting down, already running, and at
capacity in one atomic step, answers immediately with nothing queued, and
returns a lease holding the capacity slot, the Subagent's one-active-Run
claim, and the Result-store reservation. Nothing waits, and nothing is
allocated by a rejection: everything decidable without provider I/O is decided
before an identifier is spent. A resume's Subagent is claimed inside the
acquire because its id is known; a start's is bound once its backend has
opened. Which Subagent is running, and whether its Conversation is still
there, is the **Subagent records**' answer rather than the supervisor's.

→ [ADR-0026](adr/0026-v2-control-admission.md),
[ADR-0034](adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)

## 5. Usage is Run-local, and context is a gauge

Deltas are Run-local: a resume is charged for its own work and not for the
conversation behind it. Context occupancy is a **gauge** rather than a sum, so
a figure that grew without bound would mean a gauge was being added up.
Terminal reconciliation replaces usage rather than adding to it, which is what
makes replaying it idempotent, and a provider replaying its transcript adds no
usage at all.

Every backend reports cumulative totals or per-message deltas in its own
vocabulary; the adapter converts, and the core sees one shape.

→ [ADR-0027](adr/0027-v2-usage-normalization.md)

## 6. Delivery reads what was stored

**Storage precedes notification, and delivery reads the store rather than being
handed a value.** That one rule is what makes a notification failure
survivable: a retry re-reads the same immutable Result, so it cannot deliver
something `agent_result` would not return, and it cannot alter settlement
because it has nothing to alter it with.

Delivery deduplicates by Run id with an atomic claim, so a settlement wake-up
and a **sweep** arriving together produce one push. The sweep exists because a
wake-up can be missed, and the store is the source of truth that makes recovery
possible: whatever is stored, terminal, and unannounced has not been announced.

**Pushed is not landed.** A push that succeeded has not necessarily reached the
conversation — Pi queues a follow-up and an interrupted turn discards it — so
the Session push sink tracks **landing** through four host events: a push
records the notice unlanded, a `message_start` carrying it marks it landed and
forgets it, an aborted turn marks every unlanded notice lost, and
`agent_settled` pushes each lost notice again exactly once. Exactly one landing
per Notification.

**Landing is not the only way a hand-off finishes.** A parent that retrieves a
Run's Result with `agent_result` has done everything the notice exists to make
it do, so the tool handler tells the sink the Run was **consumed** and the
hand-off is resolved: a later push is accepted and not sent, and a notice lost
to an aborted turn is not pushed again. A notice Pi already holds still lands —
the extension API has no call that takes a queued message back — and is counted
as *consumed before landing*, which is the evidence a later hold-while-active
envelope waits for. Delivery also reports **exhaustion** to the sink when its
retry budget runs out, so the whole hand-off state has one owner.

A settled Run's widget row lasts until its hand-off is **resolved** — landed or
consumed, whichever came first — and an exhausted one keeps its row and says
so. The widget reads that through one read model with three states, `pending`,
`resolved` and `exhausted`, and never learns which of the two resolved it.

→ [ADR-0035](adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)

→ [ADR-0002](adr/0002-push-only-result-delivery.md),
[ADR-0006](adr/0006-completion-notifications-and-result-store.md)

## 7. Everything is bounded, and every bound says what it gave up

`RuntimePolicy` is one plain value holding every bound: active Runs, the three
mailbox bounds, six projection bounds, bytes per stored Result, the Result-store
budget, the observation queue bound, the open budget, the cleanup budget, the
delivery retry budget, and an optional default Run timeout. It is configuration
rather than a service, so a test lowers a bound by spreading over the defaults.

Two answers, and never a third:

- **truncate and record it.** Every projection bound keeps the newest and
  records the count dropped; every byte bound records the bytes cut. A bound
  that discarded silently would be worse than no bound, because the Result
  would look complete and be a Result with a hole in it.
- **refuse with a typed outcome.** Capacity, the mailbox, and an oversized
  Control are refusals the caller is told about.

The Result store reserves room **at admission**, so `at capacity` is an honest
answer rather than a discovery at settlement, and a reservation that does not
fit evicts the oldest *unpinned* stored output until one does — pins stay
absolute, so a store whose every entry is being delivered or read still
refuses. An evicted Result answers by id, saying its output is gone.

→ `runtime/policy.ts`, `runtime/bounds.test.ts`, `runtime/stress.test.ts`

## 8. The host boundary is the only place an Effect is run

`host/` plus the entry point is where a Pi callback crosses into Effect. It is
the only place `Effect.runPromise` and `ManagedRuntime` may appear, and the only
place that touches Pi's registries, UI context, and message surface.

`AbortSignal` and `AbortController` are confined there too, with one exception:
the Claude adapter may name them, because the SDK takes a controller on its
options bag and offers no other cancellation surface — exactly the kind of
provider mechanism an adapter exists to absorb. The core cannot name either
word, and no adapter may name the two runtime words.

Pi registers tools, commands, and renderers **once per process**, while a
Session starts and ends many times inside it. The **session handle** is where
those two lifetimes are reconciled: registrations close over it, each
`session_start` refills it, binding a runtime disposes whatever was bound so a
Session switch cannot leave two alive, and a tool call arriving between
Sessions gets a text outcome rather than a throw.

## 9. The backend contract, and what a new backend owes

One contract, three adapters, and the seam is narrow on purpose:

- `validateProfile` — deterministic, and answers without provider work.
- `open` — returns a **BackendAgent** with **declared capabilities**: `resume`,
  `steer`, `terminalTranscriptSnapshot`. Declared rather than discovered, so
  the core answers `unsupported` without calling the backend and without
  spending quota. Opening creates no public Run.
- `execute` — emits observations and returns a **terminal bundle**: an ending
  plus an optional reconciliation. It is a *report*: the core applies it and
  performs the terminal transition, because an adapter that could settle its
  own Run could settle it twice.
- `close` — idempotent, and releases every retained native resource.

**A new backend owes the shared conformance suite.** Thirty-seven scenarios in
five sections — Subagent and BackendAgent, Run, Control, usage, projection and
delivery — run against every backend, and the only permitted skip is one a
declared capability drives. It also owes a live lane: a runtime gate over the
adapter and a host gate through the surface a user has.

**What it does not owe, and must not ask for:** a provider-specific Run phase,
a repository field of its own, an opaque payload in the core, or a retry policy
above the seam. If a backend needs the Run lifecycle to change, the seam is
wrong and repairing it comes first.

→ [ADR-0028](adr/0028-v2-backend-contract.md),
[ADR-0020](adr/0020-run-settlement-through-harness-conformance.md)

## 10. The boundary rules

Twenty-two rules in `boundaries.test.ts`, each guarding a property somebody
could otherwise remove with one `import` line — or, for three of them, with a
line that imports nothing at all. That is the test for whether a rule belongs
there: not "is this tidy" but "what breaks if this edge exists". The table
below has twenty rows because the three adapter-confinement rules say the same
thing about three adapters.

| Rule | What it guards |
| --- | --- |
| The legacy Profile field name appears nowhere in the tree, in a file of any kind | one vocabulary for one product; `AgentHarness` is the reserved compound |
| The domain imports only the domain, and from `effect` only `Schema` | meaning without machinery, checked at the named-import level |
| The domain names no runtime primitive | a reducer stays a function of its arguments |
| Mechanism vocabulary stays out of the domain and the contract | the neutral core cannot learn a provider's words |
| `Layer` is confined to the composition module and its services | nothing shorter-lived than the Session becomes a Layer |
| A provider SDK is named only inside its own adapter, tests included | provider types cannot leak upward |
| Presentation names only the domain and Pi | prose that could reach the repository is one edit from folding state |
| The application façade names no host, backend, or fake | input mapping stays input mapping |
| The host does not reach around the runtime | a host handler that could open a `Backend` would make two owners of BackendAgent lifetime |
| The runtime does not know the host exists | delivery reaches its Session through one interface |
| One schema library | Effect Schema alone, so a JSON-Schema document cannot smuggle a second in |
| Pi session symbols stay in the Pi adapter; Pi's host API does not | by binding, because one package is both |
| Each adapter is confined in both directions, and no adapter names another | three siblings, no shared provider knowledge |
| A child process is spawned in one directory | the one backend that owns an OS process owns all of it |
| App Server vocabulary stays inside the Codex adapter | the composition root sees a factory, an id, options, and a probe |
| The widget imports neither the push sink nor delivery | a widget that could push would make two deciders of what the model is told |
| No inflection of *land* or of *consume* appears in `runtime/delivery.ts` or its test | delivery knows pending, handed off, and exhausted; only the push sink sees `message_start` and is told by the `agent_result` handler, so only the sink may say a notice landed or that the parent has read the Result. A link's target is not scanned, so delivery may cite the ADR whose filename carries both words |
| `presentation/notification-text.ts` names only the domain and presentation | narrower than the presentation rule above, which admits Pi's packages: a notice is prose a model reads, so changing what it says provably touches no runtime module |
| No `Ref.make`, `new Map`, or `new Set` in `runtime/supervisor.ts` | the supervisor sequences lifecycles and owns no state; admission, the Subagent records, and the waiter ledger each own the state whose invariant they carry, and a fourth holder in the file every lifecycle change passes through would read as local to whatever was being changed. The `stages` trace array is the documented exception |
| No dynamic `import()` or `require()` with a computed specifier, outside a named allow-list of one | every rule above is a rule about *specifiers*, and the checker can only read a literal one. One `await import(url)` would let any of them be broken with the suite still green, so the form is banned rather than the edges guessed at. The allow-list's single entry reads a dependency-free script outside the tree, and carries its reason |

Two more lanes belong beside them: the **timing lint**, which forbids timers
everywhere and sleeps in tests that have no test clock, and the **import
tooling**'s own tests, because a checker with a broken parser is a checker that
passes.

The checker proves its negative case: it runs against disposable fixture trees
where each rule is violated on purpose, so "the rule would catch this" is
asserted rather than assumed.

## 11. Codex, which is the one that owns a process

Worth its own section because it is where the exceptions live.

One Codex Subagent owns one `codex app-server` child and one **ephemeral root
thread** for its life. There is no `thread/resume` and no stored rollout:
continuity *is* the retained process and its root, so a later Run is another
**Turn** on the same thread, and losing the process loses the Conversation.

- **The reader is Subagent-scoped**, because stdout outlives every Run and the
  server issues client-bound requests between Turns that stall it if nobody
  answers. It demultiplexes frames by turn id; a frame for an unknown or
  settled Turn reaches no Run and is counted as a **late frame**, in both
  directions, because a routing bug does not crash — it applies a stale frame
  or loses a live one.
- **Loss has exactly two signals**, neither on the wire: process exit, and an
  expired request bound on the runtime clock, which is what a wedged-but-alive
  process produces.
- **Cancellation is a bounded ladder.** `turn/interrupt` first; then
  SIGTERM-then-SIGKILL, armed per Turn by turn id before the interrupt is
  written, standing down the moment the child exits or *that* Turn reports
  itself interrupted. An ordinary cancel therefore sends no signal at all.
- **The protocol is pinned byte-for-byte.** `npm run codex:protocol:check`
  regenerates the installed CLI's schema and compares it against the vendored
  snapshot, then asserts the shapes the adapter consumes. It goes red the
  moment the CLI moves past the pin, which is the check working; bumping the
  pin is the `codex-upgrade` procedure.

**Codex protocol fidelity is schema-derived.** Every notification shape the
transport consumes comes from the installed CLI's generated schema (verified
against codex-cli 0.153.0 plus a live stdio run), never from hand-authored
fixtures alone. The reader requires only schema-required fields, normalises
optional ones, and skips item variants it does not read — so an unknown
notification method is safely ignored and an unrecognised server-to-client
request is refused with method-not-found. Neither can fail a Run, because the
protocol carries far more variants than this adapter consumes.

→ [ADR-0021](adr/0021-retained-ephemeral-codex-conversation.md),
[ADR-0011](adr/0011-codex-app-server-migration.md),
[ADR-0012](adr/0012-ordered-codex-steering.md)

## 12. What is deliberately not here

- **No queue.** Capacity rejects immediately. Adding queueing would require
  `queued` to become a public phase with honest admission semantics
  ([ADR-0001](adr/0001-unbounded-subagent-concurrency.md) is why v1 had no
  limit at all).
- **No nested subagents.** Delegation is one level deep, enforced per adapter.
- **No cross-session persistence.** A Result belongs to the Session that asked
  for it. Identifiers do not outlive the Session that minted them, which is
  what the Session nonce is for.
- **No provider conversation reconstruction.** A display transcript is never
  used to resume a native conversation.
- **No shadow execution.** One implementation runs one request. Comparisons use
  fakes, fixtures, and golden outputs.

## 13. Where to read next

| Question | Document |
| --- | --- |
| What does a word mean? | [`CONTEXT.md`](../CONTEXT.md) |
| What does a caller observe from an operation? | [operation semantics](v2/operation-semantics.md) |
| What should each command print, per backend? | [the compatibility matrix](v2/compatibility-matrix.md) |
| Something is wrong in a live Session | [the debugging guide](debugging.md) |
| I want to change something | [the contributor rules](contributing.md) |
| Why was this decided? | [`docs/adr/`](adr/) |
| What did the migration delete? | [the deletion ledger](v2/deletion-ledger.md) |
