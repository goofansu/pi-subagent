# 29. v2 adopts Effect Schema

Date: 2026-09-02

## Status

Accepted for the v2 tree. **Implemented in M2**, whose exit gate records what
it deleted, and gated by a spike against the library. The two M3 obligations in
the table below — the Notification custom message and replacing `typebox` — are
still ahead.

Revised the day it was written. The first draft kept schemas out of the domain
module in order to preserve M1's "domain imports nothing" boundary test
unchanged. That was protecting a check rather than choosing a design: it
inverted this repository's own criterion for what the domain holds, and it
would have split every type from its own validation rules. The decision below
is the corrected one.

Carries forward:

- [ADR-0028](0028-v2-backend-contract.md) — the contract is Effect-typed
  because it is about resource lifetime, and the domain is separate because it
  is about meaning. This ADR applies that same criterion to Schema and reaches
  the opposite placement: a schema states meaning, so it belongs in the domain.
  What ADR-0028 keeps out of the domain is the *runtime* — scopes, fibers,
  interruption — and Schema is not that.
- [ADR-0024](0024-v2-observation-ordering.md) and
  [ADR-0007](0007-harness-seam-with-neutral-facts.md) — only a neutral
  vocabulary crosses the adapter boundary, and provider wire objects never do.
  Decoding at the seam is how that rule becomes *checked* rather than trusted.
- [ADR-0025](0025-v2-terminal-settlement.md) — the Result store is
  authoritative and independent of Notification delivery. Storing a Result and
  carrying one in a Notification are the two obligations that need an encoder.

This ADR supersedes nothing. It refines the v2 programme's engineering
guardrails.

## Context

M1 wrote its own validation, because the domain module imports nothing. What
that produced, and what it costs:

| Hand-written in M1 | What it costs |
| --- | --- |
| `observationProblem` | A ten-arm switch over the observation union returning `string \| undefined`. Every new observation kind is a new arm somebody must remember. |
| `usageDeltaProblem`, `contextGaugeProblem` | Field-by-field loops checking finite, integer, nonnegative, and unknown-key. |
| The exact-key-set rule | A compile-time `keyof` test *and* a separate runtime key walker, because neither alone covers both nested values and added fields. |
| Branded identifiers | A phantom `unique symbol`, four constructors, and four guards whose bodies are identical — they answer "could this be an id" rather than "is this a `RunId`", which the M1 review flagged as a name promising a discrimination it cannot perform. |
| Encoding | **Nothing.** M1 has no encoder at all. |

That last row is the one that matters, because three obligations ahead of us all
need one:

- **M2's Result store** must persist an immutable `RunResult`.
- **M3's completion Notification** is a custom message that must be built and
  parsed. v1 does both by hand in `notification-message.ts`.
- **The host boundary** must decode tool input arriving from a model.

The repository also already carries a second schema library. `typebox` is a
dependency used in exactly one place — the model-facing tool parameter schemas
the Pi host requires in `extensions/subagent/index.ts`. v2 needs Effect
regardless, so carrying two schema libraries is worse than carrying either one.

In the pinned release, `Schema` ships from the `effect` package root, alongside
a `JsonSchema` module. Adopting it costs no new dependency. It does mean the
domain module importing `effect` for that one binding, which is what the
placement question below turns on.

## Decision

### Effect is adopted wherever it reduces complexity or buys robustness

The standing direction for v2 is to reach for Effect when it **removes
machinery we would otherwise write, own, and test** — not to adopt it for its
own sake, and not to avoid it out of caution. `Scope`,
`Effect.acquireRelease`, `Fiber`, `Deferred`, bounded `Queue`, and
`SubscriptionRef` were already chosen on exactly that basis, because each one
replaces something v1 hand-rolls. `Schema` qualifies for the same reason: the
table above is machinery, and a declaration would delete most of it.

Where Effect would only re-express something already small and clear, it does
not qualify. The two transition tables are the example: they are data a
reviewer reads in one sitting, and a schema over them would add indirection
without removing a maintenance burden.

### Schemas are declared in the domain; decoding is invoked at the boundary

These are two different questions, and conflating them was the error in the
first draft of this ADR.

**Where a schema is declared** follows the same criterion
[ADR-0028](0028-v2-backend-contract.md) uses to decide what the domain holds:
lifetime is the contract's subject, and meaning is the domain's. A schema is a
statement of meaning — what a value is, and which shapes are admissible — so it
belongs beside the type it describes. `RunObservation` and its schema are one
piece of knowledge, and splitting them across two modules would guarantee they
drift.

M1 shows what that drift looks like at small scale. The observation union is
declared in `domain/observations.ts`, validated by a ten-arm switch in
`domain/reduce-run.ts`, and its exact key set tabulated a third time in
`testing/observation-vocabulary.ts` — three places holding one fact, kept in
step by hand. One schema declaration replaces all three. Declaring the schemas
anywhere but the domain would preserve that split and merely move a piece of it.

**Where decoding is invoked** is what the roadmap's guardrail governs: *"Decode
external input at the host/adapter boundary."* The backend seam and the host
boundary call `decode` using the domain's declarations. That satisfies the
guardrail exactly, with the schemas still living where the types live.

