# Debugging a live Session

**What this is:** how to find out what is wrong when something is wrong, and
what each number the extension reports actually means.

**Where to start, always:** `/subagent`. It says in two lines what is loaded,
what is running, and whether the runtime noticed anything actionable, and
reading it costs nothing. `/subagent diagnostics` is the same Session with
every counter and every probe printed, and it is the only surface that reports
them.

---

## `/subagent`

The shallow status, and the one place to start. Run it while the Session is
live. Between Sessions it answers `No subagent Session is running.`, which is
an answer rather than an error — Pi registers commands once per process and a
Session starts and ends many times inside it.

```
Subagents: 2 Profiles · 1 running, 2 completed, 1 failed
Runtime: healthy · 4 held

  explore   pi
  reviewer  claude

/subagent profiles — list Profiles and read their prompts
/subagent diagnostics — runtime counters and cleanup probes
```

Four things and then the way deeper: what is loaded, what is running, how the
runtime is, and which Profiles there are. Deliberately no counters — they are
one level down.

### The health line

Two forms, and which one you get is a verdict on the counters **by class**
rather than on their sum:

```
Runtime: healthy · 4 held
Runtime: attention needed · 1 defect · 2 incidents · 4 held — /subagent diagnostics
```

- **defect** — the runtime did something it must not do. Somebody should look,
  and the Session is not behaving.
- **incident** — something outside the runtime went wrong and the runtime
  coped. Worth seeing; not a bug in here.
- **expected** — a thing that happens in the normal course of racing endings,
  cancelling Runs, and bounding a store. **Never named in this line**, however
  high it has climbed: a Session with twenty late events and two reconciliation
  differences is running exactly as designed.

Only the non-zero classes are named, worst first. A counter name the host does
not recognise is reported as `unclassified` rather than ignored, because the
counter block is structural — a counter cannot be added without appearing — and
one that appeared and was silently dropped would defeat that.

