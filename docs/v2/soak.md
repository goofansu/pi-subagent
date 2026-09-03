# The release-candidate soak record

**Status:** Open. Started 2026-09-03 as the M4 Pi soak; extended to all three
backends at the M7 cutover.
**What is being soaked:** `2.0.0-rc.1` — v2 with the production backend set, as
the maintainer's default subagent extension. Since the cutover it is what an
installed package loads, so nothing has to be switched on; `make fallback-v1` is
the way back.
**What closing it unlocks:** the deletion of v1, its lanes, its scripts, and the
fallback switch. **The soak period is the rollback window**, and it is the last
moment at which rolling back is a Session-level switch rather than a release
rollback.

## How this is counted

Not by elapsed days. Days are easy to accumulate without exercising anything,
and a milestone that passed because a week went by would prove nothing about the
operations a user actually performs. What is counted is **representative
usage**: each of start, resume, steer, cancel, shutdown, and a Session switch,
several times, across distinct days — **and now per backend**, because a Pi
Subagent, a Claude Query, and a Codex App Server fail in different ways and a
tally that pooled them could be full while one of the three had never been run.

So this file is a log rather than a certificate. Each entry names the date, the
backend, the operation, what it was actually used for, and what happened. An
entry that says "worked" and nothing else is worth having: the point is the
tally, and the defects below are where the interesting part goes.

## Exit criteria

All four, and each is checkable rather than a judgement:

1. **The tally is full.** Every operation, on every backend, several times,
   across distinct days.
2. **Every shutdown entry records zero** on the runtime probe and on every
   adapter probe, read from the diagnostics command — or a defect entry explains
   why not.
3. **No open severity-1 or severity-2 defect.**
4. **Every severity-3 defect is fixed or marked intentional** with its decision
   reference.

## Reading the probes at each shutdown

The diagnostics command reports the runtime's own counters and one probe block
per backend adapter. Read it *before* ending a Session with nothing in flight,
because after the Session is gone there is nothing to ask:

- **the runtime probe** — live Run fibers, live reducer fibers, open observation
  queues, open mailboxes, unresolved waiters, repository subscriptions, open
  BackendAgents;
- **Pi** — native sessions and event subscriptions;
- **Claude** — live Queries, open input streams, retained conversation
  identities;
- **Codex** — live App Server processes, reader fibers, pending JSON-RPC
  requests, retained root threads, in-flight steers.

Every one should read zero for a Session with nothing running. A figure above
zero is a severity-2 defect and goes in the table below.

---

## Tally

Three tables, one per backend, because the exit gate is per backend. Update the
tally when a day's entries are added: a tally that disagrees with the log is a
tally that has stopped being read.

### Pi

| Operation | Occurrences | Distinct days | Exit gate wants |
| --- | --- | --- | --- |
| `agent_start` | 0 | 0 | several, across distinct days |
| `agent_resume` | 0 | 0 | several, across distinct days |
| `agent_steer` | 0 | 0 | several, across distinct days |
| `agent_cancel` | 0 | 0 | several, across distinct days |
| Session shutdown | 0 | 0 | several, across distinct days |
| Session switch | 0 | 0 | several, across distinct days |

### Claude

| Operation | Occurrences | Distinct days | Exit gate wants |
| --- | --- | --- | --- |
| `agent_start` | 0 | 0 | several, across distinct days |
| `agent_resume` | 0 | 0 | several, across distinct days |
| `agent_steer` | 0 | 0 | several, across distinct days |
| `agent_cancel` | 0 | 0 | several, across distinct days |
| Session shutdown | 0 | 0 | several, across distinct days |
| Session switch | 0 | 0 | several, across distinct days |

### Codex

| Operation | Occurrences | Distinct days | Exit gate wants |
| --- | --- | --- | --- |
| `agent_start` | 0 | 0 | several, across distinct days |
| `agent_resume` | 0 | 0 | several, across distinct days |
| `agent_steer` | 0 | 0 | several, across distinct days |
| `agent_cancel` | 0 | 0 | several, across distinct days |
| Session shutdown | 0 | 0 | several, across distinct days |
| Session switch | 0 | 0 | several, across distinct days |

