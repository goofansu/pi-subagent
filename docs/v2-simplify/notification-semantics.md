# Completion notification semantics

**Status:** Implemented by Phase A.
[ADR-0033](../adr/0033-notification-vocabulary-pointer-and-label-bound.md)
records the three decisions this document makes: the delivery-state
vocabulary, the universal pointer with availability, and the Run label bound.
**Audience:** model authors reading the notices, and maintainers implementing
them.
**Vocabulary:** Subagent, Run, Result, Notification, Delivery sweep, Session
push sink, Landing — as defined in [CONTEXT.md](../../CONTEXT.md). Four terms
are added here and enter the glossary in Phase A: **handed off**, **landed**,
**lost after hand-off**, **exhausted**.

This document decides, once and before implementation, three things: what a
delivery state is called and who may use the word; what a model reads when one
of its Runs settles; and what a human sees in the transcript and the widget.
[The presentation ledger](presentation-ledger.md) records every sentence this
changes from the current goldens. The compatibility matrix's Notification,
widget, and operator-surface rows cite this document from every cell it
changes, the way they cite
[operation semantics](../v2/operation-semantics.md).

The v2 [operation semantics](../v2/operation-semantics.md) already decide what
a caller observes from `agent_start`, `agent_wait`, and `agent_result`. Nothing
here changes those. A notice is a pointer to a Result, and this document only
decides the pointer.

---

## 1. Delivery states, and who owns each word

A stored Result becomes a notice, the notice is pushed to the Session, and Pi
queues it as a follow-up message. That message reaches the conversation when
`message_start` carries it, and not before; an interrupted parent turn can
discard a queued message. The code has always behaved this way. What was wrong
was the words: the delivery module calls a successful push "landed" and keeps
a set called "delivered", while only the push sink can know whether anything
landed.

### The four states

| State | Meaning | Decided by | Terminal? |
| --- | --- | --- | --- |
| **pending** | The Result is stored; no push has been accepted yet. | Delivery, from the store. | No. |
| **handed off** | `sendMessage` accepted the custom message. Pi holds it. | Delivery, from the sink's push result. | No. |
| **lost after hand-off** | A host turn was aborted while the message was queued; Pi discarded it. Re-pushed once, when the parent agent settles. | Session push sink, from `agent_end` / turn-abort evidence. | No. |
| **landed** | `message_start` carried the notice. The model has it. | Session push sink, from `message_start`. | Yes. |
| **exhausted** | The retry budget ran out with no hand-off accepted. Default budget: three attempts, one second apart. | Delivery, from its own retry loop. | Yes, for delivery. The Result is unaffected. |

### Who may use which word

```text
CompletionDelivery (runtime)   pending · handed off · exhausted
SessionPushSink (host)         handed off · lost after hand-off · landed
widget (host)                  landed or not; exhausted or not — nothing finer
ResultStore (runtime)          knows nothing about notification state
```

**Fenced.** Boundary rule 19 forbids the word *landed* and its inflections in
`runtime/delivery.ts` **and in its test**, because the reading a maintainer
takes away is as much in a comment as in a name. It has the negative-case
fixture every rule in `boundaries.test.ts` has, and a positive one proving it
does not fire on the vocabulary that replaced the banned word. The delivery
module's API becomes:

| Today | Becomes |
| --- | --- |
| `DeliveryState.delivered: ReadonlySet<RunId>` — "ids that actually landed" | `DeliveryState.handedOff` — ids the sink accepted; landing is the sink's to report |
| `delivered(): Effect<readonly RunId[]>` | `handedOff()` |
| `const landed = yield* push(...)` | `const handedOff = yield* push(...)` |
| `exhausted()` | unchanged |

The push sink's `hasLanded`, `landed()`, `unlanded()`, and `onLanding` are
unchanged. They are correct.

### What does not change

- One landing per Notification. A landed notice is never pushed again.
- A lost notice is re-pushed once, after the parent settles, with the lost
  mark cleared before the push so a synchronous landing is not marked lost.
- Delivery's pin on the stored Result is released on hand-off, not on landing.
  Phase D's consumption lease revisits this on evidence; nothing here does.
- A notification failure of any kind cannot change or lose the stored Result.

---

## 2. What the notice carries

