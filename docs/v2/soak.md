# The release-candidate soak record

**Status:** Open. Started 2026-09-03 as the M4 Pi soak; extended to all three
backends at the M7 cutover.
**What is being soaked:** `2.0.0-rc.1` — the rewrite with the production
backend set, as the maintainer's default subagent extension. It is what an
installed package loads; nothing has to be switched on.
**What closing it unlocks:** the `2.0.0` release, without the release-candidate
marker.
**The plan for running it** is [the 2.0 close](release-close.md), which starts
when the simplification programme's Phase C gate closes — the soak must run on
the build that ships — and which replaces this record's hand-written tally with
one computed from Pi's session logs, so that the maintainer writes only the
shutdown readings.

**The rollback window is not what it was designed to be, and that is worth
being plain about.** The plan was for this soak to run *before* 1.x was
deleted, so that rolling back was a Session-level switch. The deletion was
taken first, deliberately, so rolling back is now an ordinary release rollback
— `pi install …#v1.0.0` — and no Subagent, Run, or Result crosses over. That
raises the cost of a defect found here from "flip a switch" to "reinstall the
previous version", which is a real cost and is the reason this record is still
open rather than closed with the deletion.

## How this is counted

Not by elapsed days. Days are easy to accumulate without exercising anything,
and a milestone that passed because a week went by would prove nothing about the
operations a user actually performs. What is counted is **representative
usage**: each of start, resume, steer, cancel, shutdown, and a Session switch,
several times, across distinct days — **and now per backend**, because a Pi
Subagent, a Claude Query, and a Codex App Server fail in different ways and a
tally that pooled them could be full while one of the three had never been run.

So this file is a log rather than a certificate — and since [the 2.0
close](release-close.md) it is no longer the place the operations are counted.
The operation rows are read out of Pi's own session logs by
[`scripts/soak-tally.mjs`](../../scripts/soak-tally.mjs), which knows the
operation, the backend and the day of every `agent_*` call already recorded.
What is written here by hand is one shutdown entry per Session — the readings
no log can take — and a row for anything that went wrong. That is deliberate:
two soak windows closed empty because the tally was a record of things the
maintainer had already done, and nothing made writing it cheaper than not
writing it.

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

A fifth, added because the deletion came first: **any severity-1 or severity-2
defect found here is a release-rollback decision rather than a switch**, so the
entry that records one should say what a user would do about it today.

## Writing a shutdown entry

This is the whole of what the soak asks anyone to remember, and it is one
thing: at each Session end, with nothing in flight, run `/subagent` and then
`/subagent diagnostics`, and write three lines under today's date.

