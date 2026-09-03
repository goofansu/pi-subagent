# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in pi. Runs use a named harness: `pi`, `claude`, or `codex`. The Pi harness owns a retained in-process Pi SDK session and [pi's project-trust model](https://pi.dev/docs/latest/security#project-trust), Claude uses disposable streaming Claude Agent SDK Queries, and Codex uses the installed Codex CLI's App Server in headless JSON-RPC mode.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

## Command and tools

- `/agents` lists loaded agent profiles, shows their prompts, and hands one a task. With no agents configured, it prints the directory to add one to.

Delegation uses six tools. `agent_start` creates a stable, Session-scoped Subagent and immediately starts its first Run. The Run is detached from the turn that started it and settles exactly once, so starting work and retrieving its answer are separate steps:

| Tool | What it does |
| --- | --- |
| `agent_start` | Creates a stable Subagent, starts its first Run, and immediately returns distinct Subagent and Run ids. Takes `agent`, `description`, and `prompt`; the profile decides the model, effort, and tools. |
| `agent_resume` | Targets an idle Subagent id with a new `description` and full `prompt`, starts a distinct Run immediately, and returns its Run id rather than an answer. It never queues behind an active Run. |
| `agent_wait` | Waits for named runs to become terminal and returns lifecycle state only. Takes an optional `timeoutSeconds`; waiting never suppresses notifications or consumes results. |
| `agent_cancel` | Stops named runs; partial output remains available after cancellation settles. |
| `agent_steer` | Offers bounded guidance to an active run. Acceptance means local mailbox admission only; every production harness delivers accepted guidance serially through its active provider execution. |
| `agent_result` | Reads a finished run's authoritative full output by id. |

Every terminal output is stored for `agent_result` under its Run id and records its owning Subagent for orientation. A small completion notification names both identities and is pushed independently; `agent_wait` only observes Run lifecycle state. See [ADR 0006](docs/adr/0006-completion-notifications-and-result-store.md), [ADR 0013](docs/adr/0013-stable-subagent-identity.md), and [ADR 0014](docs/adr/0014-controlled-agent-resume.md).

`agent_resume` is admission-aware. Pi, Claude, and a healthy Codex adapter can
resume an idle Subagent within the current Session through adapter-private
provider context. A Harness that never supports Resume reports unsupported. If
a previously usable Conversation is irrecoverably lost, Resume starts no Run
or provider work and tells the caller to start a new Subagent.
The Subagent id is used only for `agent_resume`;
`agent_wait`, `agent_result`, `agent_cancel`, and `agent_steer` always use the
distinct Run id returned by `agent_start` or `agent_resume`.

### Steering an active Run

Call `agent_steer` with the Run id returned by `agent_start` and one guidance
message. An `accepted` response is deliberately narrow: the complete message
entered that Run's bounded local FIFO mailbox synchronously. It does not mean
the harness dequeued it, the provider accepted it, or the model consumed it, so do not
resend accepted guidance in a retry loop. Only a provider-confirmed correlated
user item becomes transcript truth in the eventual Result.

All three production harnesses support steering. Pi uses its retained
`AgentSession.steer`; Claude serializes guidance into the active streaming
Query and may cross one or more provider Result boundaries before consumption;
Codex uses native `turn/steer`. A cancelling Run or a closed Control gate
returns `not steerable`; a terminal Run reports
`already completed`, `already failed`, or `already cancelled`; an unknown id
reports `unknown run`. These are too-late outcomes and never reopen or mutate a
terminal Result.

Each active steering-capable Run accepts at most 16 pending messages, 16 KiB
of UTF-8 per message, and 64 KiB of pending UTF-8 in total. Whitespace-only or
oversize text is `invalid`; saturation is `queue full`. Dequeueing releases
capacity, while cancellation, settlement, startup failure, and Session
shutdown synchronously close the mailbox and discard anything still pending.

