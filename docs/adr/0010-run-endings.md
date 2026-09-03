# 10. Executors resolve to run endings

Date: 2026-08-26

## Status

Accepted. Supersedes only the executor-resolution consequence described in
[ADR-0005](0005-executor-reports-facts.md) and carried forward in
[ADR-0007](0007-harness-seam-with-neutral-facts.md); both ADRs' neutral-fact
and facts-plus-resolution decisions stand. Codex transport details are refined
by [ADR-0011](0011-codex-app-server-migration.md); this ADR's domain ending
precedence remains in force.

### Status after M7 (2026-09-03)

**The executor is gone; run endings are not.** `RunEnding` is a domain type and the three endings are the same three. What changed is who applies one: a backend returns an ending in a terminal bundle and the core performs the transition, arbitrating between it and up to three other candidates. [ADR-0025](0025-v2-terminal-settlement.md) is where settlement is decided now.

See [the deletion ledger](../v2/deletion-ledger.md) for what replaced
each 1.x abstraction, and [the architecture note](../architecture.md) for
how the product is built now. This ADR is kept unedited above: the reason a
decision was made is part of the record even when its subject is gone.

## Context

The harness seam now carries neutral facts, but executor resolution still used
process-shaped outcomes: exit codes, backend stop words, and optional error
text. That exposed transport details to the run fold and made each harness
encode cancellation and terminal-answer ordering independently.

The one-shot protocol also needs one shared answer to a source's final state.
A terminal answer witnessed before cancellation must remain authoritative; an
abort without such an answer must remain cancellation; and a clean source that
never answers must be a failure with the harness's missing-answer message.

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
contains a fact error message or a fact stop reason of `error`, in which case
it is failed. A failed ending's optional message is only a fallback and never
replaces a fact-borne message.

The One-shot protocol owns terminal-before-abort ordering, missing-answer
policy, live reporting, source-failure handling, and ending derivation. Its
source sink has the smallest acknowledgement contract: `true` means a
terminal answer was witnessed before abort, `false` means a translated event
was nonterminal or arrived after abort, and `undefined` means the event was
ignored or arrived after settlement. Each harness translates its wire events
before they cross the executor seam.

## Consequences

Executors no longer fabricate exit codes or backend cancellation markers, and
the lifecycle union contains no process fields. Process-backed adapters still
retain their transport diagnostics locally, while SDK-backed adapters can
resolve honestly without inventing a process result.

The protocol is tested once through scripted sources and each harness supplies
only its source and pure translator. Facts remain live; a harness with a
terminal snapshot may use transcript healing, while Codex App Server has no
such snapshot and its final completed agent message remains authoritative as a
streamed fact without a fabricated replacement. The ending's failure message remains a
fallback for facts or stderr that already explain the failure.
