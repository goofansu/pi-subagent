# Phase C exit gate — resource lifetime polish

**Status: not started.** C1 is blocked on Phase B's admission extraction. C3
and C4 depend on nothing and may land while Phase B is in progress.
**Verified against:** [the roadmap](roadmap.md), Phase C;
[the notification semantics](notification-semantics.md) §6 and §7;
[the freeze](freeze.md), rows F6 and F10.

## The deterministic gate

```
npm run check   →  exit 0
```

**Status:** OPEN.

## The items

### 1. Admission capacity is returned by scope closing

The Run fiber acquires its admission lease with `Effect.acquireRelease` and
the release is a finalizer of the Run Scope. No procedural release call
remains in the supervisor. The stress lane's zero probe still holds after
hundreds of cycles including rejected and failed starts.

**Status:** OPEN.

### 2. The acquire/release audit is recorded

For each remaining pair — subscription start/unsubscribe, delivery
claim/recovery sweep, the three store pins — this gate records whether it was
converted to a scoped resource and, if not, why the release has more than one
correct moment. The three named pins are recorded as deliberately unconverted
(freeze F6).

| Pair | Converted? | Why or why not |
| --- | --- | --- |
| admission claim/release | yes (item 1) | |
| subscription start/unsubscribe | | |
| delivery claim/recovery sweep | | |
| store pin `publication` | no | F6 |
| store pin `waiters` | no | F6 |
| store pin `delivery` | no | F6 |

**Status:** OPEN.

### 3. The widget sees three notice states and nothing finer

The widget's landing dependency is a read model with `status(runId)` returning
`pending`, `landed`, or `exhausted`, and a `subscribe`. The sink tracks
handed-off, lost, and attempt counts internally and does not expose them to
the widget.

**Evidence to name:** `host/widget.test.ts`; the widget's dependency type.

**Status:** OPEN.

### 4. An exhausted notice is visible

A settled Run whose delivery exhausted its retry budget shows a row reading
`completed · notification failed` with its Run id and `result available`.
Ledger row W-2 is confirmed with the golden that asserts it.

**Status:** OPEN.

### 5. Diagnostics distinguish the delivery failures

`/subagent diagnostics` reports pushes attempted, hand-offs accepted, hand-offs
refused, notices lost after hand-off, re-pushes, landings, and exhaustions as
separate counts. After a Session closes every one still reads, and the probes
read zero.

**Status:** OPEN.

### 6. One completion view for terminal presentation

A presentation-only type carrying Run id, Subagent id, agent, label, status,
and duration is derived from `RunSnapshot`, `RunResult`, and
`RunNotification` by one function each, and the widget's settled row, the
result card, and the notice header all print their status and duration through
it. The settled-duration goldens still pass.

**Status:** OPEN.

### 7. The bounds lane covers the exhausted projection

`runtime/bounds.test.ts` or `host/push-sink.test.ts` drives delivery past its
retry budget and asserts the projection reads `exhausted` and the Result is
untouched.

**Status:** OPEN.

### 8. Race and stress lanes pass unchanged

**Status:** OPEN.

### 9. Host smoke re-run

The widget changed. `pi:host-smoke`, `claude:host-smoke`, and
`codex:host-smoke` are run on the closing commit.

**Status:** OPEN.

### 10. The change-surface table is re-measured

R4 (display-only widget column) must still read zero generic modules.

**Status:** OPEN.

## Verdict

To be written when verified.
