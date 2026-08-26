# 10. Executors resolve to run endings

Date: 2026-08-27

## Status

Accepted. Supersedes the outcome-shape consequence of [ADR-0007](0007-harness-seam-with-neutral-facts.md); the facts-plus-resolution split from [ADR-0005](0005-executor-reports-facts.md) stands.

## Decision

The executor seam resolves to the domain-neutral `RunEnding` union:

```ts
type RunEnding =
  | { ending: "answered" }
  | { ending: "failed"; errorMessage?: string }
  | { ending: "cancelled" };
```

Exit codes and backend stop words do not cross the seam. Process sources turn
exit details into words locally, and cancellation is represented by the
cancelled ending. The fold derives the lifecycle once: cancelled and failed
endings map directly; an answered ending is completed unless its healed record
contains a fact error message or a fact stop reason of `error`, in which case it
is failed. A failed ending's optional message is only a fallback and never
replaces a fact-borne message.

The One-shot protocol owns terminal-before-abort ordering, missing-answer
policy, live reporting, source-failure handling, and ending derivation. Each
harness translates its wire events before they cross the executor seam.