A pushed notification appears as a single collapsed line and expands with the same key that expands tool output. Completed notifications contain a bounded preview; failed notifications contain the primary error; cancelled notifications are terse. Every notification points to `agent_result` when more detail is available, and notification delivery never determines whether the full result is stored.

A notification always gives the calling model a chance to act on it, and never interrupts. While the model is working it follows on after the current turn; while the session is idle it starts a turn of its own.

## Usage

### Agent format and harnesses

An agent is a Markdown file named after the agent, so `implementer.md` defines
`implementer`:

```markdown
---
description: Implements approved plans and verifies changes
harness: pi
model: openai-codex/gpt-5.6-sol
effort: high
tools: read, grep, find, ls
appendSystemPrompt: true
---

You are an implementation agent. Follow the approved plan and verify your work.
```

`description`, `harness`, and the body are the generic profile vocabulary.
`harness` defaults to `pi`, so existing profiles continue to work unchanged.
An unknown harness, or a field that the selected harness does not understand,
is reported as a profile diagnostic at session start.

The v2 rewrite renames this one field to `backend:`, with the same values and
the same `pi` default. Nothing changes for an installed package, which loads
only v1. If you run v2, rename the field first —
[Profile migration: naming your backend in v2](docs/v2/profile-backend-field-migration.md)
is the one-line change and the reasoning.

#### Pi profiles

Pi understands `model`, `effort`, `tools`, and `appendSystemPrompt`.
`model` is an exact model id (or `provider/model-id`) from Pi's catalogue;
`effort` is Pi's thinking level; `tools` is a comma-separated Pi tool list;
and `appendSystemPrompt` defaults to `true` and controls whether the profile
prompt is appended to or replaces Pi's instructions. Empty segments are
ignored, but a list containing only separators (for example `tools: ", ,"`)
disables all tools rather than restoring backend defaults. An empty or
whitespace-only value remains unset and uses backend defaults. A pinned model
is checked against Pi's loaded catalogue using its exact spelling.

One lazy in-process Pi SDK session is retained per Subagent. It uses normal Pi
resource discovery, memory-only session storage, headless extension binding,
the parent's project-trust decision, and a Bash tool that injects the child
depth per spawn without changing the host environment. This package filters
itself from child extension discovery and all orchestration tools are denied.
Sequential resumed Runs reuse the same provider session while emitting and
charging only their own messages and usage. Execution creates one disposable
Pi Attempt per Run; it owns that Run's fresh provider-event subscription,
message/usage baseline, Control consumer, and cleanup. Preparing a Run performs
no provider I/O, and no Attempt remains while the Subagent is idle.

#### Claude profiles

Use the Claude Agent SDK with the same field names:

```markdown
---
description: Review a change with Claude's coding tools
harness: claude
model: sonnet
effort: high
tools: Read, Grep, Glob, Bash
appendSystemPrompt: true
---

Review the requested change and report concrete findings.
```

