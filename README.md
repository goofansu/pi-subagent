# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in pi. Each subagent runs in its own child pi process and follows [pi's project-trust model](https://pi.dev/docs/latest/security#project-trust).

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

## Command and tools

- `/agents` lists loaded agent profiles, shows their prompts, and hands one a task. With no agents configured, it prints the directory to add one to.

Delegation is three tools, not one. A subagent runs detached from the turn that started it, so starting one and collecting its answer are separate steps:

| Tool | What it does |
| --- | --- |
| `agent_start` | Starts a run and returns a run id immediately. Takes `agent`, `description`, and `prompt`; the profile decides the model, effort, and tools. The report arrives on its own when the run finishes. |
| `agent_await` | Waits for named runs to become terminal and returns lifecycle state only. Takes an optional `timeout_seconds`; awaiting never suppresses notifications or consumes results. |
| `agent_cancel` | Stops named runs and discards their unfinished work. |
| `agent_result` | Reads a finished run's full output by id, for when a report was trimmed or needs re-reading. |

Every terminal output is stored for `agent_result`. A small completion notification is pushed independently, and `agent_await` only observes lifecycle state. See [ADR 0006](docs/adr/0006-completion-notifications-and-result-store.md).

A pushed report appears as a single collapsed line — the agent, the run id, and how much it said — and expands with the same key that expands tool output. The message the model reads is capped so a runaway agent cannot swamp the context, but the run's whole answer is kept for the session and a trimmed report says so, naming the `agent_result` call that returns the rest. Nothing an agent produced is thrown away.

A report always gives the calling model a chance to act on it, and never interrupts. While the model is working the report follows on after the current turn; while the session is idle it starts a turn of its own. Delegating work you never hear back about would defeat the point.

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

A running line ends with what the run is doing right now — its most recent tool call, or the run's description before the first one. That tail is also what tells two runs of the same agent apart, and it is the first thing dropped when the terminal is narrow. Run ids appear in tool results and reports, where the model that acts on them reads them, so the widget does not repeat them; name a run by its agent and task when asking for one to be cancelled.

The widget appears when the first run starts and disappears once the last report has been delivered — a finished run stays listed until its report actually lands, which reads as "done, waiting to report". A fan-out wider than eight runs is summarised rather than filling the screen.

Columns are measured across the visible rows so the fields line up. When the terminal is too narrow they give way in order — the activity tail first, then cost — so the status is always visible.

The widget is a display. Pi routes keyboard input to the editor, never to a widget, so runs are stopped with `agent_cancel` rather than from here.

## Technique details

### Concurrency

Subagents are not capped: every delegated run starts immediately. Each one is a child pi process, so a wide fan-out costs real local resources — see [ADR 0001](docs/adr/0001-unbounded-subagent-concurrency.md) for why the cap and its queue were removed. Runs have no time limit.

### Lifecycle

A run is detached from the turn, not from the session. `Esc` cancels the turn and leaves the runs going; `agent_cancel` stops a single one. Anything that ends the session — switching, forking, resuming, `/new`, `/reload`, quitting pi — stops every running subagent: a report belongs to the conversation that asked for it, and the next session's model has no context to act on answers it never asked for.

### Security

Project trust is [pi's](https://pi.dev/docs/latest/security#project-trust). The extension resolves none of its own and forwards pi's decision to every child.

A subagent reads files, writes files, and runs commands as far as its `tools` list allows, and cannot delegate further — delegation is one level deep. A running subagent also cannot be given more input; see [ADR 0003](docs/adr/0003-one-shot-children.md).
