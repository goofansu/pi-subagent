# Domain model

The vocabulary this codebase uses. Terms here are load-bearing: they name the
seams, and code that uses a different word for the same thing is a bug in the
naming, not a synonym.

## Core

**Agent** — a named role a task can be delegated to, e.g. `explore`. An agent is
defined by exactly one **profile**.

**Profile** — the Markdown file that defines an agent: frontmatter configuring
the run (`description`, `model`, `effort`, `tools`, `appendSystemPrompt`) and a
body that is the agent's prompt. Named after the agent, so `explore.md` defines
`explore`. Read only from user scope; see `getAgentsDir`.

**Run** — one execution of one profile against one prompt. A run has an id, a
lifecycle, a transcript, usage, and exactly one delivery. Runs are the thing the
registry holds and the widget lists. Not "job", not "task", not "call".

**Detached run** — a run that outlives the turn that started it. Every run
started by `agent_start` is detached from the turn: `Escape` does not stop it.
It is not detached from the session — a report belongs to the conversation
that asked for it, so every `session_shutdown` (switch, fork, resume, new,
reload, quit) cancels whatever is still running.

**Child pi** — the process a run executes in. One-shot: it takes one prompt on
stdin and produces one answer. It cannot be steered mid-flight.

## Delivery

**Report** — what a run gives back: its final assistant output, and nothing
else. Tool-call logs and usage belong on screen, not in the parent's context.

**Delivery** — the single act of giving a run's report to the model. The
invariant is *exactly one delivery per run*, never zero and never two. A
delivery is a push, a returned `agent_wait`, or a cancellation notice.

**Push** — delivery by injecting the report into the session as a follow-up
message when the run settles. The default path. Pushed is not landed: pi holds
a follow-up while the model is mid-turn, and the run stays listed until the
message actually enters the conversation. The operator's interrupt clears pi's
follow-up queue, discarding any report riding it — so a report pushed before
an aborted turn and still unlanded once the agent settles is pushed again.
One *landing* per run is the invariant; the push may happen more than once.

**Claim** — an `agent_wait` claims the reports of the runs it names, suppressing
their push so they return through the tool result instead. Abandoning the wait
releases the claim and the run pushes normally.

**Retention** — what a delivered run said, kept whole and addressable by id so
`agent_result` can hand back what a report's cap trimmed. Delivered means
recallable — a run the model cancelled included, once its child dies. Scoped to
the session that asked: shutdown clears it. Whole outputs are held only up to
a character budget; past it the oldest outputs are evicted, and an evicted run
still answers by id, saying its output is gone.

**Session push** — the process-lifetime push target reports go through
(`createSessionPush`). A session's own `sendMessage` throws once that session
is replaced, so each `session_start` re-aims the target. A report that settles
with no live session is dropped rather than thrown through the stale API — a
crash guard for the teardown race, never a cross-session delivery channel.

## Modules

**Registry** — the module owning the set of live runs and their lifetime.
Everything that displays or acts on runs reads it; the dispatcher is the only
module that adds runs, and delivery is the only module that releases them —
when the report actually lands in the conversation, nowhere else.

**Projection** (`RunView`) — an immutable row derived from a run for display.
Callers never touch the mutable run record.

**Dispatcher** (`runner.ts`) — the rules that hold for every run whatever it
does: the nesting guard, lifecycle settlement, and sole ownership of the run
record — executors report facts, and the fold in `run.ts`, invoked only by
the dispatcher, is what writes them.

**Executor** (`pi-agent.ts`) — the child pi process itself. It witnesses what
the child did: it reports facts (a message, a terminal transcript snapshot, a
stderr chunk) through the reporter defined in `run.ts` and resolves to an
outcome; it never touches the run record. Substitutable at that seam. Wire
format stops here — everything derived from the facts (usage, activity, the
per-message model) is computed in the fold.

**Presentation** (`presentation.ts`) — how a run and its report read to a
human: status glyphs, tones, verbs, phrases, and the report text with its
trims. The only module that interprets a lifecycle status for display; the
delivery module does bookkeeping and asks this one what a report says.

**Activity** — the one-line summary of what a run is doing right now, derived
from its most recent tool call by the dispatcher's fold and recorded on the
run. Display only; the registry projects the field without reading the
transcript.

## Constraints

**Depth** — delegation is one level deep. A subagent cannot start subagents;
`PI_SUBAGENT_DEPTH` carries the guard into children.

**Trust** — pi's project-trust decision for the working directory, resolved by
the session and forwarded to every child. The extension never derives its own.

**Shutdown** — every `session_shutdown` stops every running run, marks
everything undelivered as delivered, and clears retention, so neither a notice
nor a recallable report follows the operator into the next session. The next
session's model never started these runs and has no context to act on their
answers; after quit or reload nothing could deliver them at all. The delivery
module owns this as one operation (`shutdown`).
