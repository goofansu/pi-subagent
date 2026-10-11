# Subagent Run metrics for Piano's session context control

## Evidence and conclusion

Source review, not runtime verification. Reviewed pi-subagent revision
`578b712a552e76fbc33544afdabbc6b3ecc9edfb` (1.0.5) and Piano revision
`238fcc18a25a3986278be1c554c71038cd267ab9` at `/Users/james/code/piano`.
Re-evaluated at pi-subagent `86095cd`, which bumps Pi to **1.1.0**, the same
core Piano runs; the `core086/` citations below were taken from 0.86.0 and
were re-checked as unchanged in 1.1.0 for the shapes this note relies on
(`SessionStats`, per-message `Usage`, `AgentToolResult.usage`). Nothing in the
0.86→1.1.0 changelog alters usage reporting; the only build-affecting change
was `AgentSession.steer()` returning a disposition (`86095cd`). Path prefixes
below: none = this repository; `piano/` = Piano; `core/` = Pi core 1.1.0 under
Piano's `node_modules/@earendil-works/`; `core086/` = the same packages under
this repository's `node_modules/@earendil-works/` (now also 1.1.0); `sdk/` =
`node_modules/@anthropic-ai/claude-agent-sdk`. No provider calls, browser
runs, or `npm run check` were performed. This note builds on
`docs/research/pi-rpc-integration.md`, which already covers how tool `details`
and the Notification custom message reach Piano over RPC.

**pi-subagent already holds every metric Piano displays, per Run, in Pi core's
own vocabulary, for both backends; the only gap is that none of it is placed on
the two structured channels Piano already parses (`result` tool facts and
Notification details), so the smallest change is to add a `usage` block to
those two payloads and let Piano sum per Subagent.**

## 1. What Piano shows and where it comes from

Piano's "Session usage" group in the composer opens `ContextDetails`
(`piano/web/src/components/Composer.tsx:200-215`). That popover renders:

| Piano field | Type (`piano/shared/wire.ts`) | Pi core source | Refresh |
| --- | --- | --- | --- |
| `context.tokens`, `context.contextWindow`, `context.percent` | `ContextUsage` `:174-179`; `tokens`/`percent` nullable | `get_session_stats` → `contextUsage` (`core/dist/core/agent-session.js:3438-3471`) | `piano/server/PiSessions.ts:488-500` on open, finalized message, compaction, model change, settle (`:579-590,881-882`) |
| `tokens.input/output/cacheRead/cacheWrite/total` | `SessionStats.tokens` `:198-204` | `getSessionStats` sums assistant, toolResult, usage, compaction and branch-summary entries (`core/dist/core/agent-session.js:3383-3436`) | same |
| `cost` | `SessionStats.cost` `:200` | same, `usageTotals.cost` (`:3434`) | same |
| per-response `usage.input/output/cacheRead/cacheWrite/totalTokens/cost` + `model`, `thinkingLevel` | `Usage` `:34-39`, `RenderMsg` `:131-136` | assistant and toolResult `message.usage` from history and `message_end` (`piano/server/PiRecords.ts:15-18,45-48,202,206`), streaming `message_update.usage` (`:289`) | per message |
| derived "Cache hit" | computed `cacheRead / (input+cacheRead+cacheWrite)` | — (`piano/web/src/components/ContextDetails.tsx:22-26`) | — |

The table rows are literally Input, Output, Cache read, Cache write, Cache hit,
Total tokens, Cost (`ContextDetails.tsx:107-115`); `undefined` renders as `—`.
`SessionStats` interface is identical in both core versions
(`core/dist/core/agent-session.d.ts:201-218`,
`core086/pi-coding-agent/dist/core/agent-session.d.ts:177-194`), and
`get_session_stats` is handled in both RPC dispatchers
(`core/dist/modes/rpc/rpc-mode.js:466-468`, `core086/.../rpc-mode.js:468-470`;
documented at `core086/pi-coding-agent/docs/rpc.md:556-595`).

The per-message `Usage` shape in pi-ai is `input`, `output`, `cacheRead`,
`cacheWrite`, optional `cacheWrite1h` and `reasoning`, `totalTokens`, and a
`cost` object whose `total` Piano reads
(`core/pi-ai/dist/types.d.ts:270-289`; same fields in
`core086/pi-ai/dist/types.d.ts:273-290`). The context window comes from
`Model.contextWindow` (`core/pi-ai/dist/types.d.ts:801`).

