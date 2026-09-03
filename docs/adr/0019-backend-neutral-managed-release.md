# 19. Managed steering and resume are a three-provider release contract

**Status:** Accepted.

## Status after M7 (2026-09-03)

**The managed release is the contract's `close`.** Backend-neutral managed release is what `close` on a BackendAgent means, and it is idempotent and releases every retained native resource — a conformance scenario each backend passes. The 1.x modules this described were deleted at M7.

See [the deletion ledger](../v2/deletion-ledger.md) for what replaced
each 1.x abstraction, and [the architecture note](../architecture.md) for
how the product is built now. Everything below is kept unedited: the reason
a decision was made is part of the record even when its subject is gone.

## Context

Capability flags are correctness claims. Unit support in one adapter, or a
test-only wrapper, cannot justify a backend-neutral release claim when another
production path lacks ordering, identity confinement, cleanup, or authenticated
provider evidence.

## Decision

Production Pi, Claude, and healthy Codex adapters support steering and
Session-scoped Resume. Resume uses the neutral atomic admission interface from
ADR-0021: admitted with a prepared Run, unsupported, or Conversation loss. All
pass the same Control-capability-aware per-Run conformance and 32-repeat managed
conformance, including provider-Result-transparent steering, FIFO delivery,
admission-without-Fact, cancellation followed by resume, immutable independent
Results and notifications, per-Run transcript and usage isolation, one active
execution, and idempotent close. Provider wire and continuation identities stay
inside their adapters and the existing static/runtime boundary gates remain
mandatory.

`npm run check` is the local gate. `npm run release:check` additionally runs
separate authenticated steering and resume proofs for Codex, Pi, and Claude.
Each proof has a unique success marker, a hard timeout, signal handling, a
forced cancellation cleanup probe, and unconditional Session shutdown. The
release is not complete unless every enabled provider's live gates pass in an
environment with its real credentials and quota.

## Consequences

An intermediate provider-only change can be truthful but is not Phase 3. Live
gates spend quota and remain operator-run; deterministic seams carry the local
CI burden. Cross-Session persistence, public continuation tokens, queued resume,
and multiple active Runs per Subagent remain out of scope.
