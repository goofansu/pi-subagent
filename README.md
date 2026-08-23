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
| `agent_wait` | Waits for named runs and returns their reports. For when the calling model cannot continue without the answer. Takes an optional `timeout_seconds`, after which the runs carry on and report by themselves. |
| `agent_cancel` | Stops named runs and discards their unfinished work. |
| `agent_result` | Reads a finished run's full output by id, for when a report was trimmed or needs re-reading. |

A finished run's report is delivered exactly once: pushed into the session as a follow-up message, or returned by the `agent_wait` that claimed it — never both. See [ADR 0002](docs/adr/0002-push-only-result-delivery.md).

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
─── subagents (3) ────────────────────────────────────────────────────
  ⏳ a3f81c2b explore      gpt-5.6-sol     3 turns  $0.0142  running for 12.4s
  ⏳ 7e0d4419 reviewer     claude-opus-5    1 turn  $0.0031  running for 3.1s
  ✓  c14b90aa implementer  claude-opus-5  12 turns  $0.4210  completed in 1m 2s
```

The widget appears when the first run starts and disappears once the last report has been delivered — a finished run stays listed until its report actually lands, which reads as "done, waiting to report". A fan-out wider than eight runs is summarised rather than filling the screen.

Columns are measured across the visible rows so the fields line up. When the terminal is too narrow for all of them they give way in order — model first, then cost, then turns — so the status is always visible. Turns outlast cost because a rising turn count is what shows a run is still moving.

The widget is a display. Pi routes keyboard input to the editor, never to a widget, so runs are stopped with `agent_cancel` rather than from here.

## Technique details

### Concurrency

Subagents are not capped: every delegated run starts immediately. Each one is a child pi process, so a wide fan-out costs real local resources — see [ADR 0001](docs/adr/0001-unbounded-subagent-concurrency.md) for why the cap and its queue were removed. Runs have no time limit. `Esc` cancels the pi turn and with it every running subagent call, keeping whatever output had already arrived.

### Security

Project trust is [pi's](https://pi.dev/docs/latest/security#project-trust). The extension resolves none of its own and forwards pi's decision to every child.

A subagent reads files, writes files, and runs commands as far as its `tools` list allows, and cannot delegate further — delegation is one level deep. A running subagent also cannot be given more input; see [ADR 0003](docs/adr/0003-one-shot-children.md).
