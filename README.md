# pi-subagent

Delegate tasks to specialised subagents in Pi, using Pi or Claude. Each subagent
works in its own conversation, reports progress, and sends its result back when
finished. You can continue its conversation, give it guidance, or cancel its work.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

Add a [profile](#profiles), then use `/subagent profiles` to give it a task, or
ask Pi to delegate work to it.

## Commands

| Command | What it does |
| --- | --- |
| `/subagent` | Shows a summary of available profiles and current work. |
| `/subagent profiles` | Browse profiles, read their prompts, and assign a task. |
| `/subagent diagnostics` | Shows troubleshooting information when something goes wrong. |

## Tools

Pi uses these tools to manage delegated work. A **subagent** is a conversation
that can continue across tasks; a **Run** is one task started in that conversation.

| Tool | What it does |
| --- | --- |
| `agent_start` | Starts a new subagent with an `agent` profile name, a short `description`, and a `prompt`. Returns Subagent and Run IDs immediately. |
| `agent_resume` | Continues an idle subagent's conversation with a new task. Returns a new Run ID. |
| `agent_wait` | Waits for specified Runs and returns their results. Supports an optional timeout. |
| `agent_wait_all` | Waits for all currently active Runs and returns their results. Supports an optional timeout. |
| `agent_cancel` | Requests cancellation of specified Runs, keeping any partial output. |
| `agent_steer` | Sends guidance to an active Run. Acceptance does not guarantee the subagent has read it yet. |
| `agent_result` | Retrieves a finished Run's result, including output too long to fit in its completion notice. |

Use the **Subagent ID** for `agent_resume`; use **Run IDs** for the other tools
that take IDs.

Results arrive automatically, so Pi can keep working while subagents run.
Waiting returns results directly without a duplicate completion notice.

**Output limits:** completion notices include answers up to 16 KiB; longer
answers arrive as a preview with instructions to retrieve the rest.
`agent_result` returns the stored result, and `agent_wait` returns the same
content for each Run. Each stored result is limited to 256 KiB, with 4 MiB of
storage shared across the session. Oversized results are shortened and marked
as truncated. These are storage limits, not exact tool-response sizes; a wait
covering several Runs combines their results.

- Up to eight Runs can work at once. Additional starts or resumes are refused
  immediately rather than queued. Subagents cannot delegate further.
- `Esc` stops Pi's current turn, not its subagents. Ask Pi to cancel their work.
- Starting, switching, reloading, or leaving a session stops its active Runs.
  Subagent conversations and results do not carry over to another session.
- Older results may expire when the session's output storage fills up.

## Widget

A widget above the editor shows each subagent's progress:

```text
 subagents   2 running   1 completed
 explore      pi      running             3 turns  look around · grep: getFinalOutput
 reviewer     claude  running             1 turn   review the changes
 implementer  claude  completed in 1m 2s
```

Each row shows the agent, backend, status, and task. Active Runs also show their
turn count and latest activity; finished Runs show their duration.

Finished rows disappear once their completion notice reaches the conversation
or Pi retrieves their result. If a notice cannot be delivered, the row stays
visible with an explanation. Ask Pi to retrieve the result or cancel active work
by naming the agent and task—the widget itself is not interactive.

## Profiles

Create Markdown files in `~/.pi/agent/agents/` (or
`$PI_CODING_AGENT_DIR/agents/` if configured). Profiles are loaded from this user
directory, not from individual projects. The filename is the agent name:
`reviewer.md` defines `reviewer`.

```markdown
---
description: Reviews changes for bugs and missing tests
backend: claude
model: sonnet
effort: high
tools: Read, Grep, Glob
---

Review the changes. Report actionable bugs and missing tests with file references.
Do not modify files.
```

| Field | What to set |
| --- | --- |
| `description` | A short explanation of when to use this agent. |
| `backend` | `pi` (default) or `claude`. |
| `model` | For Pi, a model ID or `provider/model-id`; omitted, it uses the caller's model. For Claude, use `fable`, `opus`, `sonnet`, or `haiku`; omitted, it uses Claude's default. Full Claude model IDs are not accepted. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | A comma-separated list of tool names for that backend. Omit to use its defaults. Pi and Claude use different tool names. |
| `appendSystemPrompt` | Defaults to `true`, adding the profile's instructions to the backend's standard instructions. Set `false` to replace them. |

The text below the frontmatter contains the agent's instructions. Invalid
profiles are reported when the session starts.

**Claude runs without permission prompts** and inherits your Claude Code
settings, including configured MCP servers. Its `tools` field limits built-in
tools, not MCP access. Only delegate work you trust it to perform. Pi subagents
follow Pi's project-trust settings.
