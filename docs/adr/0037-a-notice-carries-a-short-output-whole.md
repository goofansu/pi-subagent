# 37. A notice carries a short output whole

Date: 2026-09-05

## Status

Accepted.

**Amends [ADR-0006](0006-completion-notifications-and-result-store.md)** in
one respect: a completion notice carries the Run's output whole when the
output fits a size bound, and previews it — as ADR-0006 decided — only when it
does not. Everything else ADR-0006 decided stands: storage precedes
notification, the Result store is authoritative, and `agent_result` returns the
stored Result. **Amends
[ADR-0033](0033-notification-vocabulary-pointer-and-label-bound.md)** in one
respect: the universal pointer gains an inlined form. Both entries carry a
status note pointing here.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — the notice
  is built from the stored Result, after storage, and cannot say something
  `agent_result` would contradict. An inlined output is the stored
  `finalOutput`, untouched.
- [ADR-0033](0033-notification-vocabulary-pointer-and-label-bound.md) — every
  terminal notice carries a pointer with the exact argument shape. It still
  does; the inlined form changes its verb, not its presence.
- [ADR-0036](0036-a-wait-delivers-the-result-it-waited-for.md) — a wait
  delivers the Result and no notice follows. This entry is the other half of
  the same picture: the automatic path delivers too, when it can.

## Context

ADR-0036 made the wait deliver the Result it waited for, and the copy now tells
the model that a completion is delivered automatically, so its default after
`agent_start` is other work. That leaves the automatic path as the common
one — and on the automatic path the model was still handed a 500-byte preview
and told to call `agent_result` for the answer.

For most delegated tasks that is a fetch for its own sake. A subagent's answer
is usually a summary, a finding, or a plan: a few hundred to a few thousand
bytes. The preview showed the first line of it, the model called `agent_result`
to read the rest, and the round trip cost a tool call and a turn to deliver
what would have fit in the notice.

ADR-0006 chose the preview to bound context cost on large fan-outs, and the
reasoning holds at the top of the range: ten Runs each returning a whole file
should not each land a whole file in the parent's context. It does not hold at
the bottom: ten Runs each returning three paragraphs cost the parent ten
`agent_result` calls to read thirty paragraphs it was going to read anyway.

## Decision

> A completion notice carries the Run's final output **whole** when the output
> is non-empty and fits `NOTIFICATION_INLINE_MAX_BYTES` (16 KiB). Otherwise it
> carries the bounded preview and points at `agent_result`, as before. The
> notice's shape says which: `output` is present exactly when the whole output
> is there.

**The bound is 16 KiB, and it is a chosen default rather than a measured
one.** It matches the two "one message" bounds the extension already has — a
projected text part and a steering message are each capped at 16 KiB — so an
output that fits one message travels as one message. It is a few thousand
tokens: room for the answer a delegated task usually returns, and small enough
that a fan-out of ten completions costs the parent long messages rather than a
context window. It is a domain constant next to the preview bound, applied
where the notice is built, for the reason the preview bound is. Nothing in the
project derives it, and changing it is one edit plus the tests that probe the
bound.

**Presence is the discriminant, not size.** The formatter does not measure
anything; it asks whether `output` is on the value. That is what keeps a
preview from ever being mistaken for the answer, and what keeps the two bounds
independent: the preview is built unconditionally and read only when the
output is absent.

**The body carries the output in a fenced, labelled block.** `Output from the
subagent:` for a completed Run, `Output produced before failure:` after the
reason for a failed one, `Output produced before cancellation:` for a
cancelled one, each between two lines of `"""`. A quoted string worked for a
one-line preview; a multi-line Markdown answer needs a boundary a reader can
scan for. Fencing is not a security boundary and does not claim to be, exactly
as quoting was not.

**The pointer becomes a note when the output is inlined.** `This is the
complete output; nothing further to fetch. agent_result with {"id":"run-1"}
re-reads it with the transcript.` — and for partial output, `This is all the
output the Run produced.` The word *Call* is deliberately absent from these two
sentences, because it is the word the fetch habit is keyed on. The
non-inlined sentences are unchanged, and the record-only sentence is unchanged
in both forms because there is nothing to inline.

**`agent_result` stays**, for two cases the copy now names: an output the
notice previewed because it was too long, and re-reading a Run later — its
transcript, its cost, or an output that has since left the parent's context.

## Alternatives considered

- **Always inline.** Re-creates the problem ADR-0002 hit and ADR-0006 fixed: a
  runaway agent returning a whole file lands the file in the parent's context
  on every completion. The bound is what makes inlining safe to default to.
- **Inline the whole RunCard**, transcript and accounting included. The
  transcript is the part of a Result that is large and rarely needed at the
  moment of completion; the accounting is already on the notice. The output is
  what the parent is waiting for, so the output is what travels.
- **Drop `agent_result`.** Tempting once the common case needs no fetch, but
  the over-bound case and the re-read case both still need it, and a model
  that has been told "the result is available" needs somewhere to go. The
  copy narrows when to use it instead.
- **A smaller bound, such as 2 KiB or 8 KiB.** Cheaper per notice and more
  fetches: a four-paragraph review with code blocks is over 2 KiB and is
  exactly the answer a parent wants whole. 8 KiB was the first draft; 16 KiB
  was chosen because it is a bound the extension already means something by,
  and because the fetch it saves costs a tool call and a turn either way.

## What it costs

- One optional field on `RunNotification`, one constant, and one condition in
  `toRunNotification`.
- The notice text changes for every completion whose output fits the bound,
  which is most of them. The golden tests for the notice are rewritten; the
  three-backend golden (N-8) still proves one identical notice across
  backends.
- A parent's context grows by the output on each short completion. That is the
  trade this entry makes deliberately, and the bound is where it is capped.

## What breaks if it is wrong

The worst case is an output that is **neither inlined nor previewed** — a
notice with no body pointing at a Result. It cannot happen structurally: the
preview is always built, the body reads `output` first and `preview` second,
and the record-only case owns the empty-output sentence. `N-1`, `N-3`, `N-4`
and `N-7` in `presentation/notification-text.test.ts` prove both branches for
every terminal status, and the boundary case is proven at the bound and one
byte past it.

Nothing here touches storage or delivery order. The conformance scenarios
`a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` pass unchanged.
