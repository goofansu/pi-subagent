# 27. v2 usage normalization

Date: 2026-09-02

## Status

Accepted for the v2 tree. Supersedes no earlier decision.

Carries forward:

- [ADR-0007](0007-harness-seam-with-neutral-facts.md) — input, output, cache
  counters, turns, and cost crossing the boundary are **additive deltas** that
  the core folds, while context occupancy is a **latest-value gauge**. v2 keeps
  exactly this split.
- [ADR-0018](0018-ordered-claude-query-conversation.md) — cumulative provider
  accounting is differenced at every Result boundary with nonnegative reset
  handling, and a fresh Query starts a fresh per-Run baseline.
- [ADR-0019](0019-backend-neutral-managed-release.md) — per-Run usage isolation
  across resumed Runs is part of the shared conformance surface.
- [ADR-0010](0010-run-endings.md) — usage is not part of the neutral ending. An
  ending says how a Run finished; what it spent is a separate projection. v2
  keeps them apart.
- [ADR-0012](0012-ordered-codex-steering.md) — an adapter's accounting delta is
  Run-scoped and reduced in the same ordered engine as its other occurrences.
  v2 keeps this and generalizes it to every adapter.
- [ADR-0020](0020-run-settlement-through-harness-conformance.md) — the shared
  conformance surface is what enforces usage behaviour per adapter; the
  `usage-totals` scenario is where these rules are checked. v2 keeps it.

This ADR supersedes nothing.

Uses the vocabulary of [ADR-0022](0022-v2-terminology-and-backend-field.md).

## Context

The three backends report usage in three incompatible shapes. The
[Pi](../v2/spikes/pi-backend-api-risk.md),
[Claude](../v2/spikes/claude-backend-api-risk.md), and
[Codex](../v2/spikes/codex-backend-api-risk.md) spikes observed exactly what
each one offers:

| Backend | Shape observed | Terminal reconciliation surface |
| --- | --- | --- |
| **Pi** | Per-message counters — input, output, cache read, cache write, reasoning, a per-message occupancy figure, and a cost breakdown. Naturally additive. | The terminal message list the adapter already uses as a snapshot. |
| **Claude** | A terminal frame carrying counters for the whole execution, a per-model breakdown with cost and context window, and a turn count. Cumulative within one execution. | The terminal frame itself. |
| **Codex** | Streamed usage notifications carrying both a Conversation-cumulative total and a per-Turn figure, each broken into input, cached input, cache write, output, reasoning, and a total. | **None.** The Turn-completion frame carries no usage at all. |

The exact field names behind each row are recorded in the spike documents, where
provider vocabulary belongs. This ADR names only what the shapes mean.

Two spike findings force decisions rather than mere translation. Claude's
per-model breakdown for a single-model Run contained **two** models — the one
the Profile asked for and a smaller one the SDK invoked internally. And Codex's
authoritative figure is **Conversation-cumulative**, so a resumed Run that read
it naively would be charged for every prior Run of that Subagent.

## Decision

### Usage crossing the boundary is Run-local

An adapter emits usage **for the Run it is executing and no other**. Whatever
shape the provider reports, the adapter converts it to a Run-local delta before
it crosses the boundary:

- **Pi** emits per-message deltas as they arrive. No conversion is needed.
- **Claude** differences its cumulative counters at every provider Turn boundary,
  with nonnegative handling for a reset, and starts a fresh baseline for each
  Run's execution.
- **Codex** takes a Conversation-cumulative baseline when the Run's first Turn
  starts and emits the difference. The per-Turn figure the provider also offers
  is not enough on its own, because one Run may span several Turns.

**Resume never charges prior Conversation usage.** A resumed Run's reported
usage covers only its own work. Cache reads it benefits from are its own reads —
the [Claude spike](../v2/spikes/claude-backend-api-risk.md) observed the second
Run reporting exactly as many cached-input tokens as the first Run had written,
which is the correct attribution.

### Which models a Run is charged for

When a backend reports usage per model, the Run is charged for **every model the
provider ran on the Run's behalf**, not only the model the Profile named.
Auxiliary models the SDK invokes internally are part of what the Run cost.

The Run's reported **model** — the one shown in the Notification and the widget —
remains the model the Profile selected or the provider identified as primary. So
a Claude Run can honestly report one model name and a cost that includes an
auxiliary model's tokens. That is the true cost, and hiding it would understate
what the Run spent.

### Context occupancy is a gauge

Context occupancy is **not** summed. It is a latest-value gauge: the most recent
observed value wins, and intermediate values may be dropped exactly like Activity
([ADR-0024](0024-v2-observation-ordering.md)).

- Pi's per-message occupancy figure is a gauge value, not a delta.
- Codex's Conversation-cumulative total doubles as the Conversation's occupancy
  gauge.
- Claude's per-model context window supplies the denominator when one is shown.

Summing a gauge is a category error, and it is the single easiest mistake to
make when porting these adapters. A missing or unparseable gauge value leaves
the previous value in place; it never resets the gauge to zero.

### Terminal reconciliation heals drift without double counting

At settlement an adapter may reconcile its streamed usage projection with an
authoritative terminal figure. Reconciliation **replaces** a field; it never
adds to it. Healing drift must not double count.

Where a backend has no terminal usage surface — Codex — reconciliation uses the
last usage notification observed before the completion frame, and the adapter
**must not wait** for a usage frame that will never arrive.

Turn counts follow the same rule with one refinement carried forward from v1: a
terminal total may **raise** an observed turn count but never lower it, and a
missing or invalid total is ignored. Already-observed progress survives
cancellation and backend failure.

## Consequences

Every adapter owns a baseline and a differencing step, which is more work than
forwarding the provider's numbers. In exchange, `agent_result` and the completion
Notification report what *this* Run cost, and a Subagent's tenth Run does not
report the cost of the first nine.

Charging a Run for auxiliary models means a reported cost can exceed what a user
would compute from the named model's published rate. That is a reporting
surprise, and it is the honest one; the alternative silently understates spend.

Gauges and deltas being different kinds means the domain must keep them in
different fields with different fold rules, and a reviewer has to check which
kind a new counter is before adding it. That check is the whole point of writing
this down.

Codex having no terminal usage surface means its reconciliation is
best-effort by construction: if the last usage notification arrives after the
completion frame, that Run's final figure is slightly stale. Waiting for it would
risk never settling, so a slightly stale figure is accepted over a stuck Run.