**The classes are the code's**, in
[`runtime/counters.ts`](../extensions/subagent/runtime/counters.ts), as
`COUNTER_CLASSES`, exhaustive by type: a counter added without a class fails to
compile. The tables under [The counters](#the-counters) below are grouped by
those same three classes, so the guide and the health line cannot drift apart
silently.

The `N held` is a *count* of the runtime probe and not a verdict on it. A live
Session holds a fiber per Run and a repository subscription for its widget on
purpose; the probe only has to read zero once the Session Scope has **closed**.

## `/subagent diagnostics`

The full report: every counter and every probe, zeroes included.

```
Runtime counters:
  duplicateSettlements: 0
  lateEvents: 0
  ...
Runtime probe:
  liveRunFibers: 0
  liveReducerFibers: 0
  ...
Notification hand-offs:
  pushesAttempted: 0
  handOffsAccepted: 0
  handOffsRefused: 0
  lostAfterHandOff: 0
  rePushes: 0
  landings: 0
  exhaustions: 0
  consumedBeforeLanding: 0
Backend probe (pi):
  openSessions: 0
  ...
Backend probe (claude):
  ...
Backend probe (codex):
  ...
```

The report is three kinds of block and the split is the whole point:

- **Counters** are things that *happened* and nobody had to be told about at
  the time. One is usually normal. Thousands is a bug.
- **Probes** are what is *still alive*. Every field must read zero for a
  Session with nothing in flight, and every field must read zero once a Session
  has closed. There is one probe block per backend rather than a merged total,
  because "which adapter is still holding something" is the only question the
  block exists to answer and a sum cannot answer it.
- **Notification hand-offs** are what happened to each completion notice, by
  outcome. They come from the Session push sink rather than from the runtime,
  and they are one Session's: binding a new Session starts them over.

### The hand-off block

| Field | What it counts | What a high one means |
| --- | --- | --- |
| `pushesAttempted` | calls delivery made to the sink | one per settled Run, normally |
| `handOffsAccepted` | pushes the sink took | includes a consumed Run's, which is accepted and deliberately not sent |
| `handOffsRefused` | pushes it could not take | no Session was bound, or the Session threw and was dropped. **The first half of the pipeline is failing** |
| `lostAfterHandOff` | notices an aborted turn discarded | the parent is being interrupted a lot; each is re-pushed once |
| `rePushes` | notices handed over a second time | should track `lostAfterHandOff`, minus any the parent consumed meanwhile |
| `landings` | notices `message_start` carried into the conversation | the successful end of the pipeline |
| `exhaustions` | Runs delivery gave up on | matches `deliveryFailures`. Those rows read `completed · notification failed` |
| `consumedBeforeLanding` | landings whose Result the parent had already retrieved | notices that arrived after they were needed. Near zero means nothing to do; a steady count is the evidence a hold-while-active envelope waits for |

A Session where `handOffsRefused` is high and `landings` is zero is failing
before Pi ever sees a message; one where `handOffsAccepted` is high and
`landings` is low is failing after. That distinction is the only reason these
are eight numbers rather than one.

**Every field is printed, zeroes included.** A diagnostics command that hid its
zeroes would make "is this counter even wired up" unanswerable.

Read it **before** ending a Session you are suspicious of. After the Session is
gone there is nothing to ask.

## The runtime probe

Seven counts. Non-zero with nothing running means something leaked.

| Field | What is still held | What a leak means |
| --- | --- | --- |
| `liveRunFibers` | Run execution fibers | a Run's Scope did not close |
| `liveReducerFibers` | per-Run reducer fibers | the same, one level in |
| `openObservationQueues` | bounded observation intakes | a Run Scope closed without releasing its intake |
| `openMailboxes` | Control mailboxes | as above, for Controls |
| `unresolvedWaiters` | `agent_wait` callers still waiting | a waiter was registered and never released — note that aborting a wait *should* release it |
| `repositorySubscriptions` | live views of the Run index | a UI consumer outlived its Session; the widget is the only one |
| `openBackendAgents` | retained native conversations | a Subagent Scope did not close |

`openBackendAgents` above zero **while a Session is live is normal and
correct** — that is what retention is. It must be zero after the Session
closes.

## Each backend's probe

What that provider's own handles are, so a leak names the adapter.

- **Pi** — native sessions, and event subscriptions.
- **Claude** — live Queries, open input streams, retained conversation
  identities.
- **Codex** — live App Server processes, reader fibers, pending JSON-RPC
  requests, retained root threads, in-flight steers.

**Codex is the one to check with the operating system.** It is the only backend
that owns an OS process, and an adapter's probe reading zero is the adapter's
word for it:

```sh
ps -eo pid=,ppid=,command= | grep 'codex.*app-server'
```

Nothing should be left after a Session closes. The live gate asks `ps` for
exactly this reason, and since M7 it asks about every descendant it ever
observed alive, not only the child it spawned.

## The counters

Grouped by the three classes the code names, in
[`runtime/counters.ts`](../extensions/subagent/runtime/counters.ts). The health
line on bare `/subagent` reads the same classification, so a counter's class is
one fact rather than two that can disagree.

### defect — non-zero is a defect in the runtime

| Counter | What happened | What it means |
| --- | --- | --- |
| `duplicateCommits` | the same Result was committed twice | settlement ran twice for one Run |
| `conflictingCommits` | a *different* Result was committed for a Run that had one | worse: two different answers for one Run. The first stands. |
| `unreadableResults` | the repository says a Run settled and the store cannot read it back | the output is gone and `agent_result` can only say it expired, so this counter is the only place the difference between a defect and ordinary eviction is visible |
| `seamDecodeFailures` | an observation did not decode at the backend seam | an adapter emitted something the observation union does not describe. Suspect a provider whose payload shape changed. |
| `queueOverflows` | a non-blocking bridge could not hand an observation over | the Pi callback bridge is the only one; it fails the Run out loud rather than losing half a transcript |

### incident — something outside the runtime went wrong and it coped

| Counter | What happened | What to do |
| --- | --- | --- |
| `cleanupEscalations` | a native finalizer outlived the cleanup budget, so the core closed the BackendAgent out from under it | the Subagent's Conversation is lost, honestly, and a later resume says so. Look for a provider that hangs on close. |
| `deliveryFailures` | a Notification exhausted its retry budget | the model was not told a Run finished. **The Result is still stored and `agent_result` still returns it** — delivery failure is never Result loss. |

### expected — reading them is about the *rate*

| Counter | What happened | When to care |
| --- | --- | --- |
| `duplicateSettlements` | a second terminal candidate arrived for a Run that had one | two endings racing is normal, and the first candidate always wins. A large number means something is producing candidates it should not. |
| `lateEndings` | an ending arrived after one had already won | arbitration discarded it. Normal on cancellation. |
| `evictions` | a stored output was dropped to keep the store inside its budget | normal in a long Session. If `agent_result` is expiring output the model still wants, the Session is holding more Results than the budget allows. |
| `lateEvents` | an observation was emitted after intake was sealed | normal: an adapter emitting from its own finalizer does this on every Run. The intake dropped it and nothing was mutated. |
| `lateObservations` | an observation reached the reducer and the projection was already terminal | a different fact from `lateEvents`: it got further. Still a no-op. |
| `reconciliationDifferences` | a terminal reconciliation changed something that had been streamed | one or two means streamed drift was healed, which is what reconciliation is for. Many means a backend's streaming and its terminal snapshot disagree systematically. |

## Diagnostic categories

Diagnostics appear on a Run and in `agent_result`'s expanded body, each with
its category. Ten of them, and the category is what tells a runtime note apart
from a reason a Run has no answer:

| Category | Means |
| --- | --- |
| `backend-failure` | the provider or the adapter failed. **A reason the Run has no answer.** |
| `transport-loss` | the connection to the provider went. **A reason.** |
| `cleanup-escalation` | a finalizer was escalated past. **A reason** the conversation is lost. |
| `queue-overflow` | a bridge could not hand an observation over |
| `reconciliation-difference` | a terminal snapshot disagreed with what was streamed |
| `late-event` | something was emitted after sealing |
| `delivery-failure` | a Notification could not be delivered |
| `profile` | a Profile could not be used |
| `control` | a Control could not be delivered |
| `other` | none of the above |

Only the first three stand in for a missing error message in a failed Run's
body. A `late-event` is a note; a `backend-failure` is the answer to "why did
this fail".

Provider-authored text is **redacted** rather than retained where a provider
could have put an identity in it: a redacted diagnostic carries its category
and `[redacted]`, which is deliberate and not a truncation bug.

---

## Symptoms

### A Run never finishes

1. `/subagent diagnostics`: is `liveRunFibers` above zero with nothing
   apparently running?
2. Is the Run's phase `finalizing`? Then its backend's execution ended and its
   cleanup has not. Wait for the cleanup budget; a `cleanupEscalations` of one
   afterwards means it was escalated past, which is the bound working.
3. `agent_cancel` it. Cancellation is admitted immediately and the Run stops
   when its execution and cleanup finish, keeping whatever output it produced.
4. If cancel says `already cancelling`, the first request stands and a second
   changes nothing.

### The widget shows nothing

A row lasts from `agent_start` until the Run's completion hand-off is
**resolved**: its notice **landed** in the conversation, *or* the parent
retrieved its Result with `agent_result`, whichever came first. `agent_wait`
resolves nothing, so a row can outlive a wait.

If a Run has settled and its row is still there, neither has happened yet.
Read `/subagent diagnostics`: `handOffsRefused` says the sink could not hand
the message over at all, `lostAfterHandOff` says a turn was interrupted while
it was queued, and a `landings` well below `handOffsAccepted` says the
messages are being accepted and not arriving.

A row reading **`completed · notification failed`** is one whose delivery
exhausted its retry budget — `deliveryFailures` and `exhaustions` will both be
non-zero. Nothing more will be pushed for it, and it will not leave on its own.
**The Result is still there**: the row carries the Run id and says `result
available`, and `agent_result` with that id both returns the answer and takes
the row away.

If no row ever appears, the widget appears with the *first* live Run and is
cleared when there are none left; between Sessions there is no widget.

### The model was never told a Run finished

`deliveryFailures` above zero, or an interrupt that discarded the follow-up. The
Result is stored either way: `agent_result` with the Run id returns it. A notice
lost to an interrupt is pushed again once the agent settles, exactly once —
unless the parent has already retrieved that Result, in which case the notice
has nothing left to say and is deliberately not pushed again.

A notice that arrives *after* the parent has read the Result is counted as
`consumedBeforeLanding` and is harmless: Pi has no call that takes a queued
message back, so a notice already handed over lands whatever the parent does.

### `agent_result` says the output was evicted

The Result store is bounded and the oldest unpinned output goes first. The Run
is still known and its status still answers; the output is gone and cannot be
recovered. If this is happening to Results the model still needs, the Session is
producing more output than the budget holds.

### `agent_start` says `at capacity`

Too many Runs are active at once. Nothing was queued and no Run was started.
Wait for one to finish or cancel one. If nothing is running and this still
happens, the Result store could not reserve room — check `evictions` and see
whether every stored Result is pinned, which is the one case a reservation
cannot evict its way out of.

### A resume says the Conversation was lost

The provider context needed to continue is gone. Three ways to get here: the
Subagent's BackendAgent was closed, a cleanup escalation closed it, or — for
Codex — the App Server process died. Start a new Subagent; there is no
replacement Conversation.

### A steer was accepted and the model ignored it

`accepted` means the text is in the Run's local mailbox and **nothing more**. It
does not mean the backend dequeued it, a provider accepted it, or a model
consumed it. Check the Run's transcript: a user observation appears only on
authoritative provider confirmation, so no user item means it was never
confirmed. Do not resend in a loop.

### A Profile does not appear in `/subagent profiles`

It failed validation, and the Session said so at start with a warning naming
the file and the rule. The most likely cause after upgrading from 1.x is the
Profile still naming its backend with the old field — see
[the migration note](v2/profile-backend-field-migration.md).

### Something is wrong right after upgrading the `codex` CLI

`npm run check` goes red at the protocol check, which is the check working: the
vendored schema is compared byte-for-byte against the installed CLI's. Bumping
the pin is the `codex-upgrade` procedure in
`.agents/skills/codex-upgrade/SKILL.md`.

---

## Reproducing it deterministically

If a symptom can be reproduced without a provider, it belongs in a test rather
than in a session:

- **`runtime/stress.test.ts`** — hundreds of lifecycle cycles with every bound
  lowered, asserting the probe is zero after every cycle. This is where an
  accumulating leak shows up.
- **`runtime/bounds.test.ts`** — each bound driven past, asserting the
  truncation is recorded or the refusal is typed.
- **`runtime/races.test.ts`**, **`runtime/faults.test.ts`** — controlled
  interleavings and injected failures.
- **the conformance suite** — thirty-seven scenarios against both fakes and all
  three real adapters, with the only permitted skip driven by a declared
  capability.

Nothing in the lane lets real time pass. If a fix needs time to elapse, it uses
`TestClock`; a timer anywhere fails the timing lint.

## Live gates

Six, all credentialed and all outside `check`:

```sh
npm run pi:smoke        npm run pi:host-smoke
npm run claude:smoke    npm run claude:host-smoke
npm run codex:smoke     npm run codex:host-smoke
```

A runtime gate drives the supervisor over one adapter and reads every probe
after the Session Scope has closed. A host gate drives the same backend through
the surface a user has. Each prints an exact success marker and nothing else
counts as a pass.
