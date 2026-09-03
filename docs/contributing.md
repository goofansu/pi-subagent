# Contributing

**What this is:** the rules a change has to satisfy, and why each exists. Read
[the architecture note](architecture.md) first; this document assumes it.

**The gate:** `npm run check`. One typecheck, lint, one test lane, the shared
conformance suite, and the pinned protocol check. It must pass before a commit.

---

## The invariants a change may not break

These outlive whatever plan you are working from. Each is enforced by something
in `check`, so breaking one is a failing test rather than a review comment.

1. **A Subagent is a stable logical specialist; a Run is one unit of work.**
   Every admitted `start` or `resume` creates a new Run; a rejected operation
   allocates none and never reuses an identifier.
2. **One Subagent owns at most one active Run.**
3. **A BackendAgent owns retained native conversation resources**, for its
   Subagent's whole life.
4. **Provider wire objects never cross the adapter boundary.**
5. **Backends never mutate central Run state.** They emit observations.
6. **Semantic observations are ordered and lossless within a Run.**
7. **A Run settles exactly once**, and a Result cannot become ready before the
   Run Scope's finalizers finish.
8. **Late native events cannot mutate a terminal Run.**
9. **Notification failure cannot change or lose a stored Result.**
10. **Closing the Session Scope releases everything beneath it.**
11. **Every queue, projection, transcript, diagnostic, and Result store has an
    explicit bound**, and every bound either truncates *and records it* or
    refuses with a typed outcome.
12. **Once shutdown begins, new work is rejected**, and shutdown is idempotent.
13. **Aborting a caller waiting in `agent_wait` stops only that waiter.**

## The simplification rule

**A change is a simplification only if it removes a concept, or a reason for
unrelated files to change together, without weakening an existing invariant.
Moving correctness from a test into a comment is not a simplification.**

The rule exists because a simplification is the one kind of change whose
failure mode is invisible. A feature that breaks an invariant fails a test. A
simplification that weakens one can pass every test by deleting the test, or
by moving the property from a check into a comment, and look tidier
afterwards.

So the reviewer's question on such a change is: **which test enforces this
property now?** If the answer is a comment, the change is not done. A rename is
a simplification when its test diff is the rename itself and any new fence; an
extraction is one when the existing tests pass unmodified, because a test that
had to change means the behaviour changed.

[The invariant freeze](v2-simplify/freeze.md) is the list of properties this
applies to and what enforces each today. It is in force for the whole
simplification programme, and its rows do not lift when the programme ends —
they are the architecture, and the invariants above carry them.

## The boundary rules

