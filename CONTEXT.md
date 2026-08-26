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
has an id, a lifecycle, a transcript, and usage. Runs are the thing the registry holds and
the widget lists. Not "job", not "task", not "call". Notification delivery
state is a separate state machine, tracked by the delivery module keyed by run
id — never on the run itself.

**Detached run** — a run that outlives the turn that started it. Every run
started by `agent_start` is detached from the turn: `Escape` does not stop it.
It is not detached from the session — a result belongs to the conversation
that asked for it, so every `session_shutdown` (switch, fork, resume, new,
reload, quit) cancels whatever is still running.

**Child pi** — the process a run executes in. One-shot: it takes one prompt on
stdin and produces one answer. It cannot be steered mid-flight.

**Fact** — a harness-neutral record of something the child did: a message with
a role and parts (text, tool call) plus usage, model, and stop reason in domain
units. Facts are the only vocabulary that crosses the executor seam; a wire
format is translated into facts inside its harness and nowhere else.

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

**Await** — `agent_await` observes terminality only. It returns run identity and
terminal lifecycle state, never output, and does not suppress notifications or
affect the result store. Repeated awaits return the same lifecycle state.

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

**Harness** — a named backend (`pi`, `claude`) that knows how to run profiles:
it validates the harness-owned parts of a profile and supplies an executor per
run. A profile names its harness; core resolves that name through the harness
registry and never interprets harness-specific configuration or imports a
backend's types.

**Executor** — the per-run execution a harness supplies (`pi-agent.ts` is the
pi harness's). It witnesses what the child did: it reports harness-neutral
facts through the reporter defined in `run.ts` and resolves to an outcome; it
never touches the run record. Wire format stops inside the harness — no
backend's message shapes cross this seam.

**Conformance** — the named battery of required scenarios every harness's
executor must pass as part of its own tests. It makes the executor
obligations of `run.ts` mechanical: backend failures resolve as failed,
backend aborts normalize to
cancellation, a terminal answer survives a later abort, usage deltas fold with
latest context gauges, child depth reaches the child, and profile configuration
stays unchanged. Transcript healing is optional and visibly skipped by
harnesses that do not support it.

**Presentation** (`presentation.ts`) — how a run and its notification read to a
human: status tones, verbs, phrases, tool-outcome prose, and notification text.
It is the only module that interprets a lifecycle status for display and the
only producer of model-facing prose about runs; the delivery module does
bookkeeping and asks this one what a notification says.

**Session lifecycle** (`session-lifecycle.ts`) — owns session start and
shutdown: refilling stable profile/session-fact references, re-aiming pushes,
replacing the widget, one-shot feature registration, warnings, and cleanup.
The composition root only forwards host events to it.

**Activity** — the one-line summary of what a run is doing right now, derived
from its most recent tool call by the dispatcher's fold and recorded on the
run. Display only; the registry projects the field without reading the
transcript.

## Constraints

**Depth** — delegation is one level deep. A subagent cannot start subagents,
whichever harness runs it. The Dispatcher alone decides a child's depth;
executors only copy it, and each harness owns enforcement in its children —
`PI_SUBAGENT_DEPTH` as pi's transport, the agent-spawning tool disallowed for
claude.

**Trust** — pi's project-trust decision for the working directory, resolved by
the session and forwarded in every run request; the extension never derives its
own. Applying it is harness policy: the pi harness forwards it to its child,
the claude harness does not consult it yet — its policy is a constant bypass,
the forwarded value reserved for later.

**Shutdown** — every `session_shutdown` stops every running run, drops every
unlanded notification, and clears the result store, so neither a notification
nor a stored result follows the operator into the next session. The next
session's model never started these runs and has no context to act on their
answers; after quit or reload nothing could notify about them at all. The delivery
module owns this as one operation (`shutdown`).
