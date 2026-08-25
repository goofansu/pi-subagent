# 5. Executor reports facts

Date: 2026-08-24

## Status

Accepted. Supersedes [ADR-0004](0004-shared-mutable-run-record.md).

## Context

ADR-0004 deferred the single-writer deepening of the run record, with two
re-open triggers: a bug crossing two of the record's three writers, or a new
outcome field. Neither fired. The decision was re-opened anyway, by the
operator, on timing grounds: the full understanding of the record's writers,
their ordering, and the invariants between them was freshly built during the
architecture-review session that wrote ADR-0004, and doing the deepening warm
is strictly cheaper than doing it cold later under a trigger. The general
practice agrees with the shape — harnesses in this space converge on events
across seams, one owner folding them into state, and a terminal snapshot that
heals the stream.

## Decision

The executor never holds the run record. The seam in `run.ts` carries a
normalized fact vocabulary — `message`, `transcript` (the terminal snapshot),
`stderr` — and the executor resolves to an outcome (`exitCode`, and
`stopReason`/`errorMessage` when the ending says so, with
`stopReason: "aborted"` as the abort marker, since only the executor knows
whether a cancellation actually killed the child).

The fold from facts to record writes lives in `run.ts`, beside the record;
the dispatcher is the only module that invokes it. Everything derivable is
derived in the fold rather than reported — usage from folded messages,
activity from the latest tool call, the per-message model refinement — so an
executor cannot get them wrong and the `agent_end` snapshot heals any drift.
Activity is recorded on the run, which ends the registry's import of the
message wire format: wire knowledge now stops at `pi-agent.ts`.

`emit` left the executor contract entirely; the fold signals a change after
every fact, so an executor can neither forget nor over-call it.

## Consequences

The invariants ADR-0004 could only document are now structural: an executor
cannot set `status`, cannot violate the failure-text field priority, and
cannot write anything the fold does not derive, because it never sees the
record. The failure-text priority (`errorMessage`, then `stderr`, then the
transcript) has exactly one reader, `presentation.ts`, and one writer, the
fold.

The executor tracks locally what it used to read back from the record (did
anything diagnose this failure already?) — the one piece of state the seam
pushed onto its side.

Stand-in executors return outcomes and report facts; they can no longer
fabricate half-settled records, which makes some previously expressible test
states (an executor observing the record mid-run) impossible by design.

The fact vocabulary crossing the seam is deliberately pi-ai's `Message`
while pi is the only harness. The fold and the message readers consume its
payload shape directly — `provider`, `model`, `stopReason`, the usage
fields, tool-call and text content parts — so that knowledge lives above
the executor (in `messages.ts` and the fold) rather than behind a
harness-neutral fact type. This is accepted, not overlooked: designing a
"neutral" vocabulary against a single wire format would bake pi's
assumptions into the neutral type anyway.

Re-open this — and design the domain fact vocabulary as that work's first
step — when a second harness (Claude Code, Codex) is actually being built;
until then, a payload shape misread above the seam is the only other
trigger. See `.scratch/architecture-deepening/issues/07` for the gated
ticket.
