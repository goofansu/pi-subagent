# 42. A notice waits for the parent's turn to end

Date: 2026-10-15

## Status

Accepted.

**Amends [ADR-0035](0035-completion-hand-off-resolves-on-landing-or-consumption.md)**
in one respect: a notice is no longer handed to Pi while the parent is
mid-turn, so the case that entry could only count — a Result consumed before
its queued notice landed — is suppressed rather than counted. The count,
`consumedBeforeLanding`, stays, and should now read near zero. **Amends
[ADR-0036](0036-a-wait-delivers-the-result-it-waited-for.md)** in one
respect: the hold-while-active envelope that entry set aside as "still
available" is taken, in its narrow form. Both entries carry a status note
pointing here.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — storage
  precedes notification. A deferred notice is built from a stored Result and
  delivery has already released its pin; deferring changes when Pi is handed
  the message, not what is stored.
- [ADR-0033](0033-notification-vocabulary-pointer-and-label-bound.md) — only
  the Session push sink may say where a notice has got to. **Deferred** is an
  eighth word with that property, in the same module.
- [ADR-0035](0035-completion-hand-off-resolves-on-landing-or-consumption.md)
  — a hand-off resolves on landing or consumption, consumption is recorded at
  the host boundary, and one landing per notification is the invariant. All
  three stand; this entry adds a way for consumption to arrive first.
- [ADR-0036](0036-a-wait-delivers-the-result-it-waited-for.md) — a wait holds
  its Runs' notices. The hold is unchanged and is checked first; a released
  hold now falls into the deferral when the parent is still mid-turn, which is
  the case a timed-out wait leaves behind.

## Context

The same dogfood Session ADR-0041 measured showed the other half of the cost.
Two Runs reached the parent **twice**: `agent_result` returned 49,183
characters and the notice then landed with 2,779 more; `agent_result` returned
34,636 and the notice landed with 3,820. Both followed the same shape. The
parent called `agent_wait` with a timeout; the wait gave up; the Run finished
a moment later while the parent was still mid-turn; the parent called
`agent_result`; the turn ended; the notice landed.

ADR-0035 described exactly this and explained why it could not then be fixed:
while the parent is streaming, delivery's push goes into Pi's own follow-up
queue through `sendMessage`, and the extension API exposes nothing that
removes a queued message. So consumption after hand-off could only be
counted, and the count was the evidence a "hold-while-active envelope" would
be scheduled on. ADR-0036 then built a hold for the one case it could promise
— a wait in flight — and left the general envelope aside because "it changes
the timing of every notice, waited or not, and the count it was scheduled on
has not been read yet."

The count has now been read, on a Session where it fired twice in nine Runs,
and the timing objection turns out to be smaller than it looked. Pi delivers
a follow-up queued mid-turn "only when the agent has no more tool calls or
steering messages" — at the end of the run. A notice the host keeps until the
run settles and then sends lands at the same point. The difference is who
holds it in the meantime, and only the host can drop what it holds.

Pi reports whether the parent is mid-turn through the context's `isIdle()`,
which is read live, and it emits `agent_settled` once per run after marking
the run inactive; a `sendMessage` with `triggerTurn` from inside that handler
is deferred by Pi until the emission ends and then starts a turn. Those three
facts are what make the decision below implementable without a queue API.

## Decision

> A push while the parent is mid-turn is **accepted and deferred** in the
> Session push sink rather than handed to Pi. Deferred notices are handed
> over when the parent settles, unless Pi still reports pending messages,
> in which case they wait for the next settle. A deferred notice whose Run
> is consumed in the meantime is dropped as **answered while deferred**. A
> push while the parent is idle is handed over at once, as before.

**Mid-turn is Pi's answer.** The host binds `() => ctx.isIdle()` next to
`() => ctx.hasPendingMessages()`, and the sink reads it at the moment of each
push. A sink bound without it treats the parent as idle, which is what every
test that is not about turns wants and what every such test already assumed.

**The settle is the one hand-over event.** A non-aborted `turn_end` hands
nothing over: a turn ends many times inside one agent run, and the next turn
may be the one that calls `agent_result`. Handing over at turn end would
reopen the window this entry closes. At settle the hand-over bypasses the idle
check, because the settle is the evidence and Pi's `isIdle()` is also false
during a compaction that may run at the same instant; it still yields to
pending messages, exactly as a lost notice's re-push does.

**A lost notice re-dispatched mid-turn is deferred too.** ADR-0035's re-push
at a non-aborted turn end now goes through the same decision, so a notice Pi
discarded on abort is not put back into Pi's queue mid-run only to land on
top of a Result the parent then fetched.

**The hold comes first.** A wait's hold is checked before the idle check, so a
wait in flight owns its Runs' notices as ADR-0036 decided. A hold released
while the parent is still mid-turn — a timed-out or aborted wait — defers the
notice instead of handing it over, which is precisely the measured case.

**Two counts are added.** `deferredForTurn` is pushes kept for the turn;
`answeredWhileDeferred` is deferred notices dropped on consumption. Their
difference is how many deferrals were handed over at settle. The diagnostics
report prints both.

**The widget reads nothing new.** A deferred notice is `pending`, as a held
one is; the widget never learns which.

## Alternatives considered

- **Keep counting.** The count has been read and it fires in ordinary use.
  Every firing costs the parent a whole delivery text; after ADR-0041 that is
  a few thousand characters rather than fifty thousand, but it is still the
  same answer twice.
- **Hand over at every non-aborted turn end.** Simpler, and wrong: it is the
  window the measured duplicates sat in.
- **Ask Pi to drop the queued message.** `clearQueue()` is on the session
  object, not the extension API, and it drops the user's queued messages
  with ours. ADR-0035 rejected it for the same reason.
- **Track streaming from `agent_start` and `agent_settled` events** instead
  of asking `isIdle()`. Equivalent in the common case and one more thing to
  keep in step with Pi; the live predicate is the host's own answer, and the
  settle hand-over bypasses it where it is known to disagree.

## What it costs

- One optional predicate on `bind`, one state, one count pair, one branch in
  `dispatch`, one hand-over at settle.
- `SessionStartContext` reads `isIdle` from the Session, and the stand-in
  host answers it: idle unless a test says otherwise, and streaming for the
  duration of any tool call, because Pi never executes a tool while idle.
- Every reader of `HandoffCounts` gains two rows.
- The landing time of a mid-turn notice is unchanged in the ordinary case and
  **later in one**: a Run that settles while the parent is compacting, with
  no agent run active, is announced at the next settle rather than at once.

## What breaks if it is wrong

The worst case is a notice **deferred and never handed over**. The hand-over
runs on `agent_settled`, which Pi emits once per run, and bypasses the idle
check there; `unbind` forgets every deferred notice at Session end, so a
Session cannot leave one for the next. `host/push-sink.test.ts` proves the
hand-over, the drop on consumption, the wait for pending messages, the
bypass, the aborted-turn case, the lost-notice case, the released-hold case
and unbinding; `host/tools.test.ts` proves the measured scenario end to end
through the real registrations — a wait that gave up, a Run that settled
mid-turn, a fetch, a settle, and nothing sent — and the inverse, a Run that
settled mid-turn with no fetch, announced once at settle.

Nothing here can lose or alter a stored Result, and `consumedBeforeLanding`
is still counted for the one path that can still produce it: a notice handed
over while idle that Pi had not yet started when the parent fetched.
