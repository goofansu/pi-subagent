# 23. v2 scope ownership

Date: 2026-09-02

## Status

Accepted for the v2 tree. Written after the three backend API-risk spikes and
incorporating every exception they found. Supersedes no earlier decision.

Carries forward:

- [ADR-0013](0013-stable-subagent-identity.md) — one Subagent owns at most one
  active Run; a terminal Run leaves an open Subagent idle; Session shutdown
  marks every Subagent closed before it cancels anything.
- [ADR-0014](0014-controlled-agent-resume.md) — the prepared adapter is retained
  across Runs and resume reuses it.
- [ADR-0017](0017-retained-pi-sdk-conversation.md) and
  [ADR-0021](0021-retained-ephemeral-codex-conversation.md) — the retained
  native conversation belongs to the Subagent, not the Run.
- [ADR-0019](0019-backend-neutral-managed-release.md) — idempotent close is part
  of the shared conformance surface.

Uses the vocabulary of [ADR-0022](0022-v2-terminology-and-backend-field.md).

## Context

v1 owns lifetimes by hand: an `AbortController` per Run, a closed flag per
adapter, a manual shutdown sequence in `session-lifecycle.ts`, and bounded
timeouts scattered through each adapter's cleanup. It works, but nothing in the
type system says what owns what, and every new backend re-derives the ordering.

v2 owns lifetimes with Effect Scopes. Before committing to a hierarchy, three
disposable spikes exercised native open, run, resume, steer, cancel, close,
event bridging, and usage against the SDK versions this repository already
carries. Their findings are in
[Pi](../v2/spikes/pi-backend-api-risk.md),
[Claude](../v2/spikes/claude-backend-api-risk.md), and
[Codex](../v2/spikes/codex-backend-api-risk.md).

## Decision

### The hierarchy

```
Session Scope
└── Subagent Scope          (one per Subagent; owns one BackendAgent)
    └── Run Scope           (at most one at a time)
        └── native execution scope   (nested; may close independently)
```

- The **Session Scope** owns every Subagent Scope. Closing it releases
  everything beneath it, in reverse order of acquisition.
- A **Subagent Scope** owns exactly one **BackendAgent** and, at any instant, at
  most one **Run Scope**. It outlives every Run it opens.
- A **Run Scope** owns the Run's Control mailbox, its observation plumbing, its
  cancellation, and its finalizers. It closes when the Run settles.
- The **native execution scope** is nested inside the Run Scope. It may close
  independently — a provider Turn, Query, or prompt can end without ending the
  Run — but it can never outlive its Run Scope.