1. **The date, and the backends that were live** in that Session.
2. **The paste** — both blocks, unedited.
3. **Anything that went wrong**, which also gets a row in
   [Defects](#defects) with a severity.

Nothing else. The operation counts are the script's; this is the reading.

**Both commands, because they report different things.** Bare `/subagent`
carries the Run summary and the health line; `/subagent diagnostics` carries
the runtime counters, the runtime probe, the notification hand-off block, and
one probe block per backend adapter. [Phase D's decision
rules](../v2-simplify/roadmap.md#phase-d--long-session-concerns-on-evidence-only)
read the Run summary from the first and `consumedBeforeLanding` from the
second, so a paste of one command cannot answer them.

Take the reading *before* ending the Session: after the Session is gone there
is nothing to ask.

Four things are read out of the paste later rather than written out again now,
which is why the paste goes in whole:

- **the runtime probe** — live Run fibers, live reducer fibers, open observation
  queues, open mailboxes, unresolved waiters, repository subscriptions, open
  BackendAgents;
- **each adapter probe** — Pi's native sessions and event subscriptions;
  Claude's live Queries, open input streams and retained conversation
  identities; Codex's live App Server processes, reader fibers, pending
  JSON-RPC requests, retained root threads and in-flight steers;
- **the hand-off block** — what each completion notice did, by outcome,
  including `consumedBeforeLanding`, which is the number the hold-while-active
  envelope's decision rule is read from;
- **the health line** and the Run summary above it — the runtime's own verdict
  by counter class, and how many Runs this Session has settled, which is the
  number the terminal-compaction rule is read from.

Every probe field should read zero for a Session with nothing running. A
figure above zero is a severity-2 defect and goes in the table below.
[The debugging guide](../debugging.md) is what each field means.

---

## Tally

**These three tables are generated, not kept by hand.** At the end of each soak
day run

```
node scripts/soak-tally.mjs <the-first-soak-day>
```

and paste its three tables over the three below. The script reads every Pi
Session started on or after that date, attributes each `agent_start` to a
backend through the Profile it names, resolves each `agent_resume`,
`agent_steer` and `agent_cancel` through the start or resume in the same
Session that produced its id, and counts Sessions as shutdowns and switches. So
a day of real usage counts whether or not anyone wrote it down.

It also prints, below the tables, an **unattributed** list of every call it
could not place — with the Session and the line — and the number of Sessions it
read. Neither is pasted here, but a run with a long unattributed list is one to
look at before believing the tables: the script lists what it cannot attribute
rather than dropping it, precisely so the tally never reads fuller than the
usage was. A field the script needs and cannot find is a thrown error naming
the file and the line, not a smaller number.

**Last pasted:** never. The tables below are the empty ones this record opened
with.

Three tables, one per backend, because the exit gate is per backend.

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
One entry per Session of use, newest last, in the form above: the date and the
live backends, the paste, and anything that went wrong. No operation counts —
the script counts those, and a hand-written count that disagreed with it would
only raise the question of which to believe.

### 2026-09-04 — Pi, Claude and Codex live

```
Subagents: 5 Profiles · 0 running, 7 completed, 1 failed
Runtime: healthy · 0 held

Runtime counters:
  duplicateSettlements: 0
  ...
Runtime probe:
  liveRunFibers: 0
  ...
Notification hand-offs:
  pushesAttempted: 8
  ...
  consumedBeforeLanding: 0
Backend probe (pi):
  openSessions: 0
  ...
Backend probe (claude):
  ...
Backend probe (codex):
  ...
```

- Nothing went wrong. (Anything that did goes here in a sentence, and in the
  defects table below with a severity.)
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
| 2026-09-03 | 3 | any | A settled Run's row kept counting upwards. The published row carried the instant a Run started and none for when it settled, so `completed in …` was recomputed against the render clock on every redraw — reporting how long ago the Run started rather than what it cost, and disagreeing with the figure the Run's own RunCard quotes from its stored Result. Visible for as long as the row waited for its notice to land, which M7 had just extended. Found by watching four Subagents finish. Fixed — the row carries the instant the Run settled, and a terminal row is measured against it. | Fixed |

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

### The settled row's climbing duration (2026-09-03, severity 3)

**What happened.** Four Subagents finished and their rows sat in the widget
waiting for their notices to land. All four durations were climbing, in step —
`completed in 11.5s`, `11.6s`, and rising together by a tenth at a time about
Runs that had stopped doing anything. The lockstep is the tell: four Runs that
finished at four different moments cannot all cost the same and then all gain a
tenth of a second together. None of the four figures was the Run's cost; each
was its age at the moment the row happened to be drawn.

**Why.** The published index carries the instant a Run *started* and, until this
fix, no instant for when it settled. Presentation reads no clock of its own — a
row's text is a function of a snapshot and an instant it is handed — so the row
formatter could only subtract the start from *now*. For a live Run that is
right. For a settled one there was nothing else to use, so the figure measured
the age of the Run rather than its cost, and it moved on every redraw. v1 did
not have this: its row projection used the live clock while a run was running
and the run's own recorded finish time once it had settled, so the number
stopped when the run did.

**Why nothing caught it.** Every test of a row supplied one fixed instant, and
so did the disposable script behind [the presentation ledger](presentation-ledger.md),
which is why that document recorded all twelve widget row fixtures as identical
to v1 while its own preamble noted that v1's row view carries an elapsed figure
where v2 derives one from a start and a supplied `now`. A duration that has
stopped and a duration that is still climbing are the same string when you look
once. Proving the difference takes two looks, and nothing in the tree could take
one: the host rig rendered its widget at a constant instant.

It is also worth saying what made it visible rather than what made it wrong. The
arithmetic had been wrong since M3. What changed at M7 is that a settled row
stopped vanishing at settlement and started waiting for its notice to land —
which gave the moving number somewhere to be seen.

**Fixed.** The published row carries the instant the Run settled, present
exactly when its phase is terminal, beside the terminal status. It is supplied by
the Run Scope on the settling transition rather than read from a clock inside the
repository, and it is the very instant the immutable Result records — so the row
and the RunCard built from that Result quote one figure to the tenth of a second
they both print. The shared elapsed-time helper prefers the row's instant over the
one it is handed, which fixes the widget row and the RunCard's live branch
together, and leaves presentation with no clock. A settlement recorded without
its instant now fails to compile.

Proven by `a settled row says what the Run cost, and the number does not move`
in `host/widget.test.ts`, which settles a Run, advances the display's instant a
second and then a minute past the Run's own, and requires the rendered lines to
be identical at all three readings — with the row still present, since the freeze
only matters while the row is waiting. The formatter's own goldens are pinned by
`a settled row's duration is the Run's cost, so a later draw reads the same` in
`presentation/rows.test.ts`. The host rig's render instant is now movable
(`renderAt`), which is what made the host-seam test expressible at all. The
compatibility matrix gained an **Active widget — settled duration** row citing
both.

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
