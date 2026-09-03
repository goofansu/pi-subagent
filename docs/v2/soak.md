# v2 Pi soak record

**Status:** Open. Started 2026-09-03.
**What is being soaked:** v2 with the Pi backend, as the maintainer's default
local subagent extension. Since the M7 cutover it is what an installed
package loads, so nothing has to be switched on; `make fallback-v1` is the way
back.

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

## What is not available while the soak runs

**Only Pi-backed Profiles work.** v2 has one backend until M5 adds Claude and
M6 adds Codex, so a Profile naming either is skipped at Session start with a
diagnostic and does not appear in `/agents`. Renaming `harness:` to `backend:`
does not help — the field name becomes valid and the backend still does not
exist.

Measured against this machine's own agents directory on 2026-09-03:

| Profile | Under v2 |
| --- | --- |
| `explore` | Runs. No backend field, and its pinned model is in the catalogue. |
| `librarian` | Runs. Same. |
| `implementer` | **Unavailable.** Names Codex; M6. |
| `spec-reviewer` | **Unavailable.** Names Claude; M5. |
| `standards-reviewer` | **Unavailable.** Names Claude; M5. |

So the soak is a soak of *Pi delegation*, and three of five specialists are off
the table for its duration. That is worth deciding about rather than
discovering: if those three are load-bearing for daily work, the honest options
are to soak in shorter stretches with `make fallback-v1` in between, or to hold
the soak until M5 lands and Claude is available again. What is not an option is
running both at once — v1 and v2 register the same six tool names, so a Pi
process with both would offer the model each tool twice.

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

See also [what driving M4 against a real Pi host turned up](m4-live-findings.md),
which records how each of these was established and the testing gap they sat in.

| Found | Severity | What happens | Status |
| --- | --- | --- | --- |
| 2026-09-03 | 3 | The first Run of every Session was `run-2`: one sequence counter was shared by the Run and Subagent allocators, so `start` gave the Subagent 1 and its Run 2. Fixed — each kind is numbered from one. | Fixed |
| 2026-09-03 | 1 | Ids restart at 1 when a session is reloaded, but the transcript keeps the old ones — so a pre-reload `run-1` silently resolves to a different Run once a new one takes the id. Our own completion notice invites exactly that. v1's random ids could not collide. Fixed — every identifier now carries a per-Session nonce (`run-<nonce>-1`), so a stale id is reported unknown as it was in v1. | Fixed |
| 2026-09-03 | 2 | The Result store could wedge a Session permanently. Nothing evicted to make room for a *reservation*, and eviction only ran when the budget was already exceeded — so a Session whose stored results grew to just inside the budget answered `at capacity` to every later `start`, for ever, with unpinned results sitting there that nobody was going to read. Found by the M7 stress lane on its fifth cycle. Fixed — a reservation now evicts the oldest unpinned output, and still refuses when every entry is pinned. | Fixed |
| 2026-09-03 | 3 | The widget drops a Run's row the moment the Run settles, where v1 keeps it until the Run's completion notification lands. For anything but a long Run the widget appears and disappears before it is read, so v2 reads as having no widget at all. Fixed in M7 — a settled Run's row now lasts until its notice lands. | Fixed |

### The Result store's permanent capacity stall (2026-09-03, severity 2)

**What happened.** `ResultStore.reserve` took `maxResultBytes` of headroom or
refused, and `evict` only ran from `commit` and `releasePin`, and only while
the budget was already exceeded. Nothing else in a Session ever frees a stored
result. So the steady state of a long Session was: stored results accumulate to
just inside `resultStoreBytes`, the next reservation does not fit, and
`agent_start` answers `at capacity` — permanently, with nothing running and
with unpinned results the store was entitled to evict.

**How it was found.** Not by reasoning about the code. The M7 stress lane
lowered every bound and ran the lifecycle in a loop; the fifth cycle's `start`
came back `at capacity` and the sixth never happened. At the default bounds it
would take on the order of a thousand stored results in one Session to reach,
which is why nothing before this had noticed — and why "several hundred cycles
with every bound lowered" is a different test from "one cycle".

**The fix.** A reservation that does not fit now evicts the oldest *unpinned*
stored output until one fits. Pins stay absolute, so this is not a way around
the budget: a store whose every entry is still being delivered or read refuses
as before. An evicted result already had an honest public outcome —
`ResultExpired`, which operation semantics distinguishes from an unknown Run —
so the loss is one the surface can already describe, while a permanent capacity
stall is not.

Proven by `a reservation evicts old unpinned output rather than wedging the
Session` and `a reservation still refuses when nothing can be freed`
(`runtime/result-store.test.ts`), and under load by `a store full of unread
results evicts the oldest rather than refusing the next Run`
(`runtime/bounds.test.ts`).

### The widget's row lifetime (2026-09-03, severity 3)

**What happens.** v1's widget lists every *tracked* Run, and a Run stays tracked
until `release(id)` — "drop a run whose notification has reached the model". So
a v1 row is visible from `agent_start` until the answer arrives in the
conversation. v2's widget lists Runs that are *not terminal*, so the row goes
the instant the Run settles, which is typically well before the notification
lands and often within the same turn.

**Verified, not inferred.** Driven against a real Pi host with the tool handler
called directly so no orchestrating model was involved:

```
change size=1 live=1
install rows=1            # the widget installs with one live row
change size=1 live=1      # redraws while the Run runs
change size=1 live=0      # the Run settles
uninstall installed=true  # the row goes at once
```

So the machinery is sound and the *policy* is what differs.

**Why it is here rather than fixed.** It is a deliberate M3 decision, recorded
in `host/widget.ts`: "A terminal Run leaves the widget at publication, which is
a deliberate difference from v1 — v1 kept a settled row until its notification
landed, and the row's job here is to show what is *live*." The reasoning still
holds on its own terms; what it did not account for is that a row nobody sees
is not showing anything. The compatibility matrix's Active widget row says the
widget is "removed when none are left" and cites v1's tests for it, so v2
diverges from a promised behaviour without a **[v2 change]** marker — which
makes this a parity break rather than a taste question.

**Fixed in M7 (ticket 01).** A terminal Run's row now lasts until its
notification has landed, which is a fact the Session push sink already tracked.
The sink gained two functions — `hasLanded(runId)` and `onLanding(listener)` —
the widget is handed both beside the repository, and `liveRows` became
`widgetRows`, which keeps a terminal Run whose notice has not landed. Landing is
a host event rather than an index change, so the listener is what redraws; both
the predicate and the listener are read-only from the widget's side, and a
boundary rule now rejects a widget that imports the sink or delivery at all.

Proven by `a terminal Run keeps its row until its completion notice lands, and
the landing takes it away` and `a notice lost to an interrupt keeps its row
until the re-push lands` in `host/widget.test.ts`, both driven through the
stand-in host. The compatibility matrix gained an **Active widget — row
lifetime** row citing them.

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
