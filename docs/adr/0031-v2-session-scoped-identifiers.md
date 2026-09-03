# 31. Identifiers carry a per-Session nonce

Date: 2026-09-03

## Status

Accepted for the v2 tree, implemented in M4 after the first day of dogfood.

Carries forward:

- [ADR-0013](0013-stable-subagent-identity.md) — a Subagent has one stable
  identity for as long as it exists, and a Run identity is never reused. This
  ADR is about what "never reused" means once the *process* can end and the
  conversation cannot.
- [ADR-0022](0022-v2-terminology-and-backend-field.md) — `SubagentId` and
  `RunId` are the public identity vocabulary, and both are strings a model
  reads and types back.

## Context

v2 numbers identities sequentially per Session: `subagent-1`, `run-1`, `run-2`.
v1 minted `run-${crypto.randomUUID().slice(0, 8)}` — random per Run. The change
was made for readability, and nobody wrote down what the randomness had been
doing.

It had been doing something. Identities are Session-scoped by design: the
`RunRepository` is a session-long service, and
[the compatibility matrix](../v2/compatibility-matrix.md) says twice that this
is intended — *"Local Subagent and Run identity sets are forgotten at the
Session boundary"* and *"After Session shutdown — Nothing is retrievable:
Results belong to the Session that asked."* The Subagents, their retained
native sessions, and their stored Results all die with the process. Identifiers
that outlived them would point at nothing.

But **the conversation transcript is not Session-scoped.** Reloading a Pi
session builds a new runtime whose numbering starts again at one, into a
transcript that still holds the previous Session's identifiers. So an
identifier written before the reload can be handed to a *different* Run after
it, and there are two cases:

- Before a new Run has taken the number, the stale reference is reported
  unknown. Honest. Observed in a real session: `agent_resume subagent-1` after
  a reload answered *"Cannot resume subagent subagent-1: unknown Subagent."*
- After a new Run has taken it, the stale reference silently resolves to the
  wrong Run. Demonstrated through the host rig, one process, two Sessions:
  asking for the first Session's `run-1` returned the second Session's Run,
  brief and all, with nothing in the answer saying so.

The second case is a wrong answer presented as a right one, which is the worst
category of defect this product can have.

It is also **likely rather than incidental, and this extension causes it.**
Every completion notice v2 writes into the conversation ends with *"Use
`agent_result` with id `run-1` to retrieve the full result."* That sentence
survives the reload and invites the model to use an identifier that has since
been reassigned. The attractor is our own prose.

Two smaller facts shaped the decision. Sequential numbering is genuinely worth
something: `run-3` is an identifier a person reads in a widget row, types into
`agent_cancel`, and matches against a notice, and `run-3f9a1c22` is not. And
the defect was found by hand-driving the product on its first day as a daily
driver, not by any test — the full record is in
[the M4 live findings](../v2/m4-live-findings.md).

## Decision

**Each Session runtime draws a nonce, and every identifier it mints carries
it.** Four characters from a 36-character alphabet, appended after the kind:

```
subagent-k3f9-1
run-k3f9-1
run-k3f9-2
```

One nonce per Session runtime, **shared by both kinds**, so a Session's
identities read as a set. Sequence numbers stay per-kind and start at one, so
what a person reads is still a small number they can hold in their head.

The nonce is drawn through Effect's `Random` rather than `Math.random`, so a
test that needs a reproducible sequence can pin it with a seed without the
repository knowing anything about testing.

`forget()` — the Session-boundary reset — re-mints the nonce, so a runtime
reused after shutdown begins a new identity space. Its sequence counters
deliberately keep counting rather than restarting: uniqueness *within* one
process stays a certainty rather than resting on two nonces differing.

### What was rejected

**Returning to v1's fully random identifiers.** It closes the hazard
completely, and it gives back the unreadability the sequence was introduced to
fix. The hazard needs a model to reach back into a stale part of a transcript;
the readability cost is paid on every glance at a widget row.

**Leaving it and documenting the hazard.** Defensible for a single-user tool,
and it was the state of things for a day. Rejected because the failure is
silent and wrong rather than loud and unavailable, and because the product's
own notice is what leads a model into it.

**Detecting stale identifiers without changing their shape.** Not possible: the
identifier is the only thing that crosses the reload, so distinguishing an old
one from a new one requires something in the identifier.

## Consequences

A stale identifier is reported unknown, which is what v1 gave and what v2 lost
when it made identifiers readable.

**This is weaker than v1 in degree, and the difference is worth stating.** Two
Sessions draw the same nonce about once in 1.7 million, and when they do they
share *every* identifier rather than one. Pairs are the right unit here,
because a stale identifier only misleads if the Session that minted it and the
Session reading it collide with each other; the birthday bound across all
Sessions ever run is far shorter, around 1,500, but two Sessions that never
share a transcript cannot confuse anybody. v1's per-Run randomness had no such
bound at all. That is the price of an identifier a person can type.

Identifiers are longer. `run-k3f9-1` is eleven characters where `run-1` was
five. Every widget row, notice, and tool result carries the extra four.

Tests that pinned a literal identifier had to change, and the way they changed
is the more durable half of this ADR. Eight of them asserted values like
`run-2`; they now take an identifier apart and assert its *parts* through
`testing/identifiers.ts`. That file exists because the previous numbering
defect — a single counter shared by both kinds, so the first Run of every
Session was `run-2` — survived five tests that all agreed it was `run-2`. They
had been written by reading the output and pinning it, which pins a defect
exactly as readily as it pins a behaviour.

The wider lesson: **when a property is removed for a good reason, write down
what it was providing.** Sequential identifiers were adopted for readability
and the randomness they replaced was treated as incidental. It was load-bearing,
and the load only became visible when the product was used across a restart.
