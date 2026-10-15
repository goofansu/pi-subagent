# 40. Delivered Results carry the final output for external readers

Date: 2026-10-15

## Status

Accepted.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — the
  Notification is built from the stored Result, after storage. The answer it
  now carries as a fact is that Result's final output, so it cannot disagree
  with `agent_result`.
- [ADR-0037](0037-a-notice-carries-a-short-output-whole.md) — a notice
  carries the retained value whole only when it fits
  `NOTIFICATION_INLINE_MAX_BYTES`, and previews it otherwise. The fact follows
  the same rule and says which form it took.
- [ADR-0039](0039-delivered-results-carry-run-usage-for-external-readers.md)
  — the same two payloads, the same reader, the same compatibility rule:
  additive keys, optional on read, written on every delivery, keyed by Run id
  across both channels.

## Context

An external reader of a Pi Session — Piano, over Pi's RPC mode — draws a
transcript row for every Subagent event from the `details` this extension
attaches to its tool results and to its `subagent-notification` message.
Identity, status, duration, usage and model are structured there, so the
reader renders them itself. The Run's answer was not: it reached the reader
only as prose, fenced under `Output from the subagent:` between a header
sentence, three identity lines, an explanation and an accounting line, or
wrapped in status context in an `agent_result` or wait text. A reader that
wanted to show only the answer, or only a status note, had to parse that prose
back apart — and the prose is written for the model, so its shape is not a
contract.

The domain already interprets the final output once, for every surface:
`interpretFinalOutput` on a Result and `notificationFinalOutputOf` on a
notice, yielding the four retention kinds (absent, retained, retained prefix,
removed), the removed byte count, and whether transcript evidence survives.
The final-output section already decides which failure reason and which
cancellation reason the prose prints. Nothing new had to be decided; it had
to be carried.

## Decision

> The `details` on both structured channels carry the delivered Run's final
> output and how the Run ended, as facts: each `ResultRunSummary` in tool-row
> facts (`agent_result`, `agent_wait`, `agent_wait_all`) and
> `NotificationDetails`. The model-visible prose is unchanged.

The shape, spread into both payloads from one shared declaration:

```ts
finalOutput?:
  | { kind: "absent"; hasTranscriptEvidence: boolean }
  | { kind: "removed"; removedBytes: number; hasTranscriptEvidence: boolean }
  | { kind: "retained"; text: string }
  | { kind: "retained"; preview: string }
  | { kind: "retained-prefix"; removedBytes: number; text: string }
  | { kind: "retained-prefix"; removedBytes: number; preview: string }
failure?: string
cancellationReason?: "requested" | "shutdown" | "timeout"
```

And on `ResultRunSummary` alone, because `NotificationDetails` already had it:

```ts
durationMillis?: number
```

- **The four kinds are the domain's four words** for Final output retention.
  A reader learns absence, removal and a cut prefix the way the prose says
  them, without a sentence to match.
- **`text` is the whole retained value, byte for byte what the prose
  fences.** On a tool result it is the Result's bounded final output. On a
  Notification it is the value the notice inlined. It is the agent's Markdown
  untouched, exactly as the content carries it.
- **`preview` is carried only when the content previews.** A Notification for
  an answer over the inline bound carries the same bounded one-line preview the
  content quotes, under `preview` rather than `text`, so a reader cannot
  mistake it for the answer. Presence is the discriminant, as it is on the
  notice itself (ADR-0037). The whole value is then in the Result and nowhere
  else; `agent_result` fetches it, and a reader that needs it does the same.
- **Transcript evidence is stated only where no output remains.** For a
  retained kind it is not inferable from the notice and is not invented, which
  keeps one shape across both channels.
- **The reasons live beside `status`, not inside the output fact.** `failure`
  is present for a failed Run that reported a non-empty reason; it is the
  value the prose prints after `Reason:` — the Notification's bounded one on
  that channel, the Result's primary failure on the other.
  `cancellationReason` is present exactly when the Run was cancelled, and is
  the reason the header prints in parentheses. They describe the ending, not
  the output, and a reader looking for the status note looks next to the
  status.
