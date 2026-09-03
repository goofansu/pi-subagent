# Domain model

The vocabulary this codebase uses. Terms here are load-bearing: they name the
seams, and code that uses a different word for the same thing is a bug in the
naming, not a synonym.

## Core

**Agent** — a named role a task can be delegated to, e.g. `explore`. An agent is
defined by exactly one **profile**.

**Profile** — the Markdown file that defines an agent: frontmatter configuring
the run and a body that is the agent's prompt. Generic parsing understands only
`description`, `harness` (default `pi`), and the body; every other field
(`model`, `effort`, `tools`, `appendSystemPrompt`) keeps one name across
harnesses but is validated and interpreted by the named harness, and a field
the harness does not recognize is a diagnostic, not a silent pass-through.
Named after the agent, so `explore.md` defines `explore`. Read only from user
scope; see `getAgentsDir`.

**Subagent** — a stable, Session-scoped asynchronous identity created from one
Profile. A Subagent is **running** with exactly one active Run, **idle** with no
active Run, or **closed**. Creation moves directly to running with its first Run;
there is no empty or queued state. The manager owns its Profile association,
prepared Harness adapter, lifecycle, and active-Run relationship. A terminal
Run leaves an open Subagent idle, while Session shutdown closes it. A Subagent
id is local, distinct from every Run id, and never a provider identity. A
successful `agent_resume` synchronously claims a resumable idle Subagent and
starts its next Run; an active Subagent rejects resume rather than queueing it.

**Run** — one managed goal cycle of one Subagent's fixed Profile, begun by one
new prompt and settled exactly once with one immutable terminal Result. A Run
may span several provider Turns: intermediate provider completion is
accounting and Conversation evidence, not a second Run and not necessarily
settlement. A Run has its own local id, lifecycle, transcript, usage, Result,
and owning Subagent.
The registry holds live-display Runs, and the widget lists them. Not "job", not
"task", not "call", and not a provider Turn. Notification delivery state is a
separate state machine, tracked by the delivery module keyed by Run id — never
on the Run itself.

**Resume** — the asynchronous orchestration operation that accepts a stable
Subagent id plus the next Run's description and full prompt. It returns the new
Run id immediately rather than an answer. Resume never rebinds the fixed
Profile, Harness adapter, working directory, child depth, resolved policy, or
trust posture, and core never receives a provider continuation token. Pi
continues its retained SDK session; Codex starts another Turn on its retained
process-local Conversation; Claude attaches a fresh disposable Attempt through
native continuation. All continuation remains inside the prepared adapter and
current Session. Resume reports **Conversation loss** distinctly when a
previously resumable Subagent has lost that context.

**Conversation** — provider-owned semantic context that may span multiple Runs
of one Subagent. Its continuation identity and accounting baseline stay inside
the prepared adapter; it is neither a Subagent nor a Run and never crosses the
Harness seam. A Codex Conversation is process-local and retains its App Server
until Session shutdown. Losing that process loses the Conversation, leaving the
Subagent idle but non-resumable; recovery requires a new Subagent rather than a
replacement Conversation.

**Conversation loss** — the terminal loss of provider semantic context needed
to Resume a Subagent, not merely a failed or cancelled Run. Loss known before
Resume admission starts no Run; loss after admission belongs to that Run, while
a terminal Result remains immutable. The Subagent then remains idle but
non-resumable, and a later Resume reports the loss without exposing provider
identity or mechanism.

**Attempt** — one disposable provider attachment used to execute one Run
against a Conversation. A prepared Run is not yet an Attempt: the Attempt
begins when execution starts and ends only after its Run-local provider cleanup
finishes. Claude owns one fresh streaming Query per Attempt; Codex owns one
fresh Turn, translator, accounting delta, ordered reducer, and Run-local cleanup
while its retained App Server remains the Conversation owner. A Codex Attempt
settles after its matching Turn completion is fully reduced; the retained
process does not settle the Run. No Attempt remains alive while its Subagent is
idle. Pi instead retains one idle-capable SDK session while each Attempt owns a
fresh provider-event subscription and accounting baseline and consumes its
Run's fresh reporter and Control source.

**Control** — bounded, harness-neutral guidance offered while a Run is active.
The only Control is steering text. `accepted` means the complete text entered
the Run's bounded local admission and synchronously reached the source's one
subscriber; it does not claim that a provider accepted it, a model consumed
it, or it became transcript truth. A prepared Run declares supported Controls,
and unsupported Runs have no live source. Pi serializes native session
steering; Claude serializes user input through one ordered Query engine across
provider Result boundaries; Codex reduces Controls with its App Server events
and sends native `turn/steer`. Cancellation discards unsent admissions and
provider queues. Only authoritative provider evidence of the guidance, never
local admission or request acceptance, becomes a neutral user Fact.

