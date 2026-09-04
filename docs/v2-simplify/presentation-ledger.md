# The simplification presentation ledger

**Status:** Confirmed at the Phase A gate. Every row names the golden that
asserts its after column, except W-2, which is Phase C's.

The v2 programme kept [a ledger of every textual difference between v1 and
v2](../v2/presentation-ledger.md) so that a changed sentence was a decision
somebody made rather than a decision nobody made. This is the same instrument
for the same reason, with one difference: v2's ledger compared two trees that
both existed, and this one compares the tree that exists with the text this
programme has decided to produce. The "after" column is the specification; the
Phase A gate turns it into a golden.

## How to read a row

**Before** is the current golden, quoted from the presentation tests. **After**
is what [notification semantics](notification-semantics.md) decides. **Why**
names the section that decided it. Every row is **intentional**; there is no
"nobody decided" category, because the after column was written before the
code. A row that lands differently from its after column is a defect in one or
the other and the gate says which.

Fixture values follow the presentation fixtures: agent `explore`, Subagent
`subagent-1`, Run `run-1`, a description of `look around`, and a Run that
started at 1,000 and settled 12,400 ms later, so every duration reads
`12.4s`. The draft of this document guessed a description of `look at the
thing` and a duration of `1.0s`; the fixtures already had a description, so
the after columns below use the fixtures' own values rather than changing
them, and the durations are what `formatDuration` produces from the fixtures'
two instants.

## Completion notices (model-facing text)

### N-1 · Completed, with output

**Before**

```text
Subagent explore (subagent-1), run run-1 completed.

done

Use agent_result with id run-1 to retrieve the full result.
```

**After**

```text
Subagent "look around" completed in 12.4s.

Agent: explore
Run: run-1
Subagent: subagent-1

Preview from the subagent:
"done"

The result is available. Call agent_result with {"id":"run-1"}.
```

