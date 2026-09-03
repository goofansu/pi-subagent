# Domain model

The vocabulary this codebase uses. Terms here are load-bearing: they name the
seams, and code that uses a different word for the same thing is a bug in the
naming, not a synonym.

There is one implementation and therefore one vocabulary. The 1.x
implementation this replaced had its own — a Harness rather than a backend, a
Fact rather than an observation, a manager and a dispatcher rather than scopes
— and every one of its terms is listed under [Historical
terms](#historical-terms) with what replaced it, so a plan or a commit message
written in the old words can still be read. The decision behind the rename is
[ADR-0022](docs/adr/0022-v2-terminology-and-backend-field.md); the rest of the
mapping is [the deletion ledger](docs/v2/deletion-ledger.md).

## The product

**Agent** — a named role a task can be delegated to, e.g. `explore`. An agent
is defined by exactly one **Profile**.

**Profile** — the Markdown file that defines an agent: frontmatter configuring
the Run and a body that is the agent's prompt. Generic parsing understands only
`description`, `backend` (default `pi`), and the body; every other field
(`model`, `effort`, `tools`, `appendSystemPrompt`) keeps one name across
backends but is validated and interpreted by the named backend, and a field the
backend does not recognise is a diagnostic rather than a silent pass-through.
Named after the agent, so `explore.md` defines `explore`. Read only from user
scope; see `getAgentDir`.

**Subagent** — a stable, Session-scoped asynchronous identity created from one
Profile. A Subagent is **running** with exactly one active Run, **idle** with no
active Run, or **closed**. Creation moves directly to running with its first
Run; there is no empty or queued state. A terminal Run leaves an open Subagent
idle; Session shutdown closes it. A Subagent id is local, distinct from every
Run id, and never a provider identity. A successful `agent_resume` claims a
resumable idle Subagent and starts its next Run; an active Subagent rejects
resume rather than queueing it.

**Run** — one managed goal cycle of one Subagent's fixed Profile, begun by one
new prompt and settled exactly once with one immutable terminal Result. A Run
may span several provider Turns: intermediate provider completion is accounting
and Conversation evidence, not a second Run and not necessarily settlement. A
Run has its own local id, phase, projection, usage, Result, and owning
Subagent. Not "job", not "task", not "call", and not a provider Turn.

**Label** — the Run's one-line description of the work it was given: what
`agent_start` and `agent_resume` call `description`, bounded to one line of at
most 200 UTF-8 bytes (`RUN_LABEL_MAX_BYTES`) once, at admission, before the
Run exists. A label longer than that is **shortened and recorded** as a Run
diagnostic, never refused — a label is orientation, and refusing a start over
its length would cost a round trip and buy no safety.

Two words for one thing, deliberately, and this is which is which. The field a
*caller* fills in is `description`, because that is what the tool schema has
always called it and a model that learned the name keeps it. Every surface that
*shows* it calls it the label: the notice's header, the collapsed transcript
line, the widget's activity tail. The value is the same string everywhere,
because the bound is applied once and every reader downstream reads what
admission stored.
[ADR-0033](docs/adr/0033-notification-vocabulary-pointer-and-label-bound.md).

**Run phase** — where a Run is, as five states: `running`, `finalizing`,
`completed`, `failed`, `cancelled`. `finalizing` is the window between a
backend's execution ending and the Run settling, and it exists so that no
surface ever shows a Run as terminal while its cleanup is still running.

**Resume** — the asynchronous operation that accepts a stable Subagent id plus
the next Run's description and prompt. It returns the new Run id immediately
rather than an answer. Resume never rebinds the fixed Profile, backend, working
directory, child depth, resolved policy, or trust posture, and the core never
receives a provider continuation token: all continuation stays inside the
adapter and the current Session. Resume reports **Conversation loss**
distinctly when a previously resumable Subagent has lost that context.

**Conversation** — provider-owned semantic context that may span several Runs
of one Subagent. Its continuation identity and accounting baseline stay inside
the adapter; it is neither a Subagent nor a Run and never crosses the backend
contract.

**Conversation loss** — the terminal loss of the provider context needed to
resume a Subagent, which is not the same as a failed or cancelled Run. Loss
known before resume admission starts no Run; loss after admission belongs to
that Run, and a terminal Result stays immutable either way. The Subagent then
remains idle but non-resumable, and a later resume reports the loss without
exposing provider identity or mechanism.

**Control** — bounded, backend-neutral guidance offered while a Run is active.
The only Control is steering text. `accepted` means the complete text entered
the Run's bounded local mailbox and nothing more: it does not claim a provider
accepted it, a model consumed it, or it became transcript truth. A backend
declares whether it supports steering at all, so `unsupported` is answered
without calling the provider. Cancellation discards unsent admissions. Only
authoritative provider evidence of the guidance — never local admission —
becomes a neutral user observation.

**Turn** — one provider model response, folded into a Run's usage and counted
by the widget. A Turn is provider accounting, not a second Run and not a
provider session that can be resumed.

**Detached Run** — a Run that outlives the turn that started it. Every Run
started by `agent_start` or `agent_resume` is detached from the turn: `Escape`
does not stop it. It is not detached from the *Session* — a Result belongs to
the conversation that asked for it, so every `session_shutdown` (switch, fork,
resume, new, reload, quit) cancels whatever is still running.

**Ending** — a backend's honest terminal resolution of one execution:
**answered**, **failed** (with an optional message), or **cancelled**. It
carries no exit code and no provider stop vocabulary; the reducer turns it into
a Run phase and preserves the details the observations carried.

**Cancel** — request that a Run stop. *Cancelled* is the terminal phase of a
Run stopped intentionally, and the model, the operator, and presentation all
say cancelled. *Abort* is not a domain word: it is mechanism vocabulary —
`AbortController`, `AbortSignal`, Pi's `stopReason: "aborted"` — normalised to
cancelled inside the adapter and never shown above it.

**Cancellation reason** — `requested` or `shutdown`, reported wherever a
cancelled Run is named. The difference is not decoration: at shutdown every Run
is cancelled without anyone asking, and a caller told plain `cancelled` would
conclude its own request had taken effect.

**Result** — the authoritative immutable terminal output of one Run. It records
the owning Subagent for orientation, is written to the Result store only when
the Run settles, and is retrieved by Run id with `agent_result`. A provider's
own "result" event is adapter-local Turn evidence; it is not this Result and is
not synonymous with settlement.

**Notification** — a small status-specific completion notice pushed as a
follow-up message. It opens with the Run's **Label**, so a model running
several Subagents reads which delegation finished before it reads an
identifier; it identifies the owning Subagent and the specific Run, says how
much of the Result is there, and points at `agent_result` with the exact
argument shape. It is not the Result itself. **Pushed is not landed**: Pi may hold a follow-up while the model is
mid-turn, and if an interrupt discards it the notice is pushed again once the
agent settles. One landing per Notification is the invariant. The four states a
notice can be in — **handed off**, **landed**, **lost after hand-off**,
**exhausted** — are defined under **Delivery sweep**, each with the one
component that decides it.

**Wait** — `agent_wait` observes terminality only. It returns Run identity and
terminal phase, never output, and neither suppresses Notifications nor touches
the Result store. Repeated waits return the same phase. Aborting a wait stops
only that waiter.

**Result store** — the authoritative home of every terminal Run's output,
addressable by id from the moment the Run settles. Reading observes a stored
Result without consuming it. Results are scoped to the Session that asked, so
shutdown clears the store. Outputs are held only up to a byte budget; past it
the oldest unpinned output is evicted, and an evicted Run still answers by id,
saying its output is gone.

**Depth** — delegation is one level deep. A Subagent cannot start Subagents,
whichever backend runs it. Admission decides a child's depth and each adapter
enforces it in its own children, through a shared environment key for the
processes that spawn one and by denying the delegation tools where that is
possible.

**Trust** — Pi's project-trust decision for the working directory, resolved by
the Session and fixed when a Subagent is opened; the extension never derives
its own. Applying it is each backend's policy: Pi applies it to retained SDK
settings and resource loading; Claude and Codex do not consult it, and their
constant bypass with the value forwarded is reserved for a future shared
posture ([ADR-0009](docs/adr/0009-codex-trust-posture-and-environment-inheritance.md)).

**Shutdown** — closing the Session Scope. It cancels every active Run and
awaits its cleanup, closes every BackendAgent, drops every unlanded
Notification, clears the Result store, and forgets every local identity, in
reverse acquisition order. New starts, resumes, and Controls are rejected from
the moment it begins, and it is idempotent. A late settlement cannot reopen a
closed Subagent or notify the next Session, whose model never started these
Runs and has no context in which to act on their answers.

## The architecture

**Backend** — the identity of Pi, Claude, or Codex. `BackendId` is its type.

**Adapter** — the integration boundary that implements one backend. Provider
wire objects never cross it. The word names the whole module, not one object
inside it.

**BackendAgent** — the adapter-owned retained native conversation, session, or
process. Owned by exactly one Subagent Scope and alive for that Subagent's whole
life. One word for three different things: the retained Pi SDK session, the
retained Claude conversation identity, and the retained Codex App Server
process with its ephemeral root thread.

**SubagentId** — the stable logical specialist the product exposes. Minted as
`subagent-<nonce>-<n>`.

**RunId** — one public `start` or `resume` operation. Minted as
`run-<nonce>-<n>`, numbered from one independently of SubagentId's sequence.

**Session nonce** — four random characters minted once per Session runtime and
carried by every SubagentId and RunId that runtime hands out. It is what makes
an identifier mean one thing rather than one thing per Session: identity sets
are forgotten at the Session boundary, but the conversation transcript is not,
so without it a Run id written before a reload would resolve to whichever Run
had since taken that number. With it, a stale identifier is reported as
unknown. Two Sessions draw the same nonce about once in 1.7 million, and share
every identifier when they do — a weaker guarantee than a random id per Run
would give, and the trade recorded in ADR-0031.
[Operation semantics §5](docs/v2/operation-semantics.md).

**Attempt** — adapter-internal vocabulary for native execution details and
retries. Explicitly *not* a core product type, and it never appears in a core
signature. It was a documented domain term in 1.x; see [Historical
terms](#historical-terms).

**Scope** — an Effect resource lifetime, nested Session → Subagent → Run →
native execution. Closing one releases everything beneath it, in reverse
acquisition order, which is why there is no shutdown order to write by hand.
[ADR-0023](docs/adr/0023-v2-scope-ownership.md).

**Observation** — the neutral record of something a backend witnessed, ordered
and lossless within a Run.
[ADR-0024](docs/adr/0024-v2-observation-ordering.md).

**Observation kinds** — the ten things an observation can be: `message`,
`tool_progress`, `activity`, `usage`, `context`, `diagnostic`, `link`, `model`,
`reconciliation`, and `ending`. One union, so everything a backend witnesses
crosses the boundary in one vocabulary. The union is one schema declaration,
and decoding it at the backend seam with excess properties rejected is how
ADR-0024's no-provider-vocabulary rule is enforced rather than merely stated:
an unlisted key at any depth is a rejection, not a silent strip.
[ADR-0029](docs/adr/0029-v2-effect-schema.md).

**Transcript item role** — `user`, `assistant`, or `tool`. A `tool` item is the
result of a native tool call, reported as its own item rather than folded into
the assistant message that asked for it: attributing a tool's output to the
model would make the Run look as though it had said it. Only an `assistant`
item is an answer, which is why the final output is taken from those alone.
Added at M4, because every backend that runs tools produces tool results.

**Projection** — what a Run looks like after its observations have been folded:
transcript, tools, diagnostics, links, usage, activity, model, final output,
and a truncation record. Every list and every text in it is bounded. The pure
`reduceRun` is its only writer — no adapter, host handler, or presentation code
writes to one — no adapter, host handler, or presentation module can.

**Applied report** — what `reduceRun` says about one observation, alongside the
next projection: `applied`, `applied-with-truncation`, `ignored-late` (the
projection was already terminal), or `ignored-invalid` (the observation was
malformed). The reducer reports rather than logs, so it stays a function of its
arguments and the runtime decides what to emit as a diagnostic.

**Terminal reconciliation** — a backend's authoritative terminal snapshot,
applied as the last ordered observation of a Run and before settlement. Present
fields replace, absent fields retain, usage replaces rather than adds, and
replaying it is a no-op. A backend with no snapshot sends none and never
fabricates one. [ADR-0025](docs/adr/0025-v2-terminal-settlement.md).

**Terminal bundle** — what one backend execution resolves to: an ending plus an
optional terminal reconciliation. It is a *report*, not a settlement — the
core applies it and performs the terminal transition, because an adapter that
could settle its own Run could settle it twice.

**Capabilities** — the three booleans a BackendAgent declares when it is
opened: `resume`, `steer`, and `terminalTranscriptSnapshot`. Declared rather
than discovered, so the core can answer `unsupported` without calling the
backend and without spending provider quota.
[ADR-0028](docs/adr/0028-v2-backend-contract.md).

**Session runtime** — the one managed Effect runtime per Pi Session, composed
in a single module from Layers for six session-long services — `BackendCatalog`,
`ProfileCatalog`, `RunRepository`, `ResultStore`, `SubagentSupervisor`, and
`CompletionDelivery` — plus a runtime policy value and the ambient clock.
Nothing shorter-lived than the Session is a Layer, and the boundary test
enforces that by confining `Layer` to this module and the services it wires.
[ADR-0023](docs/adr/0023-v2-scope-ownership.md).

**Runtime policy** — every bound the Session enforces, as one plain value:
maximum active Runs, the three Control mailbox bounds, projection bounds, the
maximum bytes one stored result may occupy, the total result-store budget, the
observation queue bound, the open budget, the cleanup budget, the delivery
retry budget, and an optional default Run timeout. Configuration rather than a
service, so a test lowers a bound by spreading over the defaults.

**Run Scope** — what one Run holds for its lifetime: a bounded observation
intake, one reducer fiber, a Control mailbox, a completion `Deferred` used only
as a wake-up, a settlement coordinator, and — nested inside it — the native
execution scope. Closing the Run Scope releases all of them; the nested scope
can close independently, because a provider turn may end without ending the Run.

**Settlement coordinator** — the per-Run thing that captures exactly one
terminal **candidate** into a `Deferred`. Later candidates increment a
duplicate-settlement counter and change nothing. That is what "a Run settles
exactly once" means when four things — a returned bundle, an interruption, a
defect, and an in-stream `ending` — can each decide a Run is over at the same
moment.

**Arbitration** — the pure function that decides which candidate the Run
actually had. An ending already reduced from the stream wins; a bundle the
execution returned wins over a cancellation request that arrived afterwards; an
interruption that took effect first yields `cancelled` with the *first*
recorded reason; a defect yields `failed` with a redacted `backend-failure`
diagnostic. Pure and tested alone, so the rule is decided in one place rather
than inferred from a race.

**Sealing** — closing a Run's observation intake at the moment its candidate is
captured. Everything emitted afterwards is a counted late event and a no-op, so
the contract's "emit never fails" holds for an adapter emitting from its own
finalizer.

**Cleanup escalation** — what happens when closing the native execution scope
outlives the cleanup budget: a `cleanup-escalation` diagnostic on the Run, the
BackendAgent closed by the core, its Conversation marked lost so a later resume
is honest, and settlement continuing with the observations it has. A hung
finalizer must not leave a Run in `finalizing` forever.

**Subagent records** — what the supervisor knows about each Subagent it owns,
and the only writer of any of it: the fixed facts (id, Profile, context,
BackendAgent, Scope) and the four things that change — the phase, the Run
currently in flight, the fiber settling it, and whether the Conversation is
lost. Every mutation is a call on the module, so the rule that a Subagent owns
at most one active Run is asserted where the record lives rather than at each
call site, and finding a Run's owner is an index lookup rather than a scan.
**Not a registry** — see the historical term of that name.
[ADR-0034](docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md).

**Admission lease** — what one admitted Run holds: a slot in the Session's
capacity, the Subagent's one-active-Run claim, and the Result-store
reservation. One atomic `acquire` yields either a lease or a typed refusal —
*shutting down*, *already running*, or *at capacity* — and the lease gives
back everything it holds in one idempotent `release`, so no path has to
remember which of the three it took. A resume's Subagent is claimed inside the
acquire because its id is known; a start's is `bind`-ed once its backend has
opened, because until then there was no Subagent. The module also owns the
shutting-down flag and the first-caller-wins `beginShutdown`, so "once
shutdown begins, new work is rejected" is one module's promise.
[ADR-0034](docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md).

**Waiter ledger** — how many callers registered at a Run's settlement have
yet to read it, and the Result store's `waiters` pin held on their behalf.
`register` takes one waiter's registration and hands back the release for that
waiter alone, which goes into the wait's own finalizer so that resolving,
timing out, and being interrupted all pass through it — aborting a waiter stops
only that waiter. The pin belongs to the ledger rather than to any one waiter,
so it is let go at exactly two moments: when the last waiter releases, and
when settlement finds there were none.
[ADR-0034](docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md).

**Reservation** — the room a Run takes in the Result store at admission, before
it starts, so that "the result can be stored" is a guarantee rather than an
estimate discovered at settlement. Released by a failed open, and by the
admission lease at Run-fiber exit if a commit has not already consumed it.

A reservation that does not fit **evicts the oldest unpinned stored output**
until one does, and only refuses `at capacity` when there is nothing evictable
left. That is a reversal of the original decision, which refused rather than
evicting: nothing else in a Session ever frees a stored result, so refusing
made a Session's own history able to wedge it permanently.
[ADR-0032](docs/adr/0032-reservations-evict-rather-than-refuse.md).

**Pin** — a hold on a stored result that stops eviction reaching it. Set at
commit for three named holders, and released when terminal publication is done,
when every waiter registered at settlement has read, and when delivery has
succeeded or exhausted its budget.

**Delivery sweep** — a pass comparing stored terminal results against what has
been announced, delivering anything missed. It is why a lost wake-up costs one
extra pass rather than a Notification.

The four words for where a Notification has got to. Each is decided by exactly
one component, and no component may use a word for a state it cannot observe;
[the notification semantics](docs/v2-simplify/notification-semantics.md) is the
table, [ADR-0033](docs/adr/0033-notification-vocabulary-pointer-and-label-bound.md)
is the decision, and a boundary rule keeps *landed* out of
`runtime/delivery.ts`.

**Handed off** — Pi's `sendMessage` accepted the custom message and now holds
it. Decided by `CompletionDelivery`, from the sink's push result. It is the
strongest thing delivery knows and it is not a landing: delivery releases the
stored Result's pin here, on the strength of having stored the Result first.

**Landed** — `message_start` carried the notice into the conversation, so the
model has it. Decided by the **Session push sink** alone, and terminal: a
landed notice is never pushed again. See **Landing** for the mechanism.

**Lost after hand-off** — a host turn was aborted while the message was queued
and Pi discarded it. Decided by the Session push sink, from `agent_end` and
turn-abort evidence. Re-pushed exactly once, when the parent agent settles.

**Exhausted** — the retry budget ran out with no hand-off accepted; three
attempts a second apart by default. Decided by `CompletionDelivery`, from its
own retry loop, and terminal for delivery. The stored Result is untouched, so
`agent_result` still answers.

**Runtime probe** — the test-facing count of what is still alive: live Run
fibers, live reducer fibers, open observation queues, open mailboxes,
unresolved waiters, and open BackendAgents. Every race, backpressure, fault,
and leak test asserts it reads zero after the Session Scope closes, which turns
"nothing leaked" from a hope into an assertion.

**Host boundary** — the `host/` module plus the entry point: the one place
where a Pi callback crosses into Effect. It is the only place
`Effect.runPromise` and `ManagedRuntime` may appear, and the only place that
touches Pi's registries, UI context, and message surface. `AbortSignal` and
`AbortController` are also confined to it, with one exception added at M5: the
Claude adapter may name them, because the SDK takes a controller on its options
bag and offers no other cancellation surface, which is exactly the kind of
provider mechanism an adapter exists to absorb. The core still cannot name
either word, and no adapter may name the two runtime words. The boundary test
enforces every half, so the exit-gate rule is checked rather than reviewed.

**Session handle** — the one process-level variable holding the current
Session's managed runtime, or none. Pi registers tools, commands, and renderers
once per process while a Session starts and ends many times inside it, and this
is where the two lifetimes are reconciled: the registrations close over the
handle and each `session_start` refills it. Binding a runtime disposes whatever
was bound, so a Session switch cannot leave two alive; running against no
runtime returns a text outcome rather than throwing, because a tool call can
arrive between Sessions.

**Façade** — `Subagents`, the six functions the host handlers call and the only
caller of the supervisor from outside the runtime. Each maps a decoded tool
input plus the Session facts to a supervisor request and hands the outcome to
presentation. It has no fields and holds no state; lifecycle stays in the
runtime and prose stays in presentation. It exists because the implementation
this replaced had one orchestrator talking to lifecycle, presentation, and
delivery directly, and once three callers could reach one mutable Run record,
no single place knew what a Run looked like.

**Backend set** — the value a Session is built from: a name, the backends that
exist, the Profiles they ship, and two host facts only a backend can answer —
whether this process is loading as one of its own children, and how deep in a
delegation chain it is. A Session is built from exactly one.

Three sets exist, and only one ships. The **demo backend set** is M3's: the two
fake backends and one **demo Profile** per fake, so launching Pi with only the
entry point gave a working extension with nothing to configure; it stays in the
tree because a host test needs a deterministic backend. The **Pi set** is
M4's, and stays for Pi's own live lane and its tests. The **production backend
set** is M5's and is what the entry point uses: Pi and Claude, no Profiles of
its own, the host facts from Pi, and one native probe per backend. A Profile's
`backend:` field is what picks one of the two.

**Session push sink** — the `NotificationSink` implementation that pushes a
completion Notification into a live Pi Session as a follow-up message that
triggers a turn. It exists because *pushed is not landed*: `CompletionDelivery`
is done when a push succeeds, correctly, since it stored the Result first — but
Pi queues a follow-up and an interrupted turn discards what was queued.

**Landing** — a pushed Notification actually reaching the conversation. Tracked
by the sink through four host events: a push records the notice unlanded, a
`message_start` carrying it marks it landed and forgets it, a turn whose stop
reason or signal says it was aborted marks every unlanded notice lost, and
`agent_settled` pushes each lost notice again exactly once. Exactly one landing
per Notification is the sink's contract. The retained value is the bounded
notice rather than a pin on the stored Result, because delivery releases that
pin on a successful push.

**RunCard** — the pure presentation of one Run, built from a published index row
(live, and therefore carrying no output) or from an immutable stored Result
(terminal, and therefore carrying everything). It is where Run presentation
grows: M3 gave it identity, status, duration, accounting, and the final output,
and M4 added the recent transcript, the tools with their statuses, the context
gauge, diagnostics, links, and the truncation record. Having one place for that
is what stops four renderers each assembling the same fields in a slightly
different order. Every expanded section is omitted when it is empty: a Run that
used no tools has nothing to say about tools rather than zero of them.

**Pi adapter** — everything this codebase knows about Pi, in `backend/pi/`. The SDK's
session symbols, its message and event shapes, the resource loader, the
child-load discriminator, and the depth environment variable all stop there,
and the boundary test enforces it in both directions: nothing outside names a
Pi session symbol, and nothing outside the composition root imports the
directory at all. The adapter does not know the runtime, the host, or
presentation exist.

**Claude adapter** — everything this codebase knows about Claude, in
`backend/claude/`.
The SDK's `query` function, its forty-member frame union, its options bag, its
streamed input message, and the provider's own `AbortController` all stop
there. The boundary test enforces it by *specifier* rather than by binding —
stricter than the Pi rule, because `@anthropic-ai/claude-agent-sdk` is a
provider and nothing else, while Pi's package is also the host API — and it
admits the SDK nowhere outside the directory, not even in the adapter's own
test doubles, which take the SDK's types through the aliases the adapter
re-exports. The adapter does not know the runtime, the host, presentation, or
the *other two adapters* exist.

**Codex adapter** — everything this codebase knows about Codex, in
`backend/codex/`. The
child process, the App Server's JSON-RPC framing, its request and notification
shapes, the root thread and turn identities, the Subagent-scoped reader, and
the steering correlation all stop there. The boundary test enforces it three
ways: `node:child_process` is admitted in that directory and nowhere else in
the tree, nothing outside the composition root imports the directory at all,
and the
App Server's own vocabulary — the transport, the routing table, the protocol
shapes, the child-process types — may not be *named* even by the composition
root, which sees only the factory, the id, the options, and the probe. The
adapter does not know the runtime, the host, presentation, or the other two
adapters exist.

**App Server** — `codex app-server`, the Codex CLI's headless JSON-RPC mode,
spoken over a child process's stdin and stdout one line per frame. One Codex
Subagent owns one of them for its life.

**Root thread** — the ephemeral Codex thread a Codex BackendAgent starts at
`open` and retains for its Subagent's life. It is the whole of what "resume"
means for Codex: there is no `thread/resume` and no stored rollout, so a later
Run is another Turn on the same root.
[ADR-0021](docs/adr/0021-retained-ephemeral-codex-conversation.md).

**Turn** — one unit of Codex work on a thread, named by a turn id that
`turn/start` returns before the model does anything. One Run is exactly one
Turn, and the turn id is the routing key every frame of that Run carries.

**Subagent-scoped reader** — the one fiber that owns a Codex BackendAgent's
stdout for its whole life, because the stream outlives every Run and the server
issues client-bound requests between Turns that stall it if nobody answers.
It demultiplexes frames by turn id into the active Run's intake, with a frame
for an unknown or settled Turn reaching no Run at all. That is ADR-0023's first
exception: for Pi and Claude "a late event cannot reach a settled Run" is true
because the event source is gone, and for Codex it is a **routing** decision
the adapter has to make.
[ADR-0023](docs/adr/0023-v2-scope-ownership.md),
[ADR-0024](docs/adr/0024-v2-observation-ordering.md).

**Late frame** — a frame the reader routed nowhere, counted rather than
dropped silently. It is what makes a Codex routing bug visible: such a bug does
not crash, it either applies a stale frame to a live Run or loses a live one,
so the tests assert the counter in both directions.

**Loss signal** — how a Codex Run learns its conversation is over, given that
the protocol will never say so. There are exactly two, and neither is on the
wire: **process exit**, watched by the client that owns the child, and an
**expired request bound** on the runtime clock, which is what a
wedged-but-alive process produces. The M0 spike killed an App Server mid-Turn
and found no terminal frame ever arrived and a later request neither resolved
nor rejected.
[ADR-0025](docs/adr/0025-v2-terminal-settlement.md).

**Signal ladder** — the bounded SIGTERM-then-SIGKILL escalation a Codex
adapter falls back on: after `turn/interrupt`, if the Turn does not report
itself interrupted within the rung's bound, and again before the process is
killed outright. It stands down the moment the child exits or *the Turn it was
armed for* reports itself interrupted, which is why an ordinary cancel sends no
signal at all. Armed **per Turn, by turn id, before the interrupt is written**,
and the stand-down is noticed by the transport as the frame is parsed. All
three details are load-bearing: a stand-down kept per BackendAgent would be set
by the first cancelled Run and disarm every later one; a Run watching for its
own confirmation would miss it, because by then the Run has settled and given
up its routing entry; and arming after writing the interrupt would miss a
server that answers before the arming exists.

**Client message id** — the id the Codex adapter attaches to a `turn/steer`,
and the only thing that can later confirm the guidance was read: a `user`
observation appears when — and only when — a user-message item comes back
carrying it. A steer already sent keeps its correlation live through
cancellation, because the model really did read it.
[ADR-0012](docs/adr/0012-ordered-codex-steering.md).

**Conversation-cumulative usage** — Codex's `tokenUsage.total`, which is the
running total for the whole thread rather than for the Run reporting it. A
Run-local delta is the difference against the total the Turn started from, and
the context gauge is `tokenUsage.last` — the last request's own occupancy —
because the cumulative figure grows without bound and would exceed its own
window. `turn/completed` carries no usage at all, so the last usage frame
before it stands and nothing waits for one that will never come.
[ADR-0027](docs/adr/0027-v2-usage-normalization.md).

**Conversation identity** — the single opaque string a Claude BackendAgent
retains for its Subagent's life. It is the whole of what "resume" means for
Claude, and ADR-0024 forbids it from crossing the seam, so it never appears in
an observation, a result, or a Notification. Its state is **unopened**,
**opened**, or **lost**, and loss is monotonic: close, a failed attachment, and
an identity mismatch each reach `lost`, and nothing moves back.

**Unopened** — a BackendAgent that holds no provider identity because none
exists yet. The Claude SDK has no open call: `query()` starts an execution, and
an identity first appears on the init or result frame of the first Run. So
opening a Claude BackendAgent loads the SDK and constructs nothing, and
`admitResume` answers `conversation lost` until a Run has produced an identity.
That is ADR-0023's first exception, and it is why `ResumeAdmission` has three
answers rather than four: "never opened" and "the conversation is gone" are the
same fact to a caller.
[ADR-0023](docs/adr/0023-v2-scope-ownership.md).

**Identity boundary** — the frame that carries a conversation identity
authoritatively: the init frame, and every result frame. Before its boundary a
resumed Query may replay user, assistant, and system history belonging to the
earlier conversation, and none of it is this Run's work — so a resumed Run
drops every frame until the boundary, whether or not the provider flagged it as
a replay. At the boundary a missing, malformed, or *different* identity fails
the Run with a fixed attachment message and marks the conversation lost. It
never falls back to a fresh conversation, because a resumed Run silently
answering from an empty context is worse than one that says it could not
attach.

**Turn boundary** — a provider result frame that ends a *turn* rather than the
Run. Claude's steering enters a live Query through the same input stream the
prompt came from, and the provider answers each turn with its own result frame.
So a Run with guidance still outstanding stays active across a result the
provider correlated to an input the Run owns, and settles on the result that
finds nothing outstanding. The execution decides when the Run is semantically
complete; the core still performs the terminal transition. ADR-0018 meeting
ADR-0025.

**Client-owned input stream** — the async iterable one Claude Run creates,
pushes its prompt and each admitted Control into, and closes. The SDK only
iterates it. It is Run-scoped, because a Query whose input never closes never
ends — and because guidance has to be able to reach a Query that is still
running.

**Control slot** — the one place a Claude Control can be provider-visible at a
time. The steering consumer is deliberately **not eager**: it takes one Control
from the mailbox and only when the slot is free, so guidance the provider is
not ready for stays in the mailbox where ADR-0026 puts the bound and where a
caller learns at once that there is no room. An adapter that drained the
mailbox into an array of its own would have moved the queue somewhere with
neither a bound nor an answer.

**Confirmation** — the provider evidence that turns an admitted Control into a
`user` observation: a user frame echoing the uuid the client pushed, or a result
frame naming that uuid as the input its turn answered. Nothing else counts. A
Control the provider never acknowledges was still *accepted*, which is what the
caller was told, and it appears nowhere in the transcript — a transcript
showing guidance the model never saw is the one lie this seam must not tell.

**Adapter tally** — BackendAgents an adapter opened, and closes that took
effect. Beside the native probe and deliberately not part of it: it answers a
different question and never returns to zero, so a probe carrying it could
never read clear. It exists because Claude has no SDK close call to count
twice, and "close is idempotent" needs a number rather than a claim.

**Child-load discriminator** — the `AsyncLocalStorage` flag that says "this
resource load belongs to a child". Pi initializes an extension's factory while
the loader discovers resources and applies the extensions filter only
afterwards, so the filter alone would not stop a child from registering the
delegation tools; the flag covers that window. Shared through a global
symbol, so whichever entry point a child reaches reads a true answer.

**Child depth** — how deep in a delegation chain a process is, carried in the
`PI_SUBAGENT_DEPTH` environment variable that a Bash spawn's own environment
gains. Zero in a parent. The entry point registers nothing above zero, and
admission refuses a Run past `DEFAULT_MAX_DELEGATION_DEPTH`, which is one:
delegation is one level deep.

**Native probe** — what an adapter is still holding, counted: for Pi, open
native sessions, live event subscriptions, and native cleanups in flight; for
Claude, live Queries, open input streams, and retained conversation identities;
for Codex, live App Server processes, reader fibers, pending JSON-RPC requests,
retained root threads, and in-flight steers.
Deliberately outside the backend contract — a probe on the contract would be a
field every adapter had to invent something for, and a number the core could
start believing. `/subagent` prints one block per backend beside the
runtime's own, because "which adapter is still holding something" is the only
question a probe exists to answer and a merged total cannot answer it. Every
block must read zero once a Session has closed.

**Callback bridge** — the buffer between Pi's synchronous event listener, which
cannot wait, and the observation intake, which applies backpressure. It never
drops: a buffer that fills fails the Run out loud with the backend module's two
overflow observations, because a Run that quietly lost half its transcript is
indistinguishable from one that had nothing more to say.

**AgentHarness** — reserved for Pi's own native abstraction, and the one
compound the boundary test admits that contains the legacy field name. Nothing
of ours is called this.

## Historical terms

The 1.x implementation is deleted. Its vocabulary is recorded here so that a
plan, an ADR, a commit message, or an exit gate written in the old words is
still readable, and so that "what happened to X?" has an answer that is not
`git log`. What each abstraction was replaced *by*, and why, is [the deletion
ledger](docs/v2/deletion-ledger.md).

Terms that carried over unchanged — Agent, Profile, Subagent, Run, Resume,
Conversation, Conversation loss, Control, Turn, Detached Run, Ending, Cancel,
Result, Notification, Wait, Result store, Depth, Trust, Shutdown — are defined
above and are not repeated here.

**Harness** — 1.x's name for a named provider integration. Replaced by
**Backend**. The word survives in exactly one place: `AgentHarness`, Pi's own
native abstraction, which ADR-0022 reserves. The frontmatter field `harness:`
is replaced by `backend:` with no alias — [the migration
note](docs/v2/profile-backend-field-migration.md).

**Fact** — 1.x's neutral record of something a child did. Replaced by
**Observation**, which is ordered and lossless within a Run and carries ten
kinds rather than two.

**Attempt** — in 1.x a documented domain term: one disposable provider
attachment executing one Run against a Conversation. It is now explicitly *not*
a core type and appears in no core signature; adapters may use the word
internally for native execution details and retries.

**Subagent manager** — 1.x's owner of Subagent identity, Profile association,
lifecycle, and the active-Run relationship. Replaced by the **Subagent Scope**
and the supervisor's records: ownership is a Scope rather than a map.

**Registry** — 1.x's `SubagentRuns`, which held live-display Runs and handed
out write access to them. Replaced by the **RunRepository**, which is the only
writer of Run snapshots and hands out no write access at all. The word stays
retired: the supervisor's own per-Subagent state is the **Subagent records**,
and naming a new thing "registry" would make this section, whose whole job is
to let an old plan still be read, say something untrue.

**Dispatcher** — 1.x's orchestrator, which talked to lifecycle, presentation,
and delivery directly. Replaced by the **Façade** for input mapping, the
**supervisor** for lifecycle, and **presentation** for prose — three seams
where there was one caller, which is what stopped three callers reaching one
mutable Run record.

**Executor** — 1.x's per-Run provider driver. Replaced by the **backend
contract**'s `execute`, which returns a **terminal bundle** and settles
nothing.

**Control source** — 1.x's per-Run Control lifecycle, with its own gate and
subscriber. Replaced by the **Control mailbox** in the Run Scope, which is a
bounded queue closed by the Scope.

**Session lifecycle** — 1.x's hand-ordered shutdown machinery. Replaced by
**Scope** nesting: closing the Session Scope releases everything beneath it in
reverse acquisition order, so there is no order to hand-write.

**Session push** — 1.x's process-lifetime push target, re-aimed at each
`session_start`. Replaced by the **Session push sink**, which does the same
re-aiming and additionally tracks **landing**.

**Ingress order** — 1.x's adapter-local ordering of provider events, Controls,
cancellation, process outcomes, and escalation in one reducer. The property
survives as observation ordering ([ADR-0024](docs/adr/0024-v2-observation-ordering.md));
the Codex adapter's **Subagent-scoped reader** is where the one-reducer shape
still lives, because Codex is the backend whose Turn and steering share a
connection.

**Pi session** — 1.x's name for the retained in-process `AgentSession`. It is
now one instance of a **BackendAgent**, which is the word for the same thing
across all three backends.

**Projection** (1.x sense) — 1.x's shared mutable Run record, which four
modules could reach ([ADR-0004](docs/adr/0004-shared-mutable-run-record.md)).
The word is kept for the *immutable* value the reducer produces; the mutable
record is gone.

**Dogfood switch** — the local settings switch that ran the rewrite beside the
frozen implementation during the migration, and its inverse, the v1 fallback
switch. Both are deleted: the manifest names the one extension there is.