**Ingress order** — the adapter-local order assigned when a complete external
occurrence enters the executor, before translation, reporting, or Promise
continuations can delay it. Codex orders provider events, Controls,
cancellation, process outcomes, and escalation in one Attempt reducer because
its semantic Turn and native steering share one App Server connection. A
successful Control offer assigns this order during its synchronous subscriber
callback, before the offer returns; cancellation-first instead closes the gate
before abort ingress. Only the reducer may initiate native `turn/steer` or
`turn/interrupt`. Provider ordering and identity remain adapter-local; neither
a local Subagent id nor a Run id is a provider thread, Turn, item, request, or
correlation identity.

**Turn** — one provider model response, folded into a Run's usage and counted
by the widget. A Turn is provider accounting, not a second Run or a provider
session that can be resumed. In the retained Codex lifecycle, each Run owns one
current protocol Turn and a matching completion settles its Turn-scoped Attempt
only after current ingress is fully reduced; later Turns continue on the same
Conversation. Claude provisionally counts one unique root assistant message id
(including aborted frames), treating a missing parent id as root for
compatibility, deduplicating its block-level
events, and excluding non-null sidechains. Its terminal total can raise that
count but never lower it, so cancellation and backend failure preserve already
observed progress. Missing message ids contribute nothing until a usable
terminal total can catch up; missing or invalid totals are ignored. Refusal
fallback retractions cannot retract additive Facts, so their bounded overcount
is accepted rather than desynchronizing later catch-up.

**Detached run** — a run that outlives the turn that started it. Every run
started by `agent_start` or `agent_resume` is detached from the turn: `Escape` does not stop it.
It is not detached from the session — a result belongs to the conversation
that asked for it, so every `session_shutdown` (switch, fork, resume, new,
reload, quit) cancels whatever is still running.

**Pi session** — the lazy, in-process `AgentSession` owned by one prepared Pi
adapter. It uses normal resources and memory-only state, is bound headlessly,
retains provider context while idle, and accepts one prompt plus serial native
steering for the active Run. Its orchestration tools and this extension are
excluded from child discovery.

**Fact** — a harness-neutral record of something the child did: usually a
message with a role and parts (text, tool call) plus usage, model, and stop
reason in domain units. A metadata fact carries provider run metadata without
pretending the provider emitted a conversational message; it contributes no
implicit turn. Facts are the only vocabulary that crosses the executor seam;
a wire format is translated into facts inside its harness and nowhere else.

**Ending** — the executor's honest terminal resolution of a run: **answered**,
**failed** (with an optional fallback message), or **cancelled**. It carries no
exit code or backend stop vocabulary; the fold turns it into lifecycle state
and preserves fact-derived details.

**Cancel** — request that a run stop. *Cancelled* is the terminal domain status
of a run stopped intentionally; the model, the operator, and presentation all
say cancelled. *Abort* is not a domain word: it is mechanism vocabulary —
`AbortController`/`AbortSignal`, pi's `stopReason: "aborted"` — normalized to
cancelled at the executor seam and never shown above it.

## Delivery

**Result** — the authoritative immutable terminal output for a managed Run. It
records the owning Subagent for orientation, is written to the result store
only when the Run settles, and remains authoritatively retrieved by Run id with
`agent_result`. A provider's own Result event is adapter-local Turn evidence;
it is not this domain Result and is not synonymous with Run settlement.

**Notification** — a small status-specific completion notice pushed as a
follow-up message. It identifies both the owning Subagent and the specific Run,
orients the model, and points to `agent_result` by Run id; it is not the Result
itself. Pushed is not landed: pi may hold a follow-up while the model
is mid-turn. If an interrupt discards it, the notification is pushed again
after the agent settles. One landing per notification is the invariant.

**Wait** — `agent_wait` observes terminality only. It returns run identity and
terminal lifecycle state, never output, and does not suppress notifications or
affect the result store. Repeated waits return the same lifecycle state.

**Result store** — the authoritative home of every terminal run's output,
addressable by id from the moment the run settles. `agent_result` observes a
stored result without consuming or pinning it. Results are scoped to the
session that asked: shutdown clears the store. Whole outputs are held only up
to a character budget; past it the oldest outputs are evicted, and an evicted
run still answers by id, saying its output is gone. Notification delivery does
not determine whether a result is stored.

