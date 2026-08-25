# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in pi. Each subagent runs in its own child pi process and follows [pi's project-trust model](https://pi.dev/docs/latest/security#project-trust).

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
| `agent_await` | Waits for named runs to become terminal and returns lifecycle state only. Takes an optional `timeout_seconds`; awaiting never suppresses notifications or consumes results. |
| `agent_cancel` | Stops named runs; partial output remains available after cancellation settles. |
| `agent_result` | Reads a finished run's authoritative full output by id. |

Every terminal output is stored for `agent_result`. A small completion notification is pushed independently, and `agent_await` only observes lifecycle state. See [ADR 0006](docs/adr/0006-completion-notifications-and-result-store.md).

A pushed notification appears as a single collapsed line and expands with the same key that expands tool output. Completed notifications contain a bounded preview; failed notifications contain the primary error; cancelled notifications are terse. Every notification points to `agent_result` when more detail is available, and notification delivery never determines whether the full result is stored.

A notification always gives the calling model a chance to act on it, and never interrupts. While the model is working it follows on after the current turn; while the session is idle it starts a turn of its own.

## Usage

### Agent format

An agent is a Markdown file named after the agent, so `implementer.md` is the agent `implementer`:

```markdown
---
description: Implements approved plans and verifies changes
model: openai-codex/gpt-5.6-sol
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

The frontmatter configures the run and the body is the prompt. Only `description` and the body are required; a file missing either is skipped and reported at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. | `Implement and verify a scoped change` |
| `model` | No | Exact `provider/model-id` or model id from Pi's loaded catalogue. Omit it to use the calling session's model. | `openai-codex/gpt-5.6-sol` |
| `effort` | No | Reasoning depth, independent of `model`. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | No | Comma-separated pi tool names. Omit it to use pi's defaults. | `read, grep, find, ls` |
| `appendSystemPrompt` | No | Append the prompt to pi's own instructions. Defaults to `true`; `false` replaces them. | `false` |

At each session start, profiles with pinned models absent from Pi's loaded model catalogue are skipped with a warning. This check also runs when a session is resumed. A valid `model` then reaches pi untouched, so reasoning depth belongs in `effort`, which pi takes as its thinking level. The two fields resolve independently:

| Profile | Model the subagent runs | Thinking level it runs at |
| --- | --- | --- |
| neither field | the calling session's | the calling session's |
| `effort` only | the calling session's | `effort` |
| `model` only | `model` | pi's own `defaultThinkingLevel` |
| both fields | `model` | `effort` |

Pinning a `model` therefore drops the caller's thinking level instead of carrying it over, since a level chosen for one model is not a level for another. Set `effort` whenever the depth matters. Pi clamps either to what the chosen model supports.

### Agent lookup

Only the user directory is resolved: `~/.pi/agent/agents/`, or `$PI_CODING_AGENT_DIR/agents/` when that is set.

### Watching runs

Runs are listed in a widget above the editor, one line each:

```
─── subagents (3) ─────────────────────────────────────────────
 ●  explore      $0.0142  running  · grep: getFinalOutput
 ●  reviewer     $0.0031  running  · review the delivery module
 ●  implementer  $0.4210  completed in 1m 2s
```

The status indicator is Herdr's colored dot: a `●` whose color carries the state — yellow running, green completed, red failed — plus a hollow `○` for a cancelled run, which Herdr has no state for.

A running line ends with what the run is doing right now — its most recent tool call, or the run's description before the first one. That tail is also what tells two runs of the same agent apart, and it is the first thing dropped when the terminal is narrow. Run ids appear in tool results and notifications, where the model that acts on them reads them, so the widget does not repeat them; name a run by its agent and task when asking for one to be cancelled.

The widget appears when the first run starts and disappears once the last notification has landed — a finished run stays listed while its completion notice is waiting to enter the conversation. A fan-out wider than eight runs is summarised rather than filling the screen.

Columns are measured across the visible rows so the fields line up. When the terminal is too narrow they give way in order — the activity tail first, then cost — so the status is always visible.

The widget is a display. Pi routes keyboard input to the editor, never to a widget, so runs are stopped with `agent_cancel` rather than from here.

## Technique details

### Concurrency

Subagents are not capped: every delegated run starts immediately. Each one is a child pi process, so a wide fan-out costs real local resources — see [ADR 0001](docs/adr/0001-unbounded-subagent-concurrency.md) for why the cap and its queue were removed. Runs have no time limit.

### Lifecycle

A run is detached from the turn, not from the session. `Esc` cancels the turn and leaves the runs going; `agent_cancel` stops a single one. Anything that ends the session — switching, forking, resuming, `/new`, `/reload`, quitting pi — stops every running subagent: notifications and results belong to the conversation that asked for them, and the next session's model has no context to act on answers it never asked for.

### Security

Project trust is [pi's](https://pi.dev/docs/latest/security#project-trust). The extension resolves none of its own and forwards pi's decision to every child.

A subagent reads files, writes files, and runs commands as far as its `tools` list allows, and cannot delegate further — delegation is one level deep. A running subagent also cannot be given more input; see [ADR 0003](docs/adr/0003-one-shot-children.md).
