# Public compatibility matrix

**Status:** Complete for M0. This is v2's definition of behavioural parity.
**Date:** 2026-09-02
**Scope:** every public command, Subagent close through the existing host and
session surface, `/agents`, the active widget, completion Notification messages,
and Profile loading and validation — across the Pi, Claude, and Codex backends.

Every cell states the outcome a user should observe, including `unsupported`,
rejected, and Conversation-loss outcomes, and cites the v1 test that proves it.
Cells marked **[v2 change]** are places where v2 intentionally differs from v1;
each points at [the operation-semantics document](operation-semantics.md), which
records the difference. M0 changes no v1 behaviour to match.

Test citations name the test and the file it lives in. Every cited test is in
the `npm run check` lane.

Three tests were added in M0 under the freeze's testability exception, purely to
prove a cell that nothing proved before. They assert existing behaviour and
change no v1 runtime code:

- `a run line names each harness the same way` — `extensions/subagent/widget.test.ts`
- `the agents list is identical whichever harness a profile names` — `extensions/subagent/agents-command.test.ts`
- `completion notification prose is identical whichever harness ran the Run` — `extensions/subagent/presentation.test.ts`

Shorthand used below:

- **conformance** — the thirteen-scenario capability-aware battery every adapter
  runs, registered as `<backend> conformance: <scenario>` by
  `extensions/subagent/harnesses/conformance.ts`.
- **managed conformance** — `<backend> managed conformance: stable identity and
  managed resume`, registered by
  `extensions/subagent/harnesses/managed-conformance.ts`.

---

## `agent_start`

