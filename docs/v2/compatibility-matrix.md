# Public compatibility matrix

**Status:** Complete. Every cell cites a test or live gate that exists in this
repository.
**Date:** 2026-09-02, rewritten at M7 (2026-09-03) when the 1.x implementation
was deleted.
**Scope:** every public command, Subagent close through the existing host and
Session surface, `/agents`, the active widget, completion Notification
messages, and Profile loading and validation — across the Pi, Claude, and Codex
backends.

## What this document is

The behavioural contract. Each section states **what a caller observes** for one
command, in all three backend columns, and then **what proves it**, in the same
three columns.

It began as a specification of 1.x's behaviour, written so that the rewrite had
a parity target rather than an intention, and every cell cited a 1.x test. Those
tests are gone with the implementation, so at M7 the outcome tables became pure
behaviour statements and the citations moved to the proof tables — which had
been accumulating one per backend since M4. They read as a second table rather
than as a column because the proofs are per backend and several of them are
backend-specific.

Three kinds of citation appear, and the difference matters:

- **conformance** — `<Backend>Backend conformance: <scenario>`, from the shared
  suite. Thirty-seven scenarios run against both fake backends and all three
  real adapters, each behind a scriptable stand-in provider, so a pass means the
  seam behaves rather than that a backend-shaped test was written to agree with
  a backend-shaped adapter. **No backend skips any of the thirty-seven**, and a
  test asserts each empty skip list.
- **a named test**, with the file it lives in. Paths are relative to
  `extensions/subagent/`.
- **live**, one of the six opt-in credentialed gates — `pi:smoke`,
  `pi:host-smoke`, `claude:smoke`, `claude:host-smoke`, `codex:smoke`,
  `codex:host-smoke`. A runtime gate drives the supervisor over one adapter; a
  host gate drives the same backend through the surface a user has.

A cell reading "Same" means the same expected outcome as the Pi column of that
row — an explicit statement about that backend rather than a deferral.

## What the **[v2 change]** markers mean

Five cells are marked, and only those: places where the current behaviour
deliberately differs from 1.x's. Each names its decision, so a difference is
either recorded here with a reference or it is a regression.

