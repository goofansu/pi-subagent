# Phase C exit gate — the completion hand-off, and resource lifetime polish

**Status: not started.** Rewritten 2026-09-04 at the Phase B close, when
[the roadmap](roadmap.md) redefined C3 around the hand-off and added the Phase
A follow-up (A6–A8), which this gate verifies as well. C1 is ready: the lease
exists and its release is one call. A6–A8, C3 and C4 depend on nothing in each
other and may land in any order after A8, which changes model-facing text and
goes first.
**Verified against:** [the roadmap](roadmap.md), Phase A follow-up and Phase
C; [the notification semantics](notification-semantics.md) §1 *Consumption*,
§3, §5, §6 and §7; [the presentation ledger](presentation-ledger.md) rows
N-10, W-2, W-3, C-3; [the freeze](freeze.md), rows F4, F6 and F10;
[ADR-0035](../adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md).

## The deterministic gate

```
npm run check   →  exit 0
```

**Status:** OPEN.

## The items

### 1. The health line judges by class (A6)

`runtime/counters.ts` classifies every `SupervisorCounter` as `defect`,
`incident`, or `expected`, exhaustively by type. Bare `/subagent` reads
`Runtime: healthy · N held` for a Session whose only non-zero counters are
expected ones, and `Runtime: attention needed · …` naming the non-zero classes
otherwise. A counter name the host does not recognise counts as actionable.

**Evidence to name:** `host/diagnostics-command.test.ts` (ledger C-3);
`runtime/counters.test.ts` or the type-level check.

**Status:** OPEN.

### 2. The debugging guide describes two commands (A7)

`docs/debugging.md` has one section for `/subagent` (the shallow status and
the health line, with the three classes named) and one for
`/subagent diagnostics` (the full report). Its counter tables are regrouped
to the three classes and name them; `duplicateSettlements` and `lateEndings`
sit under *expected*.

**Status:** OPEN.

### 3. Availability says what a model will find (A8)

`ResultAvailability` is `complete` / `partial` / `record-only`, derived as
semantics §3 says. The three pointer sentences are semantics §5's. A completed
Run with no output has no body and the record-only pointer. Ledger row N-10 is
confirmed with its goldens, and rows N-1, N-2, N-4, N-5, N-7 still pass
reading their pointer through it.

**Evidence to name:** `presentation/notification-text.test.ts`; the host
smoke lanes (item 14).

**Status:** OPEN.

### 4. Admission capacity is returned by scope closing (C1)

The Run fiber acquires its admission lease with `Effect.acquireRelease` and
the release is a finalizer of the Run Scope. No procedural release call
remains in the supervisor. `detachRun` still runs before the lease releases.
The stress lane's zero probe still holds after hundreds of cycles including
rejected and failed starts.

**How the two paths are covered.** The acquire stays in `start` and `resume`
rather than moving into the Run fiber, because the fiber has to be attached to
its record *before* the outcome is reported and a fiber cannot hand itself its
own handle without two more `Deferred`s — machinery boundary rule 21 exists to
keep out. Instead the admitted span runs under its own Scope and expresses a
post-admission rejection as a **failure**, so `admission.admit` releases on the
way out; the Run fiber's Scope holds the lease from the fork on, with
`detachRun` registered *after* the lease so last-in-first-out runs it first.

**Evidence to name:** `runtime/admission.test.ts` (the refusal paths);
`runtime/supervisor.test.ts` (the concurrent-close test the Phase B review
added, unmodified); `runtime/stress.test.ts` (the zero probe).

**Status:** PASS.

### 5. The acquire/release audit is recorded (C2)

For each remaining pair — subscription start/unsubscribe, delivery
claim/recovery sweep, the three store pins — this gate records whether it was
converted to a scoped resource and, if not, why the release has more than one
correct moment. The three named pins are recorded as deliberately unconverted
(freeze F6).

| Pair | Converted? | Why or why not |
| --- | --- | --- |
| admission claim/release | yes (item 4) | Two Scopes, and each has exactly one correct moment: the admitted span's Scope returns the lease when it closes on a rejection, and the Run fiber's Scope returns it when the Run is over. No `release()` call remains in `runtime/supervisor.ts`. |
| subscription start/unsubscribe | yes, already | `RunRepository.subscribe` is an `Effect.acquireRelease` around the `repositorySubscriptions` probe (`runtime/repository.ts`), and its consumer — the widget — registers its own unsubscribe as a Session-Scope finalizer. Recorded rather than changed. |
| delivery claim/recovery sweep | no | **Not a pair.** The claim is taken once per Run and kept whatever the push did; the sweep is a *retry over stored ids*, not the claim's release, and it has no single moment that is the claim's end. Converting it would mean inventing a release moment in order to have one. |
| store pin `publication` | no | F6 |
| store pin `waiters` | no | F6 |
| store pin `delivery` | no | F6 |

The three named pins are deliberately unconverted, and the freeze says why: a
pin's release has more than one correct moment — the holder decides, and
delivery's is a hand-off rather than a Scope closing — so a Scope would have to
pick one and be wrong for the others.

**Status:** PASS. Every row has a verdict and a reason.

### 6. The hand-off resolves on landing or consumption (C3)

