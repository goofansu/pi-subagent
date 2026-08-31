# Run settlement is enforced through Harness Conformance

**Status:** Accepted. Supersedes only ADR-0010's shared executable One-shot protocol decision; its neutral `RunEnding` and terminal-precedence decisions remain in force.

A Run settles exactly once with one immutable Result, but Pi, Claude, and Codex reach that settlement through materially different provider semantics. Each Harness adapter therefore owns its event ordering, missing-answer policy, and Ending derivation, while the shared Harness Conformance test surface enforces the observable Run contract; the dormant generic One-shot and process-source modules are removed rather than retained as a shallow interface.
