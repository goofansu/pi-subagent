# 35. A completion hand-off resolves on landing or consumption

Date: 2026-09-04

## Status

**Proposed**, before the first Phase C3 commit, which is
[the roadmap's](../v2-simplify/roadmap.md) discipline and the lesson
[the Phase A gate](../v2-simplify/phase-a-exit-gate.md) recorded: a programme
whose premise is deciding before coding writes its ADR first.

**Accepted** in the commit that closes
[the Phase C gate](../v2-simplify/phase-c-exit-gate.md) — the commit carrying
this entry. The acceptance criterion stated in *Acceptance* below is met: the
gate's items 6, 7, 8 and 13 read PASS, and the conformance scenarios
`a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` pass unchanged.
`npm run check` is green.

**One reading recorded at the gate.** The ledger's W-2 after column puts
`completed · notification failed` in the *status* position, which is where a
settled row prints its duration, so on that one row the duration gives way to
the explanation. Every other settled row is unchanged (W-1). The ledger's W-2
entry carries the reasoning.

Everything from *Context* down is the text that was proposed, unchanged.

Refines [ADR-0006](0006-completion-notifications-and-result-store.md), which
decided that storage precedes notification and that a notice points at
`agent_result`; both stay in force. **Amends
[ADR-0033](0033-notification-vocabulary-pointer-and-label-bound.md)** in one
respect, recorded in *The availability vocabulary (A8)* below: the three
availability values it named are renamed and their derivation changed.
ADR-0033 carries a status note pointing here; its text is otherwise untouched.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — the Result
  is stored before it is announced, and `agent_result` is authoritative. A
  hand-off that resolves without a landing changes nothing about either.
- [ADR-0033](0033-notification-vocabulary-pointer-and-label-bound.md) — only
  the Session push sink may say whether a notice landed. *Consumed* is the
  second word with that property, and the same fence carries it.
- [ADR-0034](0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)
  — the admission lease, whose release becomes a Scope finalizer in the same
  phase (C1) and which this decision does not touch.

## Context

A completion notice exists to make a parent model fetch a Result. A parent
that fetches the Result the moment its Run settles has done everything the
notice exists to make it do, and the runtime does not notice.

Three things follow from that, and all three are visible.

**The widget row has one exit.** A settled Run's row lasts until its
completion notice lands. A parent that called `agent_result` at once still
sees the row wait for a landing that tells it nothing it does not already
know.

**A read notice is re-pushed.** A notice handed to Pi and then discarded by an
aborted turn is pushed again when the parent settles. If the parent read the
Result in between, it is re-oriented toward work it has finished with.

**A settled row cannot say why it will not leave.** When delivery exhausts its
retry budget nothing lands, ever, and the row sits with no explanation. The
widget's dependency is two functions about landing — `hasLanded` and
`onLanding` — and carrying a third state through it means a third function,
and then a fourth when somebody wants the attempt count.

### What Pi allows, stated as fact

While the parent is streaming, the sink's
`sendMessage(…, { deliverAs: "followUp", triggerTurn: true })` goes into Pi's
own follow-up queue: `AgentSession.sendCustomMessage` hands it to
`agent.followUp`. The extension API exposes `hasPendingMessages()` and
**nothing that removes one queued message**. `clearQueue()` exists on the
session object rather than on the extension API, and it would discard the
user's queued messages along with ours.

So a notice that has been handed off **will land**, whatever the parent does.
"The parent called `agent_result`, so the notification is suppressed" is
achievable only for a notice the host has not yet handed to Pi, and delivery
pushes at settlement — which makes that window milliseconds wide except after
a push failure or a lost hand-off. Widening it means the host holding notices
while the parent is active and handing them over at settle, which is Phase D's
envelope. This decision therefore resolves everything that is the host's to
resolve and counts what it cannot.

## Decision

> A terminal Run's hand-off is **unresolved** until its completion notice
> lands **or** its Result is retrieved with `agent_result`, whichever comes
> first. `agent_wait` resolves nothing.

**Consumed** is a fourth state of the Session push sink, recorded once, at the
host boundary, when the `agent_result` tool handler has returned a Result. It
does three things and nothing else:

- A push for a consumed Run is **accepted and not sent**. Delivery sees a
  hand-off, which is exactly what happened: the host accepted the message, and
  the host's acceptance includes deciding not to send it.
- A consumed notice **lost after hand-off is not re-pushed** at settle.
- A consumed notice Pi already holds **lands as usual**, is marked landed, and
  increments **consumed before landing** — the count Phase D's envelope is
  scheduled on.

`agent_wait` does not consume. It reports that a Run is terminal and
deliberately withholds the answer, so a parent waiting on a fan-out must still
be pointed at each Result.

**The widget reads one read model, with three states:**

```ts
interface CompletionHandoffView {
  status(runId: RunId): "pending" | "resolved" | "exhausted";
  subscribe(listener: () => void): () => void;
}
```

`resolved` is *landed or consumed*, and the widget cannot tell which. An
exhausted row reads `completed · notification failed` with the Run id and
`result available`; consuming that Result resolves it and the row goes.

**Delivery tells the sink when it gives up**, through one call added to the
`NotificationSink` interface and made in the branch that already counts
`deliveryFailures`. That is what gives the whole hand-off state one owner. It
adds a fact delivery already knows to an interface delivery already owns, and
delivery still never learns the words *landed* or *consumed*.

**Consumption is recorded in `host/tools.ts` and nowhere else**, through one
narrow function handed to tool registration — the way the widget is handed its
read model, and for the same reason: a component that could name the sink
could push a notification.

## What this removes

- **A row lifetime with one exit.** A settled row now leaves on landing *or*
  on retrieval, so the widget shows unresolved work rather than work the model
  has already read.
- **The re-push of a notice whose Result was already read.** The parent is not
  re-oriented toward finished work after an aborted turn.
- **A two-function widget boundary about to grow a third, fourth and fifth
  function.** `hasLanded` and `onLanding` become `status` and `subscribe`, and
  the exhausted state costs no further function — nor would an attempt count,
  because the widget would not be told one.

## What was rejected

- **Recording consumption in `Subagents.result`.** The application layer would
  then know that a host surface exists, which is the one thing the layering
  keeps it from knowing.
- **Recording it in `ResultStore.read`.** Delivery and diagnostics read the
  store too, so an internal read would suppress a notice nobody had read.
- **A fourth store pin.** Pins answer "may this output be evicted?";
  consumption answers "does the parent still need orienting?". They are
  different questions, and [the freeze](../v2-simplify/freeze.md) row F6 keeps
  the three named pin holders exactly three.
- **Consuming on `agent_wait`.** A parent that waits for a fan-out to finish
  would silence the very pointers it needs to read each Result.
- **Suppressing a notice Pi already holds.** There is no extension API for it;
  see *What Pi allows* above. Phase D's hold-while-active envelope is the
  design that could, and it waits on the count this phase produces.

## What it costs

- One more set and one more call at the tool boundary: the sink keeps a
  `consumed` set, and the `agent_result` handler calls one function.
- **Every `NotificationSink` gains `exhausted`.** That is a required method on
  an interface every test rig builds, so `testing/fake-sink.ts`,
  `testing/session-rig.ts`, the three backend rigs, `boundaries.test.ts`'s
  fixture, and `host/production-backends.test.ts` all gain it. All are test
  code.
- **A compatibility-matrix cell changes.** The widget's row-lifetime cell now
  reads "until its completion notice reaches the conversation or its Result is
  retrieved with `agent_result`, whichever comes first". That is a public
  contract changing, and it is why this is an ADR rather than a fix.
- One more state for a reader of the sink to hold: unlanded, lost, landed,
  exhausted, consumed. It is five states in one module rather than three in
  one and two in another, which is the trade being made.

## The architecture challenge gate

**What does this delete?** A row lifetime with one exit, a re-push of a notice
the parent has already acted on, and the third, fourth and fifth functions the
widget's landing boundary was going to grow. It also deletes an asymmetry: the
sink knew four things about a hand-off and delivery knew a fifth (exhaustion)
that nobody could display.

**Is it provider-neutral?** Yes, and structurally so. Everything decided here
lives in `host/` and in one method on the `NotificationSink` interface;
nothing in `backend/` is named, nothing a provider reports is read, and the
notice's text does not change. The three-backend golden that proves one
identical notice text is untouched.

**What breaks if it is wrong?** The worst case is a notice that is not sent
for a Run whose Result was never actually retrieved — the parent would then
have a stored Result it was never pointed at. That is why consumption is
recorded at exactly one place, on exactly one shape of response (a returned
Result), and why `host/tools.test.ts` asserts the absence on a rejection, on
an expired Result, and on `agent_wait`. Nothing here can lose or alter a
stored Result: delivery's relationship to the store is unchanged, and
contributing invariant 9 is enforced by the conformance scenarios
`a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement`, which this phase
does not touch.

## The availability vocabulary (A8)

The Phase A follow-up A8 lands in the same phase and **amends ADR-0033**, so
it is recorded here rather than left to a ticket.

`ResultAvailability` was `full` / `partial` / `metadata-only`, with `full` for
every completed Run whatever its output. A completed Run with nothing to show
therefore read `No output was produced.` in its body and then `Full result is
available.` in its pointer. The semantics were coherent — availability
describes the *stored Result*, not the Run's success — and the sentence
misleads a model, to whom "full result" means an answer is waiting.

The values become `complete` / `partial` / `record-only`, and the derivation
reads the output rather than the status alone, exactly as
[the notification semantics §3](../v2-simplify/notification-semantics.md#3-result-availability)
now says:

- `complete` — the status is `completed` and the final output is non-empty.
- `partial` — not `complete`, and there is a non-empty final output or a
  non-empty transcript.
- `record-only` — both are empty, whatever the status.

The three pointer sentences become semantics §5's, and the record-only
sentence owns "no output was produced" so that a completed Run with no output
says it once rather than twice. A completed Run whose output was cut by Result
bounding is still `complete`: the Result is the whole of what was stored, and
its own truncation record says what bounding removed.

ADR-0033's own text is not rewritten — an ADR never is — and it carries a
status note pointing at this entry.

## Acceptance

This ADR is accepted when the Phase C gate's items **6, 7, 8 and 13** read
PASS, and the conformance scenarios `a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` pass unchanged.
