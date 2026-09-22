---
name: effect-development
description: Apply repository-specific Effect guidance when implementing or reviewing code that composes Effect APIs, especially scopes, fibers, interruption, resources, queues, layers, schemas, and typed failures.
---

# Effect development

Use local evidence for the installed Effect version; do not rely on remembered APIs or semantics.

## Establish the contract

1. Identify the Effect APIs and lifecycle concepts touched by the change.
2. Read the matching domain definitions in `CONTEXT.md` and relevant ADRs. Domain ownership and settlement rules take precedence over a convenient Effect composition.
3. Inspect nearby production code and tests for the repository's established composition and test seams.
4. Inspect the installed `effect` package source or type declarations for uncertain signatures or behavior. Confirm the version in `package.json` and `package-lock.json`. If dependencies are unavailable, report the uncertainty rather than guessing.

## Review the composition

Account for every lifetime and ownership boundary:

- which Scope owns each resource, BackendAgent, Run, Fiber, queue, or subscription;
- whether child work is attached, detached, or explicitly forked into an owning Scope;
- what interruption can occur before acquisition, during use, and during finalization;
- whether cleanup runs exactly once and preserves the primary failure;
- whether uninterruptible regions are as small as the invariant requires;
- whether concurrent or late work can mutate state owned by a surviving Run or Session;
- whether typed failures stay distinct from defects and intentional cancellation; and
- whether Layers and services express real ownership rather than hiding mutable global state.

Prefer the smallest composition that makes ownership visible. Do not add wrappers or abstractions solely to make code appear more idiomatic.

## Test the behavior

Use deterministic Effect primitives and existing rigs:

- control ordering with `Deferred`, Fibers, queues, or `TestClock` rather than sleeps;
- assert final state and survivor behavior, not only which helper was called;
- exercise interruption and cleanup when the changed path acquires resources or forks work;
- add race, fault, or stress coverage only when the requirement depends on that class of behavior; and
- use `/test-selection` when the affected seam is unclear or crosses layers.

Run the closest focused test while iterating. Before handoff, follow the verification matrix in `AGENTS.md` and report unavailable checks.