**A Session switch** is shared across the three tables: it is a property of the
Session rather than of a backend, and one switch exercises whichever backends
that Session had open. Count it under each backend that was in use.

## Log

_No entries yet under the cutover build._ The M4 soak accumulated no entries
either — it was opened on 2026-09-03 and neither M5 nor M6 was the milestone
that should have closed it. Two of its three obstacles are now gone: all three
backends work, so no specialist is off the table, and the widget is visible for
long enough to read. The first day's usage goes below.

<!--
One entry per session of use, newest last. Name the backend in every line: a
tally is per backend and a line that does not say which one cannot be counted.

### 2026-09-04

- **Pi** `agent_start` × 3 — asked `explore` to summarise three unfamiliar
  modules. All three answered; the widget showed the tail of each and each row
  stayed until its answer arrived in the conversation.
- **Pi** `agent_resume` × 1 — followed up on the second with a narrower
  question. The answer depended on what the first Run had already read, so the
  retained conversation is doing its job.
- **Claude** `agent_start` × 2, `agent_steer` × 1 — `spec-reviewer` on two
  specs; steered the second mid-Run to also check the issue list. The steer
  appeared once in the transcript.
- **Codex** `agent_start` × 1, `agent_cancel` × 1 — `implementer` on a change
  that turned out to be wrong. Settled `cancelled (requested)` with the partial
  output retained, and the Subagent stayed resumable.
- Session shutdown × 2 — `/subagent-v2` read zero on the runtime probe and on
  all three adapter probes each time.
- Session switch × 1 — reloaded mid-afternoon; the new Session's ids started
  again and the old ones reported unknown, as they should.
-->

## Defects

Severity is about the product, not about how annoying it was:

- **1** — data loss, a wrong answer presented as right, or a Run that cannot be
  stopped.
- **2** — a lifecycle defect: a leak, a stranded Run, a duplicate or missing
  Notification, a Subagent that cannot be resumed when it should be.
- **3** — a wrong or confusing surface: prose, a row, a diagnostic.
- **4** — a papercut.

The exit gate requires **no open severity-1 or severity-2 defect**, and every
severity-3 either fixed or marked intentional with a reference.

Any defect fixed during the soak needs a test, and the fix has to be on the
build being soaked — a fix that landed after the last day of usage has not been
soaked.

See also [what driving M4 against a real Pi host turned up](m4-live-findings.md),
which records how each of the first three was established and the testing gap it
sat in, and [the presentation ledger](presentation-ledger.md), which is where
the wording differences between v1 and v2 were classified.

| Found | Severity | Backend | What happens | Status |
| --- | --- | --- | --- | --- |
| 2026-09-03 | 3 | Pi | The first Run of every Session was `run-2`: one sequence counter was shared by the Run and Subagent allocators, so `start` gave the Subagent 1 and its Run 2. Fixed — each kind is numbered from one. | Fixed |
| 2026-09-03 | 1 | any | Ids restart at 1 when a session is reloaded, but the transcript keeps the old ones — so a pre-reload `run-1` silently resolves to a different Run once a new one takes the id. Our own completion notice invites exactly that. v1's random ids could not collide. Fixed — every identifier now carries a per-Session nonce (`run-<nonce>-1`), so a stale id is reported unknown as it was in v1. | Fixed |
| 2026-09-03 | 2 | any | The Result store could wedge a Session permanently. Nothing evicted to make room for a *reservation*, and eviction only ran when the budget was already exceeded — so a Session whose stored results grew to just inside the budget answered `at capacity` to every later `start`, for ever, with unpinned results sitting there that nobody was going to read. Found by the M7 stress lane on its fifth cycle. Fixed — a reservation now evicts the oldest unpinned output, and still refuses when every entry is pinned. | Fixed |
| 2026-09-03 | 3 | any | The widget drops a Run's row the moment the Run settles, where v1 keeps it until the Run's completion notification lands. For anything but a long Run the widget appears and disappears before it is read, so v2 reads as having no widget at all. Fixed in M7 — a settled Run's row now lasts until its notice lands. | Fixed |
| 2026-09-03 | 3 | any | `agent_wait` reported a cancelled Run as plain `cancelled` where v1 reported `cancelled (requested)` or `cancelled (shutdown)`. At shutdown every Run is cancelled without anyone asking, so a model reading the v2 answer would conclude its own cancel had taken effect. Found by the M7 presentation ledger. Fixed — the terminal wait outcome carries the reason and the prose renders it. | Fixed |

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

