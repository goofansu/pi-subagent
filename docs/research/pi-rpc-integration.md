# pi-subagent integration with Pi RPC clients

## Evidence and conclusion

Source review, not runtime verification. Reviewed pi-subagent revision
`578b712a552e76fbc33544afdabbc6b3ecc9edfb` (1.0.5), Piano's research at
`/Users/james/scratch/piano/docs/research/pi-subagent-events.md`, and the installed
Pi core at `/Users/james/scratch/piano/node_modules/@earendil-works/pi-coding-agent`.
Core references below are relative to that package; repository references are
relative to this repository. No provider calls or browser verification performed.

**Three useful levels are available: existing delegation cards, a new plain-text
RPC widget without core changes, and a structured live bridge requiring a transport
decision.** Rendering belongs to Piano; pi-subagent should supply authoritative facts,
not terminal components or raw backend events.

## 1. Existing delegation cards: no pi-subagent change required

Tool results already carry structured presentation `details`; completion custom
messages carry Run/Subagent identity, label, terminal status and duration.
Piano currently drops these details. Preserve and validate them in Piano, joining
start/resume arguments to results by Pi tool-call ID, then later results by Run ID.

Sources: `extensions/subagent/host/tools.ts:63-103`,
`extensions/subagent/host/notification-message.ts:50-100`,
`extensions/subagent/presentation/tool-row-facts.ts`; Piano research §§2/5.
Core `dist/modes/rpc/rpc-mode.js:263-269` forwards session events through
`dist/modes/json-event.js`; final tool/custom messages retain their details.

Important limits:

- These are existing presentation facts, not a versioned public live-state protocol.
- Wait and result retrieval can deliver terminal Results without a notification.
- Cancellation requested is not terminal cancellation; steering admission does not
  prove the model received guidance.
- Historical admission is only last-observed state after process restart.

Sources: `extensions/subagent/host/push-sink.ts`,
`docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md`; Piano research §§2–4.

## 2. Smallest pi-subagent improvement: a plain-text RPC widget

Core explicitly supports `ctx.ui.setWidget(key, string[])` over RPC, but ignores
component factories. It forwards text as an `extension_ui_request`; the client
chooses how to display it. Removal is `setWidget(key, undefined)`.

Sources: core `docs/rpc-extension-ui.md` (Limitations and setWidget),
`dist/modes/rpc/rpc-mode.js:123-136`,
`examples/extensions/rpc-demo.ts` (session_start example).

Today's `installActiveWidget` installs a factory and thereafter calls
`tui.requestRender()`. Switching only its first installation to static lines
would leave subsequent updates stale.
Source: `extensions/subagent/host/widget.ts:185-301`.

Proposed change:

- Select a separate RPC presenter at Session installation using `ctx.mode`.
- Reuse `widgetRows`, `CompletionHandoffView` and `followPublishedRuns`.
- Publish plain, sanitized, bounded text: label, phase, current activity and counts.
- Republish changed text with a scheduled, coalesced refresh. The current TUI
  refresh latch relies on a render callback; the RPC presenter needs its own
  flush completion and explicit rate limit, not just that latch copied unchanged.
- Clear on empty state and Session teardown. Keep the TUI presenter unchanged.

This can supply live human-readable status through Piano's generic extension
widget handling. It is **not** a machine-readable feed, an interactive dashboard,
or a reconnect snapshot API. Do not encode JSON into widget lines for Piano to parse.

## 3. Rich live cards and inspector: reuse the existing observation seam

The application already exposes the necessary authoritative reads:

| Seam | Use |
| --- | --- |
| `followPublishedRuns` / `publishedRuns` | Run-index changes / current index |
| `followSubagentSummaries` | Coalesced Subagent summaries |
| `captureRunHistory` | Frozen history for one Subagent |
| `inspectRun` | Bounded Run content without consuming its Result |

Source: `extensions/subagent/application/observation.ts:145-260`.

The host's `SessionObservation` wraps these as `watchSummaries`, `captureHistory`,
`inspectRun`, `currentInstant`, and `dispose`. `SessionHandle.observe` leases the
reader to a specific Session binding. A new host bridge should reuse that boundary,
like the dashboard, rather than expose runtime services or reproduce the reducer.