**Why** — semantics §5: the label identifies the work, the ids move to the
identity block, the preview is labelled and quoted as subagent output, the
pointer carries the exact argument shape and the availability. The pointer
sentence shown is [N-10](#n-10--availability-vocabulary-phase-a-follow-up-a8)'s,
which replaced Phase A's `Full result is available.` at the Phase C gate.

### N-2 · Completed, no output

**Before** — `…completed.\n\nNo output was produced.\n\n<pointer>`

**After** — header and identity block as N-1, **no body**, and the record-only
pointer `No output was produced. The Run record is available. Call agent_result
with {"id":"run-1"}.`

**Why** — semantics §5, as revised for A8. Phase A's after column had a body
reading `No output was produced.` and then a pointer promising a full result;
[N-10](#n-10--availability-vocabulary-phase-a-follow-up-a8) is where that was
decided against, and this row now ships N-10's shape: the sentence is said
once, by the pointer.

### N-3 · Completed, long output

**Before** — preview bounded to 500 bytes; text under 700 bytes; pointer
present.

**After** — same bound on the preview; the quoting adds two bytes, the label
adds at most 200, and the identity block and pointer add their own fixed
lines, so the golden's ceiling moved from `+200` to `+400`. The test asserts
the preview's byte length exactly as it does today.

**Why** — semantics §2 (the preview bound is unchanged).

### N-4 · Failed, with reason and partial output

**Before**

```text
Subagent explore (subagent-1), run run-1 failed: the backend refused

Use agent_result with id run-1 to retrieve the full result.
```

**After**

```text
Subagent "look around" failed in 12.4s.

Agent: explore
Run: run-1
Subagent: subagent-1

Reason: the backend refused

Partial output is available. Call agent_result with {"id":"run-1"}.
```

**Why** — semantics §3 and §5: the fixture has `half an answer` as final
output, so availability is `partial`, and the pointer says so where before the
model had to know that failed Runs may keep output.

### N-5 · Failed, no reason reported

**Before** — `…failed: no reason reported\n\n<pointer>`

**After** — body `Reason: none reported.`; pointer by availability
(`record-only` when the fixture has no output:
`No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.`).

**Why** — semantics §3 and §5. The availability name and the sentence are
[N-10](#n-10--availability-vocabulary-phase-a-follow-up-a8)'s.

### N-6 · Failed, pathological error

**Before** — error bounded to 500 bytes; whole text under 700.

**After** — same error bound; the ceiling moved by the label, the identity
block, and the pointer, from `+200` to `+400`; the byte assertion on
`errorMessage` is unchanged.

**Why** — semantics §2 (the error bound is unchanged).

### N-7 · Cancelled, with reason and partial output

**Before**

```text
Subagent explore (subagent-1), run run-1 was cancelled (requested).
```

**After**

```text
Subagent "look around" was cancelled in 12.4s (requested).

Agent: explore
Run: run-1
Subagent: subagent-1

Partial output is available. Call agent_result with {"id":"run-1"}.
```

**Why** — semantics §3 and §5. **This is the one behavioural change in the
ledger**: a cancelled notice gains the pointer it deliberately lacked. The
current golden's comment says the model already knows the id it cancelled; the
semantics document answers that a timeout or a shutdown cancels too, and the
parent did not call either.

### N-8 · Backend independence

**Before** — three backends produce one identical text.

**After** — same assertion, and now structural: `backendId` is no longer on
the notice, so the test proves a property the type also guarantees.

**Why** — semantics §2.

### N-9 · Accounting line

**Before** — `cost $0.1242 · 12.3k in / 4.5k out · 3 turns · <model>`

**After** — unchanged text, fed from `NotificationAccounting` rather than
`UsageSnapshot`. The golden does not move.

**Why** — semantics §2 and §5. A model-only line is still never produced, and
now cannot be: a notice only carries an accounting value when at least one
figure is non-zero, so the formatter has no input that yields a model alone.

**A contradiction in the source documents, resolved here.** The semantics
document's worked examples illustrated the line as
`3 turns · 12.3k in / 4.5k out · $0.0421`, turns first. Its own sentence says
the order and grammar are the *existing* `formatNotificationAccounting`, which
puts the cost first, and user story 9 asks for the line "unchanged in content
and grammar, so that a habit learned on the release candidate still holds".
Unchanged wins; the illustrations were the defect and have been corrected in
[semantics §5](notification-semantics.md#accounting).

### N-10 · Availability vocabulary (Phase A follow-up, A8)

**Before** — three pointer sentences keyed by `full` / `partial` /
`metadata-only`, with every completed Run `full`:

```text
Full result is available. Call agent_result with {"id":"run-1"}.
Partial result is available. Call agent_result with {"id":"run-1"}.
No output was produced. Call agent_result with {"id":"run-1"} for the Run's record.
```

and a completed Run with no output reading `No output was produced.` in the
body and then `Full result is available.` in the pointer.

**After** — three sentences keyed by `complete` / `partial` / `record-only`,
the values read off the output rather than the status:

```text
The result is available. Call agent_result with {"id":"run-1"}.
Partial output is available. Call agent_result with {"id":"run-1"}.
No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.
```

A completed Run with no output has no body and the record-only pointer, so
"no output was produced" is said once. A completed Run with an empty final
output and a transcript is `partial`. The call keeps its exact argument shape
and its own sentence in all three.

**Why** — semantics §3 and §5 as revised at the Phase B close. "Full result"
tells a model an answer is waiting; for an empty completed Run there is none.
Rows N-1, N-2, N-4, N-5 and N-7 read their pointer through this row from the
Phase C gate on.

## Collapsed transcript summary (human-facing)

### S-1 · Summary line

**Before** — `explore (subagent subagent-1, run run-1) completed · 1.2k chars`
plus the expand hint.

**After** — `reviewer · audit auth redirects · completed in 41.2s` plus the
expand hint. The duration comes from the shared `formatDuration`, so it reads
`41.2s` rather than `41s`.

**No cost, and this row is where the decision is recorded.** The draft
appended ` · $<cost>` when non-zero. Cost is not backend-independent — the
Codex App Server reports token counts and no money — so the line would have
shown a cost for every Pi and Claude Run and never for a Codex one, teaching
the reader the backend rather than the spend. What a Run spent stays on the
notice's accounting line. See
[semantics §6](notification-semantics.md#6-what-the-human-sees).

**Why** — semantics §6. The ids are in the expanded text; the character count
told the reader nothing they could act on.

### S-2 · Failed and cancelled summaries

**Before** — same shape as S-1 with the verb changed.

**After** — `implementer · fix flaky cache test · failed in 19.4s`;
`explore · inspect the build graph · cancelled in 1m 0s`. The second is the
shared duration formatter's own reading: it switches to minutes at exactly
sixty seconds, and the notice uses that formatter rather than a second one.

**Why** — semantics §6.

## Widget rows

### W-1 · Live and settled rows

**Before and after** — unchanged in Phase A. The matrix's row-lifetime and
settled-duration cells stand.

### W-2 · Exhausted notice (Phase C)

**Before** — a settled row whose notice exhausted its retries stays with no
indication.

**After** — `completed · notification failed` with the Run id and `result
available`.

**Why** — semantics §6, Phase C3. Recorded here so the Phase C gate has a row
to confirm.

### W-3 · Row resolves on retrieval (Phase C)

**Before** — a settled row stays until its notice lands, whatever the parent
does; a parent that called `agent_result` at once still sees the row wait for
the landing.

**After** — the row goes when the hand-off resolves: the notice landed *or*
`agent_result` returned the Result, whichever first. The row's text does not
change; only its lifetime does. An exhausted row (W-2) also goes on
retrieval.

**Why** — semantics §1 *Consumption* and §6, Phase C3; ADR-0035. The matrix's
row-lifetime cell is updated with this row.

## Operator commands

### C-1 · `/subagent`

**Before** — prints every runtime and adapter counter and probe.

**After** — a shallow status. Two lines, then the Profiles, then the way
deeper:

```text
Subagents: 2 Profiles · 1 running, 2 completed, 1 failed
Runtime: healthy · 0 held

  explore   pi
  reviewer  claude

/subagent profiles — list Profiles and read their prompts
/subagent diagnostics — runtime counters and cleanup probes
```

Run counts come from the shared phase vocabulary, so a status line and a
widget row use one set of words. Health is a verdict on the counters —
"healthy" is "nothing noticed" — and a *count* of the probe rather than a
verdict on it, because a live Session holds a fiber per Run and a repository
subscription for its widget on purpose. The counters are behind
`/subagent diagnostics`, unchanged.

**Why** — roadmap A4.

### C-2 · `/agents`

**Before** — a registered command listing Profiles and opening their prompts.

**After** — **removed in 2.0.** Not registered, so Pi answers it as an unknown
command. Its flow is `/subagent profiles`, key for key: the filter, the prompt
view, the work action and every key are unchanged, so what a 1.x user relearns
is a name and not a command.

**Why** — roadmap A4, and the decision recorded in
[semantics §8](notification-semantics.md#8-what-this-document-deliberately-does-not-decide),
which reverses this ledger's draft. The draft kept `/agents` as an alias
through 2.0. An alias keeps two ways to list Profiles in `/help` and two entry
points for a maintainer to keep honest — which is the confusion Phase A was
about — and it makes the user relearn the name twice: once when the second way
appears and again when the first goes. It is the one public surface 2.0 removes
rather than preserves, and the compatibility matrix marks it **[v2 change]**.

### C-3 · `/subagent` health line (Phase A follow-up, A6)

**Before** — `Runtime: healthy · 4 held` when every counter is zero;
`Runtime: 22 counted · 4 held — /subagent diagnostics` for any non-zero
counter, including the ones the debugging guide documents as expected to rise.

**After** — `Runtime: healthy · 4 held` when no *defect* or *incident* counter
is non-zero, however many expected counters have risen;
`Runtime: attention needed · 1 defect · 2 incidents · 4 held — /subagent
diagnostics` otherwise, naming only the non-zero classes.

**Why** — roadmap A6. The taxonomy the guide already states moves into
`runtime/counters.ts` as an exhaustive classification, and the shallow status
judges by it rather than by a sum.

## Tool schema copy

### T-1 · The description field

**Before** — `Label for this specific Run` / `Label for this new Run`.

**After** — the same, followed by the bound: `; one line, at most 200 bytes,
shortened if longer`. It states what happens past the bound as well as the
bound, so nothing invites a retry.

**Why** — semantics §4. A model that reads the schema does not write a
paragraph.

## Confirmation

Filled in at the Phase A gate: for each row, the golden that now asserts its
after column, by test name and file.

| Row | Golden | File | Status |
| --- | --- | --- | --- |
| N-1 | `N-1: a completed notice labels and quotes the preview, then points at the result` | `presentation/notification-text.test.ts` | confirmed — the pointer sentence is N-10's since the Phase C gate |
| N-2 | `N-2: a completed Run with no output has no body, and its record is available` | `presentation/notification-text.test.ts` | confirmed — rewritten at the Phase C gate: the body is gone and the pointer says it once |
| N-3 | `N-3: a long answer is previewed rather than delivered` | `presentation/notification-text.test.ts` | confirmed |
| N-4 | `N-4: a failed notice states its reason and says partial output is there` | `presentation/notification-text.test.ts` | confirmed — reads its pointer through N-10 |
| N-5 | `N-5: a failed Run with no reason and no output says both` | `presentation/notification-text.test.ts` | confirmed — reads its pointer through N-10 |
| N-6 | `N-6: a failed notice bounds a pathological error message` | `presentation/notification-text.test.ts` | confirmed |
| N-7 | `N-7: a cancelled notice names its reason and points at the partial output`; `a cancelled Run with nothing to show says so and still points at the record` | `presentation/notification-text.test.ts` | confirmed — reads its pointer through N-10 |
| N-8 | `N-8: the notice is identical whichever backend ran the Run` | `presentation/notification-text.test.ts` | confirmed — now structural: the notices are one value, and the shape has no `backendId` |
| N-9 | `N-9: a Run with nothing to account for carries no accounting at all`; `N-9: the accounting a notice carries is only what the line prints`; `N-9: an accounting line can never read as nothing but a model name`; `accounting abbreviates usage and names the model last` | `presentation/notification-text.test.ts` | confirmed — the text did not move |
| S-1 | `S-1: a collapsed notice names the agent, the task, and the outcome`; `S-1: the collapsed line reads the same whichever backend ran the Run`; `a collapsed notice carries no id and no character count` | `presentation/renderers.test.ts` | confirmed |
| S-1 (ids) | `S-1: the ids are in the expanded text, where a tool call needs them` | `host/notification-message.test.ts` | confirmed |
| S-2 | `S-2: a failed and a cancelled summary read the same way, with the verb changed` | `presentation/renderers.test.ts` | confirmed |
| C-1 | `C-1: bare /subagent prints the shallow status and no counters`; `C-1: the status names every Profile with the backend it names`; `C-1: the status counts Runs in the shared phase vocabulary` | `host/diagnostics-command.test.ts` | confirmed |
| C-2 | `C-2: /subagent is the only command, and /agents is gone`; `C-2: /subagent profiles opens the Profile flow`; `the Profile flow registers no command of its own`; `the entry point registers the six tools, its one command, and the notification renderer` | `host/diagnostics-command.test.ts`; `host/agents-command.test.ts`; `index.test.ts` | confirmed |
| T-1 | `T1: the label's bound is stated on both description fields` | `host/tool-schemas.test.ts` | confirmed |
| W-1 | the row-lifetime and settled-duration tests, unmodified | `host/widget.test.ts`; `presentation/rows.test.ts` | confirmed unchanged |
| W-2 | — | — | Phase C |
| W-3 | — | `host/widget.test.ts` | Phase C |
| N-10 | `N-10: the pointer says what a model will find, in each of the three availabilities`; `N-10: availability is read off the output, not off the status alone`; `N-2: a completed Run with no output has no body, and its record is available` | `presentation/notification-text.test.ts` | confirmed at the Phase C gate |
| C-3 | `C-3: a Session whose only raised counters are expected ones is healthy`; `C-3: the health line names the non-zero classes, worst first`; `C-3: a counter the host does not recognise is named rather than ignored`; `health is a verdict on what was noticed and a count of what is held` | `host/diagnostics-command.test.ts` | confirmed at the Phase C gate |

Two rows landed differently from their drafted after column, and the
difference is in the fixtures rather than in the code:

- **The description and the durations.** The draft assumed the fixtures would
  gain a description of `look at the thing`; they already had `look around`,
  and a fixture Run that takes 12,400 ms. Changing the fixture would have
  moved every widget and card golden for no gain, so the after columns use the
  fixtures' values. The gate reads the columns as corrected.
- **`cancelled in 1m 0s`, not `60s`.** The shared duration formatter switches
  to minutes at exactly sixty seconds. The notice and the summary use that
  formatter rather than a second one, which is the decision; the sketch in the
  draft was written without checking it.
