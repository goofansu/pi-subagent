# 28. v2 backend contract

Date: 2026-09-02

## Status

**Stable** as of milestone M4 (2026-09-03). Accepted for the v2 tree at M1 and
written before any real adapter existed, so that the adapters at M4 through M6
would implement a decided contract rather than negotiate one.

Marking it stable is the roadmap's program-level health signal, and it is a
measurement rather than a decision: the first real backend was ported without
changing this contract. Not one member of `Backend`, `BackendAgent`,
`BackendCapabilities`, `RunInput`, `ExecutionIO`, `ControlFeed`, or
`TerminalBundle` was added, removed, or re-typed, and `contract.ts` and the
shape test that lists its members are byte-identical to what M1 wrote.

One thing that flows *through* the contract did widen, and it is worth naming
rather than hiding behind the sentence above: the domain's `MessageRole` gained
`tool`, so the `message` observation and the `TranscriptItem` that `emit` and
`TerminalBundle` carry can now hold one more role than they could. That is a
domain change, not a contract change — no declaration here mentions it, and no
adapter has to do anything differently for it — but a reader checking "did
anything an adapter sees change" deserves to be told yes, this.

The four changes M4 made outside the Pi adapter are enumerated and classified
in
[the M4 exit gate](../v2/m4-exit-gate.md#13-every-change-m4-made-outside-the-pi-adapter-directory);
all four are missing provider-neutral semantics with fake-backend proofs, and
none is provider leakage.

**M5 held it a second time** (2026-09-03), and this is the stronger reading of
the same measurement. Claude is the backend this contract was most carefully
shaped around and had never been tested against: a BackendAgent that begins
holding no provider identity, a provider result frame that is a Turn boundary
rather than settlement, a per-model usage map that includes models the Profile
never asked for, and a cancelled Run that can legitimately end with zero
observations. All four fit, and `contract.ts` is still byte-identical to what
M1 wrote. Nothing flowing through the contract widened either — `MessageRole`
was M4's one such change and there was no second. The three provider-neutral
changes M5 made outside `backend/claude/`, and the one shared conformance check
it loosened, are enumerated in
[the M5 exit gate](../v2/m5-exit-gate.md#11-every-change-m5-made-outside-the-claude-adapter-directory).

Stable means a change here is now a decision with a cost rather than a detail.
If Claude at M5 or Codex at M6 needs one, the roadmap's rule applies: it is an
exit-gate finding to be classified before it is made, and a contract that
changes for each backend is the signal to pause the port and repair the
abstraction.

Carries forward:

- [ADR-0007](0007-harness-seam-with-neutral-facts.md) — only a neutral
  vocabulary crosses the adapter boundary, and provider wire objects never do.
  v2 keeps this and renames Facts to observations. The contract's only
  observation type is the domain's `RunObservation`.
- [ADR-0014](0014-controlled-agent-resume.md) — the prepared adapter is
  retained across Runs, resume reuses it, and the resume decision is
  synchronous, provider-I/O-free, and has exactly three outcomes. v2 keeps all
  four properties; `admitResume` is that decision.
- [ADR-0019](0019-backend-neutral-managed-release.md) — capabilities are
  declared per prepared execution, close is idempotent, and the shared
  conformance surface is what enforces both. v2 declares capabilities on the
  opened BackendAgent instead of per Run, which is stricter, and keeps
  idempotent close and the conformance surface.
- [ADR-0021](0021-retained-ephemeral-codex-conversation.md) — the retained
  native conversation belongs to the Subagent rather than the Run. That is what
  makes `BackendAgent` a Subagent-scoped interface with `execute` nested inside
  it.
- [ADR-0023](0023-v2-scope-ownership.md) — the Session → Subagent → Run →
  native execution hierarchy, and the four exceptions the backend spikes found.
  The contract is the hierarchy expressed in three interfaces.
- [ADR-0025](0025-v2-terminal-settlement.md) — a Run settles exactly once, the
  core performs the terminal transition, and an adapter with no terminal
  snapshot does not fabricate one. `TerminalBundle` is a report, not a
  settlement.
- [ADR-0026](0026-v2-control-admission.md) — Controls are delivered serially in
  admission order, closure rejects new ones, and local acceptance never implies
  provider confirmation. `ControlFeed` is the delivery half of that.

This ADR supersedes nothing. It is the v2 replacement for v1's backend-seam
contract module, which is deleted with v1 at M7.

Uses the vocabulary of [ADR-0022](0022-v2-terminology-and-backend-field.md).

## Context

v1's backend seam is one interface with a factory, a prepared adapter, and a
per-Run executor. It works, but it says nothing about lifetime: what closes the
retained conversation, and when, is a closed flag plus a hand-ordered shutdown
in three modules. Every new backend re-derives that ordering, and the type
system does not help.

M1 has to define the contract before the Effect supervisor exists, because the
supervisor is what will be written *against* it. The question this ADR settles
is not what the members are — the milestone plan lists them — but why the
contract is Effect-typed at all when the domain beside it imports nothing.

## Decision

### Three interfaces, one per lifetime

```
Backend           session-long   id, validateProfile, open
└── BackendAgent  Subagent       capabilities, admitResume, execute, close
    └── execute   one Run        yields a TerminalBundle
```

- **`Backend`** is built once when the Session opens. `validateProfile` is
  deterministic and total: the same Profile always yields the same diagnostics,
  and it never throws. `open` acquires a `BackendAgent` into the caller's
  scope, creates no Run, and emits no observation.
- **`BackendAgent`** owns the retained native conversation, session, or
  process. It declares `capabilities` — `resume`, `steer`,
  `terminalTranscriptSnapshot` — when it is opened, so the core can answer
  `unsupported` without calling the backend at all. `admitResume` is a plain
  synchronous function with exactly three outcomes: `admitted`, `unsupported`,
  or `conversation lost`. `close` is idempotent.
- **`execute`** runs exactly one execution. It receives a `RunInput` and an
  `ExecutionIO` — an `emit` sink and a serial `controls` feed — and resolves to
  a `TerminalBundle` of an ending plus an optional reconciliation.

A BackendAgent may begin life **unopened** in the provider sense, holding no
provider identity and acquiring one as a side effect of its first Run. That is
ADR-0023's exception 1, and it is a normal state rather than a degraded one: a
Subagent whose first Run never produced an identity reports
`conversation lost`, which is why there is no fourth admission outcome.

### The contract is Effect-typed; the domain is not

The domain module is plain TypeScript and imports nothing. This module imports
`effect`. The line between them is not a compromise, it is the subject matter:

- What the **domain** is about is meaning. A phase, an observation, a fold, a
  usage rule, and a result have no lifetime, so nothing about them needs a
  runtime to express. Keeping the runtime out is what makes the reducer
  testable as a function and reviewable as data.
- What the **contract** is about is lifetime. Who owns the native handle, when
  it is released, what happens to an execution when a Run is cancelled — those
  are exactly the facts `Scope` and interruption encode in a type. Writing them
  in plain TypeScript would mean writing them in comments.

So `open` and `execute` both require a `Scope` in their environment, and
releasing the scope that opened a BackendAgent closes it. The nesting is
structural rather than remembered: a Run cannot leak its native execution,
because the execution was acquired in a scope that closes when the Run settles.

### Two deliberate absences

**No cancellation object.** An execution is cancelled by Effect interrupting
its fiber. An adapter observes that through interruption handling and is never
handed a signal to poll. The v2 boundary test forbids the two signal type names
and `Effect.runPromise` in the domain and backend modules, so mechanism
vocabulary stays at the host boundary and in tests.

**No error channel on an execution.** `execute` cannot fail. A backend failure
is a `failed` ending, because the core — not the adapter — decides when a Run
is terminal and what its result says. An adapter that fails its Effect anyway,
or dies, is classified by the caller as failed with a `backend-failure`
diagnostic and its partial observations retained: the driver does that in M1
and the supervisor does it in M2. **This half still stands.**

> **Amended by [ADR-0030](0030-v2-backend-open-failure.md) at M2.** The
> paragraph below deferred a failure channel on `open`, and the deferral did
> not survive contact with operation semantics section 1: reporting a failed
> open through a Run's `failed` ending means publishing a public Run, storing a
> Result, and sending a Notification for work that never began. `open` now
> returns an Effect that may fail with `BackendOpenFailure`, carrying one
> redacted diagnostic and nothing else, and `StartOutcome` gained `backend
> unavailable`. An **execution** still has no error channel.

`open` has no failure channel either, which is the narrower of the two
decisions. A backend whose provider I/O fails while opening reports it through
its first execution's `failed` ending, which the unopened-BackendAgent state
already makes natural. If an adapter at M4 turns out to need a typed failure at
open, adding one is a visible contract change that the shape test catches.

### The shape is pinned

The member names of all three interfaces, of `TerminalBundle`, `RunInput`,
`ExecutionIO`, and `ControlFeed`, and the three resume admissions are exported
as data, and a shape test asserts the interfaces against them at compile time.
Four kinds of vocabulary are named as forbidden in that test because they are
the four that would actually try to get in: attempt vocabulary, continuation
tokens, a cancellation signal object, and provider control types.

## Consequences

Adding a member to this contract is now expensive on purpose. One more member
is one more thing three adapters must implement, and the shape test makes the
cost visible at the moment it is proposed rather than at the moment the third
adapter is ported.

Because capabilities are declared on the opened BackendAgent rather than per
Run, a backend cannot become steerable partway through a Subagent's life. No
backend the spikes examined does that, and the stricter shape lets the core
answer `unsupported` without any provider round trip.

Because an execution cannot fail its Effect, an adapter author has to remember
that a thrown error is a *defect* rather than a failure, and defects are
classified as failed by the caller. That is a slightly surprising rule for
someone used to Effect's error channel, and it is the price of the core owning
settlement.

The Effect-typed contract means the domain and the backend module cannot be
merged later without one of them changing character. That is the intended
shape: the seam between "what the product means" and "what a resource costs" is
the seam this whole rewrite exists to draw.