Sources: `extensions/subagent/host/session-observation.ts:24-52`,
`extensions/subagent/host/session-handle.ts:104-158`,
`extensions/subagent/host/dashboard-command.ts:31-49`.

### Proposed wire contract

Define a separate versioned DTO rather than exporting internal types unchanged:

- Capabilities and schema version.
- Session/host generation, sequence, snapshot/update/reset discriminant.
- Stable Subagent ID and per-Run ID, Profile, description, authoritative phase,
  activity, timestamps and optional cumulative usage.
- Snapshot/subscription ordering, gap recovery and explicit disposal/reset.
- Bounded on-demand inspection, including truncation and Result-expired states.
- Explicit limits on rows, bytes and pending updates; window or paginate history.

A single Run's content is bounded (500 transcript items, 200 tools, 50 diagnostics,
20 links, 16 KiB per text part, 64 KiB final output), but the Session Run index is
not count-bounded. Per-Run bounds therefore do not make an entire snapshot bounded.

Sources: `extensions/subagent/domain/projection.ts:84-91`,
`extensions/subagent/runtime/repository.ts:117,502-513`.

Terminal inspection can report `ResultExpired`. A client may display previously
received historical content, but must distinguish that cached content from current
server availability. Inspection must not consume completion delivery or silently
pin Results. Old Session leases must never begin reading a replacement Session.

Sources: `extensions/subagent/runtime/inspection.ts:59-94`,
`extensions/subagent/domain/inspection.ts:28-52`,
`extensions/subagent/host/session-handle.ts:104-158`.

### Transport is the missing piece

The inspected core RPC dispatcher has no generic extension request/event API and
no direct `execute_tool` command. `pi.events` is an in-process extension bus, not
an RPC subscription. `setWidget` is text-only; `custom()` returns undefined.

Sources: core `dist/modes/rpc/rpc-mode.js:298-570`,
`docs/extensions.md` (integration points), `docs/rpc-extension-ui.md`.

Preferred end state: a **namespaced extension request/event facility in Pi core**,
with discovery and bounded delivery, then a pi-subagent host bridge using it.
An opt-in local side channel could avoid a core change, but introduces connection,
authorization, remote-host routing and lifecycle responsibilities. Do not choose it
merely to avoid specifying the transport.

Do not write ad-hoc records to core's stdout or use custom chat messages as a
high-frequency event bus. Core owns JSONL framing; chat messages enter conversation
history, and current subagent completion notifications intentionally trigger turns.
Sources: core `docs/rpc.md` (Framing),
`extensions/subagent/host/session.ts:214-222`.

### Controls: an important nuance

Registered slash commands can already be invoked through RPC `prompt`, including
while the parent is streaming, without asking the model to interpret them. However,
core discards handler return values; its `handled` acknowledgement is not a typed
operation outcome, and handler failures are separate `extension_error` events.
Unknown commands can fall through to prompting, so capability discovery matters.

Sources: core `dist/core/agent-session.js:1506-1525,1632-1657`.

This permits future human-oriented command controls without a core transport change,
but is not a replacement for correlated programmatic cancel/steer/resume results.
The existing observation seam is read-only; controls must route through application
operations with explicit acknowledgements, not through observation or silent model
prompts. Existing `/subagent dashboard` remains TUI-only.

## Recommended order and acceptance

1. Piano: retain existing details and render correlated delegation/result cards.
2. pi-subagent: add the bounded plain-text RPC widget as a small independent change.
3. Pi core + pi-subagent: agree the extension transport, then add versioned live
   snapshots and on-demand inspection; add acknowledged controls separately.

Before acceptance, observe and retain a real RPC capture showing initial widget,
activity replacement, terminal hand-off and removal. For cards, cover both notified
and wait-delivered results. For the structured bridge, additionally cover reconnect,
Session replacement, slow consumers, Result eviction and independent child lifetime
after parent settlement. Browser rendering needs separate Piano verification.

No implementation was made. Runtime compatibility and browser behavior remain
**unverified**.