Creates a Session-scoped Subagent from a Profile and immediately starts its
first Run. Returns distinct Subagent and Run identities, never the answer.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Returns a Subagent id and a first Run id immediately. The Run is detached from the calling turn. A retained SDK conversation is created lazily on first execution and performs no provider I/O at admission. | Returns a Subagent id and a first Run id immediately. The BackendAgent holds no provider identity until the first Run's Query produces one. | Returns a Subagent id and a first Run id immediately. The App Server process and its ephemeral root Conversation are created lazily on first execution. |
| **Proof** | `agent_start returns distinct Subagent and first-Run identities immediately` (`index.test.ts`); `pi managed conformance: stable identity and managed resume`; `pi conformance: usage-totals`, `pi conformance: child-depth` | `agent_start returns distinct Subagent and first-Run identities immediately` (`index.test.ts`); `claude managed conformance: stable identity and managed resume`; `Claude runs end-to-end through the core run contract` (`harnesses/claude/harness.test.ts`) | `agent_start returns distinct Subagent and first-Run identities immediately` (`index.test.ts`); `codex managed conformance: stable identity and managed resume`; `a prepared Codex adapter lazily retains one ephemeral session across clean Runs` (`harnesses/codex/harness.test.ts`) |
| **Unknown agent** | Rejected; no Subagent or Run is created. `agent_start refuses an unknown agent` (`index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Nested delegation** | Rejected at depth ≥ 1; delegation is one level deep. `startSubagent refuses to nest a subagent inside a subagent` (`runner.test.ts`) | Same. Same proof. | Same. Same proof. |
| **At capacity** | **[v2 change]** v1 has no global capacity limit ([ADR-0001](../adr/0001-unbounded-subagent-concurrency.md)), so v1 never rejects for capacity. v2 rejects immediately and queues nothing — [operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic). | Same. | Same. |

## `agent_resume`

Starts a new Run on an idle Subagent, retaining only adapter-private
Conversation context. Returns the new Run id immediately.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Supported. The retained in-process SDK session takes another prompt; no continuation token exists or crosses the seam. | Supported. A fresh Query attaches through native continuation; replayed history before the attachment boundary is not a Fact of the new Run. | Supported. A new Turn starts on the same retained ephemeral root Conversation. |
| **Proof** | `agent_resume starts a distinct Run with retained private Harness context` (`index.test.ts`); `pi managed conformance: stable identity and managed resume`; `Pi orders Control and cancellation by ingress and never carries stale guidance into resume` (`harnesses/pi/agent.test.ts`) | `claude managed conformance: stable identity and managed resume`; `Claude resumes through one fresh Query without replay and never falls back after attachment failure`; `Claude resume filters replayed user, assistant, and system history before the current attachment` (`harnesses/claude/harness.test.ts`) | `public tools retain one ephemeral Codex session across independent Results` (`index.test.ts`); `codex managed conformance: stable identity and managed resume`; `a prepared Codex adapter lazily retains one ephemeral session across clean Runs` (`harnesses/codex/harness.test.ts`) |
| **Subagent already running** | Rejected synchronously with `already running`. Nothing is queued and no provider work starts. `agent_resume has one synchronous winner and never queues behind settlement` (`index.test.ts`) | Same. Same proof. | Same; additionally `steering and active-Run admission stay scoped across retained adapter Runs` (`harnesses/codex/harness.test.ts`) |
| **Unknown Subagent id** | Rejected with `unknown subagent`; a Run id passed here is reported as the wrong kind of identifier. `agent_resume distinguishes unsupported and unknown Subagent identities` (`index.test.ts`); `presentation distinguishes every agent_resume outcome and identity kind` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |
| **`unsupported`** | Not reachable: Pi always supports resume. The outcome exists in the contract and is proven by the controlled rig — `controlled-unsupported managed conformance: stable identity and managed resume`; `agent_resume distinguishes unsupported and unknown Subagent identities` (`index.test.ts`) | Not reachable: Claude always supports resume. Same proof. | Not reachable: Codex always supports resume. Same proof. |
| **Conversation loss** | Reported when the retained session can no longer be resumed; no Run and no provider work start. `Pi does not resume while timed-out native cancellation remains active` (`harnesses/pi/agent.test.ts`); `controlled-conversation-lost managed conformance: stable identity and managed resume` | Reported when continuation attachment fails; the adapter never falls back to a fresh conversation. `Claude continuation loss never falls back across loader, Query, or input-stream failure`; `Claude rejects a malformed resumed Conversation identity without fallback` (`harnesses/claude/harness.test.ts`) | Reported when the App Server process or transport is terminally lost, without exposing provider identity. `terminal App Server loss disables adapter resume without leaking provider identity` (`harnesses/codex/harness.test.ts`) |
| **During shutdown** | Rejected; shutdown wins admission synchronously and late settlement cannot reopen the Subagent. `shutdown wins resume admission synchronously and late settlement cannot reopen the Subagent` (`index.test.ts`). **[v2 change]** v1 reports this as `unknown subagent`; v2 reports a distinct shutting-down outcome — [operation semantics §5](operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins). | Same. Same proof. | Same. Same proof. |

## `agent_steer`

Offers one guidance message to an active Run's bounded local mailbox.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | `accepted` when the complete text enters the Run's bounded mailbox. Delivered as native session steering, serialized by the SDK. Only authoritative provider evidence becomes a user Fact. | `accepted` on local admission. Delivered as streamed user input on the Run's Query; one user Fact only when a provider Result correlates the client's message id. | `accepted` on local admission. Delivered as native `turn/steer` against the active Turn, ordered with provider events in one adapter reducer. |
| **Proof** | `pi conformance: steering-single-consumed`, `steering-fifo-consumed`, `steering-intermediate-completion`, `steering-admission-no-fact`; `Pi steering rejection is diagnostic-only and creates no user Fact` (`harnesses/pi/agent.test.ts`) | `claude conformance: steering-single-consumed`, `steering-fifo-consumed`, `steering-intermediate-completion`, `steering-admission-no-fact`; `Claude reports one user Fact when Result correlation authoritatively confirms steering` (`harnesses/claude/harness.test.ts`) | `codex conformance: steering-single-consumed`, `steering-fifo-consumed`, `steering-intermediate-completion`, `steering-admission-no-fact`; `only correlated provider consumption creates one neutral steering Fact`; `retained steering is Turn-local FIFO and disposes prior correlations` (`harnesses/codex/harness.test.ts`) |
| **`unsupported`** | Not reachable: every prepared Pi Run declares `steer`. The outcome is proven by the unsupported rig — `controlled-unsupported conformance: steering-single-consumed` and its three sibling steering scenarios (`harnesses/contract.test.ts`) and `steering outcomes follow settled, cancelling, unsupported, and backpressure precedence` (`delivery.test.ts`) | Not reachable; same proof. | Not reachable: `prepared Codex Runs advertise steering` (`harnesses/codex/harness.test.ts`); same outcome proof. |
| **Mailbox full** | `queue full` at 16 pending admissions, 16 KiB per message, or 64 KiB pending. Returned immediately; the caller's turn never blocks. `steering outcomes follow settled, cancelling, unsupported, and backpressure precedence` (`delivery.test.ts`); `presentation owns every agent_steer outcome and states local-admission semantics` (`presentation.test.ts`). **[v2 change]** v2 renames this outcome `mailbox full` — [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome). | Same. Same proof. | Same. Same proof. |
| **Cancelling or closed** | `not steerable`; cancellation closes admission before the abort reaches the executor. `cancellation records its reason and closes Control admission before aborting executor work` (`runs.test.ts`). **[v2 change]** v2 renames this `mailbox closed` — [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome). | Same. Same proof; plus `Claude orders Control and cancellation by ingress in both directions` (`harnesses/claude/harness.test.ts`) | Same. Same proof; plus `cancellation-first closes first and resumed Codex Turns before later steering` (`runner.test.ts`) |
| **Terminal Run** | `already completed` / `already failed` / `already cancelled`, kept classifiable until Session shutdown. `terminal Run identity remains steer-classifiable until Session shutdown clears it` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Invalid text** | `invalid` for empty, whitespace-only, or over-16-KiB text — decided before the Run id is looked up. `steering validates before Run lookup and preserves admitted text exactly` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Unknown Run id** | `unknown run`. `steering outcomes follow settled, cancelling, unsupported, and backpressure precedence` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |

## `agent_cancel`

Requests that named Runs stop. Answers about request admission.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Admitted; the Run settles `cancelled` with partial output retained, and its normal cancellation Notification still arrives. The Subagent returns to idle and stays resumable. Native abort plus bounded idle wait; a stalled native steer never blocks cancellation. | Admitted; the Query is closed and the controller aborted. A Run cancelled before any assistant frame settles `cancelled` with no output, which is a valid outcome, not a failure. The retained identity survives. | Admitted; `turn/interrupt` stops only that Turn, with bounded SIGTERM/SIGKILL escalation if the interrupt is ignored. The process, root Conversation, and Subagent survive. |
| **Proof** | `pi conformance: abort-mid-run`, `terminal-answer-then-abort`; `Pi cancellation and shutdown do not wait for stalled native steering`; `Pi cancellation remains honest when native abort rejects` (`harnesses/pi/agent.test.ts`) | `claude conformance: abort-mid-run`, `terminal-answer-then-abort`; `Claude cancellation stays cancelled when abort arrives before a later terminal result`; `Claude cancellation stays cancelled when abort closes the stream gracefully` (`harnesses/claude/harness.test.ts`) | `codex conformance: abort-mid-run`, `terminal-answer-then-abort`; `cancelling an active Turn interrupts only that Turn and preserves partial output`; `App Server cancellation interrupts the known turn before escalating`; `App Server escalates an ignored interrupt from SIGTERM to SIGKILL` (`harnesses/codex/harness.test.ts`) |
| **Repeated cancel** | Idempotent. The first reason wins, the terminal state is unchanged, and no second Notification is produced. `INV-6: repeated cancellation is safe and terminal state is unchanged` (`delivery.test.ts`); `the first cancellation reason wins across repeated requests` (`runs.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Already terminal** | Reported as finished; the stored Result stands. `a cancel tells a finished run apart from an id that never existed` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Unknown Run id** | Reported as unknown, distinctly from a Run that finished before the cancel arrived. `a cancel tells a finished run apart from an id that never existed` (`delivery.test.ts`); `presentation owns every agent_cancel outcome` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Request vs. terminal** | The tool reports admission; terminal cancellation is the later Notification. `a cancel stops the run without suppressing its notification` (`delivery.test.ts`); `presentation owns every agent_cancel outcome` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |

## `agent_wait`

Observes terminality only. Returns identity and lifecycle state, never output.

`agent_wait` is backend-independent: it reads the delivery module's result store
and pending map and never touches an adapter. The outcome below is identical for
Pi, Claude, and Codex.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Blocks until the named Runs are terminal, then returns each Run's identity and terminal lifecycle state. Notifications are unaffected and the Result store is unchanged. | Identical. | Identical. |
| **Proof** | `INV-5: wait observes terminality without suppressing notification` (`delivery.test.ts`) | Same. | Same. |
| **Timeout** | Returns the still-running ids as a normal outcome; the Runs keep going and notify on their own. A timeout past `setTimeout`'s ceiling waits rather than firing at once. `INV-5: timeout and unknown ids are the only special wait cases`; `a timeout past setTimeout's ceiling waits instead of firing at once` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Aborted turn** | Only the waiter stops; the Run continues and still settles and notifies. `a wait entered with a cancelled turn gives up immediately` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Repeated wait** | Returns the same lifecycle state. `INV-5: wait is repeatable for an already-terminal run` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Unknown Run id** | Reported as unknown rather than blocking. `a wait tells a delivered report apart from an id that never existed` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Duplicate ids** | One observation per id. `an id named twice produces one wait observation` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |

## `agent_result`

Fetches a terminal Run's authoritative output by Run id.

Backend-independent for the same reason as `agent_wait`.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Returns the Run's full stored output with its owning Subagent for orientation. Reading neither consumes nor pins the Result and is repeatable. | Identical. | Identical. |
| **Proof** | `INV-4: a stored result is durable and repeatable` (`delivery.test.ts`) | Same. | Same. |
| **Not yet terminal** | Reports that the Run has not finished and that its Notification will arrive on its own. `presentation owns every agent_result fallback` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Evicted output** | Reports that the output was evicted to bound result-store memory; the Run id, owner, and terminal status still answer. Eviction is oldest-first by insertion order and the newest Result always survives. `INV-4: result-store eviction follows insertion order, not retrieval order`; `a single over-budget output survives until something newer lands` (`delivery.test.ts`); `presentation owns every agent_result fallback` (`presentation.test.ts`). **[v2 change]** v1 returns prose; v2 returns a distinct typed `ResultExpired` outcome — [operation semantics §8](operation-semantics.md#8-an-evicted-result-returns-a-distinct-typed-outcome). | Same. Same proof. | Same. Same proof. |
| **Unknown Run id** | Reports no such Run and points at what `agent_start` returned. `an unknown id recalls nothing rather than throwing` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **After a failed Notification** | The stored Result is unchanged; delivery failure is not Result loss. `INV-9: notification failure cannot invalidate the stored result` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **After Session shutdown** | Nothing is retrievable: Results belong to the Session that asked. `shutdown clears retention: a report belongs to the session that asked` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |

## Subagent close (existing host and session surface)

There is **no model tool for closing a Subagent, in v1 or in v2 M0.** Closing
happens through Session shutdown, which is a host event. The row below documents
that existing surface.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Every Subagent is marked closed first, then active Runs are cancelled, then the adapter closes. Pi aborts and waits for active work, bounds extension shutdown and stalled native cancellation, then disposes the retained session. | Every Subagent is marked closed first, then active Runs are cancelled. Claude aborts the close signal, waits for the active Attempt, and forgets its continuation. Idle close is idempotent. | Every Subagent is marked closed first, then active Runs are cancelled. Codex interrupts the active Turn, cleans the session, and closes the App Server process, including when close races attachment. |
| **Proof** | `shutdown closes idle and active Subagents before late settlement can notify` (`index.test.ts`); `Pi adapter close aborts and waits for active work before disposal`; `Pi adapter bounds extension shutdown before disposal`; `Pi adapter bounds stalled native cancellation before disposal` (`harnesses/pi/agent.test.ts`) | `shutdown closes idle and active Subagents before late settlement can notify` (`index.test.ts`); `Claude adapter close stops and waits for its active Attempt`; `Claude idle shutdown is idempotent and forgets its continuation` (`harnesses/claude/harness.test.ts`) | `shutdown closes idle and active Subagents before late settlement can notify` (`index.test.ts`); `closing a Codex adapter while attaching cancels and fully cleans its session`; `closing a Codex adapter before spawn preserves the cancelled Ending`; `adapter close before a resumed executor reaches the session settles cancelled without a write` (`harnesses/codex/harness.test.ts`) |
| **Late settlement** | Cannot reopen a closed Subagent or notify the next Session. `shutdown wins resume admission synchronously and late settlement cannot reopen the Subagent` (`index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Idempotence** | A Run that already settled is not asked to stop again. `a settled run is not asked to stop again on quit` (`index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Identity cleanup** | Local Subagent and Run identity sets are forgotten at the Session boundary. `Session cleanup forgets both local identity sets` (`index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Closing one Subagent alone** | Not offered. v2 M0 introduces no new model tool; the documented policy for a close that meets an active Run is cancel-and-await-cleanup — [operation semantics §4](operation-semantics.md#4-closing-a-subagent-with-an-active-run-is-cancel-and-await-cleanup). | Same. | Same. |

## `/agents`

Lists loaded Profiles and opens their prompts.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Lists each Profile by name and description, whatever backend it names; the list carries no backend-specific field. Selecting one shows its prompt and offers the work action. | Identical. | Identical. |
| **Proof** | `the agents list is identical whichever harness a profile names` (`agents-command.test.ts`, added in M0); `registerAgentsCommand registers the agents slash command`; `agents command opens a selector when agents are loaded` (`agents-command.test.ts`) | Same. Same proof. | Same. Same proof. |
| **No Profiles** | Says where to add one, naming the agents directory, and opens no selector. `an agents command with nothing to list says where to add a profile` (`index.test.ts`); `agents command points at the agents directory when none are configured` (`agents-command.test.ts`) | Same. Same proof. | Same. Same proof. |

## Active widget

The session widget listing live Runs.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | One row per live Run carrying agent, backend name, turn count, status, and current activity — nothing else fixed, and no id or model. The row for a Pi Run reads `explore  pi  3 turns  running · …`. | Identical apart from the backend name: `explore  claude  3 turns  running · …`. | Identical apart from the backend name: `explore  codex  3 turns  running · …`. |
| **Proof** | `a run line names each harness the same way` (`widget.test.ts`, added in M0); `a run line carries agent, harness, turns and status, and nothing else fixed` (`widget.test.ts`) | `a run line names each harness the same way` (`widget.test.ts`, added in M0) | `a run line names each harness the same way` (`widget.test.ts`, added in M0) |
| **Observation only** | The widget never determines lifecycle state. `INV-10: the widget observes runtime state without determining it` (`widget.test.ts`); `INV-10 boundary: widget and result presentation never determine state` (`index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Lifecycle** | Appears with the first Run and is removed when none are left; a change redraws rather than reinstalls. `the widget appears with a run and is removed when none are left`; `a change redraws the widget instead of reinstalling it` (`widget.test.ts`) | Same. Same proof. | Same. Same proof. |

## Completion Notification messages

The status-specific completion notice pushed as a follow-up message.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Expected outcome** | Derived from the neutral Result alone, so the prose is backend-independent: it names the owning Subagent and the Run, carries a bounded preview for a completed Run, and points at `agent_result` by Run id. Accounting appends usage, turn count, and the model the Profile selected. | Identical prose; the model string is a Claude model. | Identical prose; the model string is a Codex model. |
| **Proof** | `completion notification prose is identical whichever harness ran the Run` (`presentation.test.ts`, added in M0); `N1/N2: completed notification has a deterministic bounded preview and result pointer`; `notification accounting abbreviates usage and includes the model` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Failed Run** | Carries only the primary error and the pointer, bounded even for a pathological message. `N3: failed notification carries only the primary error and pointer`; `N1: failed notification bounds a pathological error message` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Cancelled Run** | Terse, with no partial output in the notice; the partial output stays retrievable through `agent_result`. `a cancelled notification is terse and contains no partial output` (`presentation.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Landing** | Exactly one landing per Notification; a notice an interrupt discarded is pushed again after the agent settles. `one landing per run: re-push never double-delivers`; `INV-9: an explicitly aborted host turn retries its unlanded push after settle` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Push failure** | Cannot change or lose the stored Result. `INV-9: notification failure cannot invalidate the stored result`; `INV-9 boundary: a failed notification push preserves the exact result` (`delivery.test.ts`, `index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **No live Session** | Dropped rather than delivered into a Session that did not start the Run. `a report with no session bound is dropped, not queued for the next one` (`delivery.test.ts`) | Same. Same proof. | Same. Same proof. |

## Profile loading and validation

Profiles are Markdown files read from user scope only.

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| **Generic parsing** | `description`, `harness` (default `pi`), and the body are the only generic fields; every other frontmatter field is handed to the named backend. A missing description or body is a diagnostic. `parseAgentConfig reads name, frontmatter, and system prompt`; `parseAgentConfig rejects agents without required description`; `parseAgentConfig rejects agents without required prompt body` (`agents.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Unknown backend name** | A profile diagnostic at session start. `unknown harnesses and fields become profile diagnostics` (`agents.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Unrecognized field** | The named backend rejects fields it does not understand; the rejection is a diagnostic, not a silent pass-through. `profile loading asks the fake harness to reject its own unknown fields`; `the named harness diagnoses profile field types` (`agents.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Model validation** | An exact model id (or `provider/model-id`) checked against Pi's loaded catalogue, with a bounded diagnostic when it is absent or the catalogue is empty. `the pi harness diagnoses models against its catalogue`; `the pi harness rejects a pinned model when its catalogue is empty`; `the pi catalogue diagnostic stays bounded` (`agents.test.ts`) | An SDK family alias, passed through unresolved for the SDK to interpret; a non-alias value is diagnosed with its value. `Claude validation accepts exactly the SDK family aliases`; `Claude passes the alias through unresolved for the SDK to interpret`; `Claude validation diagnoses a non-alias model with its value` (`harnesses/claude/harness.test.ts`) | Validated by the Codex adapter along with effort mapping and prompt composition. `Codex preserves profile validation, effort mapping, and prompt composition` (`harnesses/codex/harness.test.ts`) |
| **`tools` and `appendSystemPrompt`** | Comma-separated tool list with empty segments ignored; a separators-only list disables all tools; `appendSystemPrompt` defaults to true. `parseAgentConfig accepts a comma-separated tools list`; `common profile accessors normalize tools and default appendSystemPrompt` (`agents.test.ts`, `harnesses/contract.test.ts`) | Shares the trimming and empty-segment rules with Pi, and preserves an explicitly empty allowlist. `Claude shares tools trimming and empty-segment handling with Pi`; `Claude preserves an explicitly empty tools allowlist` (`harnesses/claude/harness.test.ts`) | Shares the common accessors. `common profile accessors normalize tools and default appendSystemPrompt` (`harnesses/contract.test.ts`) |
| **`effort`** | Pi's thinking level, validated against the shared scale. `parseAgentConfig reads effort as its own field`; `parseAgentConfig accepts every effort in the scale`; `parseAgentConfig rejects an unknown effort` (`agents.test.ts`) | Mapped to a thinking budget entirely inside the adapter. `Claude thinking budgets stay inside the adapter` (`harnesses/claude/harness.test.ts`) | Mapped to `model_reasoning_effort` inside the adapter. `Codex preserves profile validation, effort mapping, and prompt composition` (`harnesses/codex/harness.test.ts`) |
| **Scope** | Read from the user agents directory only; a project directory cannot contribute a Profile, trusted or not. `getAgentsDir reads agents from user scope only` (`agents.test.ts`); `a project directory cannot contribute an agent, trusted or not` (`index.test.ts`) | Same. Same proof. | Same. Same proof. |
| **Backend field name** | **[v2 change]** v1 reads `harness`. v2 understands only `backend`, with the same values, through a documented rename; a Profile still using the old name fails v2 validation as an unrecognized field. See [the migration note](profile-backend-field-migration.md) and [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md). v1 is unchanged. | Same. | Same. |

---

## Coverage

Every row above has an explicit expected outcome in all three backend columns —
no cell says "TBD", and no cell says only "same as v1". Cells that read "Same"
mean "the same expected outcome as the Pi column of this row", with the proof
named in the Pi column applying unchanged; that is an explicit statement about
this backend, not a deferral.

Cells marked **[v2 change]**, and only those, are places where v2 will
deliberately differ from v1:

| Row | What changes | Where it is decided |
| --- | --- | --- |
| `agent_start` | A global capacity limit that rejects immediately | [operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic) |
| `agent_resume` | Shutting-down becomes a distinct outcome instead of `unknown subagent` | [operation semantics §5](operation-semantics.md#5-shutdown-rejects-new-work-as-soon-as-it-begins) |
| `agent_steer` | `queue full` → `mailbox full`; `not steerable` → `mailbox closed` | [operation semantics §7](operation-semantics.md#7-a-full-control-mailbox-returns-an-immediate-typed-outcome) |
| `agent_result` | Evicted output becomes a typed `ResultExpired` outcome | [operation semantics §8](operation-semantics.md#8-an-evicted-result-returns-a-distinct-typed-outcome) |
| Profile loading | `harness:` → `backend:` by documented migration | [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md), [migration note](profile-backend-field-migration.md) |
