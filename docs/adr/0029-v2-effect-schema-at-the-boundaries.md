# 29. v2 adopts Effect Schema at its boundaries

Date: 2026-09-02

## Status

Accepted for the v2 tree, **scheduled for M2**. No code implements this yet; M1
closed without it, deliberately, and this ADR is what M2 and M3 build against.

Carries forward:

- [ADR-0028](0028-v2-backend-contract.md) — the backend contract is
  Effect-typed while the domain beside it imports nothing, because the contract
  is about lifetime and the domain is about meaning. This ADR extends the same
  split to decoding: what crosses a boundary is decoded at that boundary, and
  the domain stays plain.
- [ADR-0024](0024-v2-observation-ordering.md) and
  [ADR-0007](0007-harness-seam-with-neutral-facts.md) — only a neutral
  vocabulary crosses the adapter boundary, and provider wire objects never do.
  Decoding at the seam is how that rule becomes *checked* rather than trusted.
- [ADR-0025](0025-v2-terminal-settlement.md) — the Result store is
  authoritative and independent of Notification delivery. Storing a Result and
  carrying one in a Notification are the two obligations that need an encoder.

This ADR supersedes nothing. It refines the engineering guardrails in
[the v2 roadmap](../v2/roadmap.md), section 10.

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
a `JsonSchema` module. So adopting it costs no new dependency, and using it
inside the domain module would mean importing `effect` there.

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

### Decoding happens at the boundary; the domain stays plain

The roadmap's guardrail already says where this goes: *"Decode external input
at the host/adapter boundary."* An observation arriving from an adapter is
external input crossing a boundary, so:

- **Observations are decoded as they cross the backend seam**, in the `backend`
  module, which is already Effect-typed and needs no rule change.
- **The domain keeps its own constructors and predicates** for values the core
  itself builds, where there is no boundary and nothing to decode.
- **The domain purity rule is unchanged.** A production file under `domain/`
  may still import only another file under `domain/`, and the v2 boundary test
  still enforces that as "no package specifiers at all" — a fence that cannot
  be widened, rather than a named-import allowlist that can be widened with a
  one-word edit.

The consequence to accept knowingly: the phantom brand and its four guards stay
hand-written, and `Schema.brand` does not replace them. That is the price of the
purity rule, and the rule is worth more than the duplication.

### Schema owns v2's encode and decode obligations

| Obligation | Milestone |
| --- | --- |
| Decode observations crossing the backend seam | M2 |
| Encode and decode a stored `RunResult` | M2 |
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

- **Schema inside the domain module.** Covered above.
- **Schema over the transition tables.** They are data, not a decoding problem.
- **Schema for the Profile frontmatter reader.** That is a *parser*, not a
  decoder — it turns text into values, which no schema library does — and it
  lives in the domain module besides. The narrowness of that reader is recorded
  as a gap in [the M1 exit gate](../v2/m1-exit-gate.md) and is a separate
  question.

## Consequences

One schema library eventually, instead of two. If question 3 of the spike fails,
`typebox` stays at that single call site and v2 carries both — at the host
boundary only, never in the core. Recording that fallback now means it is a
known outcome rather than a surprise during M3.

Decoding at the seam costs a pass over every observation a backend emits. The
observation stream is bounded and the pass is shallow, so this is cheap; and it
converts ADR-0024's "provider wire objects never cross" from a rule adapters are
trusted to honour into one the seam rejects them for breaking.

Once the seam decodes, the domain's own predicates become belt-and-braces rather
than the primary check. M2 decides whether to keep them; the recommendation is
to keep them, because they are cheap, they guard values the core builds itself,
and `reduceRun` reporting `ignored-invalid` rather than throwing is what lets a
malformed observation be survivable instead of fatal.

Committing to "Effect where it reduces complexity" is a direction, not a licence.
The three standing limits still bind: no Layer per Subagent, BackendAgent, or Run
([ADR-0023](0023-v2-scope-ownership.md)); `Effect.runPromise` only at the host
boundary and native callback bridges; and the domain module importing nothing.
A change that needs one of those relaxed is a change to the ADR that set it, not
a judgement call at the call site.
