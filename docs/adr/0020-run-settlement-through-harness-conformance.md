# Run settlement is enforced through Harness Conformance

**Status:** Accepted. Supersedes only ADR-0010's shared executable One-shot protocol decision; its neutral `RunEnding` and terminal-precedence decisions remain in force.

## Status after M7 (2026-09-03)

**Settlement through conformance is what the shared suite is.** This ADR's rule — that Run settlement is proven by a capability-aware suite every backend runs rather than per adapter — is the shared conformance suite: thirty-seven scenarios, both fakes and all three real adapters, no skip that a declared capability does not drive. The 1.x harness conformance kit it named was deleted at M7.

See [the deletion ledger](../v2/deletion-ledger.md) for what replaced
each 1.x abstraction, and [the architecture note](../architecture.md) for
how the product is built now. Everything else here is kept unedited: the
reason a decision was made is part of the record even when its subject is
gone.


A Run settles exactly once with one immutable Result, but Pi, Claude, and Codex reach that settlement through materially different provider semantics. Each Harness adapter therefore owns its event ordering, missing-answer policy, and Ending derivation, while the shared Harness Conformance test surface enforces the observable Run contract; the dormant generic One-shot and process-source modules are removed rather than retained as a shallow interface.
