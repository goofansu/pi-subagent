# 36. A wait delivers the Result it waited for

Date: 2026-09-05

## Status

Accepted.

Refines [ADR-0006](0006-completion-notifications-and-result-store.md), which
decided that storage precedes notification, that a notice is orientation and
the Result store is authoritative; both stay in force. **Amends
[ADR-0035](0035-completion-hand-off-resolves-on-landing-or-consumption.md)** in
one respect: the sentence "`agent_wait` resolves nothing" no longer holds. A
wait now delivers the Result and resolves the hand-off, and ADR-0035's rejected
alternative *Consuming on `agent_wait`* is adopted for the reason it was
rejected — the objection was that a wait withheld the answer, and it no longer
does. ADR-0035 carries a status note pointing here; its text is otherwise
untouched.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — the Result
  is stored before it is announced, and `agent_result` is authoritative. A wait
  reads the same stored value and changes neither.
- [ADR-0033](0033-notification-vocabulary-pointer-and-label-bound.md) — only
  the Session push sink may say whether a notice landed or was consumed. The
  hold decided here is a third word with that property, and it lives in the
  same module.
- [ADR-0035](0035-completion-hand-off-resolves-on-landing-or-consumption.md) —
  consumption is recorded at the host boundary, in the tool handlers, through
  one narrow interface, and nowhere else.

## Context

The tools taught the model a five-step dance for a one-step question.

1. `agent_start` returned ids and said a notification would arrive.
2. The model called `agent_wait`, which blocked the turn and returned
   *identity and status, never output*.
3. The model then called `agent_result` for the output it had just waited
   for.
4. The completion notice arrived anyway, pointing at the Result the model
   already had.

Step 2 was the surprising one to watch: the copy told the model to wait
"whenever the Run's answer is the only thing left to do", and a model reading
that mid-task concluded the answer was always the only thing left to do. Step
4 was the visible cost: ADR-0035 counted it as *consumed before landing* and
scheduled a hold-while-active envelope on the count. And there was no barrier
tool at all — a model that had started four Runs had to spell out four ids to
wait for them.

Three things were wrong, and they are one decision.

**The wait withheld the answer it had just waited for.** ADR-0002 made
`agent_wait` "not a pull mechanism" so the delivery invariant had one path;
ADR-0006 then added `agent_result`, and the wait kept its lifecycle-only shape
without anyone deciding it should. A wait that returns status forces a second
call for the output, and the notice that follows is a third telling.

**The copy described the mechanism rather than the model.** Every sentence a
model reads about waiting was about *when to wait*. None said the one thing
that decides the default: a completion is delivered on its own, so the
parent's default is other work.

**Delivery pushes at the same instant a waiter is woken.** `run-scope.ts`
publishes the terminal snapshot, forks delivery, and succeeds the completion
`Deferred`, in that order and without awaiting the push. A notice therefore
reaches Pi's follow-up queue before a blocked wait returns, and the extension
API has no call that takes a queued message back (ADR-0035, *What Pi allows*).
Consuming on wait alone would have turned every waited Run into a *consumed
before landing* and suppressed nothing.

## Decision

> A wait delivers the Result of every Run it waited for, in the text
> `agent_result` returns, and resolves those hand-offs. While a wait covers a
> Run, the host holds that Run's notice rather than handing it to Pi; when the
> wait ends, a held notice whose Result the wait delivered is dropped, and any
> other is handed over as it would have been.

**`agent_wait` returns the Result.** The `terminal` wait outcome carries the
stored `RunResult` when the store still holds it, read under the waiters' pin
before the registration is released — which is what contributing invariant 13
always said the pin was for. The text renders each Result as the RunCard, so a
wait over three Runs reads as three `agent_result` answers. An evicted output
leaves the field absent: the Run is named by agent and status and told its
output is gone, exactly as `agent_result` says `ResultExpired`. The outcome
name list does not change.

**`agent_wait_all` is the seventh tool.** It names no Run. It covers every Run
of the Session that is active when it is called, and delivers their Results
the same way. Runs that had already finished are not repeated — their notices
were handed to Pi, or landed, or their Results were read — and when nothing is
active it says so and says where the answers went. It shares one
implementation with `agent_wait` from the id list onward.