Piano's stated expectations: Pi is the authority for usage (INV-01, INV-03:
`piano/docs/development-invariants.md:11-16,40-45`); the context popover
explicitly adds "no ... subagent aggregation"
(`piano/docs/research/2026-10-04-shelley-token-display.md`, Follow-up
paragraph); and the bridge proposal lists "optionally cumulative usage" per
row with "token accounting ... in details"
(`piano/docs/research/pi-subagent-events.md` §6B). Piano already validates
pi-subagent `details` into `SubagentCard` (`piano/shared/wire.ts:52-98`,
`piano/server/PiRecords.ts:91-182`) and renders a result card with only
`durationMillis` as a metric (`piano/web/src/components/MessageList.tsx:375`).
No `usage` is read from any subagent payload today.

## 2. What pi-subagent already captures

The domain defines usage in Pi core's own field names. `UsageDelta` carries
optional `input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `turns`
(`extensions/subagent/domain/usage.ts:64-71`); `ContextGauge` is
`{ tokens, window? }` (`:81-85`); `UsageTotals` has all five counters always
present (`:146-152`); `UsageSnapshot` is `{ totals, context, turns }`
(`:176-180`). Deltas add, the gauge replaces, reconciliation replaces
(`:191-235`), per ADR-0027 (`docs/adr/0027-v2-usage-normalization.md:57-73,
89-101,104-108`): usage is Run-local, resume never re-charges prior
Conversation usage, and the gauge is never summed.

The immutable Result carries `usage: UsageSnapshot` and an optional `model`
(`extensions/subagent/domain/result.ts:110-131`; `usage` at `:124`, `model` at
`:127`), with the gauge deliberately inside `usage.context` (`:9-12`).
Inspection also exposes it before settlement
(`extensions/subagent/domain/inspection.ts:23`,
`extensions/subagent/runtime/inspection.ts:40,63-64`). The TUI already prints
input, output, cache read, cache write, total, turns and cost
(`extensions/subagent/presentation/inspection.ts:67-97`), a context gauge with
percent when a window exists (`presentation/run-card.ts:145-153,213-215`), and
an accounting line in notices (`presentation/notification-text.ts:113-122`).

Per backend:

| Metric | Pi-backed Run | Claude-backed Run |
| --- | --- | --- |
| input / output / cacheRead / cacheWrite | per assistant message `usage.*` via in-process `AgentSession` events `message_end` / `agent_end` (`extensions/subagent/backend/pi/translate.ts:214-237,489,527-531`), summed in `run-evidence.ts:133-141,147-176` | summed over every `modelUsage` entry of the result frame (`backend/claude/translate.ts:313-339`), differenced against the previous cumulative frame (`:349-368`), emitted at `:630-636` |
| cost | `usage.cost.total` (`pi/translate.ts:215-222`) | `total_cost_usd`, falling back to summed `costUSD` (`claude/translate.ts:332-338`; `sdk/sdk.d.ts:4616-4626`) |
| context tokens | `usage.totalTokens` as a gauge, **no window** (`pi/translate.ts:26-27,223,236`) | primary model `inputTokens + cacheRead + cacheCreation`, with `contextWindow` from `ModelUsage` (`claude/translate.ts:397-411`; `sdk/sdk.d.ts:1288-1296`); no gauge when no window (`:389-395`) |
| turns | per assistant message | `num_turns` delta (`claude/translate.ts:529,633`) |
| model | `provider/model` (`pi/translate.ts:229-233`) | primary model (`:625`) |

The Pi adapter does not read the child session file or call
`getSessionStats`; it owns a real `AgentSession` from `createAgentSession`
(`backend/pi/backend.ts:16,60`), subscribes to its events
(`backend/pi/execution.ts:82,154`) and prompts it (`:373`). Neither adapter
reads Pi's `cacheWrite1h` or `reasoning`.

Summary rows exposed to the widget carry only `turns`
(`extensions/subagent/runtime/history.ts:60`,
`extensions/subagent/domain/history.ts:11-45`).

## 3. Where metrics stop today: the two structured channels

**Result tool facts.** `agent_result` returns `details.run = { runId, agent,
status }` (`extensions/subagent/presentation/tool-row-facts.ts:503-507,
654-660,892-898`); `agent_wait`/`agent_wait_all` return the same summary per
delivered Run in `collection.runs` (`:510-520,1020`). The `RunResult` is in
hand at both call sites (`resultRunSummaryOf(result)`), so `result.usage` and
`result.model` are one field away. Details are encoded and decoded with
`EXACT_KEYS` (`:1111-1117`).

**Notification details.** `NotificationDetails` is `runId`, `subagentId`,
`agent`, `label`, `status`, `durationMillis`
(`extensions/subagent/host/notification-message.ts:59-67,84-100`). The header
comment explicitly argued cost out of the details because the collapsed TUI
line does not show one (`:24-26`). The domain `RunNotification` carries a
presentation-shaped `NotificationAccounting` (input, output, cost, turns,
model; no cache figures, no gauge) rather than the `UsageSnapshot`
(`extensions/subagent/domain/notification.ts:140-156,176-193,318-320`). The
notice is built from the stored Result (`:318`), consistent with ADR-0006
("storage precedes notification, and delivery reads the store",
`docs/adr/0006-completion-notifications-and-result-store.md:20`).

Both channels are already forwarded unchanged through RPC and validated in
Piano (`docs/research/pi-rpc-integration.md` §1;
`piano/server/PiRecords.ts:91-182`). The RPC widget proposed in that note's §2
is text and must not be parsed; the live bridge in §3 is the only path for
pre-settlement usage.

**A third, Pi-native channel exists but is hazardous.** An extension tool's
`AgentToolResult` may carry `usage?: Usage`
(`core/pi-agent-core/dist/types.d.ts:370-381`;
`core086/pi-agent-core/dist/types.d.ts:337-343`); the agent loop copies it onto
the toolResult message (`core/pi-agent-core/dist/agent-loop.js:618,665`),
`getSessionStats` adds it to session totals
(`core/dist/core/agent-session.js:3383-3436`), and Pi's docs ask tools that
make nested model calls to report it "so session totals remain accurate"
(`core/pi-coding-agent/docs/extensions.md:136`). Piano would then show
Subagent spend in its existing "Session" column with no Piano change, and per
tool result (`piano/server/PiRecords.ts:206`). But one Run's Result can be
delivered by `agent_wait`, `agent_wait_all`, repeated `agent_result` calls,
and the Notification (`docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md`),
so attaching `usage` to tool results would double count unless exactly one
delivery carries it; custom messages have no `usage` field at all
(`core/dist/core/messages.d.ts:32-39`), so a Notification-only completion could
never be counted. Pi also states tool usage is "not used for main LLM context
accounting" (`core/pi-agent-core/dist/types.d.ts:380`), so the context gauge is
unaffected either way.

## 4. Gap analysis and smallest change

| Backend | Has counters, cost, turns, model | Has context gauge | On a Piano-parsed channel |
| --- | --- | --- | --- |
| Pi | yes (`pi/translate.ts:214-237`) | tokens only, no window (`:236`) | no |
| Claude | yes (`claude/translate.ts:313-339,630-636`) | tokens and window when `modelUsage` has one (`:397-411`) | no |

Smallest change, in order:

1. **`ResultRunSummarySchema` gains `usage`** (shape in §5) and
   `resultRunSummaryOf` copies `result.usage`/`result.model`
   (`tool-row-facts.ts:503-507,892-898`). This covers `agent_result`,
   `agent_wait`, and `agent_wait_all` in one place; `unavailable`/
   `still-running`/`unknown` outcomes stay as they are because no Result exists.
2. **`NotificationDetails` gains the same `usage`**
   (`host/notification-message.ts:59-67,84-100`). Either extend
   `RunNotification` with the Result's `UsageSnapshot` or build the details
   from the Result alongside the notice; the former keeps `build` a pure map of
   the domain notice, which the file's own design note prefers (`:28-30`).
   This reverses the "no cost in details" comment (`:24-26`); the reason has
   changed because a non-TUI reader now exists. The collapsed TUI line and
   `NotificationAccounting` need not change.
3. **Piano**: extend `SubagentCard` result/collection rows with the optional
   block (`piano/shared/wire.ts:52-98`), validate it in `SubagentProjection`
   (`piano/server/PiRecords.ts:133-182`), render it in the result card
   disclosure next to Duration (`MessageList.tsx:375`), and sum per
   `subagentId` from cards if a Subagent total is wanted. Usage is Run-local
   (ADR-0027), so summing Run cards is the correct Conversation total;
   pi-subagent should not pre-aggregate.

Backward compatibility: Piano's projection copies named fields and ignores the
rest, so an older Piano simply drops `usage`. An older pi-subagent reading a
newer payload with `EXACT_KEYS` would reject it (`tool-row-facts.ts:1111`,
`notification-message.ts:117-121` is lenient for landed notices), which only
matters for a persisted session reopened under a downgraded extension; a
schema with `usage` optional on the read side avoids that. The Result itself
is unchanged, so ADR-0006/0033 pointer and storage rules are untouched.

Live, pre-settlement usage stays out of scope for this change; it needs the
structured bridge from the existing note §3 (`application/observation.ts`,
`runtime/inspection.ts:40,64`).

## 5. Recommended backend-neutral metrics shape

Name fields exactly as Pi core does so Piano reuses `usageOf` and the
`ContextDetails` rows unchanged:

```ts
usage: {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number;             // USD; provider-reported, 0 when nothing was charged
}
model?: string;             // provider/model as the Run reported it
```

Decided scope: the five figures above only. Piano derives Total tokens
(`input + output + cacheRead + cacheWrite`, as `SessionStats.tokens.total`,
`core/dist/core/agent-session.js:3432`) and Cache hit
(`ContextDetails.tsx:22-26`) itself. No `turns`, no `context` gauge: a
context window for Pi-backed children is not wanted, and the gauge is
Run-local and never summed, so it has no place in a per-Profile table.

- Counters and `cost` map 1:1 from `UsageTotals` (`domain/usage.ts:146-152`).
- `cost` is always a number because both adapters supply one
  (`pi/translate.ts:222`, `claude/translate.ts:332-338`) and the domain stores
  `0` rather than absence. If a future backend cannot price, prefer omitting
  the key over sending `0`, so Piano renders `—` as it does for an unknown
  session cost (`ContextDetails.tsx:114`); that needs an `optionalKey` on the
  wire schema, not a domain change.
- `model` is optional on the wire because it is optional on the Result
  (`domain/result.ts:127`): a Profile may omit `model` (`README.md:77`), so
  the figure is what the backend reported, read from the first assistant
  message on Pi (`backend/pi/run-evidence.ts:150-177`) or the result frame on
  Claude (`backend/claude/translate.ts:620-627`), and a Run that fails or is
  cancelled before any response reports none. Every Run with non-zero usage
  had a response and so has a model; Piano can read absence as "no response
  happened", and such Runs add no row to the breakdown.
- Do not add `cacheWrite1h` or `reasoning` until an adapter captures them.

## 6. Per-Profile cost breakdown for the current Session

Piano today shows only the main Session's cost. The requested view is a
breakdown of Subagent spend by Profile for the Session open in Piano, next to
the existing Session row.

Everything needed is already keyed. Every usage-carrying payload from §4
names its Profile: `details.run.agent` on `agent_result`, `runs[].agent` on
`agent_wait`/`agent_wait_all` (`tool-row-facts.ts:503-520`), and `agent` on
`NotificationDetails` (`host/notification-message.ts:62`). Piano already
copies that name into `profile` on every card and remembers it per `runId`
and per `subagentId` (`piano/shared/wire.ts:40-45`,
`piano/server/PiRecords.ts:62,101-107,135,148,172-177`). So the breakdown is
a fold over result and collection cards:

```
byProfile[profile] += usage          // one entry per runId, last delivery wins
```

Rules the fold must follow, and why pi-subagent can promise them:

- **One entry per `runId`.** A Result can reach the Session via a wait, a
  later `agent_result`, and the Notification; the Result is immutable
  (ADR-0006, `docs/adr/0006-completion-notifications-and-result-store.md:20`;
  ADR-0036), so every delivery carries identical `usage` and replacing by
  `runId` is lossless. This is why the Pi-native tool-result `usage` field
  (§3) cannot serve the breakdown: Pi sums it per delivery, with no `runId`
  and no Profile.
- **Summing Runs gives the Subagent and Profile totals.** Usage is Run-local
  and resume never re-charges earlier Conversation usage (ADR-0027,
  `docs/adr/0027-v2-usage-normalization.md:57-73,89-101`), so Runs of one
  Subagent add without overlap. Only the context gauge must not be summed
  (`:104-108`); the breakdown should show counters and cost per Profile and
  leave the gauge per Run.
- **Neither channel is guaranteed, so both carry usage.** A Run that a
  wait or `agent_result` returns first is marked consumed, and its pushed
  Notification is accepted but not sent (`host/push-sink.ts:36-46`). A Run
  nobody waits for is announced only by the Notification. So a breakdown fed
  from tool results alone misses unwaited Runs, and one fed from
  Notifications alone misses every waited Run. Piano reads both, dedups by
  `runId`, and treats whichever arrives as the record; it must never assume
  a Notification will follow a wait or a wait will follow a Notification.
- **History survives reopen.** Piano rebuilds cards from the session file
  (`piano/server/PiRecords.ts:74-85,261`), so the breakdown is reconstructible
  without live state, matching Piano's "historical projection" stance.

Profile name is the right grouping key, not `subagentId` or `model`: the
Profile is what the user chose and what the dashboard lists, while several
Subagents may share a Profile and one Profile may run on different models per
backend (`README.md` Agent profile format). Piano can offer `model` as a
secondary grouping since the payload carries it.

Pi itself has a precedent for this layout: 1.1.0's `/session` "lists cost
per physical model" for virtual models (`core/pi-coding-agent/CHANGELOG.md:278`),
so a per-Profile table under the Session row follows an existing Pi pattern.

Where the view lives, and how it fits the current popover. The popover is a
fixed `w-96` panel that scrolls vertically
(`piano/web/src/components/Composer.tsx:214`), and the usage table is
`table-fixed` with a 2/5 label column and two numeric columns, Response and
Session, whose cells `break-all` (`ContextDetails.tsx:71-87`). Session
figures like `5,124,608` and `$6.7748` already fill those cells, so a third
numeric column would wrap. The breakdown therefore goes in rows, not columns:

- **Session column stays main-only.** It is Pi's `getSessionStats`, which
  Piano treats as the authority (`piano/docs/development-invariants.md:11-16`)
  and which matches Pi's own `/session` output. Folding Subagent spend into
  it would make the two disagree.
- **A "Subagents" section below the table**, same `table-fixed` shape: label
  column = Profile name, two numeric columns = Tokens and Cost, one row per
  Profile, a final "All subagents" row, and optionally one "Session +
  subagents" cost line. Extra rows only add height, which the popover already
  scrolls.
- **No model column.** The popover shows the model only as a caption under
  the response slider (`ContextDetails.tsx:66-68`, rendered as
  `provider/model · effort`). Follow that: if a Profile's Runs all used one
  model, print it as a muted caption under the Profile row; if they used
  several, omit it. Grouping by model would multiply rows without a place to
  put them.
- The TUI `/subagent` command does not mirror this table; the view is
  Piano-only.

## 7. Work plan

### pi-subagent

Done on branch `feat/run-usage-details` (worktree
`~/.herdr/worktrees/pi-subagent/feat-run-usage-details`): `1432e97` code and
tests, `8027219` ADR-0039 and CONTEXT.md. `npm run check` observed green.
Not pushed; the RPC transcript capture in item 5 is still open.

1. **Result tool facts.** Add `usage` (five figures, §5) and optional `model`
   to `ResultRunSummarySchema` and fill them in `resultRunSummaryOf`
   (`presentation/tool-row-facts.ts:503-507,892-898`). Covers `agent_result`,
   `agent_wait`, `agent_wait_all` at once. Keep `usage` optional on the read
   side so a persisted session from an older extension still decodes under
   `EXACT_KEYS` (`:1111`). Tests: `tool-row-facts.test.ts`,
   `agent-tool-outcome-golden.test.ts`.
2. **Notification accounting.** Add `cacheRead` and `cacheWrite` to
   `NotificationAccounting` and `toNotificationAccounting`
   (`domain/notification.ts:140-156,176-193`). Carry the unrounded cost for
   the wire and round only in the text formatter, so Piano's per-Profile
   sums do not drift; today the domain rounds to four places (`:181`). The
   accounting is `undefined` for a Run that spent nothing (`:182-184`), which
   maps to an absent `usage` on the wire. Tests: domain notification tests,
   `notification-final-output.test.ts`.
3. **Notification details.** Copy the five figures and `model` into
   `NotificationDetails` and `buildNotificationMessage`
   (`host/notification-message.ts:59-67,84-100`); update the header comment
   that argued cost out (`:24-26`). Tests: `notification-message.test.ts`,
   `push-sink.test.ts` if it asserts the details shape.
4. **Docs.** `CONTEXT.md` Notification and presentation-facts entries, and
   an ADR noting that `details` on both channels now carry Run usage for
   external readers, with Pi's native tool-result `usage` deliberately unused.
5. **Verify.** Focused tests above, then `npm run check`. Capture one real
   RPC transcript with a waited and an unwaited Run to confirm both payloads.

### Piano

1. **Wire.** Add optional `usage` `{input, output, cacheRead, cacheWrite,
   cost}` and `model` to the `result` card and to `collection.runs[]`
   (`piano/shared/wire.ts:40-98`).
2. **Projection.** Validate and copy them in `SubagentProjection.tool` for
   `agent_result` and the two waits, and in `notification`
   (`piano/server/PiRecords.ts:131-150,176-182`). Tests:
   `test/SessionProjection.test.ts`, `test/fake-delegation-pi.mjs` fixtures.
3. **Fold.** One pure function over `messages`: collect every card with
   `usage`, keep one per `runId` (last wins), group by `profile`, sum the
   five figures, derive total tokens and cache hit, record the set of models
   per Profile. Place it beside the transcript helpers
   (`piano/web/src/lib/transcript.ts`) with a unit test.
4. **Render.** A "Subagents" group under the usage table in
   `ContextDetails.tsx:71-88`: same `table-fixed` shape, one row per Profile
   (Tokens, Cost), model caption when the Profile used one model, an
   "All subagents" row, and optionally a "Session + subagents" cost line.
   Session column unchanged. Hidden when no card has usage. Tests:
   `test/MessageList.test.ts` or a new `ContextDetails` test, plus a browser
   check in the style of `test/browser-context-chart.mjs`.
5. **Verify.** Open a session that ran at least two Profiles, one waited and
   one not, and screenshot the popover.

## Open decisions

All resolved.

1. **Pi-native tool-result `usage`: no.** Pi sums it per delivery, so a wait
   followed by `agent_result` double counts unless the host keeps a
   consume-once record per Run across deliveries, which is new state; custom
   messages have no `usage` field, so Notification-only Runs still could not
   be counted that way; and it would push Subagent spend into the Session
   column, which §6 keeps main-only. It fails both the usefulness and the
   no-added-complexity tests.
2. **Context window for Pi-backed children: not wanted.** Scope is input,
   output, cache read, cache write, and cost (§5).
3. **Where the Notification gets its figures.** The Notification is one of
   the two channels, not the primary one: a Run consumed by `agent_wait`,
   `agent_wait_all` or `agent_result` sends no Notification
   (`host/push-sink.ts:36-46`), and an unwaited Run sends nothing else. Piano
   already builds a result card from the Notification's details
   (`piano/server/PiRecords.ts:172-177`), so it must carry the same usage as
   the tool-result summaries. The domain notice already carries input,
   output, cost, turns and model for the TUI accounting line
   (`domain/notification.ts:140-156`); only `cacheRead` and `cacheWrite` are
   missing. Decision: add those two fields to `NotificationAccounting`, and
   have `buildNotificationMessage` copy the five figures into
   `NotificationDetails`. That keeps the builder a pure map of the notice, as
   the file intends (`host/notification-message.ts:28-30`), and retires the
   header's "nor the cost" rationale (`:24-26`), which assumed the TUI line
   was the only reader.
4. **Piano aggregation semantics.** Decided in §6: a per-Profile
   "Subagents" row group under the Session table, Session column main-only,
   no model column (model as a caption only when a Profile used one model),
   and no mirror in `/subagent`.

Runtime behaviour, RPC payload capture, and Piano rendering remain
**unverified**.
