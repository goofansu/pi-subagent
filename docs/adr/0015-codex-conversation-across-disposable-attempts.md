# 15. Codex retains Conversation across disposable Attempts

Date: 2026-08-30

## Status

Accepted, with its disposable-process, non-ephemeral-thread, and native
continuation consequences superseded by
[ADR-0021](0021-retained-ephemeral-codex-conversation.md). Its one private
Conversation, Run-scoped Attempt state, independent accounting and Results,
no-fallback rule, provider-identity confinement, cancellation ordering, and
Session ownership remain in force. ADR-0017 and ADR-0018 record the different
Pi and Claude lifetime models.

### Status after M7 (2026-09-03)

**Superseded in substance, and its module is gone.** Codex retains a **process and an ephemeral root thread** rather than a Conversation across disposable Attempts, and `Attempt` is no longer a core type at all. [ADR-0021](0021-retained-ephemeral-codex-conversation.md) is the decision that stands.

See [the deletion ledger](../v2/deletion-ledger.md) for what replaced
each 1.x abstraction, and [the architecture note](../architecture.md) for
how the product is built now. This ADR is kept unedited above: the reason a
decision was made is part of the record even when its subject is gone.

## Decision

Codex follow-up Runs need semantic continuity, but retaining an idle App Server
child would make idle Subagents hold processes, streams, pending requests, and
Control state. The prepared Codex adapter therefore retains only the provider
thread identity and cumulative usage baseline. Every Run starts a fresh App
Server Attempt, reinitializes fixed policy, creates or natively resumes the
thread, starts one new Turn, filters all events to that thread and Turn, and
does not settle until the child and transport are fully cleaned. Core sees only
independent Runs, Results, notifications, and neutral Facts; it never receives
or replays provider continuation state.

Every Attempt has fresh steering correlation, translation, error, Activity,
completed-message, and process state. Conversation-cumulative usage is
differenced from the retained baseline, while attachment-local counters are
translated from zero, so each immutable Result receives only its own usage.
Settlement waits for complete child and transport cleanup before the open
Subagent becomes idle.

A continuation failure honestly fails the new Run with bounded redacted
diagnostics. It never falls back to a fresh thread, replays core history,
retries the Run, forks or rolls back the thread, or mutates an earlier Result.
Cancellation and Session shutdown preserve the existing ordered-ingress and
one-settlement rules; shutdown also forgets the adapter association and makes
the continuation locally unaddressable.

The provider thread is non-ephemeral, and the installed Codex CLI owns its
storage and retention. The extension retains only an in-memory association for
the parent Session. Cross-Session recovery, persistence, migration, expiry, and
provider-thread deletion remain out of scope.