Twenty of them, in `extensions/subagent/boundaries.test.ts`. They are listed
with what each guards in [the architecture note](architecture.md#10-the-boundary-rules).

**The test for whether a new rule belongs there** is not "is this tidy" but
"what breaks if this edge exists". A rule whose answer is "nothing, it would
just be ugly" is a review comment, not a fence.

**A rule must prove its negative case.** The checker runs against disposable
fixture trees where each rule is violated on purpose, so "this rule would catch
that" is asserted rather than assumed. If you add a rule, add its fixture.

**If a rule is in your way, say which property you are giving up.** Three rules
were deleted at M7 and the reason is recorded: each guarded "a rewrite must not
inherit the machinery it replaces", and there was no longer anything to inherit
from. That is what a good reason looks like. "It is inconvenient" is not one.

Two rules changed vehicle rather than dying: the dynamic-import and
comment-parsing tests used a since-deleted edge to demonstrate against and were
re-aimed at a rule that still exists. Prefer that to deletion when the property
is still worth having.

## Adding a backend

A fourth backend is a plausible thing to want. What it owes:

1. **A directory under `backend/`,** with everything the provider knows
   confined to it. The boundary test needs a new confinement rule in both
   directions: nothing outside the composition root imports the directory, and
   the provider's SDK and vocabulary are named nowhere else. Add the rule *and*
   its fixture.
2. **The shared conformance suite.** Thirty-seven scenarios in five sections,
   run against your adapter through its own rig. **The only permitted skip is
   one a declared capability drives** — if `steer` is `false`, the steering
   scenarios skip because the capability says so, not because the adapter is
   incomplete. A skip for any other reason is a backend that is not done.
3. **A live lane**: a runtime gate over the adapter, and a host gate through
   the surface a user has. Both print an exact success marker, both read every
   probe after the Session Scope has closed, and both stay out of `check`.
4. **A native probe.** What your provider's own handles are, so a leak names
   your adapter rather than the core.
5. **Compatibility-matrix cells.** One column per backend, and every cell cites
   a test that exists.

What it must **not** ask for, and the reason this list is short:

- a Run phase of its own;
- a field on the Run snapshot or the projection;
- an opaque payload the core carries but does not understand;
- prompt construction, a tool system, or a retry policy above the seam;
- a change to the generic Run lifecycle.

**If your backend needs the Run lifecycle to change, the seam is wrong.** Stop
and repair the abstraction first. That is the program-level signal the whole
migration was measured by: Claude and Codex were ported through adapter-local
work plus new conformance fixtures, and a backend that could not be would mean
the seam had stopped being a seam.

## No real time passes in a test

Sleep-based timing is not proof of race correctness. A test that waits 50ms and
hopes passes on a fast machine, fails in CI, and teaches nothing when it does.

- **Timers are forbidden in `extensions/subagent/`** — `setTimeout`,
  `setInterval`, `setImmediate`, `node:timers`. A timer is the one thing no
  clock can replace, so a timer there is a delay a test could never control.
- **A test that sleeps must supply `TestClock`.** Production code may sleep
  against the runtime `Clock`, which is exactly the thing a test replaces;
  forbidding that would push the delay somewhere a test clock could not reach.
- **Wait on a `Deferred` the test completes**, a counter, or a bounded spin —
  not on a duration.

`timing.test.ts` is the lint, and it scans the extension tree.

**`scripts/` is outside it, and that is deliberate rather than an oversight.**
The credentialed live gates drive real processes against real providers with no
clock to substitute: a `codex app-server` that wedges, a provider that never
answers, and an operator who has walked away from a coexistence prompt are all
bounded by wall-clock time or not at all. Those bounds are `setTimeout`, they
are the gates' outermost guarantee, and a gate with no deadline is a gate that
hangs CI. What is *not* allowed there either is a sleep used as proof — a live
gate waits on a marker, an exit code, or a probe, never on "long enough".

## Tests

**Test at seams.** A seam is the public boundary where behaviour is observable
without reaching inside. The ones that exist:

| Seam | What it is for |
| --- | --- |
| the pure domain | reducers, arbitration, bounding — a function of its arguments |
| the supervisor through the Session rig | lifecycle, races, backpressure, faults, leaks |
| the shared conformance suite | every backend answering the same questions |
| the stand-in host | what a user would see, through the real handlers |
| the boundary test | what may name what |
| the live gates | a real provider |

**Every test that builds a Session reads the probe after it closes.** The rig
does it for the caller, so forgetting is the only way to have a leak go
unnoticed.

**An expected value comes from an independent source**, not from recomputing
what the code does. A golden test is only as good as the first output somebody
actually read; where a value has a *rule* behind it, assert the rule. That
lesson was learned the hard way — see
[the M4 live findings](v2/m4-live-findings.md).

**A counter that should rise is asserted to rise.** A bound nobody reached is a
bound the test did not exercise, and the assertion about it is then about
nothing.

## Architecture decisions

An ADR is required for: a new generic runtime abstraction, a change to any
invariant above, a new dependency, a change to what crosses the backend
contract, and any relaxation of a boundary rule.

- Numbered sequentially in `docs/adr/`, and **never rewritten**. A decision that
  is superseded gains a status note pointing at the one that replaced it; the
  original text stays, because the reason it was decided is part of the record.
- Say what was **rejected** and what the decision **costs**. An ADR listing
  only the choice made is a description, not a decision.
- **Every new runtime abstraction must name what it removes.** That is the rule
  the migration's risk register put first: the failure mode is the old
  architecture reappearing in new clothes, and its early signal is maps, flags,
  `Promise.race`, or `AbortController` turning up in generic runtime code.

## The architecture challenge gate

**A standing rule, not a migration one.** It applies to a change that **adds an
abstraction to, or changes a decision in**, generic runtime code — the
supervisor, the repository, the store, delivery, the contract, the domain.
Answer three questions, in the commit message or in an ADR:

1. **What does this delete?** A new abstraction that removes nothing is an
   addition, and additions accumulate.
2. **Is it provider-neutral?** Prove it with the fakes and the shared suite. A
   thing only one backend needs belongs in that backend's adapter.
3. **What breaks if it is wrong?** If the answer is "a Run settles twice" or "a
   Result is lost", it needs a test before it needs a review.

A change that cannot answer them is a change to an adapter, to presentation, or
to the host — which is where most changes belong.

**What the gate is not for.** A fix that restores behaviour the compatibility
matrix already promises is not a decision, and three questions about it would
be three answers of "nothing, yes, it is already broken". Such a fix owes
something else instead, and it is not lighter: **name the matrix cell it
restores, or the presentation-ledger entry that classified it, and add the test
that holds it.** A fix with no cell and no entry is not a fix — it is a change
of behaviour wearing a fix's clothes, and it needs the three questions after
all.

## Vocabulary

**One product, one set of words.** [`CONTEXT.md`](../CONTEXT.md) is the
glossary and it is load-bearing: code using a different word for the same thing
is a bug in the naming, not a synonym.

The legacy Profile field name from 1.x may not appear anywhere in the extension
tree, in a file of any kind. The boundary test enforces it, and its job is
keeping the product's vocabulary singular rather than keeping a deleted
implementation's word out. `AgentHarness` is the one reserved compound, because
it is Pi's own native abstraction. Documentation outside the tree may name the
old field when describing history or the migration.

## Commits

- The gate passes.
- One change per commit, and the message says **why** rather than restating the
  diff.
- A commit that fixes a defect names the test that now covers it.
- A commit that changes user-visible text says which compatibility-matrix cell
  it affects.
