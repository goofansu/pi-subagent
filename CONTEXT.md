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

**Run** — one execution of one profile against one prompt. A run is one-shot —
one prompt in, one terminal answer out — whichever harness executes it. A run
has an id, a lifecycle, a transcript, and usage. The registry holds runs, and
the widget lists them. Not "job", not "task", not "call". Notification delivery
state is a separate state machine, tracked by the delivery module keyed by run
id — never on the run itself.

**Control** — bounded, harness-neutral guidance offered while a Run is active.
The only Control is steering text. `accepted` means the complete text entered
the Run's local FIFO mailbox synchronously; it does not claim that the Harness
dequeued it, a provider accepted it, or a model consumed it. A prepared Run
declares supported Controls, and unsupported Runs have no live mailbox. Pi and
Claude declare no Control support. Codex consumes steering serially through
the active App Server Turn; only a correlated provider user-message item, not
local admission or request acceptance, becomes a neutral user Fact.

**Ingress order** — the adapter-local order assigned when a complete external
occurrence enters the executor, before translation, reporting, or Promise
continuations can delay it. Codex orders provider events, Controls,
cancellation, process outcomes, and escalation this way because its semantic
Turn and native steering share one App Server connection. This does not turn a
Run id into stable Subagent identity: Phase 1 still ships no resume operation,
provider-session handle, or second Run on a retained child.

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
started by `agent_start` is detached from the turn: `Escape` does not stop it.
It is not detached from the session — a result belongs to the conversation
that asked for it, so every `session_shutdown` (switch, fork, resume, new,
reload, quit) cancels whatever is still running.

**Child pi** — the process a run executes in. One-shot: it takes one prompt on
stdin and produces one answer. It cannot be steered mid-flight.

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

**Result** — the authoritative terminal output for a run. It is written to the
result store when the run settles and observed with `agent_result`.

**Notification** — a small status-specific completion notice pushed as a
follow-up message. It orients the model and points to `agent_result`; it is not
the result itself. Pushed is not landed: pi may hold a follow-up while the model
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

**Registry** — the module owning the set of live runs and their lifetime.
Everything that displays or acts on runs reads it; the dispatcher is the only
module that adds runs, and notification delivery is the only module that releases them —
when the notification actually lands in the conversation, nowhere else.

**Projection** (`RunView`) — an immutable row derived from a run for display.
Callers never touch the mutable run record.

**Dispatcher** (`runner.ts`) — the rules that hold for every run whatever it
does: the nesting guard, lifecycle settlement, and sole ownership of the run
record — executors report facts, and the fold in `run.ts`, invoked only by
the dispatcher, is what writes them.

**Harness** — a named backend (`pi`, `claude`, `codex`) that knows how to run profiles:
it validates the harness-owned parts of a profile and supplies an executor per
run. A profile names its harness; core resolves that name through the harness
registry and never interprets harness-specific configuration or imports a
backend's types.

**Executor** — the per-run execution a harness supplies (`harnesses/pi/agent.ts`
is the pi harness's; it composes the One-shot protocol and the neutral process source).
It witnesses what the child did: it reports harness-neutral facts through the
reporter defined in `run.ts` and resolves to an **ending**; it never touches the
run record. A supported prepared Run also receives one neutral Control stream;
there is no Harness control method or provider session in core. Wire format
stops inside the harness — no backend's message shapes cross this seam.

**One-shot protocol** — the module owning terminal-before-abort ordering, the
missing-answer policy, and ending derivation, whichever source feeds it. It
runs one source to one ending, reports facts live, and discards calls after
settlement. Its sink returns `true` only for a terminal answer witnessed before
abort, `false` for a translated nonterminal or post-abort terminal event, and
`undefined` for ignored or post-settlement events.

**Conformance** — the named battery of nine required scenarios every
harness's executor must pass as part of its own tests: `backend-crash`,
`abort-mid-run`, `terminal-answer-then-abort`, `usage-totals`, `child-depth`,
`config-immutable`, `no-terminal-answer`, `post-answer-failure`, and
`terminal-transcript-healing`. It makes the executor obligations of `run.ts`
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

**Session lifecycle** (`session-lifecycle.ts`) — owns session start and
shutdown: refilling stable profile/session-fact references, re-aiming pushes,
replacing the widget, one-shot feature registration, warnings, and cleanup.
The composition root only forwards host events to it.

**Activity** — the one-line summary of what a run is doing right now. An
executor may report ephemeral live activity through the run seam; while it is
present, the projection prefers it over the dispatcher's fold-derived summary
of the most recent tool call. Display only: live activity is never transcript
truth, usage, or final output, and settling clears it so settled runs are quiet.

## Constraints

**Depth** — delegation is one level deep. A subagent cannot start subagents,
whichever harness runs it. The Dispatcher alone decides a child's depth;
executors only copy it, and each harness owns enforcement in its children —
`PI_SUBAGENT_DEPTH` as pi and codex's transport, the agent-spawning tool
disallowed for claude.

**Trust** — pi's project-trust decision for the working directory, resolved by
the session and forwarded in every run request; the extension never derives its
own. Applying it is harness policy: pi forwards it to its child; claude and
codex do not consult it yet — their policy is a constant bypass, the forwarded
value reserved for a future shared posture (ADR-0009).

**Shutdown** — every `session_shutdown` stops every running run, drops every
unlanded notification, and clears the result store, so neither a notification
nor a stored result follows the operator into the next session. The next
session's model never started these runs and has no context to act on their
answers; after quit or reload nothing could notify about them at all. The delivery
module owns this as one operation (`shutdown`).
