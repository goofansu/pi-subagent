# 24. v2 observation ordering

Date: 2026-09-02

## Status

Accepted for the v2 tree. Supersedes no earlier decision.

Carries forward:

- [ADR-0005](0005-executor-reports-facts.md) — a backend witnesses and reports;
  it never mutates central Run state. v2 keeps this and renames Facts to
  observations.
- [ADR-0007](0007-harness-seam-with-neutral-facts.md) — only a neutral
  vocabulary crosses the adapter boundary; provider wire objects never do.
- A complete external occurrence receives stable ingress order *inside* the
  adapter, before asynchronous interpretation can reorder it. That began as one
  adapter's own refinement; v2 generalizes it to the rule for every adapter.
- [ADR-0018](0018-ordered-claude-query-conversation.md) — one ordered input
  engine per Run, and a provider Result is a Turn checkpoint rather than
  settlement.
- [ADR-0010](0010-run-endings.md) — its neutral-ending vocabulary. The terminal
  ending is itself an observation, and it is the last one a Run reduces. v2
  supersedes nothing of ADR-0010 here; its already-superseded One-shot protocol
  is not revived.
- [ADR-0019](0019-backend-neutral-managed-release.md) — per-Run transcript
  isolation across resumed Runs, which this ordering rule is what makes true.
- [ADR-0020](0020-run-settlement-through-harness-conformance.md) — each adapter
  owns its own event ordering while the shared conformance surface enforces the
  observable contract. v2 keeps that division; this ADR only states what the
  observable contract requires of every adapter's ordering.

Uses the vocabulary of [ADR-0022](0022-v2-terminology-and-backend-field.md).

## Context

Backends reach the core through very different event shapes: Pi pushes typed
session events to a per-Run subscriber, Claude yields frames from a per-Run
async iterable, and a process-backed adapter would write notifications to one
stream shared by every Run of a Subagent.

If ordering were left to each adapter's Promise continuations, two observations
that arrived in one order could be reduced in another. v1 learned this the hard
way in an adapter whose stream outlived its Runs, and answered it with an
ingress-ordered reducer; v2 needs the rule stated once for all backends, before
any of them is written.

## Decision

### Semantic observations are ordered and lossless within a Run

Every **semantic observation** — a message, a tool call, a tool result, a
diagnostic, a usage delta, a terminal ending — is assigned its position when the
complete external occurrence **enters the adapter**, before translation,
reporting, or any Promise continuation can delay it. Observations are delivered
to the core reducer in that order, and none is dropped.

The transport is a **bounded queue** owned by the Run Scope. Bounded means the
bound must be chosen so that dropping is not the overflow strategy: an adapter
that cannot enqueue applies backpressure to its own reader rather than
discarding a semantic observation. Losing one is a defect, not a capacity
policy.

### Only the core reducer mutates Run projections

Adapters emit observations. A single pure `reduceRun` folds them into the Run's
projection. No adapter, no host handler, and no presentation code writes to a
Run projection. This makes the reduction order the *only* thing that determines
what a Run looks like.

### Activity is conflated

**Activity** — the one-line summary of what a Run is doing right now — is the
one exception to losslessness. It is a **conflated** signal: the latest value
wins, and intermediate values may be dropped. Activity is display-only. It is
never transcript truth, never usage, and never final output, and settling clears
it so a settled Run is quiet.

Conflation is what makes an unbounded stream of progress updates safe to render:
a slow renderer skips values instead of accumulating a backlog.

### Late events cannot mutate a terminal Run

Once a Run has settled, no observation can change it. This holds even when the
event source outlives the Run:

- **Pi and Claude** get it structurally — the subscription and the Query both
  live in the Run Scope and are gone once it closes.
- An adapter whose stream is Subagent-scoped would not. Its demultiplexer must
  drop, or route to no Run, any frame naming a Run that has settled. A frame for
  an unknown or terminal Run is discarded silently; it is not an error and it is
  not a diagnostic on the next Run.

Adapters must not "heal" a terminal Run with a late event. Terminal
reconciliation is a different thing: it happens *before* settlement, as part of
the Run's own ordered reduction — see
[ADR-0025](0025-v2-terminal-settlement.md).

### No provider vocabulary crosses the boundary

An observation names roles, parts, tools, and domain units. It never carries a
provider thread id, Turn id, item id, request id, correlation id, session uuid,
exit code, or backend stop word. Ordering and identity remain adapter-local.

## Consequences

Every adapter now pays for one ordered ingress point, even Pi and Claude, whose
event sources are already per-Run and mostly in order. That is a small cost for
one reduction rule the core can rely on without asking which backend produced
the observations.

Bounded-and-lossless means an adapter can block on a full queue. A backend that
produces observations faster than the core reduces them will slow down rather
than silently drop, and a genuine stall becomes visible as a stuck Run rather
than as a Run with missing transcript. That is the intended trade: a stuck Run
is diagnosable, a silently truncated transcript is not.

Conflating Activity means the widget may never show a particular intermediate
step. That is correct — Activity exists to say what is happening now, not to be
a log.

Silently discarding a late frame means a genuine adapter bug (routing a frame
to the wrong Run) looks like nothing at all rather than like an error. Such an
adapter's tests must therefore assert routing positively — that a frame for the
*current* Run does arrive — rather than only asserting that stale frames do
not.
