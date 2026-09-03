# The invariant freeze

**Status: in force** from the first commit of the simplification programme
until its last phase closes. **Applies to:** every change made under
[the simplification roadmap](roadmap.md), in `extensions/subagent/` and in the
documents that describe it.
**Reason:** a simplification programme is the one kind of work whose failure
mode is invisible. A feature that breaks an invariant fails a test. A
simplification that weakens an invariant can pass every test by deleting the
test, or by moving the property from a check into a comment, and look tidier
afterwards. This document is the list of what may not move, and for each item,
the thing in `check` that says so.

The v2 programme had [a freeze on the tree it was replacing](../v2/freeze.md).
This is the mirror image: a freeze on the properties of the tree being kept.

## The rule

> A simplification is successful only if it removes a concept or a reason for
> unrelated files to change together, without weakening an existing invariant.
> Moving correctness from a test into a comment is not a simplification.

Phase A added this sentence to
[contributing.md](../contributing.md#the-simplification-rule), which is now
where it lives. A reviewer's question on every pull request in the
programme is: *which test enforces this property after the change?* If the
answer is a comment, the change is not done.

## What is frozen, and what enforces it

Each row names the property, where it is decided, and what fails if it goes.
"Enforced by" names things that exist today; the programme adds to this column
and removes nothing from it.

| # | Frozen property | Decided in | Enforced by |
| --- | --- | --- | --- |
| F1 | The thirteen invariants in contributing.md, verbatim. | [contributing.md](../contributing.md#the-invariants-a-change-may-not-break) | Each names its own check; the list is the index. |
| F2 | Ownership is Session Scope → Subagent Scope → Run Scope → native execution. Runs and BackendAgents are not Effect Layers. | [ADR-0023](../adr/0023-v2-scope-ownership.md) | `runtime/lifecycle.test.ts`; the leak probes in `runtime/stress.test.ts` ending at zero. |
| F3 | One terminal candidate wins; arbitration is pure; cleanup completes or is escalated before the Result is observable. | [ADR-0025](../adr/0025-v2-terminal-settlement.md) | `runtime/arbitration.test.ts`; `runtime/races.test.ts`; conformance `a-run-settles-exactly-once` family. |
| F4 | Storage precedes notification. Delivery reconstructs the notice from the stored Result. `agent_result` is authoritative. Delivery says *handed off* and only the push sink says *landed*. | [ADR-0006](../adr/0006-completion-notifications-and-result-store.md), [ADR-0033](../adr/0033-notification-vocabulary-pointer-and-label-bound.md), [architecture §6](../architecture.md#6-delivery-reads-what-was-stored) | Conformance `a-notification-follows-storage`, `a-notification-retry-cannot-duplicate-or-alter-settlement`; `runtime/delivery.test.ts`. |
| F5 | `RunRepository` and `ResultStore` stay two services. The repository is the live index; the store is the immutable terminal output. | [architecture §6, §7](../architecture.md) | Boundary rules in `boundaries.test.ts` on who writes each; `runtime/repository.test.ts`; `runtime/result-store.test.ts`. |
| F6 | The store's pin holders stay named: `publication`, `waiters`, `delivery`. A release is attributed to one holder. | `runtime/result-store.ts` | `runtime/result-store.test.ts` (double release cannot free twice; each holder releases independently). |
| F7 | The generic capability set is `resume`, `steer`, `terminalTranscriptSnapshot`. A capability enters the core only when it changes generic lifecycle semantics. | [ADR-0028](../adr/0028-v2-backend-contract.md), [architecture §9](../architecture.md#9-the-backend-contract-and-what-a-new-backend-owes) | The exact contract-member lists in the backend contract tests; conformance skips driven by declared capability, never by backend identity. |
| F8 | Provider wire objects and vocabulary never cross the adapter boundary. | [ADR-0007](../adr/0007-harness-seam-with-neutral-facts.md), [ADR-0024](../adr/0024-v2-observation-ordering.md) | Provider-confinement rules in `boundaries.test.ts`; the Profile field-word ban. |
| F9 | Presentation depends only on domain projections. No formatter reads the repository, the store, a backend, a clock, or the profile catalog. | [architecture §8](../architecture.md#8-the-host-boundary-is-the-only-place-an-effect-is-run) | Boundary rules on `presentation/*` imports; rule 20, which restricts `presentation/notification-text.ts` to `domain/` and `presentation/`, so notification text depends on `RunNotification` alone. |
| F10 | Every bound truncates and records, or refuses with a typed outcome. | contributing invariant 11; [ADR-0032](../adr/0032-reservations-evict-rather-than-refuse.md); [ADR-0033](../adr/0033-notification-vocabulary-pointer-and-label-bound.md) for the label | `runtime/bounds.test.ts`, every bound driven past. Phase A's label bound joined this lane. |
| F11 | Control admission is not provider confirmation. | [ADR-0026](../adr/0026-v2-control-admission.md) | Conformance steer scenarios; `runtime/mailbox.test.ts`. |
| F12 | No real time passes in a test. | [contributing.md](../contributing.md#no-real-time-passes-in-a-test) | `timing.test.ts`; the test clock in every runtime lane. |

## What the freeze permits

The freeze is on properties, not on files. Any file may change, including the
supervisor, the store, and the delivery module, provided every row above still
has an enforcer afterwards. Three kinds of change are expected and welcome:

1. **Renames that make a name say what the thing does.** Phase A's
   `delivered` → `handedOff` is the model. The test diff for such a change is
   empty apart from the rename itself and any new fence.
2. **Extractions that move a mechanism out of an orchestrator without changing
   its behaviour.** Phase B's admission and registry extractions. The existing
   runtime tests pass unmodified; a test that has to change means the behaviour
   changed, and the change goes back.
3. **Fences that turn a rule in prose into a rule in `check`.** New boundary
   rules, each with its negative-case fixture, as `boundaries.test.ts` already
   requires.

## What the freeze forbids

- **Deleting a test to make a simplification land.** A test can be deleted
  when the property it guarded no longer exists; the commit says which
  property and why it is gone, as the M7 boundary-rule deletions did.
- **Merging `RunRepository` into `ResultStore` or the reverse** (F5).
- **Hiding a named pin behind a generic scope** (F6). Phase C's lease work
  stops at admission capacity for this reason.
- **Adding a capability flag for a provider feature** (F7). MCP, shell,
  browser, images, patch editing, task lists, and nested subagents are
  provider-native and stay so.
- **A new Effect Layer for a mechanism that has no independent lifetime.**
  Phase B's extracted pieces are plain scoped objects the supervisor constructs.
- **A formatter that reaches past its projection** (F9).
- **Pulling a Phase D item forward** without the ADR and the soak finding the
  roadmap requires.

## When the freeze lifts

When the last scheduled phase's gate closes. The rows above do not lift with
it; they are the architecture, and contributing.md carries them. What lifts is
the presumption that every change in flight is a simplification and must be
judged as one.