The notice is a small orientation message built from the stored Result and
nothing else. Today it copies the Result's identity, description, status,
preview, error, cancellation reason, the full `UsageSnapshot`, and the model.
It becomes:

| Field | Type | Bound | Derived from |
| --- | --- | --- | --- |
| `runId` | `RunId` | — | Result identity. |
| `subagentId` | `SubagentId` | — | Result identity. |
| `agent` | string | Profile name; already bounded by Profile loading. | Result identity. |
| `label` | string | One line, ≤ 200 UTF-8 bytes (`RUN_LABEL_MAX_BYTES`). | The Run's description, bounded once at admission (see §4). |
| `status` | `completed` \| `failed` \| `cancelled` | — | Result status. |
| `resultAvailability` | `full` \| `partial` \| `metadata-only` | — | See §3. |
| `preview` | string | One line, ≤ 500 bytes. | Result `finalOutput`. Unchanged. |
| `errorMessage` | string, optional | One line, ≤ 500 bytes. | Result primary error. Unchanged. |
| `cancellationReason` | optional | — | Result. Present exactly when cancelled. Unchanged. |
| `durationMillis` | number | — | Result `settledAt − startedAt`. The same reading the widget's settled row and the result card use. |
| `accounting` | `NotificationAccounting`, optional | Model ≤ 100 bytes. | Result usage totals and model, converted once. Absent when the Run reported nothing to account for. |
| `retrieveWith` | literal `"agent_result"` | — | Constant. |

**Removed:** `backendId` (nothing that formats a notice reads it, and its
absence is what makes "two backends, same sentence" structural), `description`
(replaced by `label`), `usage` (replaced by `accounting`), `model` (folded
into `accounting`).

```ts
interface NotificationAccounting {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly turns: number;
  readonly model?: string;
}
```

The notice remains **self-sufficient**: the host builds the message from this
value alone and never re-reads the store to say what the notice is about.

---

## 3. Result availability

Every terminal Run has a stored Result and every notice says how to get it.
The one thing the model needs to decide *whether* to get it is how much is
there.

| `resultAvailability` | When | What `agent_result` returns |
| --- | --- | --- |
| `full` | `status` is `completed`. | The whole stored Result. Its own truncation record says if bounding cut anything. |
| `partial` | `status` is `failed` or `cancelled`, and the Result has a non-empty `finalOutput` or a non-empty transcript. | What the Run produced before it ended. |
| `metadata-only` | `status` is `failed` or `cancelled`, and both `finalOutput` and the transcript are empty. | Identity, status, timestamps, usage, diagnostics. No output. |

A completed Run whose output was truncated by Result bounding is still `full`:
the Result is the whole of what was stored, and the truncation is reported
inside it. Availability describes the Result, not the Run's success.

---

## 4. The Run label

The description a model passes to `agent_start` and `agent_resume` is the Run's
label. It is identity, so Result bounding never removes it, and it is the one
Result field with no bound of its own today. That makes it the one input that
can carry a Result past its byte target after everything removable has been
cut, and the one input that can make the sink retain an unbounded value while a
notice waits to land.

**Decision.** The label is bounded at admission, before a Run exists:

- Collapsed to one line (newlines become spaces, trimmed).
- Truncated to at most 200 UTF-8 bytes, `RUN_LABEL_MAX_BYTES`, on a character
  boundary.
- A shortened label is **recorded**, in the truncate-and-record sense of
  contributing invariant 11: the Run carries a diagnostic saying its label was
  shortened and by how much, so the Result says so too. It is not refused; a
  label is orientation, and refusing a start over its length would cost the
  model a round trip for no safety gain.

The tool schemas' field description tells the model the bound, so a model that
reads the schema does not write a paragraph.

---

## 5. What the model reads

The expanded text of a notice, built by one function from `RunNotification`
alone. Four sections in a fixed order — **header, status body, pointer,
accounting** — and only the body varies by status. Sections are separated by a
blank line; an absent section leaves no blank.

### Header

```text
Subagent "<label>" <verb> in <duration>.
```

`<verb>` is `completed`, `failed`, or `was cancelled`. `<duration>` is
`formatDuration(durationMillis)`. For a cancelled Run the reason follows in
parentheses when present: `was cancelled in 1m 0s (timeout)`.

