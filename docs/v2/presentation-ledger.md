# The v1-versus-v2 presentation ledger

**Status:** Complete. **Date:** 2026-09-03. **Milestone:** M7, ticket 04.

This is the one-time comparison the roadmap asks for before v1 is deleted:
*"Compare representative v1 and v2 presentation/results for behavioral
regressions."*

## Why it had to be done, and why once

Each tree's golden tests assert **its own** words. v1's presentation tests say
what v1 prints and v2's say what v2 prints, and both pass while the wording
drifts apart — so nothing in `check` could ever have noticed a sentence
changing meaning. The compatibility matrix promises parity and cites tests for
it, but the tests it cites are each tree's own.

So the gap is specific: **is a difference in words a decision somebody made, or
a decision nobody made?** That question can only be asked while both trees
exist, which is now.

It is a ledger rather than a permanent test for the same reason. Once v1 is
gone there is nothing to compare against, and a test that pinned v2's wording
to v1's would be a test forbidding v2 to say anything better.

## How it was measured

A disposable script ran both trees' **pure presentation** functions over
equivalent fixtures and printed every pair with a SAME or DIFF marker:
`.scratch/v2-m7-cutover-and-deletion/comparison/compare.mjs`, with its output
beside it. It is under the scratch area, imported by neither tree, and excluded
from lint, typecheck, and every test glob. It goes with v1.

Fixtures are *equivalent*, not identical: v1's `SingleResult` carries
`messages` and `stderr` where v2's `RunResult` carries a `transcript` and
categorised `diagnostics`, and v1's widget view carries `elapsedMs` where v2
derives elapsed time from `startedAt` and a supplied `now`. Each pair builds
the same **situation** on both sides. Where no equivalent fixture exists — an
outcome v1 does not have — the pair says so rather than pretending.

**Result: 65 pairs, 33 identical, 32 different.** Every one of the 32 is
classified below. One was a parity break and is fixed; the rest are intentional
and each cites its decision.

## What was found and fixed

### `agent_wait` dropped a cancelled Run's reason — fixed

**The break.** v1 reported `explore (run-1): cancelled (requested)` and
`explore (run-1): cancelled (shutdown)`. v2 reported `cancelled` and nothing
more, because `WaitOutcome`'s terminal variant carried only the status.

**Why it mattered rather than being tidier.** At shutdown *every* Run is
cancelled without anyone asking for it. A model told plain `cancelled` would
conclude its own `agent_cancel` had taken effect, and would not learn that the
Session ended under it. The matrix's `agent_wait` row promises "each Run's
identity and terminal lifecycle state" and cites v1's tests for it, and v1's
lifecycle state *includes* the reason — so this was a promise broken with no
**[v2 change]** marker.

**The fix.** `WaitOutcome`'s terminal variant gained an optional
`cancellationReason`; the supervisor reads it from the stored Result, falling
back to the snapshot's recorded cancellation so an evicted Run still says why
it stopped; and `formatWaitOutcomes` renders it in parentheses exactly as v1
did. A Run that was not cancelled has no reason and grows no parenthesis.

Proven by `agent_wait says why a cancelled Run was cancelled`
(`host/tools.test.ts`) and `agent_wait says why a cancelled Run was cancelled,
and says nothing extra otherwise` (`presentation/prose.test.ts`). Both pairs in
the comparison are now byte-identical to v1.

### Nothing else was a break

Two candidates looked like losses and were not:

- **Provider diagnostics in a failed `agent_result`.** v1 folds `stderr` into
  the failure body under a `Diagnostics:` heading; v2's `formatResultBody`
  does not mention diagnostics at all. But the body is not the tool's answer:
  `formatResult` builds the whole text from the run card, which gives
  diagnostics their own section *with their category*. Comparing the whole
  texts shows the information survived and gained a label. See the pair
  `failed with provider diagnostics, whole text`.
- **Widget rows.** Every row pair is byte-identical to v1 — the columns, the
  delimiter, the agent-column cap, the order fields give way in, the activity
  tail, the summary line, and the overflow line. The only widget difference is
  a phase v1 does not have.

## The ledger

One section per compatibility-matrix row. Every difference is either
**intentional** with its reference, or **fixed** with its test.

### `agent_start`

| Difference | Classification |
| --- | --- |
| `started` | **Identical.** |
| Unknown agent, with and without alternatives | **Identical.** |
| `at capacity` — v1 has no such outcome | **Intentional.** v1 has no global capacity limit ([ADR-0001](../adr/0001-unbounded-subagent-concurrency.md)); v2 rejects immediately and queues nothing — [operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic). Already marked **[v2 change]** in the matrix. |
| `shutting down` — v1 has no distinct outcome | **Intentional.** [Operation semantics §5](operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins). Already marked **[v2 change]** in the matrix. |