| Row | What changed | Where it was decided |
| --- | --- | --- |
| `agent_start` — at capacity | A global capacity limit that rejects immediately, where 1.x had no limit at all | [ADR-0001](../adr/0001-unbounded-subagent-concurrency.md) is 1.x's decision; [operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic) is this one |
| `agent_resume` — during shutdown | A distinct shutting-down outcome instead of `unknown subagent` | [operation semantics §5](operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins) |
| `agent_steer` — mailbox full, mailbox closed | `queue full` → `mailbox full`; `not steerable` → `mailbox closed` | [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome) |
| `agent_result` — evicted output | A typed `ResultExpired` outcome instead of prose | [operation semantics §8](operation-semantics.md#8-an-evicted-result-returns-a-distinct-typed-outcome) |
| Profile loading — backend field name | The frontmatter field renamed, with no alias | [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md), [the migration note](profile-backend-field-migration.md) |

Every *other* textual difference between the two implementations was compared
once, while both still existed, and classified in
[the presentation ledger](presentation-ledger.md): 65 pairs, 33 identical, 32
different, each of the 32 intentional with its reference or fixed. One was a
regression and was fixed — `agent_wait` had stopped reporting why a Run was
cancelled.

---

## `agent_start`

Creates a Session-scoped Subagent from a Profile and immediately starts its
first Run. Returns distinct Subagent and Run identities, never the answer.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Returns a Subagent id and a first Run id immediately. The Run is detached from the calling turn. A retained SDK conversation is created lazily on first execution and performs no provider I/O at admission. | Returns a Subagent id and a first Run id immediately. The BackendAgent holds no provider identity until the first Run's Query produces one. | Returns a Subagent id and a first Run id immediately. The App Server process and its ephemeral root Conversation are created lazily on first execution. |
| **Unknown agent** | Rejected; no Subagent or Run is created. | Same. | Same. |
| **Nested delegation** | Rejected at depth ≥ 1; delegation is one level deep. | Same. | Same. |
| **At capacity** | **[v2 change]** v1 has no global capacity limit ([ADR-0001](../adr/0001-unbounded-subagent-concurrency.md)), so v1 never rejects for capacity. v2 rejects immediately and queues nothing — [operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic). | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **expected outcome** | `PiBackend conformance: open-creates-no-run`; `agent_start returns a Subagent id and a first Run id a model can act on` (`host/tools.test.ts`); live (`pi:smoke`, `pi:host-smoke`) | `ClaudeBackend conformance: open-creates-no-run`; `opening loads the SDK and starts no Query, because there is nothing else to open`, `a BackendAgent that has never run holds no conversation to resume` (`testing/claude/claude-backend.test.ts`); live (`claude:smoke`, `claude:host-smoke`) | `CodexBackend conformance: open-creates-no-run`; `opening spawns the App Server, initializes, and starts the ephemeral root` (`testing/codex/codex-backend.test.ts`); live (`codex:smoke`, `codex:host-smoke`) |
| **unknown agent** | `agent_start refuses an unknown agent and names the ones that exist` (`host/tools.test.ts`) | Backend-independent: `agent_start refuses an unknown agent and names the ones that exist` (`host/tools.test.ts`) | Backend-independent: `agent_start refuses an unknown agent and names the ones that exist` (`host/tools.test.ts`) |
| **nested delegation** | `a start already at the maximum depth is refused by admission`; `a process the backend set reports as nested registers nothing at all`; `a process the backend set calls a child registers nothing at all` (`host/inert-guard.test.ts`) | `the host facts come from Pi, which is the only backend that has them` (`host/production-backends.test.ts`); `a start already at the maximum depth is refused by admission` (`host/inert-guard.test.ts`). The depth *variable* is shared: `the child environment is the operator's, plus the depth key` (`backend/claude/options.test.ts`) | `the host facts come from Pi, which is the only backend that has them` (`host/production-backends.test.ts`); `a start already at the maximum depth is refused by admission` (`host/inert-guard.test.ts`). The depth *variable* is shared: `the child is spawned with the operator's environment plus the depth key` (`testing/codex/codex-backend.test.ts`), `the child environment is the operator's, plus the depth key` (`backend/codex/protocol.test.ts`) |
| **at capacity** | `PiBackend conformance: capacity-rejection-is-immediate` | `ClaudeBackend conformance: capacity-rejection-is-immediate` | `CodexBackend conformance: capacity-rejection-is-immediate` |

## `agent_resume`

Starts a new Run on an idle Subagent, retaining only adapter-private
Conversation context. Returns the new Run id immediately.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Supported. The retained in-process SDK session takes another prompt; no continuation token exists or crosses the seam. | Supported. A fresh Query attaches through native continuation; replayed history before the attachment boundary is not a Fact of the new Run. | Supported. A new Turn starts on the same retained ephemeral root Conversation. |
| **Subagent already running** | Rejected synchronously with `already running`. Nothing is queued and no provider work starts. | Same. | Same. |
| **Unknown Subagent id** | Rejected with `unknown subagent`; a Run id passed here is reported as the wrong kind of identifier. | Same. | Same. |
| **`unsupported`** | Not reachable: Pi declares resume. The outcome is reachable through a backend that declares none. | Not reachable: Claude declares resume. | Not reachable: Codex declares resume. |
| **Conversation loss** | Reported when the retained session can no longer be resumed; no Run and no provider work start. | Reported when continuation attachment fails; the adapter never falls back to a fresh conversation. | Reported when the App Server process or transport is terminally lost, without exposing provider identity. |
| **During shutdown** | Rejected; shutdown wins admission synchronously and late settlement cannot reopen the Subagent.. **[v2 change]** v1 reports this as `unknown subagent`; v2 reports a distinct shutting-down outcome — [operation semantics §5](operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins). | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **expected outcome** | `PiBackend conformance: resume-or-honest-refusal`; `a cancelled Run leaves the session resumable on the same conversation` (`testing/pi/pi-backend.test.ts`); live (`pi:smoke`) | `ClaudeBackend conformance: resume-or-honest-refusal`; `the first Run's identity frame is what makes a later Run resumable` (`testing/claude/claude-backend.test.ts`); live (`claude:smoke`, "resume answers from the first Run's retained conversation") | `CodexBackend conformance: resume-or-honest-refusal`; `a resumed Turn runs on the same retained root`, `the first Turn carries the Profile prompt, and a resumed Turn does not` (`testing/codex/codex-backend.test.ts`); live (`codex:smoke`, "resume answers from the first Turn's retained root") |
| **already running** | `PiBackend conformance: one-active-run-per-subagent` | `ClaudeBackend conformance: one-active-run-per-subagent` | `CodexBackend conformance: one-active-run-per-subagent` |
| **unknown Subagent id** | `agent_resume tells an unknown Subagent from a Run id` (`host/tools.test.ts`) | Backend-independent: `agent_resume tells an unknown Subagent from a Run id` (`host/tools.test.ts`) | Backend-independent: `agent_resume tells an unknown Subagent from a Run id` (`host/tools.test.ts`) |
| **`unsupported`** | Not reachable for Pi, which declares resume: `a Profile with no backend field runs on Pi, which declares all three capabilities` (`testing/pi/pi-backend.test.ts`). The outcome itself is proven by the one-shot fake: `the one-shot backend proves resume unsupported at the surface` (`host/tools.test.ts`) | Not reachable for Claude, which declares resume: `Claude declares resume and steering, and no terminal transcript snapshot` (`testing/claude/claude-backend.test.ts`). The outcome itself is proven by the one-shot fake: `the one-shot backend proves resume unsupported at the surface` (`host/tools.test.ts`) | Not reachable for Codex, which declares resume: `Codex declares resume and steering, and no terminal transcript snapshot` (`testing/codex/codex-backend.test.ts`). The outcome itself is proven by the one-shot fake: `the one-shot backend proves resume unsupported at the surface` (`host/tools.test.ts`) |
| **Conversation loss** | `admitResume answers from the adapter's own state, with no native call`; `a disposed Pi session is refused by the adapter, not by the SDK` (`testing/pi/pi-backend.test.ts`) | `a BackendAgent that has never run holds no conversation to resume`, `closing drops the identity, and it stays dropped`, `an identity that differs from the retained one fails without falling back`, `a boundary frame with a malformed identity fails the Run` (`testing/claude/claude-backend.test.ts`) | `resume is admitted while the root is live and lost once the process has gone`, `a process that dies mid-Turn fails the Run with its partial output`, `a Turn that ignores its interrupt is escalated to SIGTERM and then SIGKILL` (`testing/codex/codex-backend.test.ts`) — and no provider identity crosses in any of them |
| **during shutdown** | `PiBackend conformance: shutdown-rejects-new-work`; live (`pi:smoke`, "shutdown refuses new work") | `ClaudeBackend conformance: shutdown-rejects-new-work`; live (`claude:smoke`, "shutdown refuses new work") | `CodexBackend conformance: shutdown-rejects-new-work`; live (`codex:smoke`, "shutdown refuses new work") |

## `agent_steer`

Offers one guidance message to an active Run's bounded local mailbox.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | `accepted` when the complete text enters the Run's bounded mailbox. Delivered as native session steering, serialized by the SDK. Only authoritative provider evidence becomes a user Fact. | `accepted` on local admission. Delivered as streamed user input on the Run's Query; one user Fact only when a provider Result correlates the client's message id. | `accepted` on local admission. Delivered as native `turn/steer` against the active Turn, ordered with provider events in one adapter reducer. |
| **`unsupported`** | Not reachable: every Pi Run declares `steer`. The outcome itself is reachable through a backend that declares none. | Not reachable: Claude declares `steer`. | Not reachable: Codex declares `steer`. |
| **Mailbox full** | `queue full` at 16 pending admissions, 16 KiB per message, or 64 KiB pending. Returned immediately; the caller's turn never blocks. **[v2 change]** v2 renames this outcome `mailbox full` — [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome). | Same. | Same. |
| **Cancelling or closed** | `not steerable`; cancellation closes admission before the abort reaches the executor.. **[v2 change]** v2 renames this `mailbox closed` — [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome). | Same. | Same. plus |
| **Terminal Run** | `already completed` / `already failed` / `already cancelled`, kept classifiable until Session shutdown. | Same. | Same. |
| **Invalid text** | `invalid` for empty, whitespace-only, or over-16-KiB text — decided before the Run id is looked up. | Same. | Same. |
| **Unknown Run id** | `unknown run`. | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **expected outcome** | `PiBackend conformance: steering-admission-follows-the-declared-capability`, `controls-are-delivered-serially-in-order`, `a-user-observation-appears-only-on-confirmation`; live (`pi:smoke`, "steering reaches the answer") | `ClaudeBackend conformance: steering-admission-follows-the-declared-capability`, `controls-are-delivered-serially-in-order`, `a-user-observation-appears-only-on-confirmation`; `guidance becomes a user observation only when the provider echoes it`, `only one Control is provider-visible at a time` (`testing/claude/claude-backend.test.ts`); live (`claude:smoke`, "a confirmed steer produced exactly one user observation") | `CodexBackend conformance: steering-admission-follows-the-declared-capability`, `controls-are-delivered-serially-in-order`, `a-user-observation-appears-only-on-confirmation`; `guidance becomes a user observation only when the server echoes its id`, `only one steer is in flight at a time` (`testing/codex/codex-backend.test.ts`); `a Turn is started, steered, and interrupted with the ids it needs` (`backend/codex/protocol.test.ts`); live (`codex:smoke`, "a steer confirmed by client id produced exactly one user observation") |
| **`unsupported`** | Not reachable for Pi. Proven by the one-shot fake: `the one-shot backend proves unsupported steering at the surface` (`host/tools.test.ts`) | Not reachable for Claude. Proven by the one-shot fake: `the one-shot backend proves unsupported steering at the surface` (`host/tools.test.ts`) | Not reachable for Codex. Proven by the one-shot fake: `the one-shot backend proves unsupported steering at the surface` (`host/tools.test.ts`) |
| **mailbox full** | `PiBackend conformance: a-full-mailbox-answers-immediately` | `ClaudeBackend conformance: a-full-mailbox-answers-immediately`. Claude's consumer is not eager, so the bound genuinely binds: guidance the provider is not ready for stays in the mailbox | `CodexBackend conformance: a-full-mailbox-answers-immediately`. Codex's consumer awaits each `turn/steer`, so the bound genuinely binds: guidance the server has not answered stays in the mailbox |
| **mailbox closed** | `PiBackend conformance: a-closed-mailbox-refuses-after-cancel` | `ClaudeBackend conformance: a-closed-mailbox-refuses-after-cancel` | `CodexBackend conformance: a-closed-mailbox-refuses-after-cancel` |
| **terminal Run** | `agent_steer names a terminal Run's status rather than calling it unknown` (`host/tools.test.ts`) | Backend-independent: `agent_steer names a terminal Run's status rather than calling it unknown` (`host/tools.test.ts`) | Backend-independent: `agent_steer names a terminal Run's status rather than calling it unknown` (`host/tools.test.ts`) |
| **invalid text** | `agent_steer rejects empty guidance before it looks the Run up` (`host/tools.test.ts`) | Backend-independent: `agent_steer rejects empty guidance before it looks the Run up` (`host/tools.test.ts`) | Backend-independent: `agent_steer rejects empty guidance before it looks the Run up` (`host/tools.test.ts`) |
| **unknown Run id** | `agent_steer names a terminal Run's status rather than calling it unknown` (`host/tools.test.ts`) | Backend-independent: `agent_steer names a terminal Run's status rather than calling it unknown` (`host/tools.test.ts`) | Backend-independent: `agent_steer names a terminal Run's status rather than calling it unknown` (`host/tools.test.ts`) |
| **delivery failure is diagnostic-only** | `a native steer that rejects is a control diagnostic and no user message` (`testing/pi/pi-backend.test.ts`) | `guidance the input stream will not take is a control diagnostic and nothing else` (`testing/claude/claude-backend.test.ts`) | `guidance the server refuses is a control diagnostic and nothing else` (`testing/codex/codex-backend.test.ts`) |
| **one user Fact only on correlation** | — | `guidance the provider never acknowledges is delivered and never claimed`, `a result frame with guidance still outstanding is a Turn boundary, not settlement` (`testing/claude/claude-backend.test.ts`) | `guidance the server never echoes is delivered and never claimed`, `a steer sent before a cancel still confirms afterwards` (`testing/codex/codex-backend.test.ts`) |
| **the wrong Turn is refused by the protocol** | — | — | `a Turn is started, steered, and interrupted with the ids it needs` (`backend/codex/protocol.test.ts`); `guidance becomes a user observation only when the server echoes its id` asserts the `expectedTurnId` each steer named (`testing/codex/codex-backend.test.ts`) |

## `agent_cancel`

Requests that named Runs stop. Answers about request admission.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Admitted; the Run settles `cancelled` with partial output retained, and its normal cancellation Notification still arrives. The Subagent returns to idle and stays resumable. Native abort plus bounded idle wait; a stalled native steer never blocks cancellation. | Admitted; the Query is closed and the controller aborted. A Run cancelled before any assistant frame settles `cancelled` with no output, which is a valid outcome, not a failure. The retained identity survives. | Admitted; `turn/interrupt` stops only that Turn, with bounded SIGTERM/SIGKILL escalation if the interrupt is ignored. The process, root Conversation, and Subagent survive. |
| **Repeated cancel** | Idempotent. The first reason wins, the terminal state is unchanged, and no second Notification is produced. | Same. | Same. |
| **Already terminal** | Reported as finished; the stored Result stands. | Same. | Same. |
| **Unknown Run id** | Reported as unknown, distinctly from a Run that finished before the cancel arrived. | Same. | Same. |
| **Request vs. terminal** | The tool reports admission; terminal cancellation is the later Notification. | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **expected outcome** | `PiBackend conformance: cancellation-terminates-with-partial-output`; `a stalled native steer does not delay a cancel` (`testing/pi/pi-backend.test.ts`); live (`pi:smoke`) | `ClaudeBackend conformance: cancellation-terminates-with-partial-output`; `a Run cancelled before any frame settles cancelled with nothing at all` (`testing/claude/claude-backend.test.ts`); live (`claude:smoke`) | `CodexBackend conformance: cancellation-terminates-with-partial-output`; `cancelling an active Turn interrupts it and leaves the root resumable` (`testing/codex/codex-backend.test.ts`); live (`codex:smoke`) |
| **terminal answer then abort** | `PiBackend conformance: exactly-one-ending-wins`; `a terminal answer observed before the abort settles answered` (`testing/pi/pi-backend.test.ts`) | `ClaudeBackend conformance: exactly-one-ending-wins`; `a successful result already observed survives a later cancel` (`testing/claude/claude-backend.test.ts`) | `CodexBackend conformance: exactly-one-ending-wins`; `a final answer already observed survives a later cancel` (`testing/codex/codex-backend.test.ts`) |
| **repeated cancel** | `a repeated agent_cancel is idempotent and the first request stands` (`host/tools.test.ts`) | Backend-independent: `a repeated agent_cancel is idempotent and the first request stands` (`host/tools.test.ts`) | Backend-independent: `a repeated agent_cancel is idempotent and the first request stands` (`host/tools.test.ts`) |
| **already terminal / unknown Run id** | `agent_cancel tells a finished Run from an id that never existed` (`host/tools.test.ts`) | Backend-independent: `agent_cancel tells a finished Run from an id that never existed` (`host/tools.test.ts`) | Backend-independent: `agent_cancel tells a finished Run from an id that never existed` (`host/tools.test.ts`) |
| **request vs. terminal** | `agent_cancel reports request admission, not terminal cancellation` (`host/tools.test.ts`) | Backend-independent: `agent_cancel reports request admission, not terminal cancellation` (`host/tools.test.ts`) | Backend-independent: `agent_cancel reports request admission, not terminal cancellation` (`host/tools.test.ts`) |
| **a Run with no output is a valid outcome** | — | `ClaudeBackend conformance: a-run-may-settle-with-no-observations`; `a Run cancelled before any frame settles cancelled with nothing at all` (`testing/claude/claude-backend.test.ts`) | `CodexBackend conformance: a-run-may-settle-with-no-observations` |
| **the retained identity survives** | — | live (`claude:smoke`, "a cancelled Query leaves the conversation resumable") | — |
| **bounded SIGTERM/SIGKILL escalation** | — | — | `a Turn that ignores its interrupt is escalated to SIGTERM and then SIGKILL` (`testing/codex/codex-backend.test.ts`); `an ignored SIGTERM is followed by SIGKILL, with no real time passing`, `a request the server never answers expires and escalates` (`backend/codex/transport.test.ts`) |
| **the process and root survive** | — | — | `cancelling an active Turn interrupts it and leaves the root resumable` (`testing/codex/codex-backend.test.ts`); live (`codex:smoke`, "an interrupted Turn leaves the process, the root, and the Subagent alive") |

## `agent_wait`

Observes terminality only. Returns identity and lifecycle state, never output.

`agent_wait` is backend-independent: it reads the delivery module's result store
and pending map and never touches an adapter. The outcome below is identical for
Pi, Claude, and Codex.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Blocks until the named Runs are terminal, then returns each Run's identity and terminal lifecycle state. Notifications are unaffected and the Result store is unchanged. | Identical. | Identical. |
| **Timeout** | Returns the still-running ids as a normal outcome; the Runs keep going and notify on their own. A timeout past `setTimeout`'s ceiling waits rather than firing at once. | Same. | Same. |
| **Aborted turn** | Only the waiter stops; the Run continues and still settles and notifies. | Same. | Same. |
| **Repeated wait** | Returns the same lifecycle state. | Same. | Same. |
| **Unknown Run id** | Reported as unknown rather than blocking. | Same. | Same. |
| **Duplicate ids** | One observation per id. | Same. | Same. |
| **A cancelled Run's reason** | Reported beside the status, as `cancelled (requested)` or `cancelled (shutdown)`, because only one of the two is something the caller asked for. | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **every row** | Backend-independent, as the matrix says: `PiBackend conformance: wait-and-result-observe-the-same-value`, `a-late-waiter-reads-the-stored-result`, plus `agent_wait names each terminal Run by agent and status`, `agent_wait reports an unknown id rather than blocking on it`, `aborting the turn ends only the wait: the Run settles and its result stands` (`host/tools.test.ts`) | Backend-independent, as the matrix says: `ClaudeBackend conformance: wait-and-result-observe-the-same-value`, `a-late-waiter-reads-the-stored-result`, plus the `agent_wait` rows in `host/tools.test.ts` | Backend-independent, as the matrix says: `CodexBackend conformance: wait-and-result-observe-the-same-value`, `a-late-waiter-reads-the-stored-result`, plus the `agent_wait` rows in `host/tools.test.ts` |

## `agent_result`

Fetches a terminal Run's authoritative output by Run id.

Backend-independent for the same reason as `agent_wait`.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Returns the Run's full stored output with its owning Subagent for orientation. Reading neither consumes nor pins the Result and is repeatable. | Identical. | Identical. |
| **Not yet terminal** | Reports that the Run has not finished and that its Notification will arrive on its own. | Same. | Same. |
| **Evicted output** | Reports that the output was evicted to bound result-store memory; the Run id, owner, and terminal status still answer. Eviction is oldest-first by insertion order and the newest Result always survives. **[v2 change]** v1 returns prose; v2 returns a distinct typed `ResultExpired` outcome — [operation semantics §8](operation-semantics.md#8-an-evicted-result-returns-a-distinct-typed-outcome). | Same. | Same. |
| **Unknown Run id** | Reports no such Run and points at what `agent_start` returned. | Same. | Same. |
| **After a failed Notification** | The stored Result is unchanged; delivery failure is not Result loss. | Same. | Same. |
| **After Session shutdown** | Nothing is retrievable: Results belong to the Session that asked. | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **expected outcome** | `PiBackend conformance: wait-and-result-observe-the-same-value`; `agent_result returns the full stored output with its Run identity` (`host/tools.test.ts`); live (`pi:host-smoke`) | `ClaudeBackend conformance: wait-and-result-observe-the-same-value`; `a Profile naming claude runs end to end through the production set` (`host/production-backends.test.ts`); live (`claude:host-smoke`) | `CodexBackend conformance: wait-and-result-observe-the-same-value`; `a Profile naming codex runs end to end through the production set` (`host/production-backends.test.ts`); live (`codex:host-smoke`) |
| **not yet terminal** | `agent_result on a live Run says it has not finished, distinctly from unknown` (`host/tools.test.ts`) | Backend-independent: `agent_result on a live Run says it has not finished, distinctly from unknown` (`host/tools.test.ts`) | Backend-independent: `agent_result on a live Run says it has not finished, distinctly from unknown` (`host/tools.test.ts`) |
| **evicted output** | `PiBackend conformance: an-evicted-result-answers-expired` | `ClaudeBackend conformance: an-evicted-result-answers-expired` | `CodexBackend conformance: an-evicted-result-answers-expired` |
| **unknown Run id** | `agent_result on a live Run says it has not finished, distinctly from unknown` (`host/tools.test.ts`) | Backend-independent: `agent_result on a live Run says it has not finished, distinctly from unknown` (`host/tools.test.ts`) | Backend-independent: `agent_result on a live Run says it has not finished, distinctly from unknown` (`host/tools.test.ts`) |
| **after a failed Notification** | `PiBackend conformance: a-notification-retry-cannot-duplicate-or-alter-settlement` | `ClaudeBackend conformance: a-notification-retry-cannot-duplicate-or-alter-settlement` | `CodexBackend conformance: a-notification-retry-cannot-duplicate-or-alter-settlement` |
| **after Session shutdown** | `PiBackend conformance: shutdown-rejects-new-work`; `a tool call after shutdown returns the not-ready sentence` (`host/tools.test.ts`) | `ClaudeBackend conformance: shutdown-rejects-new-work`; `a tool call after shutdown returns the not-ready sentence` (`host/tools.test.ts`) | `CodexBackend conformance: shutdown-rejects-new-work`; `a tool call after shutdown returns the not-ready sentence` (`host/tools.test.ts`) |
| **unavailable until background terminals close** | — | — | `a result is unavailable while a background command the Run started is running` (`testing/codex/codex-backend.test.ts`) |

## Subagent close (existing host and session surface)

There is **no model tool for closing a Subagent, in v1 or in v2 M0.** Closing
happens through Session shutdown, which is a host event. The row below documents
that existing surface.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Every Subagent is marked closed first, then active Runs are cancelled, then the adapter closes. Pi aborts and waits for active work, bounds extension shutdown and stalled native cancellation, then disposes the retained session. | Every Subagent is marked closed first, then active Runs are cancelled. Claude aborts the close signal, waits for the active Attempt, and forgets its continuation. Idle close is idempotent. | Every Subagent is marked closed first, then active Runs are cancelled. Codex interrupts the active Turn, cleans the session, and closes the App Server process, including when close races attachment. |
| **Late settlement** | Cannot reopen a closed Subagent or notify the next Session. | Same. | Same. |
| **Idempotence** | A Run that already settled is not asked to stop again. | Same. | Same. |
| **Identity cleanup** | Local Subagent and Run identity sets are forgotten at the Session boundary. | Same. | Same. |
| **Closing one Subagent alone** | Not offered. v2 M0 introduces no new model tool; the documented policy for a close that meets an active Run is cancel-and-await-cleanup — [operation semantics §4](operation-semantics.md#4-closing-a-subagent-with-an-active-run-is-cancel-and-await-cleanup). | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **expected outcome** | `PiBackend conformance: close-releases-every-resource`; `closing twice emits one child shutdown and disposes once` (`testing/pi/pi-backend.test.ts`); live (`pi:smoke`, both probes clear) | `ClaudeBackend conformance: close-releases-every-resource`; `closing drops the identity, and it stays dropped` (`testing/claude/claude-backend.test.ts`); live (`claude:smoke`, both probes clear) | `CodexBackend conformance: close-releases-every-resource`; `closing the Session ends stdin once and leaves nothing held` (`testing/codex/codex-backend.test.ts`); live (`codex:smoke`, all three probes clear and no App Server child left) |
| **bounded child shutdown** | `closing twice emits one child shutdown and disposes once` (`testing/pi/pi-backend.test.ts`) | — | — |
| **late settlement** | `PiBackend conformance: late-events-cannot-mutate-a-terminal-run` | `ClaudeBackend conformance: late-events-cannot-mutate-a-terminal-run` | `CodexBackend conformance: late-events-cannot-mutate-a-terminal-run` |
| **idempotence** | `PiBackend conformance: close-is-idempotent` | `ClaudeBackend conformance: close-is-idempotent`; `closing drops the identity, and it stays dropped` (`testing/claude/claude-backend.test.ts`). Claude has no SDK close call, so the adapter's own tally is what makes one effective close a number rather than a claim | `CodexBackend conformance: close-is-idempotent`; `closing the Session ends stdin once and leaves nothing held` (`testing/codex/codex-backend.test.ts`); `close after the child is already gone returns at once, and twice is once` (`backend/codex/transport.test.ts`) |
| **identity cleanup** | `the widget is cleared when the Session shuts down` (`host/widget.test.ts`); `PiBackend conformance: close-releases-every-resource` | `nothing is left iterating or open once a Run has settled` (`testing/claude/claude-backend.test.ts`); `ClaudeBackend conformance: close-releases-every-resource` | — |
| **the graceful path** | — | — | `close ends stdin, and a child that goes needs no signal at all` (`backend/codex/transport.test.ts`), which is the spike's 13 ms exit-code-0 path |
| **process cleanup** | — | — | `closing the Session ends stdin once and leaves nothing held` (`testing/codex/codex-backend.test.ts`); live (`codex:smoke`, "no App Server child remains after closure", read from `ps` rather than from the adapter) |

## `/agents`

Lists loaded Profiles and opens their prompts.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Lists each Profile by name and description, whatever backend it names; the list carries no backend-specific field. Selecting one shows its prompt and offers the work action. | Identical. | Identical. |
| **No Profiles** | Says where to add one, naming the agents directory, and opens no selector. | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **every row** | Backend-independent: `the list holds one item per Profile, by name and description` and `the list is identical whatever backend a Profile names` (`host/agents-command.test.ts`). The Pi set supplies no Profiles of its own: `the Pi set supplies one backend and no Profiles of its own` (`host/inert-guard.test.ts`) | Backend-independent: `the list is identical whatever backend a Profile names` (`host/agents-command.test.ts`). The production set supplies no Profiles of its own: `the production set offers all three backends and no Profiles of its own` (`host/production-backends.test.ts`) | Backend-independent: `the list is identical whatever backend a Profile names` (`host/agents-command.test.ts`). The production set supplies no Profiles of its own: `the production set offers all three backends and no Profiles of its own` (`host/production-backends.test.ts`) |

## Active widget

The session widget listing live Runs.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | One row per live Run carrying agent, backend name, turn count, status, and current activity — nothing else fixed, and no id or model. The row for a Pi Run reads `explore pi 3 turns running · …`. | Identical apart from the backend name: `explore claude 3 turns running · …`. | Identical apart from the backend name: `explore codex 3 turns running · …`. |
| **Observation only** | The widget never determines lifecycle state. | Same. | Same. |
| **Lifecycle** | Appears with the first Run and is removed when none are left; a change redraws rather than reinstalls. | Same. | Same. |
| **Row lifetime** | A Run's row lasts from `agent_start` until its completion notice reaches the conversation, not until the Run settles — v1 releases a tracked Run on `notificationLanded`. Proven in v2 by `a terminal Run keeps its row until its completion notice lands, and the landing takes it away` and, and at the unit level by `the widget lists Runs that are not terminal and terminal ones whose notice has not landed`. | Same. : the row's lifetime is backend-independent. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **every row** | Backend-independent: `the widget appears with the first live Run and its row reads as the matrix says` and its siblings (`host/widget.test.ts`); `PiBackend conformance: only-the-repository-writes-snapshots` | Backend-independent: the widget rows in `host/widget.test.ts`; `ClaudeBackend conformance: only-the-repository-writes-snapshots` | Backend-independent: the widget rows in `host/widget.test.ts`; `CodexBackend conformance: only-the-repository-writes-snapshots` |
| **row lifetime** | Backend-independent: `a terminal Run keeps its row until its completion notice lands, and the landing takes it away`; `a notice lost to an interrupt keeps its row until the re-push lands` (`host/widget.test.ts`) | Backend-independent: the row-lifetime tests in `host/widget.test.ts` | Backend-independent: the row-lifetime tests in `host/widget.test.ts` |

## Completion Notification messages

The status-specific completion notice pushed as a follow-up message.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Derived from the neutral Result alone, so the prose is backend-independent: it names the owning Subagent and the Run, carries a bounded preview for a completed Run, and points at `agent_result` by Run id. Accounting appends usage, turn count, and the model the Profile selected. | Identical prose; the model string is a Claude model. | Identical prose; the model string is a Codex model. |
| **Failed Run** | Carries only the primary error and the pointer, bounded even for a pathological message. | Same. | Same. |
| **Cancelled Run** | Terse, with no partial output in the notice; the partial output stays retrievable through `agent_result`. | Same. | Same. |
| **Landing** | Exactly one landing per Notification; a notice an interrupt discarded is pushed again after the agent settles. | Same. | Same. |
| **Push failure** | Cannot change or lose the stored Result. | Same. | Same. |
| **No live Session** | Dropped rather than delivered into a Session that did not start the Run. | Same. | Same. |


**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **every row** | Backend-independent: `PiBackend conformance: a-notification-follows-storage`, `a-notification-retry-cannot-duplicate-or-alter-settlement`; the landing rows in `host/push-sink.test.ts`; live (`pi:smoke`, one notification per settled Run) | Backend-independent: `ClaudeBackend conformance: a-notification-follows-storage`, `a-notification-retry-cannot-duplicate-or-alter-settlement`; live (`claude:smoke`, one notification per settled Run and no provider identity in any of them) | Backend-independent: `CodexBackend conformance: a-notification-follows-storage`, `a-notification-retry-cannot-duplicate-or-alter-settlement`; live (`codex:smoke`, one notification per settled Run and no provider identity in any of them) |

## Profile loading and validation

Profiles are Markdown files read from user scope only.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Generic parsing** | `description`, `harness` (default `pi`), and the body are the only generic fields; every other frontmatter field is handed to the named backend. A missing description or body is a diagnostic. | Same. | Same. |
| **Unknown backend name** | A profile diagnostic at session start. | Same. | Same. |
| **Unrecognized field** | The named backend rejects fields it does not understand; the rejection is a diagnostic, not a silent pass-through. | Same. | Same. |
| **Model validation** | An exact model id (or `provider/model-id`) checked against Pi's loaded catalogue, with a bounded diagnostic when it is absent or the catalogue is empty. | An SDK family alias, passed through unresolved for the SDK to interpret; a non-alias value is diagnosed with its value. | Validated by the Codex adapter along with effort mapping and prompt composition. |
| **`tools` and `appendSystemPrompt`** | Comma-separated tool list with empty segments ignored; a separators-only list disables all tools; `appendSystemPrompt` defaults to true. | Shares the trimming and empty-segment rules with Pi, and preserves an explicitly empty allowlist. | Shares the common accessors. |
| **`effort`** | Pi's thinking level, validated against the shared scale. | Mapped to a thinking budget entirely inside the adapter. | Mapped to `model_reasoning_effort` inside the adapter. |
| **Scope** | Read from the user agents directory only; a project directory cannot contribute a Profile, trusted or not. | Same. | Same. |
| **Backend field name** | **[v2 change]** v1 reads `harness`. v2 understands only `backend`, with the same values, through a documented rename; a Profile still using the old name fails v2 validation as an unrecognized field. See [the migration note](profile-backend-field-migration.md) and [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md). v1 is unchanged. | Same. | Same. |

**Proven by.** A property only one backend has shows a dash for the others;
the row label says which property it is.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **generic parsing** | the `parseProfile` tests in `domain/profile.test.ts` | the `parseProfile` tests in `domain/profile.test.ts` | the `parseProfile` tests in `domain/profile.test.ts` |
| **unknown backend name** | `PiBackend conformance: validation-is-deterministic`; `a Profile naming an unknown backend is one diagnostic, not an exception` (`backend/contract.test.ts`) | `a Profile naming a backend the set does not hold is a diagnostic, not a crash` (`host/production-backends.test.ts`) | `a Profile naming a backend the set does not hold is a diagnostic, not a crash` (`host/production-backends.test.ts`) |
| **unrecognized field** | `a field Pi has never heard of is a diagnostic, not a silent pass` (`backend/pi/profile.test.ts`) | `a field Claude has never heard of is a diagnostic, not a silent pass` (`backend/claude/profile.test.ts`); `ClaudeBackend conformance: validation-is-deterministic` | `a field Codex has never heard of is a diagnostic, not a silent pass`, `tools and appendSystemPrompt are shared vocabulary Codex refuses` (`backend/codex/profile.test.ts`); `CodexBackend conformance: validation-is-deterministic` |
| **model validation** | `a model the catalogue does not hold names what it does hold`; `omitting the catalogue means an empty one, so a pinned model is unknown`; `the catalogue summary is bounded and says how many it left out` (`backend/pi/profile.test.ts`); end to end: `a model the Session's catalogue does not hold is a rejection, not a Run` (`testing/pi/pi-backend.test.ts`) | `every family alias is accepted, whatever its casing`, `a model that is not a family alias is diagnosed with the alias list`, `the alias reaches the Query lowercased and unresolved` (`backend/claude/profile.test.ts`); `the family alias is passed through, and no alias leaves the SDK's default` (`backend/claude/options.test.ts`) | — |
| **`tools` and `appendSystemPrompt`** | `tools is a comma-separated list, and an empty list is meaningful`; `appendSystemPrompt must be a boolean` (`backend/pi/profile.test.ts`); `a Profile's tools list reaches the session, and no list leaves the defaults` (`backend/pi/options.test.ts`) | `tools must be a string, and an empty list is meaningful`, `appendSystemPrompt must be a boolean` (`backend/claude/profile.test.ts`); `the Profile's tools narrow the built-in set, and an empty list is kept`, `the system prompt is the Claude Code preset with the Profile's appended`, `a Profile that opted out replaces the preset instead of appending` (`backend/claude/options.test.ts`) | — |
| **`effort`** | `an effort outside the shared scale is rejected by name`; `every value on the shared effort scale is accepted`; `a Profile's effort wins over the parent's thinking level` (`backend/pi/profile.test.ts`) | `every value on the shared effort scale is accepted`, `an effort outside the shared scale is rejected by name` (`backend/claude/profile.test.ts`); `each effort buys its own thinking budget`, `effort off disables extended thinking rather than buying nothing`, `an effort the table does not hold defaults to the high budget`, `the SDK's own effort parameter carries only the values it accepts` (`backend/claude/options.test.ts`) | `every value on the shared effort scale is accepted`, `an effort outside the shared scale is rejected by name`, `effort off becomes none, and every other value passes through` (`backend/codex/profile.test.ts`) |
| **scope** | `Profiles are read from the user-scope agents directory only` (`profiles/discovery.test.ts`) | Backend-independent: `Profiles are read from the user-scope agents directory only` (`profiles/discovery.test.ts`) | Backend-independent: `Profiles are read from the user-scope agents directory only` (`profiles/discovery.test.ts`) |
| **backend field name** | `a source containing the legacy backend field name is rejected` (`boundaries.test.ts`) | `a source containing the legacy backend field name is rejected` (`boundaries.test.ts`) | `a source containing the legacy backend field name is rejected` (`boundaries.test.ts`) |
| **model passthrough** | — | — | `a model is passed through for Codex to check, whatever it says`, `a model that is not a string is a diagnostic` (`backend/codex/profile.test.ts`); `a pinned model and a mapped effort reach the thread parameters` (`backend/codex/protocol.test.ts`) |

## Cross-cutting properties

Behaviours that belong to no one command. Each row cites the proof for whichever
backends have the property; a dash means it is not one that backend has.

| Property | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Model and effort inheritance** | `with no Profile model, the parent's is inherited provider-qualified`; `the parent's thinking level is inherited only when no model is pinned` (`backend/pi/profile.test.ts`) | — | — |
| **Child isolation** | `every extension directory of this package is filtered from a child`; `the Bash spawn carries the child depth without mutating the environment`; `the resource load runs inside the child-load discriminator` (`backend/pi/options.test.ts`) | — | — |
| **No provider type leaks** | `a Pi session symbol outside the adapter is rejected, its host API is not`; `a Pi message type outside the adapter is rejected`; `only the composition root may import the Pi adapter`; `the Pi adapter may not import the runtime, the host, or presentation` (`boundaries.test.ts`) | `the Claude SDK is rejected outside the Claude adapter, and admitted inside it`, `only the composition root may import the Claude adapter`, `the two adapters are siblings and neither may name the other`, `the provider's cancellation primitive is admitted in the Claude adapter and nowhere else` (`boundaries.test.ts`) | `a child process is spawned in the Codex adapter and nowhere else`, `App Server protocol and transport vocabulary stays inside the Codex adapter`, `only the composition root may import the Codex adapter`, `the Codex adapter may not import the runtime, the host, or presentation` (`boundaries.test.ts`) |
| **Environment inheritance (ADR-0008)** | — | `setting sources and MCP servers are absent, so the operator's environment is inherited`, `the child environment is the operator's, plus the depth key`, `building the options does not mutate the process environment` (`backend/claude/options.test.ts`) | `the child environment is the operator's, plus the depth key`, `building the spawn request does not mutate the process environment` (`backend/codex/protocol.test.ts`) |
| **Depth and delegation policy** | — | `Agent and Task are always disallowed, whatever the Profile's tools says`, `permissions are bypassed with the explicit skip flag` (`backend/claude/options.test.ts`) | — |
| **Usage — every model charged, Run-local** | — | `ClaudeBackend conformance: usage-deltas-are-run-local`, `a-resumed-run-excludes-prior-usage`, `a-replayed-transcript-adds-no-usage`; `every model the Query ran is charged, including one the Profile never asked for` (`testing/claude/claude-backend.test.ts`); `two result frames in one Run are differenced, not summed`, `a provider reset charges the new reading rather than a negative delta` (`backend/claude/translate.test.ts`) | — |
| **Usage — the context gauge** | — | `ClaudeBackend conformance: context-occupancy-is-a-gauge`; `the gauge is the primary model's own tokens over its own window`, `the gauge is omitted when the primary model has no entry` (`backend/claude/translate.test.ts`) | `CodexBackend conformance: context-occupancy-is-a-gauge`; `the context gauge is the last request's total, and its window when there is one` (`backend/codex/translate.test.ts`) |
| **Usage — turn counting** | — | `several assistant frames sharing one message id are one turn`, `a tool-parented assistant frame is a sidechain, not a turn`, `the result's reported total never lowers the count` (`backend/claude/translate.test.ts`); `the terminal bundle carries turns and the model, and never a transcript` (`testing/claude/claude-backend.test.ts`) | `a completed Turn counts one turn and clears the activity` (`backend/codex/translate.test.ts`); `one Turn is one Run, and its items read like any other backend's` (`testing/codex/codex-backend.test.ts`) |
| **Replay filtering** | — | `a resumed Query's replayed history is not part of the resumed Run` (`testing/claude/claude-backend.test.ts`); `ClaudeBackend conformance: a-replayed-transcript-adds-no-usage` | — |
| **Failure endings** | — | `a result the provider marked as an error fails with a confined diagnostic`, `a Query that ends without a result fails with a fixed message`, `SDK stderr becomes one bounded diagnostic and keeps not a word of itself` (`testing/claude/claude-backend.test.ts`); `ClaudeBackend conformance: a-failing-sink-cannot-strand-the-execution` | `a Turn the server reports as failed fails with a confined diagnostic`, `a declared method whose payload does not fit is one diagnostic, not a crash`, `the child's stderr is one bounded diagnostic with its identities removed` (`testing/codex/codex-backend.test.ts`); `CodexBackend conformance: a-failing-sink-cannot-strand-the-execution` |
| **Open failure** | — | `an SDK that will not load is backend unavailable with no provider text`, `an SDK loader that never returns is backend unavailable and leaves nothing open` (`testing/claude/claude-backend.test.ts`); `ClaudeBackend conformance: a-failed-open-leaves-nothing-behind` | `a missing binary is backend unavailable with no Run and nothing held`, `an initialize the adapter cannot read is backend unavailable, and the child is killed`, `a refused thread start is backend unavailable`, `a thread start that never answers is backend unavailable once the budget expires` (`testing/codex/codex-backend.test.ts`); `CodexBackend conformance: a-failed-open-leaves-nothing-behind` |
| **Profile prompt composition** | — | — | `the first Turn carries the Profile prompt and the task; later Turns do not`, `a Profile with an empty prompt body composes nothing onto the task` (`backend/codex/profile.test.ts`); `the first Turn carries the Profile prompt, and a resumed Turn does not` (`testing/codex/codex-backend.test.ts`) |
| **Trust posture (ADR-0009)** | — | — | `a thread starts ephemeral, never-approving, and fully sandboxed` (`backend/codex/protocol.test.ts`); `opening spawns the App Server, initializes, and starts the ephemeral root` asserts the posture reached the wire regardless of the forwarded trust value (`testing/codex/codex-backend.test.ts`) |
| **Usage — Run-local against a Turn baseline** | — | — | `CodexBackend conformance: usage-deltas-are-run-local`, `a-resumed-run-excludes-prior-usage`, `a-replayed-transcript-adds-no-usage`; `a resumed Run is charged for its own work only` (`testing/codex/codex-backend.test.ts`); `a usage frame emits the increment since the Turn's baseline`, `two usage frames in one Turn are differenced, not summed twice`, `a resumed Run's baseline excludes the Run before it`, `a provider reset on the Turn's first frame charges the new reading` (`backend/codex/translate.test.ts`) |
| **Usage — no terminal reconciliation surface** | — | — | `CodexBackend conformance: reconciliation-does-not-double-count`. The spike found `turn/completed` carries no usage, so the last usage frame before it stands and the snapshot carries turns alone |
| **Item translation** | — | — | `the four tool-shaped items each produce a tool call and its progress`, `an item that is not a tool call reports no progress, only activity`, `a completed command reports its status and a bounded output summary`, `a command that failed or was declined reports as failed` (`backend/codex/translate.test.ts`) |
| **Commentary versus the final answer** | — | — | `a completed agent message whose phase is not commentary is the answer`, `a commentary message is a message and not the answer`, `commentary followed by a final answer leaves the Run answered` (`backend/codex/translate.test.ts`); `a Turn that completes with no final answer fails with a fixed message` (`testing/codex/codex-backend.test.ts`) |
| **Bounded activity** | — | — | `a message delta previews the tail's last sentence`, `activity is bounded however much the provider streams`, `a command's output delta shows the command and its latest line`, `a reasoning summary shows its headline` (`backend/codex/translate.test.ts`) |
| **Transport loss — process exit** | — | — | `a process that dies mid-Turn fails the Run with its partial output` (`testing/codex/codex-backend.test.ts`); `a spontaneous exit settles every pending request and completes the loss signal` (`backend/codex/transport.test.ts`) |
| **Transport loss — an expired request bound** | — | — | `a request the server never answers cannot hold a Run open` (`testing/codex/codex-backend.test.ts`); `a request the server never answers expires and escalates` (`backend/codex/transport.test.ts`) |
| **Transport loss — a frame past the framing bound** | — | — | `a line past the framing bound fails the Run rather than being truncated` (`testing/codex/codex-backend.test.ts`); `a line past the framing bound is transport loss, not a silent truncation` (`backend/codex/transport.test.ts`) |
| **Routing — late frames reach no Run** | — | — | `a frame for a settled Turn reaches no Run and is counted`, `a frame for a turn nobody ever listened to reaches no Run` (`testing/codex/codex-backend.test.ts`). Both assert positively in each direction: the current Turn's frames arrive and the stale one is counted |
| **Client-bound requests are always answered** | — | — | `the reader answers a client-bound request that arrives between Runs` (`testing/codex/codex-backend.test.ts`); `every client-bound request is answered with a JSON-RPC error` (`backend/codex/transport.test.ts`) |
| **Protocol drift** | — | — | `npm run codex:protocol:check` (`CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.153.0`), in `check`; `the declared method list is what the drift check has to cover`, `an undeclared method is ignored rather than rejected` (`backend/codex/protocol.test.ts`) |

---

## Coverage

Every property above has an explicit expected outcome in all three backend
columns, and a proof for every backend that has the property. No cell says
"TBD" and no cell cites a test that does not exist.

What the matrix does **not** cover, deliberately:

- **Colour and emphasis.** Every golden test runs against a theme that paints
  nothing, so this document is about words. Tone is shared vocabulary
  (`runPhaseTone`) and no surface picks its own.
- **Layout of interactive surfaces.** The `/agents` selector and the transcript
  row renderers are components; their text is proven through the functions
  above, their layout is not.
- **Provider behaviour.** That a model answered well is not a compatibility
  property. That the extension reported honestly what the provider did is.

## Where the rest of the contract lives

| Question | Document |
| --- | --- |
| What does a caller observe from an operation, in detail? | [operation semantics](operation-semantics.md) |
| What does a word mean? | [the glossary](../../CONTEXT.md) |
| How is it built? | [the architecture note](../architecture.md) |
| What changed in wording between the two implementations? | [the presentation ledger](presentation-ledger.md) |
| What was deleted, and what replaced it? | [the deletion ledger](deletion-ledger.md) |