**Corrected at the Phase A gate.** The draft said the verb comes "from the
existing `runPhaseVerb` dictionary", and it cannot: `runPhaseVerb` answers
`cancelled`, because it exists to label a widget column and a column is a
label. A sentence needs `was cancelled`, since a Run does not cancel itself.
So `presentation/status.ts` gained a second dictionary, `NOTICE_VERB`, keyed
by the *terminal* phases alone — only a terminal Run has a notice, and a table
that had to invent a sentence for `running` would be inviting one to be
written. Two dictionaries in one module, each with one job, rather than one
column doing two.

Then the identity block, always:

```text
Agent: <agent>
Run: <runId>
Subagent: <subagentId>
```

### Status body

| Status | Body |
| --- | --- |
| completed, preview non-empty | `Preview from the subagent:` newline `"<preview>"` |
| completed, preview empty | `No output was produced.` |
| failed, error present | `Reason: <errorMessage>` |
| failed, no error | `Reason: none reported.` |
| cancelled | no body; the reason is in the header |

The preview is wrapped in straight double quotes and labelled as the
subagent's. Quoting is not a security boundary and does not claim to be; it
keeps delegated output out of the voice of orchestration instructions, so a
subagent that read hostile repository text does not get to address the parent
as if it were the runtime.

### Pointer

Always present. Exact argument shape, so the parent copies rather than
composes:

| `resultAvailability` | Pointer |
| --- | --- |
| `full` | `Full result is available. Call agent_result with {"id":"<runId>"}.` |
| `partial` | `Partial result is available. Call agent_result with {"id":"<runId>"}.` |
| `metadata-only` | `No output was produced. Call agent_result with {"id":"<runId>"} for the Run's record.` |

### Accounting

Present when the Run reported anything to account for; absent otherwise, and a
Run whose only usage was a cache read produces no line. Order and grammar are
the existing `formatNotificationAccounting`, fed from `NotificationAccounting`:

```text
cost $0.1242 · 12.3k in / 4.5k out · 3 turns · claude-opus-4-1
```

