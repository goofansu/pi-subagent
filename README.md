# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in pi. Each subagent runs in its own child pi process and follows [pi's project-trust model](https://pi.dev/docs/latest/security#project-trust).

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

## Command and tool

- `/agents` lists loaded agent profiles, shows their prompts, and hands one a task. With no agents configured, it prints the directory to add one to.
- `subagent` runs a task with a selected profile. It takes only `agent`, `description`, and `prompt`; the profile decides the model, effort, and tools.

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
| `model` | No | Passed to pi exactly as written. Omit it to use the calling session's model. | `openai-codex/gpt-5.6-sol` |
| `effort` | No | Reasoning depth, independent of `model`. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | No | Comma-separated pi tool names. Omit it to use pi's defaults. | `read, grep, find, ls` |
| `appendSystemPrompt` | No | Append the prompt to pi's own instructions. Defaults to `true`; `false` replaces them. | `false` |

`model` reaches pi untouched, so reasoning depth belongs in `effort`, which pi takes as its thinking level. The two fields resolve independently:

| Profile | Model the subagent runs | Thinking level it runs at |
| --- | --- | --- |
| neither field | the calling session's | the calling session's |
| `effort` only | the calling session's | `effort` |
| `model` only | `model` | pi's own `defaultThinkingLevel` |
| both fields | `model` | `effort` |

Pinning a `model` therefore drops the caller's thinking level instead of carrying it over, since a level chosen for one model is not a level for another. Set `effort` whenever the depth matters. Pi clamps either to what the chosen model supports.

### Agent lookup

Only the user directory is resolved: `~/.pi/agent/agents/`, or `$PI_CODING_AGENT_DIR/agents/` when that is set.

## Technique details

### Concurrency

At most four subagents run at once; the rest stay visible as queued work and start when a slot opens. Runs have no time limit. `Esc` cancels the pi turn and with it every running and queued subagent call, keeping whatever output had already arrived.

### Security

Project trust is [pi's](https://pi.dev/docs/latest/security#project-trust). The extension resolves none of its own and forwards pi's decision to every child.

A subagent reads files, writes files, and runs commands as far as its `tools` list allows, and cannot call the `subagent` tool itself — delegation is one level deep.
