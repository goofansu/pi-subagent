# 39. Delivered Results carry Run usage for external readers

Date: 2026-10-11

## Status

Accepted.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — the
  Notification is built from the stored Result, after storage. The usage it
  now carries is that Result's usage, so it cannot disagree with
  `agent_result`.
- [ADR-0027](0027-v2-usage-normalization.md) — usage is Run-local and resume
  never re-charges earlier Conversation usage. Each payload carries one Run's
  figures; summing Runs is the reader's job, and nothing here pre-aggregates.
- [ADR-0036](0036-a-wait-delivers-the-result-it-waited-for.md) — a Result is
  delivered by a wait, by `agent_result`, or by the Notification, and a
  delivered Result is consumed so no Notification follows it. That is why both
  channels must carry the figures.

## Context

An external reader of a Pi Session — Piano, over Pi's RPC mode — wants to show
Subagent spend per Profile beside the main Session's cost. Every figure it
needs is already on the Result: the `UsageTotals` counters and cost, and the
model the Run reported. None of it was on either structured payload a reader
can parse. The tool-row facts of `agent_result`, `agent_wait` and
`agent_wait_all` carried Run id, Profile and status; the Notification's details
carried identity, label, status and duration, and its header comment argued
cost out because the collapsed TUI line did not show one.

Neither channel alone sees every Run. A Run a wait or `agent_result` delivers
first sends no Notification; a Run nobody waits for is announced only by the
Notification.

Pi has a third channel: an extension tool's result may set `usage`, and Pi adds
it to the Session's totals.

## Decision

> The `details` on both structured channels carry the delivered Run's usage:
> each `ResultRunSummary` in tool-row facts, and `NotificationDetails`.
> Pi's native tool-result `usage` field is deliberately not set.

The shape, in Pi core's field names so a reader can reuse its own usage rows:

```ts
usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
model?: string
```

- **Cost is USD and unrounded.** A reader summing Runs must not accumulate
  rounding error. `NotificationAccounting` carries the unrounded cost, and the
  accounting line is the one place it is rounded to four places. Whether there
  was anything to account for is still decided on the rounded figure.
- **No turns, no context gauge, no total.** A reader derives total tokens
  itself; the gauge is Run-local and must never be summed (ADR-0027).
- **`usage` is optional on read.** A session persisted by an older extension
  still decodes under `EXACT_KEYS`. Tool-row facts always write it. The
  Notification omits it, with `model`, when the Run spent nothing — the same
  rule that leaves such a notice without an accounting line.
- **`model` is optional** because it is optional on the Result, and is bounded
  to `NOTIFICATION_MODEL_MAX_BYTES` on both channels so they name the same
  model.
- **Every delivery of one Run carries identical usage.** The Result is
  immutable, so a reader keys the figures by Run id and keeps one entry per
  Run, whichever channel arrived.

## Alternatives considered

- **Pi's native tool-result `usage`.** Pi sums it per delivery, so a wait
  followed by `agent_result` would double count unless the host kept a new
  consume-once record per Run across deliveries. A custom message has no such
  field, so a Run announced only by its Notification could never be counted.
  It names neither Run nor Profile, so it cannot feed a per-Profile view. And
  it would fold Subagent spend into the Session's own totals, which the reader
  keeps main-only to match Pi's `/session`.
- **Usage on one channel only.** Misses every Run the other channel delivered.
- **Pre-aggregated Subagent or Profile totals.** New state the extension does
  not otherwise need, and wrong across a resumed Conversation unless it repeats
  ADR-0027's rules; per-Run figures let the reader sum correctly.

## What it costs

- Two optional keys on `ResultRunSummary` and on `NotificationDetails`; two
  counters on `NotificationAccounting`.
- The persisted size of each delivered-Run summary and each Notification grows
  by a few numbers.
- Model-visible text and the collapsed rows are unchanged.

## What breaks if it is wrong

An older extension reopening a session written by this one would reject the
new keys in tool-row facts under `EXACT_KEYS`, so those rows would lose their
facts; a landed Notification is decoded leniently and is unaffected. That
matters only after a downgrade.
