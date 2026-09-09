# pi-subagent

Delegate tasks to specialised subagents in Pi, using Pi or Claude. Each subagent
works in its own conversation, reports progress, and sends its result back when
finished. You can continue its conversation, give it guidance, or cancel its work.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

## Commands

| Command | What it does |
| --- | --- |
| `/subagent` | Shows a summary of available profiles and current work. |
| `/subagent dashboard` | Open the Subagent dashboard: live subagents, newest-first Run history, and frozen read-only inspection. Inspection supports keyboard navigation throughout; mouse-wheel scrolling is an additional fullscreen-mode feature. Shortcut: `Alt+Shift+.` |
| `/subagent doctor` | Shows troubleshooting information when something goes wrong. |

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

## Trust and Claude settings

Pi decides whether the Session working directory is trusted once, and every
subagent uses that fixed decision. Claude subagents in trusted directories use
Claude Code's normal user, project, and local settings. In untrusted
directories they use only the user setting source: user-owned settings, MCP
servers, and cloud connectors remain available, while project/local settings,
project instructions loaded through them, and project `.mcp.json` are excluded.

Claude subagents bypass permission prompts in both cases. **Trust is not a
sandbox:** it does not restrict filesystem, shell, network, or other ambient
access, and user-configured MCP servers and connectors may provide capabilities
that are not listed in a profile.