**Corrected at the Phase A gate.** The draft of this document illustrated the
line as `3 turns · 12.3k in / 4.5k out · $0.0421 · claude-opus-4-1`, which
contradicts the sentence above it: the order and grammar are the *existing*
`formatNotificationAccounting`, and the existing one puts the cost first.
[Ledger row N-9](presentation-ledger.md#n-9--accounting-line) and user story 9
— "the accounting line unchanged in content and grammar, so that a habit
learned on the release candidate still holds" — both require the existing
order, so the illustration was the defect and the code is right.

A line reading only a model name is never produced; a model identifies
accounting and is not accounting.

### Worked examples

```text
Subagent "audit auth redirects" completed in 41.2s.

Agent: reviewer
Run: run-k3f9-2
Subagent: subagent-k3f9-1

Preview from the subagent:
"Found two redirect-validation gaps in callback handling…"

Full result is available. Call agent_result with {"id":"run-k3f9-2"}.

cost $0.0421 · 12.3k in / 4.5k out · 3 turns
```

```text
Subagent "fix flaky cache test" failed in 19.4s.

Agent: implementer
Run: run-k3f9-4
Subagent: subagent-k3f9-3

Reason: the backend refused

Partial result is available. Call agent_result with {"id":"run-k3f9-4"}.
```

```text
Subagent "inspect the build graph" was cancelled in 1m 0s (timeout).

Agent: explore
Run: run-k3f9-5
Subagent: subagent-k3f9-4

Partial result is available. Call agent_result with {"id":"run-k3f9-5"}.

cost $0.0130 · 8.1k in / 1.2k out · 2 turns
```

The third example's duration reads `1m 0s` and not `60.0s`: `formatDuration`
switches to minutes at exactly sixty seconds, and every surface here uses that
one formatter rather than a second one.

---

## 6. What the human sees

### The collapsed transcript line

Today: agent, both ids, status verb, and a character count of the expanded
text. The ids are useful for tool calls and useless for recognising which task
finished; the character count is useless for both. It becomes:

```text
<agent> · <label> · <verb> in <duration>
```

```text
reviewer · audit auth redirects · completed in 41.2s
implementer · fix flaky cache test · failed in 19.4s
explore · inspect the build graph · cancelled in 1m 0s
```

Duration appears always, through the same `formatDuration` every other surface
uses — which is why the third line reads `1m 0s`: the formatter switches to
minutes at exactly sixty seconds, and a second formatter for this one line
would be a second answer to the same question.

**No cost, decided at the Phase A gate.** The draft appended
` · $<cost>` when the cost was non-zero. Cost is **not
backend-independent**: the Codex App Server reports token counts and no money,
so `codexUsageDelta` carries input, output, and the two cache counters and no
`cost` field at all. A cost on this line would therefore appear for every Pi
and Claude Run and never for a Codex one — which teaches the reader the
backend rather than the spend, and leaves them unable to tell a free Run from
an unreported one. It would also have made the compatibility matrix's "Same."
for all three backends false on the one cell that claims it.

Nothing is lost. What a Run spent is on the notice's accounting line, where
the four figures sit together and an absent cost is one absent figure among
four rather than the difference between two shapes of line. The host payload
drops the field too: a payload carrying something no renderer reads is the
mistake the notice made when it carried a backend id.

**The whole line is fitted, not just the label**, and the label is what gives:
it takes whatever the agent, the outcome, the cost, and the hint leave, capped
at 48 columns so a long label cannot push the outcome off a wide terminal's
line. Too narrow for even one column of label and the label gives way whole
rather than leaving `· ·` behind. The outcome never gives.

**Corrected at the Phase A gate.** The draft said "truncated to the terminal
width". There is no terminal width to truncate to: Pi's `MessageRenderOptions`
carries the expansion state and the output padding and no width, so a message
renderer cannot ask. The line is fitted to `NOTICE_SUMMARY_WIDTH`, eighty
columns, which is a convention and not a measurement — and it is a *parameter*
of `formatNotificationSummary`, so the day Pi hands a renderer a width there
is one call site to change. The expand hint is unchanged. The ids are in the
expanded text.

The message payload the host sends carries what this line needs — agent,
label, status, duration — alongside `runId` and `subagentId`, so the
renderer reads the payload and not the notice. The payload is host-shaped and
its schema is the host's; the notice's shape can change without touching it.

### The widget row

Unchanged by Phase A. The row keeps the Run until its notice lands, as the
matrix says. Phase C3 adds one state to what the row can say: when delivery is
**exhausted**, the row reads `completed · notification failed` with the Run id
and `result available`, so a settled row that will never leave on its own says
why. The widget learns this through a three-state read model —
`pending` | `landed` | `exhausted` — and nothing finer.

---

## 7. Diagnostics

`/subagent diagnostics` gains, in the delivery block, separate counts for:
pushes attempted, hand-offs accepted, hand-offs refused, notices lost after
hand-off, re-pushes, landings, exhaustions. Today's counters are kept; these
are additions. A counter that cannot distinguish a refused hand-off from a
lost one cannot say which half of the pipeline is failing.

---

## 8. What this document deliberately does not decide

- **Batching.** Up to `maxActiveRuns` notices can land close together. A
  host-only envelope that groups them is Phase D, on evidence from the soak,
  and would keep `RunNotification` one-per-Run.
- **When delivery's pin is released.** It is released on hand-off today and
  stays so. A consumption lease through landing is Phase D.
- ~~**Whether `/agents` disappears.**~~ **Decided, and against this
  document's draft.** The draft said Phase A adds `/subagent profiles`, keeps
  `/agents` as an alias, and leaves the removal to the first minor after 2.0.
  `/agents` is **removed in 2.0**.

  The reason is the reason the namespace exists. Two overlapping commands with
  nothing to say which to type first is the confusion Phase A was about, and
  an alias keeps that confusion under a deprecation note — an operator reading
  `/help` still sees two ways to list Profiles, and a maintainer still has two
  entry points to keep honest. Deferring the removal one minor buys a user the
  cost of relearning the name *twice*: once when the second way appears, again
  when the first goes.

  What it costs is real and is smaller than it looks: a 1.x user who types
  `/agents` gets Pi's unknown-command answer and has to learn
  `/subagent profiles`. Nothing inside the flow moved — the filter, the prompt
  view, the work action and every key are the ones they know — so what they
  relearn is a name and not a command. The
  [compatibility matrix](../v2/compatibility-matrix.md) marks it
  **[v2 change]**, which is the mechanism a removal is supposed to go through,
  and it is the one public surface 2.0 removes rather than preserves.
