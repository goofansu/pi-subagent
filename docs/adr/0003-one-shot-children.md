# 3. One-shot children

Date: 2026-08-23

## Status

Accepted. [ADR-0012](0012-ordered-codex-steering.md) supersedes this ADR's
no-mid-run-guidance consequence while preserving the one-shot Run decision.

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
running; the child still settles and is cleaned up with that one-shot Run.

Reading a finished run does not require a live child, only retention, so
`agent_result` is provided without reopening this decision. Follow-up work
against a warm context is the one capability a persistent child would add that
retention cannot.

This is a decision, not a gap. Re-open it when follow-up delegation is worth an
RPC executor and an idle-agent lifecycle — not merely to read a result, which
retention already covers.