**What happened.** v1's widget lists every *tracked* Run, and a Run stays
tracked until `release(id)` — "drop a run whose notification has reached the
model". So a v1 row is visible from `agent_start` until the answer arrives in
the conversation. v2's widget listed Runs that were *not terminal*, so the row
went the instant the Run settled, which is typically well before the
notification lands and often within the same turn.

**Verified, not inferred.** Driven against a real Pi host with the tool handler
called directly so no orchestrating model was involved:

```
change size=1 live=1
install rows=1            # the widget installs with one live row
change size=1 live=1      # redraws while the Run runs
change size=1 live=0      # the Run settles
uninstall installed=true  # the row goes at once
```

So the machinery was sound and the *policy* was what differed.

**Why it was open rather than fixed at M4.** It was a deliberate M3 decision,
recorded in `host/widget.ts`: "A terminal Run leaves the widget at publication,
which is a deliberate difference from v1 — v1 kept a settled row until its
notification landed, and the row's job here is to show what is *live*." The
reasoning held on its own terms; what it did not account for is that a row
nobody sees is not showing anything. The compatibility matrix's Active widget
row said the widget is "removed when none are left" and cited v1's tests for
it, so v2 diverged from a promised behaviour without a **[v2 change]** marker —
which made it a parity break rather than a taste question.

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
noticing rather than waiting to trip over. The first four are backend-neutral;
the rest are each backend's own.

- **Either probe above zero after a Session ends.** The diagnostics command
  reports the runtime's and one block per adapter.
- **A cleanup escalation.** The command counts them. One means a native
  finalizer outlived the cleanup budget and the core closed the BackendAgent out
  from under it; the Subagent's conversation is then lost, honestly, and a later
  resume says so.
- **A duplicate or missing completion Notification.** Landing is tracked through
  four host events, and the failure mode if Pi stops reporting one of them is a
  notice that is pushed again.
- **A widget row that outlives its Run's answer.** The row now goes when the
  notice lands, so a row that stays after the answer is in the conversation
  means a landing that was not seen.

### Pi

- **A Run that settles `failed` with "the Pi session finished without a terminal
  event".** That means the session went idle without an `agent_end` frame the
  adapter could read. It is a fixed message rather than an invented answer, and
  seeing it in practice would mean the terminal frame's shape has changed.
- **Turn counts or context occupancy that read wrongly.** Pi reports usage per
  message: the token counts are additive and `totalTokens` is a gauge. A context
  figure that grows without bound would mean the gauge is being summed.

### Claude

- **A resumed Run that answers without the first Run's context.** Claude's
  continuation is an ordered Query conversation ([ADR-0018](../adr/0018-ordered-claude-query-conversation.md)),
  and a resume that had lost it would answer plausibly and wrongly rather than
  reporting the conversation lost.
- **A child that cannot see the MCP servers your Claude Code environment has.**
  The inheritance is [ADR-0008](../adr/0008-claude-children-inherit-operator-environment.md)
  and it is deliberate; a child missing them would fail at a tool call rather
  than at start.

### Codex

- **A `codex app-server` process alive after a Session ended.** Codex is the one
  backend that owns an operating-system process. The adapter's probe reading
  zero is the adapter's word for it; `ps` is the answer.
- **A resumed Run that does not recall the earlier Turn.** There is no
  `thread/resume` and no stored rollout ([ADR-0021](../adr/0021-retained-ephemeral-codex-conversation.md)):
  continuity *is* the retained App Server and its one ephemeral root thread, so
  losing it looks like amnesia rather than an error.
- **A steer that appears twice in the transcript, or not at all.** The adapter
  sends a client message id and the server echoes it; two would mean an echo
  counted twice and none would mean guidance the model read went unrecorded.
- **Anything from Codex Desktop.** The two share a Codex home. The coexistence
  procedure is [the release check](../codex-desktop-coexistence-release.md), and
  a rollout-writer or thread-storage conflict is what it exists to find.
