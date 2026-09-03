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

Full result is available. Call agent_result with {"id":"run-1"}.
```

**Why** — semantics §5: the label identifies the work, the ids move to the
identity block, the preview is labelled and quoted as subagent output, the
pointer carries the exact argument shape and the availability.

### N-2 · Completed, no output

**Before** — `…completed.\n\nNo output was produced.\n\n<pointer>`

**After** — header and identity block as N-1, body `No output was produced.`,
pointer `Full result is available. Call agent_result with {"id":"run-1"}.`

**Why** — semantics §5. A completed Run's Result is full even when its output
is empty.

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

Partial result is available. Call agent_result with {"id":"run-1"}.
```

**Why** — semantics §3 and §5: the fixture has `half an answer` as final
output, so availability is `partial`, and the pointer says so where before the
model had to know that failed Runs may keep output.

### N-5 · Failed, no reason reported

**Before** — `…failed: no reason reported\n\n<pointer>`

**After** — body `Reason: none reported.`; pointer by availability
(`metadata-only` when the fixture has no output:
`No output was produced. Call agent_result with {"id":"run-1"} for the Run's record.`).

**Why** — semantics §3 and §5.

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

Partial result is available. Call agent_result with {"id":"run-1"}.
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

## Collapsed transcript summary (human-facing)

### S-1 · Summary line

**Before** — `explore (subagent subagent-1, run run-1) completed · 1.2k chars`
plus the expand hint.

**After** — `reviewer · audit auth redirects · completed in 41.2s · $0.042`
plus the expand hint; cost omitted when zero. The duration comes from the
shared `formatDuration`, so it reads `41.2s` rather than `41s`.

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

**Before and after** — unchanged output; also reachable as
`/subagent profiles`. The alias is removed in the first minor after 2.0 and the
compatibility matrix says so.

**Why** — roadmap A4.

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
| N-1 | `N-1: a completed notice labels and quotes the preview, then points at the full result` | `presentation/notification-text.test.ts` | confirmed |
| N-2 | `N-2: a completed Run with no output says so, and its Result is still full` | `presentation/notification-text.test.ts` | confirmed |
| N-3 | `N-3: a long answer is previewed rather than delivered` | `presentation/notification-text.test.ts` | confirmed |
| N-4 | `N-4: a failed notice states its reason and says partial output is there` | `presentation/notification-text.test.ts` | confirmed |
| N-5 | `N-5: a failed Run with no reason and no output says both` | `presentation/notification-text.test.ts` | confirmed |
| N-6 | `N-6: a failed notice bounds a pathological error message` | `presentation/notification-text.test.ts` | confirmed |
| N-7 | `N-7: a cancelled notice names its reason and points at the partial result`; `a cancelled Run with nothing to show says so and still points at the record` | `presentation/notification-text.test.ts` | confirmed |
| N-8 | `N-8: the notice is identical whichever backend ran the Run` | `presentation/notification-text.test.ts` | confirmed — now structural: the notices are one value, and the shape has no `backendId` |
| N-9 | `N-9: a Run with nothing to account for carries no accounting at all`; `N-9: the accounting a notice carries is only what the line prints`; `N-9: an accounting line can never read as nothing but a model name`; `accounting abbreviates usage and names the model last` | `presentation/notification-text.test.ts` | confirmed — the text did not move |
| S-1 | `S-1: a collapsed notice names the agent, the task, the outcome, and the cost`; `a collapsed notice carries no id and no character count` | `presentation/renderers.test.ts` | confirmed |
| S-1 (ids) | `S-1: the ids are in the expanded text, where a tool call needs them` | `host/notification-message.test.ts` | confirmed |
| S-2 | `S-2: a failed and a cancelled summary read the same way, with the verb changed` | `presentation/renderers.test.ts` | confirmed |
| C-1 | `C-1: bare /subagent prints the shallow status and no counters`; `C-1: the status names every Profile with the backend it names`; `C-1: the status counts Runs in the shared phase vocabulary` | `host/diagnostics-command.test.ts` | confirmed |
| C-2 | `C-2: /subagent profiles opens the same flow /agents opens`; `the agents command registers itself once, with a description` | `host/diagnostics-command.test.ts`; `host/agents-command.test.ts` (unmodified) | confirmed |
| T-1 | `T1: the label's bound is stated on both description fields` | `host/tool-schemas.test.ts` | confirmed |
| W-1 | the row-lifetime and settled-duration tests, unmodified | `host/widget.test.ts`; `presentation/rows.test.ts` | confirmed unchanged |
| W-2 | — | — | Phase C |

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
