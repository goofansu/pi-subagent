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
continues its retained SDK session; Claude and Codex attach a fresh disposable
Attempt through their native continuation mechanism. All continuation remains
inside the prepared adapter and current Session.

**Conversation** — provider-owned semantic context that may span multiple Runs
of one Subagent. Its continuation identity and accounting baseline stay inside
the prepared adapter; it is neither a Subagent nor a Run and never crosses the
Harness seam.

**Attempt** — one disposable provider attachment used to execute one Run
against a Conversation. Claude owns one fresh streaming Query per Attempt;
Codex owns one fresh App Server child, initialization, current Turn,
translator, accounting fold, ordered reducer, and cleanup boundary. No Claude
or Codex Attempt remains alive while its Subagent is idle. Pi instead retains
one idle-capable SDK session and gives each Run a fresh subscription,
accounting baseline, reporter, and Control consumer.

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

**Turn** — one completed provider model turn (response), folded into a run's
usage and counted by the widget. A turn is provider accounting, not a second
run or a provider session that can be resumed. Claude provisionally counts one
unique root assistant message id (including aborted frames), treating a
missing parent id as root for compatibility, deduplicating its block-level
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
declares neutral capabilities, prepares independent per-Run executions, and
closes idempotently; provider continuation never crosses this seam.

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