Claude validates `model` at session start. It accepts only the SDK's family
aliases `fable`, `opus`, `sonnet`, and `haiku`; the SDK resolves an alias to
the family's current default ID, so explicit IDs such as `claude-sonnet-5`
are rejected. It uses the SDK default when `model` is omitted. `effort` is
translated by the adapter to a thinking-token budget (`off` disables thinking);
`tools` selects Claude built-in tools (see the [Claude Code tools
reference](https://code.claude.com/docs/en/tools-reference) to configure the
list); empty segments are ignored and an explicitly empty list disables all
built-in tools. `appendSystemPrompt` defaults to `true`, appending the profile
to Claude Code's default prompt. `false` supplies
the profile as the complete system prompt. Claude profiles do not inherit the
calling model.

Claude children bypass permissions unconditionally in this version, even when
the parent working directory is untrusted. This is an intentional sharp edge;
the trust value is carried for a future policy change. The child cannot spawn
another agent.

Claude children also inherit the operator's Claude Code environment: filesystem
settings load as they would for the CLI, so MCP servers registered with
`claude mcp add` (and the account's claude.ai connectors, when they attach) are
available to every claude child, unprompted. This is deliberate — different
harnesses exist to bring different toolsets — and it means registering an MCP
server in Claude Code also grants it to claude-harness subagents. The `tools`
field narrows built-in tools only. See
[ADR 0008](docs/adr/0008-claude-children-inherit-operator-environment.md).

Execution creates one disposable Claude Attempt per Run, and that Attempt owns
a fresh streaming Query, input stream, Control correlations, accounting deltas,
and Query cleanup. The adapter retains only the provider Conversation identity,
applies native `resume` to later Queries, and sends only the new Run prompt plus
that Run's Controls. Provider replay is ignored. Successful provider Results
are internal Turn checkpoints while earlier guidance is still outstanding; the
public Run settles once, after its later final Result and complete Attempt
cleanup. Preparing a Run performs no provider I/O, and no Attempt remains while
the Subagent is idle.

#### Codex profiles

One Codex Subagent retains one `codex app-server` process and one ephemeral,
pathless root Conversation. The first Run initializes the connection, creates
the root, and sends the Profile role with the first prompt. Later Runs start
new sequential Turns on that same root and send only the new prompt; they do
not use live-session `thread/resume`. Each Run owns fresh Turn-scoped Attempt
state: its translator, ordered reducer, Control correlations, accounting delta,
terminal interpretation, and Run-local cleanup. The retained transport owner
keeps process, JSON-RPC, root-Conversation, and cumulative-accounting state.
Each Run settles independently after its matching semantic completion. A
healthy process intentionally remains alive while the Subagent is idle, but no
Attempt does, and the process is closed at parent Session shutdown. `model` is
passed through unvalidated and Codex validates it.
`effort` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`;
`off` maps to `none` and every other value is passed through to the App Server's
model reasoning configuration. Codex does not recognize `tools` or
`appendSystemPrompt`, so those fields produce profile diagnostics. The Profile
system prompt initializes the retained Conversation once. Provider thread,
Turn, item, request, session, and correlation identities remain adapter-local.
Accepted steering is sent serially through native `turn/steer`; transcript
truth appears only when the provider confirms consumption with a correlated
user-message item.

The ephemeral root is process-local and is not a stored/listable rollout.
Unexpected process or terminal transport loss therefore destroys the
Conversation permanently. A later Resume reports Conversation loss and directs
the caller to create a new Subagent; the adapter never respawns, attaches to a
durable thread, or replays prior output. Ephemeral does not mean zero shared
Codex-home I/O: authentication, configuration, logs, plugins, MCP startup, and
provider-native child threads or tool processes may still use shared resources.

Codex App Server threads use `approvalPolicy: "never"` and
`sandbox: "danger-full-access"` — the same unconditional bypass posture as
Claude children, whatever the forwarded project-trust value says. Codex
Attempts inherit the operator's environment and reapply the fixed policy on
every attachment; see [ADR 0009](docs/adr/0009-codex-trust-posture-and-environment-inheritance.md).

#### Resolution matrix

| Profile | Pi model / effort | Claude model / effort | Codex model / effort |
| --- | --- | --- | --- |
| neither | caller's model / caller's thinking level | SDK default / SDK default | Codex default / Codex default |
| `effort` only | caller's model / profile effort | SDK default / profile budget | Codex default / profile effort |
| `model` only | profile model / Pi default thinking | profile alias / SDK default | profile model / Codex default |
| both | profile model / profile effort | profile alias / profile budget | profile model / profile effort |

Every Run begins with one new prompt and settles exactly once with one immutable
terminal Result. Every production Subagent may own several sequential Runs
through its private provider Conversation. Run preparation is provider-I/O-free;
execution starts one provider-specific Attempt, which translates provider
messages into neutral facts and returns a candidate Ending only after Run-local
cleanup. The core dispatcher folds those facts and owns authoritative lifecycle
settlement. Profiles and the rest of the runtime never depend on provider wire
types.

### Agent lookup

Only the user directory is resolved: `~/.pi/agent/agents/`, or `$PI_CODING_AGENT_DIR/agents/` when that is set.

### Watching runs

Runs are listed in a widget above the editor, one line each:

```
─── subagents (3) ─────────────────────────────────────────────
 explore      pi      3 turns  running · grep: getFinalOutput
 reviewer     claude  1 turn   running · review the delivery module
 implementer  pi      4 turns  completed in 1m 2s
```

Each row names the harness immediately after the agent. The agent, harness,
turn count, and status fields align across rows with a two-space delimiter.
Running activity follows its status with one space on either side of `·`;
lifecycle state is written in its status colour without a separate icon.

A running line ends with what the run is doing right now — executor-reported live activity when available, otherwise its most recent tool call, or the run's description before the first one. That tail is also what tells two runs of the same agent apart, and it is the first thing dropped when the terminal is narrow. Run ids appear in tool results and notifications, where the model that acts on them reads them, so the widget does not repeat them; name a run by its agent and task when asking for one to be cancelled.

The widget appears when the first run starts and disappears once the last notification has landed — a finished run stays listed while its completion notice is waiting to enter the conversation. A fan-out wider than eight runs is summarised rather than filling the screen.

When the terminal is too narrow, components give way in order — the activity
tail first, then turn accounting; agent, harness, and status remain.

The widget is a display. Pi routes keyboard input to the editor, never to a widget, so runs are stopped with `agent_cancel` rather than from here.

## Technique details

### Concurrency

Subagents are not capped: every successful `agent_start` creates a running
Subagent with its first Run immediately. A Pi Subagent owns an in-process SDK
session, a Claude Run owns a disposable SDK Query, and a Codex Subagent retains
an App Server process until Session shutdown or Conversation loss. A wide
fan-out therefore costs real local resources even while Codex Subagents are
idle — see [ADR 0001](docs/adr/0001-unbounded-subagent-concurrency.md) for why
the cap and its queue were removed. Runs have no automatic timeout; explicit
cancellation is the liveness mechanism.

### Lifecycle

A Run is detached from the turn, not from the Session. `Esc` cancels the turn and leaves Runs going; `agent_cancel` stops one Run by Run id. Any terminal Run leaves its open Subagent idle and retains the prepared adapter. `agent_resume` can synchronously claim an idle Pi, Claude, or Codex Subagent and start a fresh Run, but rejects an active Subagent without queueing. Each Run has its own lifecycle, Result, notification, reporter, cancellation signal, usage fold, and Control mailbox; settlement discards pending guidance rather than carrying it into the next Run. There is no idle-Subagent widget yet.

Anything that ends the Session — switching, forking, resuming, `/new`, `/reload`, or quitting pi — first closes every idle and running Subagent, then cancels active Runs, closes every retained adapter, and clears notifications and Results. Neither identity nor output crosses into the next Session.

There is no persistence layer, cross-Session resume, manual Subagent close
tool, provider-neutral continuation token, hidden idle expiry, or automatic
replacement Conversation. Codex's ephemeral root ends with its retained App
Server and cannot be recovered after Session shutdown or process loss.

### Security

For the Pi harness, project trust is [pi's](https://pi.dev/docs/latest/security#project-trust): the extension resolves none of its own and applies Pi's decision to the retained SDK resource loader and settings. The Claude and Codex harnesses do not consult that trust flag in this version: Claude bypasses permissions unconditionally, and Codex always bypasses approvals and sandbox — deliberate parity, with the forwarded value reserved for a future shared posture, documented in [ADR 0009](docs/adr/0009-codex-trust-posture-and-environment-inheritance.md).

A subagent reads files, writes files, and runs commands as far as its `tools` list allows, and cannot delegate further — delegation is one level deep. The neutral `agent_steer` operation is implemented at each adapter's private provider boundary. See [ADR 0020](docs/adr/0020-run-settlement-through-harness-conformance.md) for the current Run-settlement decision.

## Running v2 as the daily driver

The rewrite in `extensions/subagent-v2/` is not what the package publishes: the
manifest still exposes only v1, and it will keep doing so until the cutover at
M7. Since M4 the rewrite is nonetheless a usable product with the real Pi
backend behind it, and since M5 with Claude beside it, and switching to it
locally is one command:

```bash
make dogfood-v2     # v2 becomes what plain `pi` loads
make dogfood-v1     # and back
make dogfood-status # which one is live right now
```

Two edits to Pi's own `settings.json` make the switch, and both are reversible:
this package's entry in `packages` gains an empty `extensions` list, which
disables **this package's** extension and nothing else, and the absolute path of
the v2 entry point is added to `extensions` so plain `pi` loads it. Every other
extension you have installed stays exactly as it was — a switch that turned
everything else off would not be a daily driver. `make dogfood-v1` restores the
settings file to what it was.

The two can never both be loaded, and that is deliberate: they register the same
six tool names, and a Pi process with both would offer the model each tool
twice.

`make dev-v2` is the other way in — every extension disabled and only the v2
entry point loaded, for checking the surface in isolation rather than for using
it.

Profiles are read from the same `agents/` directory v1 reads, with one
difference: a v2 Profile names its backend with `backend:` rather than v1's
field. The values are unchanged and the default is still `pi`, so a Profile that
pins nothing runs on Pi under both. See
[`docs/v2/profile-backend-field-migration.md`](docs/v2/profile-backend-field-migration.md).

**v2 offers all three backends from M6 onward.** A v2 Profile may name `pi`,
`claude`, or `codex`, and each understands exactly what its v1 counterpart did.
A `claude` Profile reads `model` as a family alias, plus `effort`, `tools`, and
`appendSystemPrompt`, and the environment inheritance is the same one
[ADR 0008](docs/adr/0008-claude-children-inherit-operator-environment.md)
decided: a v2 Claude child sees the MCP servers and connectors your Claude Code
environment has, unprompted. A `codex` Profile reads `model` — passed through
unvalidated, because the App Server resolves a model name itself — and `effort`,
with `off` mapping to `none`; `tools` and `appendSystemPrompt` are diagnostics,
because a Codex thread carries its own tool set and the Profile's prompt is
composed into the first Turn's input. One Codex Subagent owns one
`codex app-server` process and one ephemeral root thread for its life, and each
Run is one Turn on that thread.

`/subagent-v2` reports the live Session's runtime counters and every cleanup
probe — the runtime's, which says whether the core is holding a fiber or a
queue, and one per backend adapter, which says whether that provider's own
handles are still held: for Pi, native sessions and event subscriptions; for
Claude, live Queries, open input streams, and retained conversation identities;
for Codex, live App Server processes, reader fibers, pending JSON-RPC requests,
retained root threads, and in-flight steers. Every one reads zero for a Session
that has nothing in flight.

## Release verification

v1 is frozen. Only critical fixes and testability changes that add proof for a
compatibility-matrix row land in `extensions/subagent/`; the policy, and the
commit at which the quality gate was recorded green, are in
[`docs/v2/freeze.md`](docs/v2/freeze.md). The rewrite lives beside it in
`extensions/subagent-v2/`; `make dev-v2` opts into it for one Pi process, and
`make dogfood-v2` makes it the default.

`npm run check` runs typechecking for both extension trees, lint, per-Run
Harness Conformance, repeated managed Subagent conformance for the controlled
harness and every production adapter, the full test suite, the v2 lane (v2 tests
plus the v1/v2 import boundary), the shared v2 backend conformance suite against
both fake backends and all three real adapters (`npm run test:v2:conformance`,
also runnable on its own), and a byte-for-byte generated Codex
protocol check (`npm run codex:protocol:check`). `npm run release:check` adds all six
authenticated provider gates and the retained-Codex evidence gate. It remains
red until the pinned authenticated smoke and human Desktop record both exist.
`npm run codex:smoke` preserves the live
steering/interruption proof and prints `CODEX_STEERING_LIVE_SMOKE_PASS`, while
`npm run codex:resume-smoke` proves two Runs on one retained ephemeral,
pathless App Server Conversation, stored-thread nondiscoverability, and complete
cleanup before printing `CODEX_RESUME_LIVE_SMOKE_PASS`. Pi uses
`npm run pi:steering-smoke` and `npm run pi:resume-smoke`, printing
`PI_STEERING_LIVE_SMOKE_PASS` and `PI_RESUME_LIVE_SMOKE_PASS`. Claude uses
`npm run claude:steering-smoke` and `npm run claude:resume-smoke`, printing
`CLAUDE_STEERING_LIVE_SMOKE_PASS` and `CLAUDE_RESUME_LIVE_SMOKE_PASS`.

The v2 lane adds six gates of its own, all opt-in and all in `release:check`.
Three are runtime gates, one per real backend: `npm run v2:pi:smoke`,
`npm run v2:claude:smoke`, and `npm run v2:codex:smoke` each build a real
Session runtime over that adapter and drive start, resume, steer, cancel,
timeout, and shutdown against a real model, then read the runtime probe and
every adapter probe after the Session Scope has closed. They print
`V2_PI_LIVE_SMOKE_PASS`, `V2_CLAUDE_LIVE_SMOKE_PASS`, and
`V2_CODEX_LIVE_SMOKE_PASS`. The Claude gate additionally proves what only a
live model can: that the resumed Run answers from the first Run's context, that
a confirmed steer produces exactly one user message in the transcript, and that
a cancelled Query leaves the conversation resumable. The Codex gate proves the
same three for a retained root thread — the resumed Turn answers from the first
Turn's context, one steer confirmed by client message id produces exactly one
user message, and an interrupted Turn leaves the process, the root, and the
Subagent alive — and adds the one claim no adapter can make about itself: it
asks the operating system whether the `codex app-server` child is gone.

The other three are host gates — one script, taking the backend as an argument,
because what it exercises is the host and the host is the same whichever
backend a Profile names. `npm run v2:pi:host-smoke`,
`npm run v2:claude:host-smoke`, and `npm run v2:codex:host-smoke` launch Pi in
RPC mode with only the v2 entry point, ask the model to delegate to a Profile
naming that backend, read the answer back through `agent_result`, and print
`V2_PI_HOST_LIVE_SMOKE_PASS`, `V2_CLAUDE_HOST_LIVE_SMOKE_PASS`, or
`V2_CODEX_HOST_LIVE_SMOKE_PASS`.

All six honour `V2_PI_LIVE_TIMEOUT_MS`, `V2_CLAUDE_LIVE_TIMEOUT_MS`, or
`V2_CODEX_LIVE_TIMEOUT_MS`, and `V2_PI_LIVE_MODEL` / `V2_CLAUDE_LIVE_MODEL` /
`V2_CODEX_LIVE_MODEL` pin the model they use — a catalogue reference for Pi, a
family alias for Claude defaulting to `haiku`, and for Codex a name the App
Server resolves itself, left unset so its own default is used.

The human-only Codex Desktop coexistence gate is recorded with
[`docs/codex-desktop-coexistence-release.md`](docs/codex-desktop-coexistence-release.md).
It runs the Codex resume smoke with an idle-process pause while Desktop remains
open; it is deliberately separate from non-interactive `release:check`.
`npm run codex:retained-release:check` spends no quota; it verifies the pinned
protocol first and then checks that the recorded evidence is complete. It
cannot create or substitute for human evidence.

The Pi commands require a usable model and credentials in the normal Pi agent
directory. The Claude commands require an authenticated Claude Code SDK
environment. They spend provider quota, default to a five-minute hard timeout
(override with `MANAGED_AGENT_LIVE_TIMEOUT_MS`), force a cancellation cleanup
probe, handle `SIGINT`/`SIGTERM`, and always shut down the manager and provider
resources on success, provider failure, timeout, cancellation, or interruption.
