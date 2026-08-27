# 11. Codex App Server migration

Date: 2026-08-27

## Status

Accepted. Refines the Codex execution consequences of
[ADR-0007](0007-harness-seam-with-neutral-facts.md) and
[ADR-0009](0009-codex-trust-posture-and-environment-inheritance.md), and the
Codex protocol consequence of [ADR-0010](0010-run-endings.md). Their neutral
fact, trust-posture, and run-ending decisions remain in force.

## Context

Codex was initially invoked with `codex exec --json`. That process-shaped
interface makes process exit look like completion, exposes a stream format
that does not describe the semantic end of a provider turn, and offers no
clean home for ephemeral activity or cumulative usage updates. The App Server
provides those semantics over JSON-RPC, but also exposes thread, turn, item,
and request identities that must not become part of the one-shot Run model.

The migration therefore has to preserve the harness seam from ADR-0007 and
the ending precedence from ADR-0010 while making five boundaries explicit:
provider identity must remain local, activity must remain display-only, usage
must fold exactly once, and a completed answer must survive a later interrupt.

## Decision

1. **Codex runs through App Server.** Each run starts `codex app-server` over
   stdio JSON-RPC, creates one ephemeral thread, and executes one logical turn.
   Semantic `turn/completed` is authoritative over process exit. Process exit is
   a fallback or escalation path when the semantic turn does not settle; it is
   not an independent successful completion signal.

2. **Provider identity is adapter-local.** Thread, turn, item, and request ids
   are transport identity. They never enter facts, the Run record, history, or
   presentation. The adapter offers no resume, steer, or persisted provider
   session surface.

3. **Live activity is ephemeral.** The harness-neutral live-activity channel
   sits beside durable facts. It is for the live UI only, never transcript
   truth, and is cleared when the run settles. If no live activity is reported,
   the core may derive display activity from the most recent durable tool-call
   fact.

4. **Usage uses cumulative-total diffs.** Each cumulative token-usage update
   is compared with the previous update inside the Codex adapter and emits one
   metadata usage-delta fact per provider model response. No usage is emitted
   again at turn end. Additive counters are therefore folded once, and a crash
   mid-turn preserves the deltas already folded.

5. **The terminal answer is latched by the completed agent message.** A
   completed non-commentary agent message latches the answer. A commentary-only
   turn still answers honestly. A turn that completes without any agent message
   fails with the existing missing-answer message. Cancellation maps to
   `turn/interrupt` and resolves to the domain `cancelled` ending unless the
   answer was latched first.

## Considered alternative

Keep `codex exec --json` and infer completion from its final process event or
exit code. Rejected: exit is not semantic turn settlement, cumulative usage
would be easy to double-count, and provider identity and live protocol detail
would be pulled toward the core seam. A persistent App Server thread was also
rejected because it would turn a one-shot Run into a resumable provider session
and make provider identity part of the Run lifetime.

## Consequences

Codex now has two codex-owned modules — the harness and the App Server
transport — while the core still sees only facts, ephemeral activity, and a
`RunEnding`. The transport owns JSON-RPC parsing, request correlation, process
cleanup, interrupt requests, and provider ids; none of those details are
available to dispatch, lifecycle, or presentation.

The widget can show provider turns and live activity without treating either
as transcript output. A semantic completion can win over a noisy or late
process exit, and a mid-turn failure retains usage already folded. A final
completed agent message remains an authoritative streamed fact because App
Server provides no terminal transcript snapshot; no replacement transcript is
fabricated.

Codex continues the unconditional bypass and operator-environment inheritance
recorded in ADR-0009. The migration changes transport and settlement
semantics, not that accepted trust posture. The one-shot and domain-ending
contracts from ADR-0007 and ADR-0010 remain the shared harness obligations.