**Session push** — the process-lifetime push target notifications go through
(`createSessionPush`). A session's own `sendMessage` throws once that session
is replaced, so each `session_start` re-aims the target. A notification emitted
with no live session is dropped rather than thrown through the stale API — a
crash guard for the teardown race, never a cross-session delivery channel.

## Modules

**Subagent manager** (`subagents.ts`) — the Session-scoped owner of Subagent
records, lifecycle, fixed Profile association, prepared adapter lifetime, and
active-Run relationship. It creates a Subagent and first Run atomically, retains
the adapter while idle, synchronously admits at most one resumed Run, marks
every Subagent closed before shutdown cancellation, and cannot be reopened by
late settlement.

**Registry** — the module owning the set of live-display Runs and their
lifetime. Everything that displays or acts on Runs reads it; the dispatcher is
the only module that adds Runs, and notification delivery is the only module
that releases them — when the notification actually lands in the conversation,
nowhere else. Released identities remain spent until Session shutdown resets
the registry.

**Projection** (`RunView`) — an immutable row derived from a run for display.
Callers never touch the mutable run record.

**Dispatcher** (`runner.ts`) — the rules that hold for every Run whatever it
does: lifecycle settlement and sole ownership of the Run record — executors
report facts, and the fold in `run.ts`, invoked only by the dispatcher, is what
writes them. The manager supplies a retained prepared adapter; dispatch creates
a fresh Result, Control gate, reporter, and execution for the Run and does not
own adapter lifetime.

**Harness** — a named backend (`pi`, `claude`, `codex`) that knows how to run Profiles:
it validates the harness-owned parts of a profile and prepares one
Subagent-scoped adapter from the fixed Profile, working directory, child depth,
project trust, and inherited parent-model policy. A profile names its harness;
core resolves that name through the harness registry and never interprets
harness-specific configuration or imports a backend's types. The prepared
adapter is the only object allowed to retain provider Conversation state. It
prepares the initial Run, synchronously admits Resume as admitted, unsupported,
or Conversation loss, prepares independent per-Run executions, and closes
idempotently; provider continuation never crosses this seam.

