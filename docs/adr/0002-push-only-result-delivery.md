# 2. Push-only result delivery

Date: 2026-08-23

## Status

Accepted.

## Context

`agent_start` returns a run id, not an answer. The report has to reach the model
some other way. Two mechanisms were available.

Push injects the report into the session with
`sendUserMessage(..., { deliverAs: "followUp" })` when the run settles. Pull
gives the model a tool — `subagent_result(id)` — that it calls when it wants the
answer.

Pull risks the model simply never collecting, leaving work done, paid for, and
unread. Push risks reports arriving uninvited and consuming context the model
did not budget for.

## Decision

Push only. There is no collect tool.

Context cost is bounded at the source instead: a report carries the final
assistant output alone, with the run id named. Tool-call logs, usage and
transcripts are display-only and never enter the parent's context.

A report is capped, but the cap is a backstop rather than a budget, and this
follows directly from push-only. There is no way to fetch a report a second
time, so anything trimmed is lost — which means the cap must sit far above any
genuine answer and catch only a runaway agent returning a whole file. A trim
also states how much went missing, because a report that merely stops reads
like a report that finished.

`agent_wait` is not a pull mechanism. It exists for the case where the model
cannot proceed without an answer, and it claims the run's report rather than
fetching a second copy of it — see the delivery invariant in `CONTEXT.md`.

Delivery uses `deliverAs: "followUp"` together with `triggerTurn`. The first
keeps a report from cutting into a turn in progress; the second means an idle
session still acts on one. Without the second, a report delivered while nobody
was typing would sit unread in context until the operator happened to say
something, which defeats delegating the work. Pi marks a run active
synchronously, so several reports settling at once produce one turn and a queue
of follow-ups rather than competing turns.

## Consequences

A report can land in a turn after the one that started the run, possibly after
the conversation has moved to another topic. The widget is what keeps this from
being a surprise, which is why the widget is part of the feature and not a
decoration on top of it.

If the model is later observed needing to fetch a report it did not wait for,
add the collect tool then. Do not add it pre-emptively: two ways to obtain a
result is how the delivery invariant gets broken.
