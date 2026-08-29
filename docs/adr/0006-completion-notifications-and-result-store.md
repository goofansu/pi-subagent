# 6. Completion notifications and authoritative results

Date: 2026-08-25

## Status

Accepted. Supersedes ADR-0002.

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