### `agent_resume`

| Difference | Classification |
| --- | --- |
| `started`: v1's trailing clause is `; its own notification will arrive when this Run finishes`, v2's is `. Its notification will arrive when the Run finishes; carry on until then.` | **Intentional.** One sentence, said the same way by `agent_start` and `agent_resume` in v2, where v1 phrased each separately. The instruction it adds — carry on rather than block — is the admission semantics of a detached Run ([operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic)). |
| `already running`: v2 adds `Wait for that Run to finish, then resume.` | **Intentional.** One active Run per Subagent is invariant 2, and the outcome now says what to do about it. |
| `unsupported`: v1 says `its Harness does not support resume`, v2 says `its backend does not support resume` and adds `Start a new Subagent to continue this work.` | **Intentional.** The vocabulary is [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md): `backend` identifies Pi, Claude, or Codex, and `Harness` is reserved for Pi's own native abstraction. |
| `unknown Subagent`, `conversation lost` | **Identical.** |

### `agent_steer`

Every steering outcome differs in wording and none differs in meaning. Two
things account for all of it: the ADR-0022 vocabulary rename, and outcomes that
now state the rule they enforce rather than leaving a caller to infer it.

| Difference | Classification |
| --- | --- |
| `accepted`: v2 says `this Run's local bounded mailbox, and that is all acceptance means` and `the backend dequeued it` where v1 said `its local bounded mailbox` and `the Harness dequeued it` | **Intentional.** [Operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome) is emphatic that acceptance is a statement about the local mailbox and nothing else, and the vocabulary is ADR-0022. |
| `invalid`: v1 states the rule (`non-whitespace text no longer than 16 KiB of UTF-8`), v2 names which rule was broken | **Intentional.** The bound is unchanged; the message now says which of the two the caller hit rather than restating both. |
| `unknown Run`: v2 says `unknown Run` and points at `agent_start or agent_resume` | **Intentional.** `Run` is a v2 domain term (ADR-0022), and `agent_resume` also hands out Run ids, which v1's sentence predates. |
| `already completed` / `failed` / `cancelled`: v2 adds `Use agent_result with that Run id to read what it produced.` | **Intentional.** The next useful action, which v1 left the caller to infer. |
| `mailbox closed`, renamed from `not steerable` | **Intentional.** Already marked **[v2 change]** in the matrix — [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome). |
| `unsupported`: v1 says `this prepared Run does not support steering`, v2 says `its backend declared no steering Control` and that no later attempt will be admitted either | **Intentional.** Capabilities are declared per backend rather than per Run in v2 ([ADR-0028](../adr/0028-v2-backend-contract.md)), so the answer is stable for the Subagent rather than incidental to one Run. |
| `mailbox full`, renamed from `queue full`, plus `Nothing was truncated and nothing was dropped silently.` | **Intentional.** Already marked **[v2 change]** in the matrix; the added clause is the bound's own promise. |

### `agent_cancel`