The sink records `consumed` when the `agent_result` tool handler reports a
returned Result. A push for a consumed Run is accepted and not sent; a
consumed notice lost after hand-off is not re-pushed at settle; a consumed
notice Pi already holds lands, is marked landed, and increments
`consumedBeforeLanding`. `agent_wait` consumes nothing. `runtime/delivery.ts`
does not contain the word *consumed*; the boundary rule that fences *landed*
covers it.

**Evidence to name:** `host/push-sink.test.ts` — `a push for a consumed Run is
accepted and nothing is sent`, `a consumed notice lost to an interrupt is not
pushed again`, `a consumed notice Pi already holds lands anyway, and is
counted`, `consuming a Run whose notice already landed changes nothing`;
`host/tools.test.ts` — `agent_result tells the host the parent has the Result,
and nothing else does`, `a rejected agent_result tells the host nothing`, `a
Result the store evicted tells the host nothing either`; `boundaries.test.ts` —
`the delivery module saying "consumed" is rejected, and the push sink saying it
is not`, with `delivery may cite the ADR whose filename carries both banned
words` as the one narrow exemption.

**Status:** PASS.

### 7. The widget sees three hand-off states and nothing finer (C3)

The widget's dependency is a read model with `status(runId)` returning
`pending`, `resolved`, or `exhausted`, and a `subscribe`. `resolved` is landed
or consumed and the widget cannot tell which. A settled row leaves on
retrieval with no landing (ledger W-3). The sink keeps handed-off, lost,
attempt counts, and the consumed set internally.

**Evidence to name:** `host/widget.test.ts` — `W-3: a settled row leaves when
the parent retrieves its Result, with no landing` and `the widget lists Runs
that are not terminal and terminal ones whose hand-off is unresolved`; the
dependency type `CompletionHandoffView` in `host/widget.ts`, which has exactly
`status` and `subscribe`, and `HandoffStatus`, declared with the asker rather
than the answerer because rule 18 forbids the widget to name the sink.

**Status:** PASS.

### 8. An exhausted notice is visible (C3)

Delivery tells the sink when its retry budget runs out, through one call on
`NotificationSink`. A settled Run whose delivery exhausted shows a row reading
`completed · notification failed` with its Run id and `result available`;
retrieving that Result resolves it. Ledger row W-2 is confirmed with the golden
that asserts it.

**One reading recorded.** W-2 puts `completed · notification failed` in the
status position, which is where a settled row prints its duration, so on that
one row the duration gives way to the explanation. W-1 stands for every other
settled row. The ledger's W-2 entry records the reasoning.

**Evidence to name:** `presentation/rows.test.ts` — the four `W-2:` goldens;
`runtime/delivery.test.ts` — `a sink that always fails exhausts its budget,
releases the pin, and leaves the result` now also asserts the sink was told,
and the successful-retry test asserts it was not.

**Status:** PASS.

### 9. Diagnostics distinguish the hand-off outcomes (C3)

`/subagent diagnostics` reports a hand-off block from the sink: pushes
attempted, hand-offs accepted, hand-offs refused, notices lost after hand-off,
re-pushes, landings, exhaustions, consumed before landing. Every field is
printed, zeroes included. After a Session closes every one still reads, and the
probes read zero.

**Status:** OPEN.

### 10. One completion view for terminal presentation (C4)

A presentation-only type carrying Run id, Subagent id, agent, label, status,
and duration is derived from `RunSnapshot`, `RunResult`, and
`RunNotification` by one function each, and the widget's settled row, the
result card, and the notice header all print their status and duration through
it. The settled-duration goldens still pass.

**Status:** OPEN.

### 11. The bounds lane covers the exhausted projection

`runtime/bounds.test.ts` or `host/push-sink.test.ts` drives delivery past its
retry budget and asserts the projection reads `exhausted` and the Result is
untouched.

**Status:** OPEN.

### 12. Race and stress lanes pass unchanged

`runtime/races.test.ts` and `runtime/stress.test.ts` have an empty diff for
the phase.

**Status:** OPEN.

### 13. ADR-0035 is accepted, and the contracts say landing or retrieval

ADR-0035 was proposed before the first C3 commit and is accepted in the
closing commit. The compatibility matrix's widget **Row lifetime** cell reads
"until its completion notice reaches the conversation or its Result is
retrieved with `agent_result`, whichever comes first" and cites semantics §6.
The debugging guide's "widget shows nothing" symptom says the same. The
ledger's confirmation table names a golden for N-10, W-2, W-3 and C-3.

**Status:** OPEN.

### 14. The live gates are re-run

Model-facing text changed (A8) and lifecycle mechanics moved (C1). All six
lanes (`pi:smoke`, `pi:host-smoke`, `claude:smoke`, `claude:host-smoke`,
`codex:smoke`, `codex:host-smoke`) are run on the closing commit and their
pass markers recorded here.

**Status:** OPEN.

### 15. The change-surface table is re-measured

The Phase C row of [`change-surface.md`](change-surface.md) is measured on the
closing tree. R4 (display-only widget column) must still read zero generic
modules; R1 must still read zero, because A8 changed wording and touched
nothing under `runtime/`.

**Status:** OPEN.

## Verdict

To be written when verified.
