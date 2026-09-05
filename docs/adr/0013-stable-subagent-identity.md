# 13. Stable Session-scoped Subagent identity sits above one-shot Runs

Date: 2026-08-29

## Status

Accepted. Supersedes ADR-0012 only where it said no stable Subagent identity
exists, and refines ADR-0003 without changing its one-shot Run decision.
[ADR-0014](0014-controlled-agent-resume.md) supersedes this ADR only where it
deferred the `agent_resume` operation.

### Status after M7 (2026-09-03)

**The one-shot Run premise this refined is gone.** Stable Session-scoped Subagent identity is exactly what the product has, and `SubagentId` is its type. What no longer holds is the frame it sat in: a Run is no longer the whole of a child's life, because a Subagent retains a **BackendAgent** and `resume` starts another Run on the same Conversation. [ADR-0014](0014-controlled-agent-resume.md) began that, and
[ADR-0017](0017-retained-pi-sdk-conversation.md) and
[ADR-0018](0018-ordered-claude-query-conversation.md) are where each backend's
retained conversation now lives.

The glossary in [CONTEXT.md](../../CONTEXT.md) records what replaced each 1.x
abstraction and how the product is built now. This ADR is kept unedited above:
the reason a decision was made is part of the record even when its subject is
gone.

## Context

`agent_start` historically used one Run id for both the delegated worker and
its one goal cycle. Settlement closed the prepared Harness adapter. That left
no stable local identity above the immutable Result, and retaining an adapter
later would have made ownership ambiguous between the dispatcher, delivery,
and Session lifecycle.

Provider identities cannot fill this role. A provider thread, Turn, query,
session, item, request, or correlation id has backend-specific lifetime and
security semantics. Exposing one would couple core orchestration, Results, and
presentation to a Harness implementation.

## Decision

Introduce one Session-scoped Subagent manager. It is the sole owner of local
Subagent records, the fixed Profile association, prepared Harness adapter
lifetime, Subagent lifecycle, and the active-Run relationship. A Subagent has
exactly three states: running with one active Run, idle with none, and closed.
Creation moves directly to running and atomically starts the first Run; there is
no empty or queued state.

`agent_start` keeps its existing inputs and immediately returns two visibly
distinct, locally generated identities: the stable Subagent id and the first
Run id. Run ids remain the only accepted identity for `agent_wait`,
`agent_result`, `agent_cancel`, and `agent_steer`.

The dispatcher remains the sole writer of each Run record, Fact fold, Control
gate, cancellation reason, terminal lifecycle, and immutable Result. Every
terminal outcome moves an open Subagent to idle. The manager retains the
prepared adapter while idle, but no Run Control mailbox becomes reusable
Subagent state. Notification landing releases only the Run's live display
record. Results and notifications name the owning Subagent for orientation
while retrieval and landing remain keyed by Run id.

Session shutdown first marks every Subagent closed, then forwards cancellation
to active Runs and closes idle and active adapters. Delivery clears Results,
notifications, and live Run state. Both local identity sets are forgotten.
Settlement after the closed transition cannot restore idle state or deliver
into a later Session.

Subagent and Run ids are never provider ids and are not reused within a
Session, even after live display state is released.

## Consequences

The existing Run widget continues to show running and notification-pending
Runs; it does not observe idle Subagents. A completed, failed, or cancelled
first Run keeps its stable owner and prepared adapter alive until Session
shutdown, while its terminal lifecycle, Result, notification, and closed
Control gate remain unchanged.

This decision establishes identity and lifetime only. There is no
`agent_resume` operation in this change, and no production adapter advertises
resume yet. A later decision may add another Run to an idle Subagent through
the retained adapter without reopening or mutating the first Run.
