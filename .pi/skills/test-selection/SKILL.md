---
name: test-selection
description: Select focused tests and completion checks for changes to pi-subagent across domain, Effect runtime, backend contracts, host integration, presentation, profiles, and live provider behavior.
---

# Test selection

Choose tests from the behavior's owning seam, not merely from the directory containing the edit. Read the requirement, relevant domain definitions and ADRs, changed code, and nearby tests before selecting a lane.

## Select every applicable lane

- **Pure domain decisions:** use adjacent domain unit tests. Add property-style sequence coverage when the behavior is an invariant over ordering, repetition, reconciliation, or bounds.
- **Effect lifetime and concurrency:** use runtime tests with controlled Fibers, `Deferred`, queues, or `TestClock`. Assert interruption, cleanup, terminal settlement, and surviving state. Avoid timing sleeps as an oracle.
- **Backend-neutral behavior:** use contract tests and the conformance scenario table. Run `npm run test:conformance` when behavior must agree across fake, Pi, and Claude rigs or when an override or skip changes.
- **Provider adaptation:** use the affected Pi or Claude translation, evidence, profile, options, or stand-in tests. Provider wire objects and vocabulary should be proven at the adapter boundary, not above it.
- **Application or host integration:** use the application observation tests or host session, tool, notification, inspection, and end-to-end rigs that own the visible result.
- **Presentation:** use the narrowest renderer or view test, plus golden, final-output-surface, status, or text-width coverage when the visible contract changes.
- **Profiles:** use discovery and profile-field tests. For bundled Profiles, also run `npm run profiles:smoke` before handoff.
- **Module boundaries and primitives:** use `boundaries.test.ts`, `effect-primitives.test.ts`, or import-specifier tests when dependency direction or permitted primitives change.
- **Live provider behavior:** use a named `*:smoke` command only when the user explicitly requests live or release verification. These commands require configured providers and spend quota.

A change may require several lanes. Prefer one focused test from each owning seam over broad duplicate coverage at incidental layers.

## Test quality

Tests should:

- exercise the highest stable boundary that owns the observable result;
- derive expected behavior from requirements, domain rules, or an independent oracle rather than recomputing it with implementation logic;
- use explicit event ordering for races and assert the final owner and state;
- cover failure and cleanup paths introduced by the change; and
- avoid provider calls in ordinary unit, integration, and conformance tests.

Do not add tests solely for constructible but unsupported values unless they cross an actual trust boundary or have a concrete supported consequence.

## Run focused checks

Use the repository test setup for one test file:

```sh
node --import tsx --import ./extensions/subagent/suite-setup.ts --test <test-file>
```

Run focused checks while iterating, then follow the completion matrix in `AGENTS.md`. Report failed or unavailable checks without weakening the test to obtain a pass.
