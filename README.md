# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in pi. Runs use a named harness: `pi`, `claude`, or `codex`. The Pi harness uses a child pi process and [pi's project-trust model](https://pi.dev/docs/latest/security#project-trust), Claude uses the Claude Agent SDK, and Codex uses the installed Codex CLI's App Server in headless JSON-RPC mode.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

## Command and tools

- `/agents` lists loaded agent profiles, shows their prompts, and hands one a task. With no agents configured, it prints the directory to add one to.

Delegation uses four tools. A subagent runs detached from the turn that started it, so starting one and retrieving its answer are separate steps:

| Tool | What it does |
| --- | --- |
| `agent_start` | Starts a run and returns a run id immediately. Takes `agent`, `description`, and `prompt`; the profile decides the model, effort, and tools. A completion notification arrives when the run finishes. |
| `agent_wait` | Waits for named runs to become terminal and returns lifecycle state only. Takes an optional `timeout_seconds`; waiting never suppresses notifications or consumes results. |
| `agent_cancel` | Stops named runs; partial output remains available after cancellation settles. |
| `agent_result` | Reads a finished run's authoritative full output by id. |

Every terminal output is stored for `agent_result`. A small completion notification is pushed independently, and `agent_wait` only observes lifecycle state. See [ADR 0006](docs/adr/0006-completion-notifications-and-result-store.md).

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

#### Codex profiles

Codex starts `codex app-server` and runs one ephemeral thread with one
logical turn over headless JSON-RPC. Semantic turn completion is authoritative;
process exit is only a fallback or escalation path. `model` is passed through
unvalidated and Codex validates it. `effort` accepts `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`; `off` maps to `none` and every other value
is passed through to the App Server's model reasoning configuration. Codex does
not recognize `tools` or `appendSystemPrompt`, so those fields produce profile
diagnostics. The profile system prompt is prepended to the task prompt. Each
run has no resumable provider session: thread, turn, item, and request
identities remain adapter-local.

Codex App Server threads use `approvalPolicy: "never"` and
`sandbox: "danger-full-access"` — the same unconditional bypass posture as
Claude children, whatever the forwarded project-trust value says. Codex
threads are ephemeral and inherit the operator's environment; see [ADR 0009](docs/adr/0009-codex-trust-posture-and-environment-inheritance.md).

#### Resolution matrix

| Profile | Pi model / effort | Claude model / effort | Codex model / effort |
| --- | --- | --- | --- |
| neither | caller's model / caller's thinking level | SDK default / SDK default | Codex default / Codex default |
| `effort` only | caller's model / profile effort | SDK default / profile budget | Codex default / profile effort |
| `model` only | profile model / Pi default thinking | profile alias / SDK default | profile model / Codex default |
| both | profile model / profile effort | profile alias / profile budget | profile model / profile effort |

All harnesses are one-shot: one prompt in and one terminal answer out. The
adapter translates provider messages into neutral facts; profiles and the rest
of the runtime never depend on provider wire types.

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

Subagents are not capped: every delegated run starts immediately. A Pi-harness run is a child pi process; a Claude-harness run uses the Claude Agent SDK directly; a Codex-harness run starts `codex app-server` as a child process. Either way, a wide fan-out costs real local resources — see [ADR 0001](docs/adr/0001-unbounded-subagent-concurrency.md) for why the cap and its queue were removed. Runs have no time limit.

### Lifecycle

A run is detached from the turn, not from the session. `Esc` cancels the turn and leaves the runs going; `agent_cancel` stops a single one. Anything that ends the session — switching, forking, resuming, `/new`, `/reload`, quitting pi — stops every running subagent: notifications and results belong to the conversation that asked for them, and the next session's model has no context to act on answers it never asked for.

### Security

For the Pi harness, project trust is [pi's](https://pi.dev/docs/latest/security#project-trust): the extension resolves none of its own and forwards Pi's decision to every child pi process. The Claude and Codex harnesses do not consult that trust flag in this version: Claude bypasses permissions unconditionally, and Codex always bypasses approvals and sandbox — deliberate parity, with the forwarded value reserved for a future shared posture, documented in [ADR 0009](docs/adr/0009-codex-trust-posture-and-environment-inheritance.md).

A subagent reads files, writes files, and runs commands as far as its `tools` list allows, and cannot delegate further — delegation is one level deep. A running subagent also cannot be given more input; see [ADR 0003](docs/adr/0003-one-shot-children.md).
