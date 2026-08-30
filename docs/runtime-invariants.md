# Runtime Invariants

These invariants define the correctness contract of the subagent runtime.

## Harness seam

Runs are one-shot and backend-neutral. A profile names a harness (default
`pi`); the registry resolves it before dispatch. Harness preparation receives
only fixed Subagent inputs and returns one adapter instance. That adapter may
own private provider Conversation state, declares neutral capabilities,
prepares each Run from its description and prompt, and closes idempotently.
The Session-scoped Subagent manager creates one adapter, starts the first Run,
and retains the adapter when that Run settles; the dispatcher owns the Run but
never adapter lifetime. Session shutdown closes idle and active adapters. Core
receives no provider continuation handle. Pi, Claude, and Codex adapters alone
know provider wire messages and translate them into `Fact` records. The
dispatcher, fold, registry, presentation, and widget consume only those facts.
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

An adapter's neutral `resume` capability is the sole admission authority above
the Harness seam; core never branches on a harness name. Production Pi,
Claude, and Codex declare resume supported. A successful resume reuses the
adapter created from the fixed Subagent context but creates a fresh per-Run
execution, reporter, AbortSignal, Control source, Result, usage fold,
lifecycle, and notification. Earlier provider context remains available only
inside the adapter and is neither re-emitted nor charged to the new Run.

One Pi adapter lazily creates and retains one in-process `AgentSession`. Its
fixed construction uses normal resource discovery, explicit project trust,
memory-only session state, headless extension binding, orchestration-tool
denial, self-filtering by package identity, and per-spawn child depth. Each Run
owns one event subscription, one serial steering path, and a message/usage
baseline. Cancellation closes admission, clears native queues, aborts, and
waits for idle. Session shutdown emits bounded extension shutdown and disposes
the session exactly once. Pi executes extension factories before applying the
child's package-identity filter, so an adapter-owned asynchronous resource-load
context makes only that in-process child initialization inert. Parent factories
remain free to reattach full handlers and tools after reload or session replacement.

Every Claude Run owns one disposable streaming Query. The first Query records
an authoritative provider Conversation identity privately; later Queries use
native `resume` and receive only their new prompt plus current-Run Controls.
Replay events are ignored. Result accounting is cumulative within a Query and
is differenced at every Result boundary; a fresh Query starts a fresh baseline.
A missing, malformed, or changed Conversation identity fails attachment with a
redacted diagnostic and never falls back to a fresh Query. Input, Query,
Control subscription, abort listener, and accounting/correlation state are
disposed before the Subagent becomes idle.

Every Codex Run owns one disposable Attempt: a fresh App Server child is
initialized, then creates or resumes the adapter-owned thread and starts one
new Turn. The first accepted Turn creates a non-ephemeral thread and includes
the fixed Profile role; local continuation retention begins only after
`turn/start` succeeds, so a rejected first Turn cannot lose that role on a
later Run. Later attachments use native `thread/resume` and send only the new
Run prompt. Resume reapplies cwd, model, effort, approval, sandbox, inherited
environment, and child depth. Attachment Turns and notifications not matching
the adapter-owned thread plus current Turn are discarded.
Conversation-cumulative accounting is differenced from the retained baseline,
while attachment-local counters are translated from zero; only the current Run
receives the resulting usage. Run settlement waits for child exit and complete
transport and Control cleanup, leaving an idle Subagent with continuation
metadata but no live process resource.

Continuation loss fails only the current Run with bounded redacted diagnostics.
It never creates a replacement thread, replays core history, retries the Run,
forks the thread, or rolls back the Conversation. The installed Codex CLI owns
provider-thread storage and retention. Session shutdown closes the local
adapter and forgets its in-memory association, making that continuation
unaddressable to the extension in later Sessions.

A prepared Run declares its neutral Control capability. Every execution
receives a fresh reporter, AbortSignal, and Control source. Supported Runs
receive one bounded, synchronous, single-consumer Control source. Accepted
admissions reach its subscriber before the offer returns and remain budgeted
until acknowledged or discarded; unsupported Runs receive an already-closed
source and no live queue. Cancellation records its reason and
closes Control admission synchronously before the executor's `AbortSignal`
fires. Settlement and Session shutdown also close admission without draining
pending Controls. Every production adapter advertises steering. Pi calls
native session steering through one FIFO Promise chain and reports user Facts
only from authoritative session events. Claude sends one correlated user input
at a time through the active Query; a successful provider Result is an
intermediate checkpoint while an earlier Control remains outstanding, and
only provider echo or Result correlation creates its user Fact. Codex assigns
every synchronous admission an ingress sequence in the
same Attempt reducer as cancellation, provider messages, process outcomes, and
escalation. Only that reducer initiates serial native `turn/steer` requests.
For a ready Turn, accepted-Control-before-cancellation writes `turn/steer`
before `turn/interrupt`; cancellation-first closes admission and writes no
later steer. Pre-identity Controls retain their ingress position but may be
discarded by cancellation or settlement. Provider-confirmed correlated user
items are the only steering events that become Facts. Cancellation discards
unsent admissions but preserves sent-steering correlation until Attempt
settlement or failure, so provider-confirmed transcript truth arriving after
cancellation is still reported. Every provider identity remains adapter-local.

## INV-1 — Subagent and Run identities are stable

A Subagent ID identifies exactly one Session-scoped Subagent. A Run ID
identifies exactly one one-shot Run owned by a Subagent. The two identity kinds
are distinct, locally generated, and never provider identities.

Neither identity is reused within the Session, including after notification
landing releases a Run's live display record. Run-scoped operations never
redirect a Subagent id.

## INV-2 — Successful start means running

If `agent_start` succeeds, one Subagent and its first Run have been created
atomically, both identities have been returned, and the Run is actually
running. The Subagent has no preceding empty state.

There is no hidden queued state.

If the concurrency limit is reached, `agent_start` fails instead.

*Status: the no-queue half holds today. The fail-at-limit half is a target —
the current runtime is deliberately uncapped (ADR-0001); enforcing a limit
re-opens that decision and needs its own ADR.*

## INV-2A — Successful resume means a new Run is running

`agent_resume` accepts only a stable Subagent id, a description for the next
Run, and its full prompt. If the Subagent is known, idle, open, and its adapter
advertises resume, admission synchronously moves it to running and returns a
new Run id immediately rather than an answer.

An active or settling Subagent rejects resume without queueing or preparing
provider work. Two concurrent calls have one synchronous winner. An unknown,
Run, stale, wrong-kind, or prior-Session id is an unknown Subagent; an idle
non-resumable Subagent reports unsupported. Completed, failed, and cancelled
Runs return an open Subagent to idle only after settlement. Each Run's terminal
Result is immutable and independently retrievable; resuming can neither append
to nor replace an earlier Run's Result or notification.

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

## INV-8 — Shutdown closes every Subagent

When the parent Session shuts down, every Subagent is marked closed before
active-Run cancellation is forwarded. Idle and active adapters are closed,
Results and notifications are cleared, and all local identities are forgotten.
Late Run settlement cannot move a closed Subagent back to idle or notify the
next Session. Closing admission also makes later resume calls unknown, and
pending Controls from an active Run are discarded rather than inherited.

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