Closing a Subagent Scope follows the cancel-and-await-cleanup policy in
[operation semantics §4](../v2/operation-semantics.md#4-closing-a-subagent-with-an-active-run-is-cancel-and-await-cleanup):
mark closed, cancel the active Run, await the Run Scope's finalizers and the
BackendAgent's native cleanup, then release.

### Layers are for services only

**No Subagent, BackendAgent, Run, Query, Turn, or subscription is represented as
a `Layer`.** Layers are for session-long services — configuration, the clock,
the Result store, the notification pusher, backend resolution — built once when
the Session Scope opens.

Anything whose lifetime is shorter than the Session, or of which there may be
more than one at a time, is a Scope and a resource, not a Layer. This is
roadmap invariant 17, made a decision here so it is citable.

### Per-backend viability

| Backend | Verdict | Basis |
| --- | --- | --- |
| Pi | **Viable** | [Pi spike](../v2/spikes/pi-backend-api-risk.md). Opening is local and provider-free; one `prompt()` is one Run; resume is another `prompt()` on the retained handle; cancellation leaves the handle and conversation alive; subscriptions attach and release per Run. |
| Claude | **Viable with an exception** | [Claude spike](../v2/spikes/claude-backend-api-risk.md). One Query per Run, per-Run event source, retained identity survives a cancelled Query. The exception is recorded below. |
| Codex | **Viable with exceptions** | [Codex spike](../v2/spikes/codex-backend-api-risk.md). Process plus ephemeral root map onto the Subagent Scope exactly; one Turn is one Run; the native interrupt is Turn-scoped and leaves the process alive. Three exceptions are recorded below. |

### Exceptions found by the spikes, resolved here

**1. A Claude BackendAgent has no provider-side open.** The SDK's only entry
point is `query()`, which starts an execution. A Claude BackendAgent therefore
begins life **unopened**, holding no provider identity, and acquires one as a
side effect of its first Run.

*Resolution:* the BackendAgent contract has an explicit unopened state. Opening
a Subagent Scope constructs the BackendAgent but promises no provider identity.
Resume is admissible only from an opened BackendAgent; a Subagent whose first
Run never produced an identity is not resumable, and reports that through the
existing Conversation-loss outcome rather than a new one.

**2. The Codex event stream is Subagent-scoped, not Run-scoped.** One
process-wide stream carries every frame for every Turn, and it outlives
each Run. The App Server also issues server-to-client requests that must be
answered or it stalls.

*Resolution:* the Codex adapter's transport reader is a **Subagent-scoped**
fiber, forked into the Subagent Scope and finalized when it closes. It answers
server requests between Runs and demultiplexes frames by `threadId` and
`turnId` into the active Run's observation queue. Because the event source does
not disappear when a Run Scope closes, the rule that late events cannot mutate a
terminal Run is enforced by the adapter's routing — see
[ADR-0024](0024-v2-observation-ordering.md) — not by the source vanishing.

**3. A disposed Pi session still accepts `prompt()`.** The Pi spike observed
that calling `prompt()` after `dispose()` neither threw nor was rejected.

*Resolution:* a closed scope is enforced by the **adapter's own state**, never
by trusting an SDK to reject work after disposal. Every adapter checks its
closed flag before starting an execution and before acquiring a native resource.
v1 already does this; v2 keeps it as a requirement rather than an accident.

**4. Codex process loss produces no protocol signal.** The Codex spike killed
the App Server mid-Turn: no terminal Turn frame ever arrived, and a request
issued afterwards neither resolved nor rejected — it simply never came back.

*Resolution:* for Codex the **native execution scope's finalizer is driven by
process exit**, not by a provider frame. The adapter watches the child it owns,
settles every outstanding request when it dies, and bounds each request so a
wedged-but-alive process cannot hold a Run Scope open forever. A Run Scope must
never be able to wait indefinitely on a peer that has no way to say it is gone.
The Run's ending is derived from process exit, which
[ADR-0025](0025-v2-terminal-settlement.md) treats like any other neutral
ending.

None of the four exceptions requires the hierarchy to change, so no separate
ADR is needed for any of them.

## Consequences

Cleanup becomes structural rather than remembered. A Run cannot leak its
mailbox, its subscription, or its native execution, because all three are
acquired in a scope that closes when the Run settles. Session shutdown is one
scope close rather than a hand-ordered sequence across three modules.

The cost is that ordering is now expressed as acquisition order, which is less
obvious to read than an explicit shutdown function. A finalizer that must run
before another has to be acquired after it, and that relationship is invisible
unless it is commented.

Because a BackendAgent is Subagent-scoped, N idle Subagents retain N native
resources until the Session closes: N Pi sessions, N Codex App Server processes,
N retained Claude identities. Only the Codex case costs an OS process, and
[ADR-0021](0021-retained-ephemeral-codex-conversation.md) already accepted that
trade. There is no idle expiry and no speculative reaping; explicit cancellation
and Session shutdown remain the liveness mechanism.

Forbidding Layers for Subagents and Runs rules out a tempting shortcut —
`LayerMap` keyed by `SubagentId` would build and cache a service per Subagent —
in exchange for keeping one obvious answer to "what releases this, and when".
