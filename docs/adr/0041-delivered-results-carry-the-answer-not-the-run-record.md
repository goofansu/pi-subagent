# 41. Delivered Results carry the answer, not the Run's record

Date: 2026-10-15

## Status

Accepted.

**Amends [ADR-0036](0036-a-wait-delivers-the-result-it-waited-for.md)** in
one respect: the text a wait delivers, which is the text `agent_result`
returns, no longer renders the whole RunCard. It renders the answer. The two
texts are still one text, built by one function, and a wait over three Runs
still reads as three `agent_result` answers. **Amends
[ADR-0037](0037-a-notice-carries-a-short-output-whole.md)** in one respect:
the inlined pointer's sentence drops the words *with the transcript*, because
`agent_result` no longer prints one for a Run that has an answer. Both entries
carry a status note pointing here.

Carries forward:

- [ADR-0006](0006-completion-notifications-and-result-store.md) — the Result
  store is authoritative and `agent_result` reads it. Nothing is removed from
  the store; what changes is how much of a stored Result the model-facing
  text repeats.
- [ADR-0037](0037-a-notice-carries-a-short-output-whole.md) — a notice
  carries the output and not the transcript, for the reason given there: "the
  transcript is the part of a Result that is large and rarely needed at the
  moment of completion." This entry applies the same reasoning to the other
  two delivery channels.
- [ADR-0040](0040-delivered-results-carry-the-final-output-for-external-readers.md)
  — the structured `details` on every delivery are unchanged. An external
  reader draws the answer from facts, not from this prose.

## Context

A dogfood Session (2026-10-14, nine Runs over two Subagents) was measured for
how many characters of delivery text each Run put into the parent's context:

| Delivery | Characters | Of which the answer |
| --- | --- | --- |
| `agent_wait`, one Run | 73,282 | about 2,400 |
| `agent_result`, one Run | 49,183 | about 2,800 |
| `agent_result`, one Run | 34,636 | about 3,800 |
| `agent_wait`, one Run | 22,915 | under 2,000 |
| `agent_wait`, one Run | 13,614 | under 2,000 |
| `agent_wait`, one Run | 6,686 | under 2,000 |

Roughly 200,000 characters across the Session, and the answers were a small
part of it. In the largest case the card's **Tools** section was 70,661 of the
73,282 characters. The section printed one line per tool entry with the
entry's bounded output summary, and the bound on one summary is 16 KiB, the
same as one text part — so a Run that ran forty tools could print forty
summaries, each the size of a whole notice, under a heading the parent never
asked for. The **Recent transcript** section was smaller, a few thousand
characters, and said the same things again.

The sections date from M4, when the card was the only expanded view of a Run
and a reader had nowhere else to see how a Run got where it did. That is no
longer so. The dashboard's inspection renders the stored Result's transcript
and tool record in full, navigably, for the operator; it reads the same
Result the card reads. The card's copy of them reached only one reader — the
parent model — and the parent model had asked a different question.

Two different readers want two different things from one Result. The parent
asked *what did the Run find*; the operator asks *what did the Run do*. The
notice already answers the first and only the first (ADR-0037), and
`agent_wait` is the parent asking the same question synchronously
(ADR-0036). Printing the record in those two channels and not in the third
was never decided; it was inherited.

## Decision

> The text `agent_result` returns, which is the text each wait delivers,
> carries the Run's **answer**: identity, status and duration, accounting,
> the context gauge, diagnostics, links, the truncation record, and the final
> output. It does not carry the transcript or the tool record. The one
> exception is a Run with no final output left — none produced, or all of it
> removed by retention — where the last few transcript items are the only
> evidence of what the Run did, the notice has said they are there, and so
> they are printed.

**The record stays in the Result and in inspection.** Nothing about bounding,
storage, the projection, or the dashboard changes. A Result still holds up to
five hundred transcript items and every tool entry with its summary; the
dashboard's inspection still renders them; `agent_result` still reads the same
Result. What is removed is a copy that reached the wrong reader.

**The exception is bounded and conditional.** `RECENT_TRANSCRIPT_ITEMS` (six)
transcript items appear only when `interpretFinalOutput` reports no retained
output and transcript evidence present. A Run with an answer, whole or as a
retained prefix, delivers the answer and nothing of the record. The condition
is read from the same interpretation the final-output section and the notice
read, so the card cannot show evidence the notice did not promise, or promise
evidence the card does not show.

**The pointer's sentence changes once.** Where an inlined notice said
`agent_result with {"id":"run-1"} re-reads it with the transcript.`, it now
says `re-reads it.` The non-inlined sentences, the removed-output sentence
with its *Supporting transcript evidence remains*, and the absent-output
sentence with its *Supporting transcript evidence is available* are unchanged,
because for those Runs the evidence is still what `agent_result` shows.

**The tool record has no compact form here.** A line of tool names and
statuses was considered and not taken: it is cheap, and it is also a second
thing the parent would have to learn to skip. A parent that needs to know
whether a Run ran tests asks for that in the prompt and reads it in the
answer.

## Alternatives considered

- **Bound the tool summaries tighter in the card.** A card that printed the
  first two hundred bytes of each of forty summaries would still be eight
  thousand characters of material the parent did not ask for. The problem
  was the section, not its size.
- **Print the record only on `agent_result` and not on waits.** The two
  channels are one function by ADR-0036's decision, and the measured
  `agent_result` fetches were the larger ones. A parent that fetched a Result
  because the notice previewed it wants the output the preview cut, not the
  record.
- **Drop the transcript exception too.** Then a notice saying *Supporting
  transcript evidence is available. Call agent_result* would point at a text
  that showed none, and a Run that failed before answering would deliver
  nothing readable through any model-facing channel. The exception exists so
  that the pointer stays honest.

## What it costs

- The expanded tool-result view in the TUI, which prints the model text,
  shows less for a Run with an answer. The dashboard's inspection is one
  keystroke away and shows more than the card ever did.
- The RunCard test for the fully-populated card changes; a test is added that
  a Result with forty tool entries and forty transcript items delivers under
  two hundred characters around its answer; the host `agent_result` text test
  no longer expects a transcript line; five notice-text assertions drop three
  words.
- ADR-0036's sentence "the text renders each Result as the RunCard" is true
  of a smaller card. The card is still the one place Run presentation grows.

## What breaks if it is wrong

The worst case is a parent that **needed the record** and now cannot get it
from any tool. It can: the record is in the Result, the Result is in the
store, and the dashboard reads it. What the parent cannot do is read the
record through a tool call, which it also could not do completely before —
the card showed six transcript items of up to five hundred.

A Run that produced no answer keeps its six-item transcript, proven for the
absent and removed cases and for every terminal status in
`presentation/run-card.test.ts` and `presentation/result-format.test.ts`.