### The domain purity rule is enforced by property, not by proxy

The rule exists for three reasons: the fold must be testable as a pure function
with no runtime, no provider SDK may reach the core, and no runtime machinery
may appear in the domain. Importing `Schema` breaks none of them. A schema
declaration is a plain value, and `decodeResult`, `decodeOption`, and
`decodeSync` are runtime-free paths alongside the Effect-returning ones, so a
domain module using Schema is still callable from a bare test with no runtime.

M1's boundary test enforced "no package specifiers at all", which is a proxy for
those three properties rather than the properties themselves. It is easy to
check, and that is the only thing it had going for it — protecting it over the
design was the wrong trade. The rule becomes:

- a production file under `domain/` may import other domain files, and from
  `effect` may import **only** the `Schema` binding — every other named import
  from that specifier is a violation, checked at the named-import level rather
  than the specifier level;
- no production file under `domain/` may name a runtime primitive, which the
  existing mechanism-vocabulary rule already covers and which M2 extends to the
  fiber, scope, and queue vocabulary;
- no v2 file imports a provider SDK, unchanged.

That is a **stricter** fence than the one it replaces, because it checks the
properties the rule is for. The boundary walker already reads imports through
the TypeScript AST, so reading named imports is a small extension of existing
tooling.

The consequence: `Schema.brand` replaces the phantom brand, its four
constructors, and its four guards — including the four identical guard bodies
whose names promise a discrimination they cannot perform, which the M1 review
flagged and which the first draft of this ADR accepted as a permanent cost.

### Schema owns v2's encode and decode obligations

| Obligation | Milestone |
| --- | --- |
| Schema declarations for the observation union, endings, usage, and `RunResult`, in the domain beside the types | M2 |
| Branded identifiers via `Schema.brand`, replacing the phantom brand and its guards | M2 |
| Decode observations crossing the backend seam, using those declarations | M2 |
| Encode and decode a stored `RunResult` | M2 |
| The domain boundary rule extended to a named-import check, with fixtures | M2 |
| Build and parse the completion Notification custom message | M3 |
| Tool parameter schemas at the host boundary, replacing `typebox` | M3, if the spike below clears it |

### A disposable spike comes first

In the same style as M0's three backend spikes, and for the same reason: the
`Schema` module in this release is a rewrite rather than the Effect 3 package,
so its rough edges should be found in something we throw away. Three questions:

1. Does the observation union express cleanly as a tagged union with excess
   properties rejected, such that the exact-key-set rule becomes a property of
   the schema rather than two separate tests?
2. Is a decode failure's text good enough to put in a bounded, redacted
   diagnostic — and does it stay free of provider payload?
3. Can `JsonSchema` emit tool parameter schemas the Pi host accepts?

The findings belong in `docs/v2/spikes/`, like the backend ones.

### What stays out

- **Schema over the transition tables.** They are data a reviewer reads in one
  sitting, not a decoding problem; a schema would add indirection and remove no
  maintenance burden.
- **Schema for the Profile frontmatter reader.** That is a *parser*, not a
  decoder — it turns text into values, which no schema library does — and it
  lives in the domain module besides. The narrowness of that reader was
  recorded as a gap at the M1 exit gate and is a separate question.

## Consequences

One schema library eventually, instead of two. If question 3 of the spike fails,
`typebox` stays at that single call site and v2 carries both — at the host
boundary only, never in the core. Recording that fallback now means it is a
known outcome rather than a surprise during M3.

Decoding at the seam costs a pass over every observation a backend emits. The
observation stream is bounded and the pass is shallow, so this is cheap; and it
converts ADR-0024's "provider wire objects never cross" from a rule adapters are
trusted to honour into one the seam rejects them for breaking.

`reduceRun` keeps reporting `ignored-invalid` rather than throwing, whatever
produces the failure. That is what makes a malformed observation survivable
instead of fatal, and it is a property of the reducer's contract rather than of
how validation is implemented. What changes is where the reason string comes
from: a formatted schema issue instead of a hand-written sentence.

The one way Schema could make things *worse* is if a decode failure's text
included the offending value. A malformed provider payload would then ride into
a bounded diagnostic and cross the boundary
[ADR-0024](0024-v2-observation-ordering.md) exists to hold. That is spike
question 2, and it gates the adoption rather than following it.

Committing to "Effect where it reduces complexity" is a direction, not a licence.
Three limits still bind: no Layer per Subagent, BackendAgent, or Run
([ADR-0023](0023-v2-scope-ownership.md)); `Effect.runPromise` only at the host
boundary and native callback bridges; and no runtime primitive named in the
domain module, `Schema` being the one binding it may import from `effect`. A
change that needs one of those relaxed is a change to the ADR that set it, not a
judgement call at the call site.

The wider lesson from having to revise this ADR the day it was written: a
boundary test is a means, and its simplicity is not evidence that what it checks
is the right thing. "The domain imports nothing" was easy to verify and was
standing in for three properties that can each be checked directly. When a rule
and a design disagree, the rule is the thing to re-examine first.