**Executor** — the per-Run execution a prepared adapter supplies
(`harnesses/pi/agent.ts` is the Pi harness's retained-session engine). Each
execution is prepared from only that
Run's description and prompt, then receives a fresh reporter, AbortSignal, and
Control source. The source synchronously presents each accepted admission to
its one subscriber, which explicitly acknowledges when it takes the Control;
the admission remains bounded until then. The executor witnesses what the child did: it reports harness-neutral
facts through the reporter defined in `run.ts` and resolves to an **ending**;
it never touches the run record. Steering support is declared per prepared Run;
there is no Harness control method or provider session in core. Wire format
stops inside the harness — no backend's message shapes cross this seam.

**Conformance** — the capability-aware battery of thirteen required scenarios every
harness's executor must pass as part of its own tests: `backend-crash`,
`abort-mid-run`, `terminal-answer-then-abort`, `usage-totals`, `child-depth`,
`config-immutable`, `no-terminal-answer`, `post-answer-failure`, and
`terminal-transcript-healing`, `steering-single-consumed`,
`steering-fifo-consumed`, `steering-intermediate-completion`, and
`steering-admission-no-fact`. It makes the executor obligations of `run.ts`
mechanical: backend failures resolve as failed, backend aborts normalize to
cancellation, a terminal answer survives a later abort, usage deltas fold with
latest context gauges, child depth reaches the child, and profile configuration
stays unchanged. Snapshot-capable harnesses heal streamed drift; Codex has no
transcript snapshot and instead proves its final completed agent message from
the App Server event stream remains an authoritative streamed fact without
inventing a replacement. Claude is the only harness with a visible skip for
this scenario.

**Presentation** (`presentation.ts`) — how a run and its notification read to a
human: status tones, verbs, phrases, tool-outcome prose, and notification text.
It is the only module that interprets a lifecycle status for display and the
only producer of model-facing prose about runs; the delivery module does
bookkeeping and asks this one what a notification says.

**Session lifecycle** (`session-lifecycle.ts`) — owns Session start and
shutdown: refilling stable profile/session-fact references, re-aiming pushes,
replacing the widget, single feature registration, warnings, and ordered
cleanup. Shutdown unbinds delivery, asks the manager to close Subagents and
cancel active Runs, then clears delivery and live Run state. The composition
root only forwards host events to it.

**Activity** — the one-line summary of what a run is doing right now. An
executor may report ephemeral live activity through the run seam; while it is
present, the projection prefers it over the dispatcher's fold-derived summary
of the most recent tool call. Display only: live activity is never transcript
truth, usage, or final output, and settling clears it so settled runs are quiet.

## Constraints

**Depth** — delegation is one level deep. A subagent cannot start subagents,
whichever harness runs it. The Dispatcher alone decides a child's depth;
executors only copy it, and each harness owns enforcement in its children —
per-spawn `PI_SUBAGENT_DEPTH` for Pi Bash and Codex transport, with
agent-spawning tools denied for Pi and Claude.

**Trust** — Pi's project-trust decision for the working directory, resolved by
the session and fixed when a Subagent is prepared; the extension never derives
its own. Applying it is harness policy: Pi applies it to retained SDK settings
and resource loading; Claude and
Codex do not consult it yet — their policy is a constant bypass, the forwarded
value reserved for a future shared posture (ADR-0009).

**Shutdown** — every `session_shutdown` first marks every Subagent closed, then
forwards cancellation to active Runs, closes idle and active adapters, drops
every unlanded notification, clears the Result store, releases live display
state, and forgets local Subagent and Run identities. A late settlement cannot
move a closed Subagent to idle or notify the next Session. The next Session's
model never started these Runs and has no context to act on their answers.

## v2 vocabulary

Everything above describes v1, which is frozen (see
[`docs/v2/freeze.md`](docs/v2/freeze.md)). The rewrite in
`extensions/subagent-v2/` uses the vocabulary below from its first line of code.
Where a v2 term replaces a v1 one, the v1 term stays valid for v1 and is deleted
with it at milestone M7. The decision is
[ADR-0022](docs/adr/0022-v2-terminology-and-backend-field.md).

**Backend** — the identity of Pi, Claude, or Codex. `BackendId` is its type.
Replaces v1's **Harness** as the name for a named provider integration.

**Adapter** — the integration boundary that implements one backend. Provider
wire objects never cross it. v1 already uses this word for the object a Harness
prepares; v2 uses it for the whole module.

**BackendAgent** — the adapter-owned retained native conversation, session, or
process. Owned by exactly one Subagent Scope and alive for that Subagent's whole
life. v1 has no single word for this: it is the retained Pi SDK session, the
retained Claude Conversation identity, and the retained Codex App Server process
plus its ephemeral root, described separately.

**SubagentId** — the stable logical specialist the product exposes. v1 calls it
the Subagent id. Minted as `subagent-<nonce>-<n>`.

**RunId** — one public `start` or `resume` operation. v1 calls it the Run id.
Minted as `run-<nonce>-<n>`, numbered from one independently of SubagentId's
sequence.

**Session nonce** — four random characters minted once per Session runtime and
carried by every SubagentId and RunId that runtime hands out. It is what makes
an identifier mean one thing rather than one thing per Session: identity sets
are forgotten at the Session boundary, but the conversation transcript is not,
so without it a Run id written before a reload would resolve to whichever Run
had since taken that number. With it, a stale identifier is reported as
unknown. Two Sessions draw the same nonce about once in 1.7 million, and share
every identifier when they do — a weaker guarantee than v1's, which needed no
such term because it drew a random id per Run.
[Operation semantics §5](docs/v2/operation-semantics.md).

**Attempt** — adapter-internal vocabulary for native execution details and
retries. In v2 this is explicitly *not* a core product type and never appears in
a core signature; in v1 it is a documented domain term (see **Attempt** above).

**Scope** — an Effect resource lifetime. v2 nests them Session → Subagent → Run
→ native execution, and closing one releases everything beneath it. This
replaces v1's hand-ordered shutdown machinery.
[ADR-0023](docs/adr/0023-v2-scope-ownership.md).

**Observation** — the neutral record of something a backend witnessed, ordered
and lossless within a Run. Replaces v1's **Fact**.
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
writes to one. Replaces v1's mutable Run record.

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

**Reservation** — the room a Run takes in the Result store at admission, before
it starts. A Run that cannot reserve one is rejected `at capacity`, so a
reservation is a guarantee that the result can be stored rather than an
estimate. Released by a failed open.

**Pin** — a hold on a stored result that stops eviction reaching it. Set at
commit for three named holders, and released when terminal publication is done,
when every waiter registered at settlement has read, and when delivery has
succeeded or exhausted its budget.

**Delivery sweep** — a pass comparing stored terminal results against what has
been announced, delivering anything missed. It is why a lost wake-up costs one
extra pass rather than a Notification.

**Runtime probe** — the test-facing count of what is still alive: live Run
fibers, live reducer fibers, open observation queues, open mailboxes,
unresolved waiters, and open BackendAgents. Every race, backpressure, fault,
and leak test asserts it reads zero after the Session Scope closes, which turns
"nothing leaked" from a hope into an assertion.

**Host boundary** — the v2 `host/` module plus the entry point: the one place
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
runtime and prose stays in presentation. It exists because v1's dispatcher
talked to lifecycle, presentation, and delivery directly, and once three callers
could reach one mutable Run record, no single place knew what a Run looked like.

**Backend set** — the value a Session is built from: a name, the backends that
exist, the Profiles they ship, and two host facts only a backend can answer —
whether this process is loading as one of its own children, and how deep in a
delegation chain it is. A Session is built from exactly one.

Three sets exist, and only one ships. The **demo backend set** is M3's: the two
fake backends and one **demo Profile** per fake, so launching Pi with only the
v2 entry point gave a working extension with nothing to configure; it stays in
the tree because a host test needs a deterministic backend. The **Pi set** is
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

**Pi adapter** — everything v2 knows about Pi, in `backend/pi/`. The SDK's
session symbols, its message and event shapes, the resource loader, the
child-load discriminator, and the depth environment variable all stop there,
and the boundary test enforces it in both directions: nothing outside names a
Pi session symbol, and nothing outside the composition root imports the
directory at all. The adapter does not know the runtime, the host, or
presentation exist.

**Claude adapter** — everything v2 knows about Claude, in `backend/claude/`.
The SDK's `query` function, its forty-member frame union, its options bag, its
streamed input message, and the provider's own `AbortController` all stop
there. The boundary test enforces it by *specifier* rather than by binding —
stricter than the Pi rule, because `@anthropic-ai/claude-agent-sdk` is a
provider and nothing else, while Pi's package is also the host API — and it
admits the SDK nowhere outside the directory, not even in the adapter's own
test doubles, which take the SDK's types through the aliases the adapter
re-exports. The adapter does not know the runtime, the host, presentation, or
the *other adapter* exist.

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
delegation tools; the flag covers that window. Shared with v1 through a global
symbol, so whichever entry point a child reaches reads a true answer.

**Child depth** — how deep in a delegation chain a process is, carried in the
`PI_SUBAGENT_DEPTH` environment variable that a Bash spawn's own environment
gains. Zero in a parent. The entry point registers nothing above zero, and
admission refuses a Run past `DEFAULT_MAX_DELEGATION_DEPTH`, which is one:
delegation is one level deep.

**Native probe** — what an adapter is still holding, counted: for Pi, open
native sessions, live event subscriptions, and native cleanups in flight; for
Claude, live Queries, open input streams, and retained conversation identities.
Deliberately outside the backend contract — a probe on the contract would be a
field every adapter had to invent something for, and a number the core could
start believing. `/subagent-v2` prints one block per backend beside the
runtime's own, because "which adapter is still holding something" is the only
question a probe exists to answer and a merged total cannot answer it. Every
block must read zero once a Session has closed.

**Callback bridge** — the buffer between Pi's synchronous event listener, which
cannot wait, and the observation intake, which applies backpressure. It never
drops: a buffer that fills fails the Run out loud with the backend module's two
overflow observations, because a Run that quietly lost half its transcript is
indistinguishable from one that had nothing more to say.

**Dogfood switch** — the local, reversible change that makes v2 what plain `pi`
loads: this package's entry in Pi's settings gains an empty `extensions` list,
disabling its v1 extension alone, and the v2 entry point is added to the
settings' extension paths. `make dogfood-v2` and `make dogfood-v1`. The
published manifest still exposes only v1 until M7.

**AgentHarness** — reserved for Pi's own native abstraction. v2 never uses it
for anything of ours.

### v1-only terms, scheduled for deletion at M7

**Harness**, **Executor**, **Dispatcher**, **Registry**, and **Subagent
manager** name v1 modules and seams that v2 does not have. They remain correct
for v1 and must not be used in v2 code, plans, or documents.

### Configuration

A v2 Profile names its backend with `backend:`, not v1's field. The values are
unchanged and the default is still `pi`. The migration is a documented rename
with no alias and no tool; see
[`docs/v2/profile-backend-field-migration.md`](docs/v2/profile-backend-field-migration.md).
