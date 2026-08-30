# 3. One-shot children

Date: 2026-08-23

## Status

Accepted. [ADR-0012](0012-ordered-codex-steering.md) supersedes this ADR's
no-mid-run-guidance consequence. [ADR-0013](0013-stable-subagent-identity.md)
adds stable Session-scoped identity and idle adapter retention above Runs.
Both preserve the one-shot Run decision. [ADR-0014](0014-controlled-agent-resume.md)
supersedes only this ADR's rejection of follow-up orchestration: resume creates
a new one-shot Run rather than reopening the old one. [ADR-0015](0015-codex-conversation-across-disposable-attempts.md)
adds Codex Conversation retention without retaining a child process.
[ADR-0016](0016-codex-resume-release-contract.md) records the release contract:
Codex resume reopens follow-up only above the one-shot Run boundary, so every
goal still owns one immutable Result.

## Context

A running subagent cannot be given more input. Its child pi is spawned with
`-p` in JSON mode and its stdin is closed immediately after the prompt is
written, so there is no channel to send it anything further.

Making children steerable would mean running them in interactive or RPC mode,
holding a bidirectional session per run, and giving the parent a way to address
one.

Pi's RPC mode would in fact support this: it exposes `prompt`, `follow_up`,
`abort`, `get_messages` and `get_last_assistant_text` over a persistent
connection. So the obstacle is not feasibility. It is that idle children never
free themselves — with concurrency unbounded, a session accumulates live pi
processes each holding a full context — and that the lifecycle grows a state,
an `agent_close` primitive, and a policy for a model that forgets to call it.
The executor would be rewritten around a request/response connection instead of
spawn-stream-exit.

## Decision

Children stay one-shot: one initial prompt in, one terminal result out. There
is no follow-up or resume operation against an idle child, and none is planned.

The original orchestration surface was deliberately the process algebra —
spawn (`agent_start`), join (`agent_wait`), cancel (`agent_cancel`). ADR-0012
adds bounded guidance to an active Codex Run without retaining an idle child or
creating a resumable provider session.

## Consequences

Pi and Claude Runs still require cancellation and a new Run to correct their
direction. Codex may accept bounded guidance only while its one active Turn is
running; its disposable Attempt still settles and is cleaned up with that
one-shot Run even though the prepared adapter retains Conversation identity.
ADR-0013 retains the Subagent-scoped adapter after settlement, not the child
process or the Run's Control mailbox.

Reading a finished run does not require a live child, only retention, so
`agent_result` is provided without reopening this decision. Follow-up work
against a warm context is the one capability a persistent child would add that
retention cannot.

This is a decision, not a gap. Re-open it when follow-up delegation is worth an
RPC executor and an idle-agent lifecycle — not merely to read a result, which
retention already covers.
