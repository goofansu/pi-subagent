# 19. Managed steering and resume are a three-provider release contract

**Status:** Accepted.

## Context

Capability flags are correctness claims. Unit support in one adapter, or a
test-only wrapper, cannot justify a backend-neutral release claim when another
production path lacks ordering, identity confinement, cleanup, or authenticated
provider evidence.

## Decision

Production Pi, Claude, and Codex advertise steering and Session-scoped resume.
All pass the same capability-aware per-Run conformance and 32-repeat managed
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
