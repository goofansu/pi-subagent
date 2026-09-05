# 33. Delivery says "handed off", every notice points at its Result, and the Run label is bounded

Date: 2026-09-03

## Status

Accepted. Three decisions about notification semantics, taken together because
they are the same argument applied to a state name, a sentence, and a bound. It refines
[ADR-0006](0006-completion-notifications-and-result-store.md) — which decided
that storage precedes notification and that a notice points at
`agent_result` — and leaves everything it decided in force.

**Amended in one respect by
[ADR-0035](0035-completion-hand-off-resolves-on-landing-or-consumption.md),
accepted at the Phase C gate.** The availability vocabulary this entry decided
— `full` / `partial` / `metadata-only`, with `full` for every completed Run —
is renamed to `complete` / `partial` / `record-only` and derived from the
Result's output rather than from its status alone, and the three pointer
sentences change with it. The reason is recorded there: "full result" tells a
model an answer is waiting, and for a completed Run with no output there is
none. Everything else this entry decided — that only the Session push sink may
say whether a notice landed, that every terminal notice carries a pointer with
the exact argument shape, and that the Run label is bounded at admission —
stands. The text below is what was decided on 2026-09-03 and is not rewritten.

## Context

Three things were wrong at once, and only one of them was a bug.

**The delivery module's words disagreed with its reliability model.**
`CompletionDelivery` kept a set called `delivered`, documented as "ids that
actually landed", and named the local that received a push result `landed`.
The behaviour was correct: delivery stores the Result first, so a push that
fails cannot have lost anything, and delivery is done when the host accepts
the message. But only the Session push sink sees `message_start`, so only the
sink can know whether anything reached the conversation. A reader of the
delivery module would eventually conclude that an accepted push means the
model has the notice, and act on that.

**A cancelled notice had no pointer.** The golden's own comment said the model
already knows the id it cancelled. A timeout cancels, and so does a shutdown,
and the parent asked for neither — and a cancelled Run keeps whatever output
it produced before it stopped. So the model most in need of the pointer was
the one that did not get it.

**The Run's description had no bound.** It is identity, so Result bounding
never removes it: identity, status, and timestamps are what a Result must
still be able to say after every removable section is cut. That made the
description the one input a model could use to carry a Result past its byte
target with nothing left to cut, and the one input that could make the push
sink retain an unbounded value while a notice waited to land. Ten kilobytes of
pasted brief in the `description` field is not a hostile act; it is what a
model does when the schema does not say otherwise.

## Decision

**One. Delivery knows pending, handed off, and exhausted, and says so.**
`DeliveryState.delivered` becomes `handedOff`, `delivered()` becomes
`handedOff()`, and *handed off* means the host accepted the message and now
holds it. `exhausted()` is unchanged. The push sink's `hasLanded`, `landed()`,
`unlanded()`, and `onLanding` are unchanged; the sink is the one owner of the
word. Boundary rule 19 forbids any inflection of *land* in
`runtime/delivery.ts` and its test, with a negative fixture that fails the
checker on purpose and a positive one proving the rule does not fire on the
vocabulary that replaced it. `CONTEXT.md` defines all four terms — handed off,
landed, lost after hand-off, exhausted — each naming the one component that
decides it.

**Two. Every terminal notice ends with the availability and the exact call.**
The notice carries `resultAvailability`: `full` when the status is completed,
`partial` when failed or cancelled with a non-empty final output or a
non-empty transcript, `metadata-only` otherwise. The pointer is a *section* of
the text rather than something each status branch appends, so no status can be
the one that forgets it, and it spells the argument shape —
`Call agent_result with {"id":"run-1"}.` — so the parent copies rather than
composes. Availability describes the stored Result and not the Run's success:
a completed Run whose output was cut by bounding is still `full`, because the
Result is the whole of what was stored and its truncation record says what
went.

**Three. The Run label is bounded once, at admission, and recorded when
shortened.** `RUN_LABEL_MAX_BYTES` is 200. The description a model passes to
`agent_start` or `agent_resume` is collapsed to one line, trimmed, and cut on
a character boundary where a tool input becomes a supervisor request — the
last point before a Run exists. A shortened label produces a Run diagnostic
saying so and by how many bytes, which travels with the request and reaches
the projection through the same observation intake every other diagnostic
uses. Both tool schemas state the bound and what happens past it. This is the
truncate-and-record branch of contributing invariant 11.

## Alternatives rejected

**Rename landing rather than hand-off — let delivery keep the word and make
the sink say something else.** Backwards. The sink's vocabulary is the one
that is correct: `message_start` is a landing, and the sink is where it is
observed. Delivery is the module that cannot see it.

