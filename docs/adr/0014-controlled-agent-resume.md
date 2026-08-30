# 14. Resume an idle Subagent into a new controlled Run

Date: 2026-08-30

## Status

Accepted. Supersedes ADR-0003's rejection of follow-up orchestration and
ADR-0013 only where it deferred `agent_resume`. Every Run remains one-shot.
ADRs 0015–0019 subsequently enable the production provider implementations.

## Context

ADR-0013 introduced a stable Session-scoped Subagent above immutable Runs and
retained its prepared Harness adapter while idle. Without an orchestration
operation, that identity could not begin later work. Treating a provider token
as the Subagent id or appending to the settled Run would leak backend policy and
destroy independent lifecycle, Result, notification, usage, and cancellation
semantics.

## Decision

Add `agent_resume`. It accepts a stable Subagent id, the next Run description,
and the full next prompt. A successful call synchronously claims an idle
Subagent, starts a fresh Run immediately, and returns that Run id rather than an
answer. Active and settling Subagents reject admission without a hidden queue;
two racing calls have one synchronous winner.

The manager remains the sole writer of Subagent lifecycle and active-Run
ownership. The dispatcher remains the sole writer of each Run record and
creates a fresh reporter, AbortSignal, Control gate, usage fold, Result, start
time, lifecycle, and notification path. Every terminal outcome returns an open
Subagent to idle only after settlement. Pending Controls close with their Run.

Resume reuses the one adapter prepared from the Subagent's fixed Profile,
Harness, resolved model policy, working directory, child depth, project trust,
and adapter trust posture. Capability is declared neutrally by that adapter;
core receives no provider continuation token and never branches on a harness
name. The controlled resumable adapter proves private semantic context crosses
Runs while each public Result contains only its own output. Pi, Claude, and
Codex remain unsupported in this milestone; ADR-0015 later enables Codex
without changing the neutral admission contract.

Delivery registers every resumed Run through the existing per-Run Result and
notification state machines. Resume neither releases a notification-pending
Run nor pins old Result output. Wait, result, cancellation, steering, and
notification landing remain keyed only by Run id.

Session shutdown marks all Subagents closed before cancellation and adapter
cleanup. Resume after that synchronous boundary is unknown, and late settlement
cannot reopen an identity in the old or next Session.

## Consequences

The public model now has two deliberately distinct identities: Subagent ids
for `agent_resume`, and Run ids for `agent_wait`, `agent_result`,
`agent_cancel`, and `agent_steer`. There is still no idle-Subagent observer or
public close operation. Production resume remains gated on a provider adapter
proving its own continuation, disposable execution, correlation, accounting,
cleanup, and live behavior.