| Difference | Classification |
| --- | --- |
| v1 `Cancelled: run-1.` → v2 `Cancellation requested: run-1. Each Run stops when its execution and cleanup finish, keeps whatever output it produced, and still sends its own notification.` | **Intentional.** [Operation semantics §3](operation-semantics.md#3-cancellation-is-idempotent-and-distinguishes-request-from-terminal): an admitted *request* is not a terminal cancellation. v1's past tense said the opposite of what had happened. |
| v1 `Already settling:` → v2 `Already cancelling: … The first request stands and this one changed nothing.` | **Intentional.** Same section: repeat cancellation is idempotent, and the sentence says so. |
| v2 names the terminal status: `Already finished, result kept: run-1 (completed).` | **Intentional.** Cancelling a finished Run should say *how* it finished; v1 reported only that it had. |
| v1 `Nothing to cancel.` → v2 `No run ids were given.` | **Intentional.** v1's sentence was ambiguous between "you named nothing" and "nothing was cancellable". v2 uses the same sentence `agent_wait` uses for the same input. |
| One unknown id | **Identical.** |

### `agent_wait`

| Difference | Classification |
| --- | --- |
| A cancelled Run's reason | **Fixed.** See above. Both pairs now identical. |
| `Still running:` gains `The wait gave up, not the Runs: each keeps going and notifies on its own, so do not immediately wait on the same ids again.` | **Intentional.** [Operation semantics §6](operation-semantics.md#6-aborting-agent_wait-stops-only-that-waiter): a timed-out wait is not a cancelled Run, and a caller who re-waits in a loop has misread v1's one-line version. |
| Terminal completed, unknown ids, no ids | **Identical.** |

### `agent_result`

| Difference | Classification |
| --- | --- |
| `run` → `Run` throughout the bodies (`The Run finished without output.`, `This Run failed before completing.`, `The Run failed before producing output.`) | **Intentional.** [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md): `Run` is a domain term and is capitalised as one wherever the product names it. |
| Failed body: v1 folds `stderr` in under `Diagnostics:`, v2's body omits it | **Intentional, and not a loss.** v2's whole text gives diagnostics their own run-card section with their category. Verified by the whole-text pair; see "Nothing else was a break". |
| Cancelled body names the reason: `This Run was cancelled before finishing (requested).` | **Intentional.** The same fact `agent_wait` reports, for the same reason: cancelled-at-shutdown and cancelled-on-request are different outcomes. v1's Result carried the reason and its body did not print it. |
| Evicted output: v1 returns prose in the body, v2 returns a distinct typed outcome naming the Run, its owner, and its status | **Intentional.** Already marked **[v2 change]** in the matrix — [operation semantics §8](operation-semantics.md#8-an-evicted-result-returns-a-distinct-typed-outcome). |
| Whole text: v1 is the identity line and the body; v2 is the identity line, a description/backend/status line, accounting, recent transcript, tools, diagnostics, links, truncation, then the body | **Intentional.** The M4 run card, recorded in `presentation/run-card.ts`. The identity line and the body are v1's, unchanged and in the same places; everything between them is added. Nothing v1 printed was removed. |
| `not finished yet`: v2 adds `so it has no result` | **Intentional.** Says why the call produced no output, which is the question the caller has. |
| `unknown id`: v2 points at `agent_start or agent_resume` | **Intentional.** Same reason as the steering outcome: `agent_resume` also hands out Run ids. |
| Completed with output | **Identical.** |

### Completion Notification messages

**Every pair identical.** Eight fixtures: completed with output, completed with
no output, completed with the full accounting line (cost, tokens, turns,
model), completed with one turn so the grammar is singular, failed with a
reason, failed with no reason, cancelled on request, cancelled at shutdown.

This is the surface a model reads on every finished Run, and it is byte-for-byte
v1's — including the accounting line's field order and separators, the
`Use agent_result with id …` pointer, and the `no reason reported` fallback.

### Active widget

| Difference | Classification |
| --- | --- |
| Twelve row fixtures — the description tail, a reported activity tail, no turns yet, a truncated long agent name, each of the three backends, each of the three terminal phases, three Runs with the summary line, ten Runs with the overflow line, and a narrow terminal that drops turn accounting | **All identical.** Byte for byte. |
| A `finalizing` row, which v1 cannot render | **Intentional.** v2 has five Run phases where v1 has four: `finalizing` is the window between a backend's execution ending and the Run settling, and it exists so no surface shows a Run as terminal while its cleanup is still running (invariant 12, [ADR-0025](../adr/0025-v2-terminal-settlement.md)). |
| Row *lifetime* | **Fixed in ticket 01**, not here: v2 now keeps a settled Run's row until its completion notice lands, as v1 did. Recorded in [the soak record](soak.md#the-widgets-row-lifetime-2026-09-03-severity-3). |

### `/agents`

| Difference | Classification |
| --- | --- |
| `Add a profile to …` → `Add a Profile to …` | **Intentional.** [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md): a Profile is a domain term. |
| Action title, select items, filtering, action items, prompt body, work message, key hints | **Identical.** |

### Profile loading and validation

Not compared here as prose. The two trees' diagnostics are structurally
different — v1 reports per-file strings, v2 reports typed `ProfileDiagnostic`
values rendered by `formatInvalidProfilesWarning` — and the *behavioural*
difference is the one that matters and is already recorded: v2 understands only
`backend`, and a Profile still naming the old field fails validation as an
unrecognised field. That is the matrix's **Backend field name** cell, marked
**[v2 change]** and pointing at [the migration note](profile-backend-field-migration.md).

## What this ledger does not cover

- **Colour and emphasis.** Every comparison ran against a theme that paints
  nothing, so the ledger is about words. Tone selection is shared vocabulary
  in both trees (`runStatusTone` / `runPhaseTone`) and neither surface picks
  its own.
- **Behaviour.** Whether the right outcome was produced is the compatibility
  matrix's business, proven by tests in both trees. This ledger only asks
  whether the words for a given outcome changed.
- **Interactive surfaces.** The `/agents` selector's rendering and the
  transcript row renderers are components rather than strings; their text is
  compared through the functions above, their layout is not.
