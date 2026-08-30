# 16. Codex resume preserves one goal and one Result per Run

Date: 2026-08-30

## Status

Accepted. Reopens ADR-0003's no-follow-up decision for Codex Subagents while
preserving its one-shot Run boundary. It consolidates the release contract
introduced by ADR-0013, ADR-0014, and ADR-0015.

## Context

ADR-0003 rejected resume because a persistent idle child would retain an
unbounded process and blur the lifetime of the original Run. Stable local
Subagent identity and a Subagent-scoped Harness adapter now provide a narrower
seam: semantic context can outlive a Run without reopening that Run or keeping
its execution resources alive.

The release still needs one unambiguous unit of work and one immutable terminal
record. Treating provider continuation as the Run identity, appending a second
goal to the first Result, or replaying core history into a replacement thread
would break cancellation, accounting, notification, and failure ownership.

## Decision

`agent_resume` may create a new one-shot Run only on an idle, open Subagent
whose adapter truthfully advertises resume. The stable Subagent retains its
fixed Profile and execution policy, while every Run retains exactly one goal,
one lifecycle, one Control mailbox, one usage fold, one immutable Result, and
one notification. Active Subagents reject resume without queueing. Pi and
Claude remain unsupported.

Codex uses a non-ephemeral provider thread as its private Conversation. The
prepared adapter keeps the thread association only in memory for the current
parent Session. Each Run uses a disposable App Server Attempt: initialize,
create or resume the thread, start one Turn, settle one Run, and completely
dispose the process and transport before the Subagent becomes idle. The first
thread is retained locally only after its first `turn/start` succeeds with the
fixed Profile role; a pre-Turn failure therefore retries creation rather than
resuming a thread that never received that role.

After a Conversation has an accepted Turn, continuation failure is an honest
failure of the new Run. There is no fresh-thread fallback, core transcript
replay, automatic retry, fork, or rollback. Provider identity never crosses
the Harness seam.

The installed Codex CLI owns storage, retention, and any eventual cleanup of
the non-ephemeral thread. Session shutdown closes the local adapter and forgets
the in-memory association. Extension-managed persistence, cross-Session
recovery, expiry, migration, and provider-thread deletion remain out of scope.

## Consequences

Codex can resume semantic work within one Session without retaining an idle
child or mutating an earlier Result. Provider storage may outlive the
extension's ability to address it, according to the installed CLI's retention
behavior. Operators receive no `/subagents` observer, manual close tool, or
cross-Session recovery surface in this release.