- **The tool channel's summary also carries `durationMillis`.** The
  Notification's details carried the Run's duration since ADR-0033's collapsed
  line needed it; the tool summaries did not, so a reader could show a
  tool-delivered Run's duration only by parsing "completed in 3.1s" out of
  the prose. It is the same reading the notice header, the widget row and the
  card share, through the completion view, so every channel prints one number.
- **`finalOutput` is optional on read.** A session persisted by an older
  extension still decodes under `EXACT_KEYS`. Every payload built here writes
  it. An older Piano ignores the new keys; a newer one falls back to the raw
  content when they are missing.
- **Each channel's facts are its own prose's values**, and the two channels
  agree up to two rules: the text-or-preview rule above, and the failure rule,
  under which a Notification carries its bounded `errorMessage` and a tool
  result carries the Result's primary failure, which falls back to a failure
  diagnostic when the error message is empty. So a failed Run whose only
  reason is a diagnostic has `failure` on `agent_result` and none on its
  Notification. `finalOutput` and `cancellationReason` are identical on both.
  The Result is immutable, so a reader keys the facts by Run id and keeps one
  entry per Run, whichever channel arrived; when both a tool result and a
  Notification would describe a Run, only one does (ADR-0036), so there is no
  second copy to reconcile.

One presentation module, `final-output-facts.ts`, owns the Schema fragment and
the two builders. It reshapes the domain's interpretation and the final-output
section's framing; it decides nothing. The two payload schemas spread the
fragment in, so the Notification and the tool-row facts cannot carry two
shapes for one fact.

## Alternatives considered

- **A flat struct with every key optional**, as first proposed. Easier to
  declare, but it cannot say that a retained kind carries exactly one of
  `text` and `preview`, and a reader would have to know the rule from the
  prose. The union states it.
- **The whole value on the Notification regardless of the inline bound.** The
  domain notice does not carry it (`toRunNotification` drops it past the
  bound), and ADR-0037's reason for the bound is the parent's context; a
  structured copy would not cost context, but it would make the Notification
  the one channel where a persisted payload is unbounded. The Result is the
  authoritative home of a long answer.
- **The reasons inside the output fact**, as first proposed. Grouping "what
  became of it" with the output reads well in a sentence and badly in a
  schema: a reader of `status: "failed"` would look for the reason beside the
  status and find it under the output.
- **Two declarations, one per payload**, as ADR-0039 did for usage. The usage
  struct is five numbers; this fact is a six-member union, and two copies of it
  would drift.

## What it costs

- Three optional keys on `ResultRunSummary` and on `NotificationDetails`, a
  fourth on `ResultRunSummary` for the duration, one new presentation module,
  and one test file per seam.
- The persisted size of each delivered-Run summary grows by the retained
  answer, which the tool result's content already carries once; the
  Notification's details grow by at most the inline bound. A session file
  with many long delegations gets larger by about the answers again.
- Model-visible text, the collapsed rows and the golden outputs are
  unchanged.

## What breaks if it is wrong

An older extension reopening a session written by this one would reject the
new keys in tool-row facts under `EXACT_KEYS`, so those rows would lose their
facts; a landed Notification is decoded leniently and is unaffected. That
matters only after a downgrade, exactly as it did for ADR-0039.

If a fact and the prose beside it ever disagreed, `final-output-surfaces.test.ts`
is where it would show: it asserts, for every retention kind and ending, that
the fact on both channels is the text the Result card prints and the notice
fences.

## Amendment — 2026-10-15

`ResultRunSummary` also carries `subagentId` and `label`, both optional on
read and written on every delivery, under the same compatibility rule. The
Notification details had carried both from ADR-0033; the tool channel's
summary had not, so a reader that keys Runs to their Subagent could do so
only by having seen the Run's `agent_start` result at the top level. A start
made inside a codemode call is nested where such a reader does not look, and
a multi-Run `agent_wait_all` then showed Run ids without Subagent ids while a
single Run showed both. The values are the stored Result's `subagentId` and
bounded `description`, so both channels agree byte for byte.