**The push sink holds while a wait covers a Run.** The wait handlers tell the
sink which Runs they are about to wait on — an id list for `agent_wait`, `all`
for `agent_wait_all`, whose ids are read off the index inside the façade —
*before* they start waiting, and release the hold however the wait ends. A
push for a held Run is **accepted and kept** in the sink: delivery sees a
hand-off, which is what happened. At release each kept notice goes one of two
ways. The wait delivered its Result, so the handler recorded it consumed
before releasing, and the notice is dropped as **answered by the wait**. Or
the wait gave up — a timeout, an abort, or an evicted output — and the notice
is handed to Pi now, exactly as it would have been at settle.

A held notice is *unresolved*, which is what earns holding its place under the
sink's own rule for adding a state: it is a way an unresolved hand-off can
become resolved without a landing. Two counts are added, `heldForWait` and
`answeredByWait`, and their difference is how many holds ended in a hand-over
after all.

**The copy states the delivery model once and quotes it.** One paragraph,
`DELIVERY_MODEL`, appears in `agent_start`'s description and in both waits':

> A Run's completion or failure is delivered to you automatically once it
> reaches a final status: if you are mid-turn it is queued and arrives when
> the turn ends; if you are idle it starts a new turn. Continue independent
> work instead of waiting. Use `agent_wait` or `agent_wait_all` only when your
> next action depends on those answers and no useful work remains meanwhile;
> an active wait receives the results directly, with no duplicate notification
> afterwards.

It is in the start description because that is where a model decides what to
do next; a guideline about waiting that is read only once a wait is already
being considered arrives too late to change the decision.

**Consumption is recorded in `host/tools.ts` and nowhere else**, as before.
The one narrow function ADR-0035 handed to tool registration becomes a
two-function interface, `ResultHandoff`: `consumed(id)` and
`hold(scope) → release`. Neither can push. The façade still does not know a
host surface exists: the wait handlers read the Runs whose Result was
delivered off the same `details.runs` shape the `agent_result` handler already
reads, which the façade builds for the collapsed transcript line.

## Alternatives considered

- **Consume on wait without holding.** Turns every waited Run into a *consumed
  before landing* and suppresses nothing, for the ordering reason in
  *Context*. This is the alternative that would have looked done and was not.
- **The hold-while-active envelope, Phase D as scheduled.** Hold every notice
  while the parent is mid-turn and flush at turn end. It is the more general
  mechanism and it is still available; this decision does not preclude it. It
  was not taken here because it changes the timing of every notice, waited or
  not, and the count it was scheduled on has not been read yet. Holding while
  *waited* is the narrow case the copy actually promises.
- **Put the whole Result in the notice.** ADR-0006 rejected it for context
  cost on fan-outs and that reasoning stands. A wait is the parent asking for
  the answer; a notice is the runtime offering it.
- **Have `agent_wait_all` include already-finished Runs.** Their notices are
  Pi's, and a notice Pi holds lands whatever the parent does, so including
  them would re-create the duplicate the wait exists to avoid. The idle
  sentence points at `agent_result` instead.
- **Add a `waitAll` supervisor operation.** The active ids are one read of
  the repository the façade already declares, and from the list onward the two
  waits are the same operation. A second operation would have been a second
  place for the wait to be wrong.

## What it costs

- One optional field on the `terminal` wait outcome, and one restructured
  `waitOne` so the store read happens under the pin.
- The push sink gains a hold scope, a held map, one method and two counts.
  Every reader of `HandoffCounts` — the diagnostics report and its test —
  gains two rows.
- **The widget's documented row lifetime changes again**, from "until its
  notice lands or `agent_result` retrieves its Result" to "or a wait delivers
  it". That is a public contract changing, and it is why this is an ADR.
- **Tests that used `agent_wait` as a synchronisation step and then asserted
  on the notice** can no longer, because the wait now takes the notice. The
  host rig gains `settled(...ids)`, which reads terminality through the
  supervisor for the same reason the rig reads the probe: what it observes has
  no surface of its own.
- Seven tools rather than six, everywhere the count is stated.

## What breaks if it is wrong

The worst case is a notice **held and never released** — a parent that waited,
got nothing back, and was never pointed at a stored Result. The release runs in
a `finally` around the handler's whole body, so a timeout, an abort, a decode
that passed and a runtime that went away all reach it; and `unbind` forgets
every hold, so a Session ending cannot leave one behind. `host/push-sink.test.ts`
proves the four exits — delivered, gave up, overlapping holds, unbind — and
`host/tools.test.ts` proves at the surface that a wait which gave up leaves the
notice to arrive on its own.

Nothing here can lose or alter a stored Result: the wait reads the store, and
the conformance scenarios `a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` pass unchanged.
