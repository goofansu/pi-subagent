# The simplification presentation ledger

**Status:** Rows drafted from the current goldens and
[the notification semantics](notification-semantics.md). **To be confirmed**
against the updated goldens when Phase A closes; the Phase A gate cites this
document.

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
`subagent-1`, Run `run-1`, and a description the fixtures will need to gain,
taken here as `look at the thing`.

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
Subagent "look at the thing" completed in 1.0s.

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

**After** — same bound on the preview; the quoting adds two bytes and the
label adds at most 200; the golden's ceiling moves accordingly and the test
asserts the preview's byte length exactly as it does today.

**Why** — semantics §2 (the preview bound is unchanged).

### N-4 · Failed, with reason and partial output

**Before**

```text
Subagent explore (subagent-1), run run-1 failed: the backend refused

Use agent_result with id run-1 to retrieve the full result.
```

**After**

```text
Subagent "look at the thing" failed in 1.0s.

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

**After** — same error bound; the ceiling moves by the label and identity
block; the byte assertion on `errorMessage` is unchanged.

**Why** — semantics §2 (the error bound is unchanged).

### N-7 · Cancelled, with reason and partial output

**Before**

```text
Subagent explore (subagent-1), run run-1 was cancelled (requested).
```

**After**

```text
Subagent "look at the thing" was cancelled in 1.0s (requested).

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

**Why** — semantics §2 and §5. A model-only line is still never produced.

## Collapsed transcript summary (human-facing)

### S-1 · Summary line

**Before** — `explore (subagent subagent-1, run run-1) completed · 1.2k chars`
plus the expand hint.

**After** — `explore · look at the thing · completed in 1s · $0.042` plus the
expand hint; cost omitted when zero.

**Why** — semantics §6. The ids are in the expanded text; the character count
told the reader nothing they could act on.

### S-2 · Failed and cancelled summaries

**Before** — same shape as S-1 with the verb changed.

**After** — `implementer · fix flaky cache test · failed in 19s`;
`explore · inspect the build graph · cancelled in 60s`.

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

**After** — a shallow status: profile count, running, completed, runtime
health, one line per Profile with its backend, and the two subcommands. The
counters are behind `/subagent diagnostics`.

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
shortened if longer`.

**Why** — semantics §4. A model that reads the schema does not write a
paragraph.

## Confirmation

To be filled in at the Phase A gate: for each row, the golden test that now
asserts the after column, by test name and file.

| Row | Golden | Status |
| --- | --- | --- |
| N-1 … N-9 | | not yet |
| S-1, S-2 | | not yet |
| C-1, C-2 | | not yet |
| T-1 | | not yet |
| W-2 | | Phase C |
