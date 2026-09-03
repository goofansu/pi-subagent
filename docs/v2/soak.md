# v2 Pi soak record

**Status:** Open. Started 2026-09-03.
**What is being soaked:** v2 with the Pi backend, as the maintainer's default
local subagent extension, switched on with `make dogfood-v2`.

The M4 exit gate does not count the soak by elapsed days. Days are easy to
accumulate without exercising anything, and a milestone that passed because a
week went by would prove nothing about the operations a user actually performs.
What it counts is **representative usage**: each of start, resume, steer,
cancel, shutdown, and a Session switch, several times, across distinct days.

So this file is a log rather than a certificate. Each entry names the date, the
operation, what it was actually used for, and what happened. An entry that says
"worked" and nothing else is worth having: the point is the tally, and the
defects below are where the interesting part goes.

---

## Tally

| Operation | Occurrences | Distinct days | Exit gate wants |
| --- | --- | --- | --- |
| `agent_start` | 0 | 0 | several, across distinct days |
| `agent_resume` | 0 | 0 | several, across distinct days |
| `agent_steer` | 0 | 0 | several, across distinct days |
| `agent_cancel` | 0 | 0 | several, across distinct days |
| Session shutdown | 0 | 0 | several, across distinct days |
| Session switch | 0 | 0 | several, across distinct days |

Update the tally when a day's entries are added. A tally that disagrees with the
log is a tally that has stopped being read.

## Log

_No entries yet. The switch landed on 2026-09-03 and the first day's usage goes
below._

<!--
One row per session of use, newest last:

### 2026-09-04

- `agent_start` × 3 — asked `explore` to summarise three unfamiliar modules.
  All three answered; the widget showed the tail of each.
- `agent_resume` × 1 — followed up on the second with a narrower question. The
  answer depended on what the first Run had already read, so the retained
  conversation is doing its job.
- `agent_cancel` × 1 — stopped a Run that had misread the brief. Settled
  `cancelled` with the partial output retained, and the Subagent stayed
  resumable.
- Session shutdown × 2 — `/subagent-v2` read zero on both probes each time.
-->

## Defects

Severity is about the product, not about how annoying it was:

- **1** — data loss, a wrong answer presented as right, or a Run that cannot be
  stopped.
- **2** — a lifecycle defect: a leak, a stranded Run, a duplicate or missing
  Notification, a Subagent that cannot be resumed when it should be.
- **3** — a wrong or confusing surface: prose, a row, a diagnostic.
- **4** — a papercut.

The exit gate requires **no open severity-1 or severity-2 defect**.

| Found | Severity | What happens | Status |
| --- | --- | --- | --- |
| _none yet_ | | | |

## What to watch for

These are the places the port is most likely to be wrong, so they are worth
noticing rather than waiting to trip over:

- **A Run that settles `failed` with "the Pi session finished without a terminal
  event".** That message means the session went idle without an `agent_end`
  frame the adapter could read. It is a fixed message rather than an invented
  answer, and seeing it in practice would mean the terminal frame's shape has
  changed.
- **A cleanup escalation.** `/subagent-v2` counts them. One means a native
  finalizer outlived the cleanup budget and the core closed the BackendAgent out
  from under it; the Subagent's conversation is then lost, honestly, and a later
  resume says so.
- **Either probe above zero after a Session ends.** The command reports both.
- **A duplicate or missing completion Notification.** Landing is tracked through
  four host events, and the failure mode if Pi stops reporting one of them is a
  notice that is pushed again.
- **Turn counts or context occupancy that read wrongly.** Pi reports usage per
  message: the token counts are additive and `totalTokens` is a gauge. A context
  figure that grows without bound would mean the gauge is being summed.
