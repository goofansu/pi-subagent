# 6. Completion notifications and authoritative results

Date: 2026-08-25

## Status

Accepted. Supersedes ADR-0002.

### Status after M7 (2026-09-03)

**The delivery module this describes is gone.** Its three jobs are now three things: `ResultStore` owns storage, reservations, pins, and eviction; `CompletionDelivery` reads what was stored and pushes it; the Session push sink owns landing. The rule that made this ADR worth having — **storage precedes notification, and delivery reads the store** — is unchanged and is why a notification failure is survivable.

See [the deletion ledger](../v2/deletion-ledger.md) for what replaced
each 1.x abstraction, and [the architecture note](../architecture.md) for
how the product is built now. This ADR is kept unedited above: the reason a
decision was made is part of the record even when its subject is gone.

## Context

Pushing a run's full answer makes every completion consume context whether or
not the parent needs the details. Truncating that push also made notification
delivery part of result correctness.

## Decision

Every terminal output is stored at settle and retrieved with `agent_result`.
A pushed completion notification provides orientation only: identity and
status, a bounded deterministic preview for success, the primary error for
failure, or a terse cancellation notice. The result store is authoritative.

The intentional bounded duplication between wait and notifications: wait
communicates terminality, the notification orientation, the result tool
authoritative output — do not "fix" the duplication by reinventing claims.

Notification re-push is reliability, not correctness. An interrupt may discard
a queued notice, so the runtime retries a notice known to be lost, but the
stored result never depends on that landing.

## Consequences

Large fan-outs consume roughly one preview per completion rather than one full
answer per completion. Models retrieve only results worth reading. A failed
notification remains diagnostic in the common case while raw stderr and
partial transcript output remain behind `agent_result`.