**A comment instead of a boundary rule.** The vocabulary already had a comment
— "ids that actually landed" — and the comment is what taught the wrong
reading. A rule with a fixture is a failing test; a comment is a hope.

**Leave the cancelled notice terse and put the pointer in the tool
description.** That is where it was, and it made the model responsible for
knowing which statuses keep output. The one behaviourally observable change in
this phase is that a cancelled notice gains a pointer, and it is the change
most worth making.

**Add availability to the tool result rather than the notice.** The notice is
the value a model reads without asking for anything. A model that has to call
`agent_result` to learn whether calling `agent_result` is worthwhile has
learned nothing.

**Refuse a start whose description is too long.** Rejected explicitly. A
label is orientation; refusing the call would cost the model a round trip and
buy no safety, and contributing invariant 11's first branch — truncate and
record — is the right one here. ADR-0032 made the same call for a store
reservation, for the same reason: a refusal that the caller can do nothing
useful about is a stall.

**Bound the label at settlement, with Result bounding.** Impossible by
construction: bounding may never remove identity, and the label *is* identity.
Bounding it there would mean a Result that cannot say which Run it belongs to.

**Bound it in the domain's `toRunResult` instead of at admission.** Later than
necessary. The repository's published index, the widget's activity tail, and
the tool response all show the description before any Result exists, and each
would have to bound it again. Bounding once at admission means every surface
downstream is reading the same string. The notice's derivation applies the
one-line bound a second time anyway, so the invariant does not depend on a
call site having remembered it.

## Consequences

**What it costs.** The label bound is the expensive part: five production
modules, two of them generic, because a bound on caller-supplied input is
declared in the domain, applied in the façade, and carried through the
supervisor to reach the Run's diagnostics. That was recorded as a finding at
the time, with a request that a later gate give this shape of change a target
of its own. A model that pastes a paragraph into `description` now gets a Run
whose label is one line and whose Result says the label was shortened; a model
that reads the schema does not do it at all.

The universal pointer adds two sentences to every notice, including the terse
cancelled one. That is the trade for a parent that never has to remember which
statuses keep output.

**What it does not change.** Storage still precedes notification, and delivery
still reconstructs the notice from the stored Result. Delivery's pin is still
released on hand-off rather than on landing; a consumption lease through
landing is a Phase D question and needs evidence from real use. The retry budget, the
recovery sweep, the atomic Run-id claim, and re-pushing a lost notice once on
settle are all unchanged. One landing per Notification is still the sink's
contract. The preview and error bounds are still 500 bytes each. No Run
lifecycle behaviour moved: the conformance scenarios
`a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` pass unmodified.

**The architecture challenge gate**, the four questions a structural change
has to answer:

- *What does this delete?* Two structural branches from the notification
  formatter, the Result's whole `UsageSnapshot` and its backend identity from
  the notice, and a word from the delivery module. It adds one bound and one
  domain field, and both replace something: the bound replaces an unbounded
  identity field, and `resultAvailability` replaces the model's obligation to
  remember which statuses keep output.
- *Is it provider-neutral?* Yes, and more so than before. The notice has no
  field a backend identity could travel in, so the three-backend golden proves
  a property the type also guarantees.
- *What breaks if it is wrong?* A model is pointed at a Result that is not
  there, or is told a Result is full when it is partial. Both are read off the
  stored Result by one function with a golden per availability, and the pointer
  cannot be omitted by a status branch because it is not in one.

**Proof.**

| Decision | Proof |
| --- | --- |
| Delivery says "handed off" | boundary rule 19 with both fixtures: `the delivery module saying "landed" is rejected, and the push sink saying it is not`, `delivery's own three states are not landing vocabulary` (`boundaries.test.ts`); `runtime/delivery.test.ts` unchanged apart from the rename |
| Every notice points at its Result | `N-1` … `N-7`, `every terminal status ends with the availability sentence and the exact call`, `the pointer says how much is there for each of the three availabilities`, `availability describes the stored Result rather than the Run's success` (`presentation/notification-text.test.ts`) |
| The label is bounded and recorded | `a label past its byte bound is collapsed to one line, cut, and recorded`, `a label within its bound is stored whole and records nothing`, `a maximal label leaves a result inside its byte budget once everything removable is cut` (`runtime/bounds.test.ts`); `T1: the label's bound is stated on both description fields` (`host/tool-schemas.test.ts`) |
| No lifecycle behaviour moved | conformance `a-notification-follows-storage`, `a-notification-retry-cannot-duplicate-or-alter-settlement`, and every lane under `runtime/` passing unmodified apart from the rename and the new bounds tests |
