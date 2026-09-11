# pi-subagent

Run and orchestrate specialised agents in separate conversations from Pi, backed
by Pi or Claude. Fan out work in parallel, keep track of every Run from the live
dashboard, and resume, steer, or cancel agents without interrupting your main
conversation.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

The package includes profiles for general work, implementation, specification
review, and standards review.

## Commands

| Command | Description |
| --- | --- |
| `/subagent` | Lists profiles and current work. |
| `/subagent dashboard` | Opens the dashboard for live work, Run history, and read-only inspection. Press `Alt+Shift+.` to open it directly. |
| `/subagent doctor` | Reports configuration and runtime problems. |

## Tools

A **subagent** is a conversation that can continue across tasks. A **Run** is one
task in that conversation.

| Tool | Description |
| --- | --- |
| `agent_start` | Creates a subagent and starts its first Run. |
| `agent_resume` | Starts another Run in an idle subagent. |
| `agent_wait` | Waits for named Runs and returns their results. |
| `agent_wait_all` | Waits for all Runs active at the time of the call. |
| `agent_cancel` | Requests cancellation and keeps partial output. |
| `agent_steer` | Sends guidance to an active Run. |
| `agent_result` | Returns a finished Run's full result. |

`agent_start` and `agent_resume` return IDs immediately. A completion notice
contains the result when it fits. Use `agent_result` to read longer output.

## Trust and Claude settings

Pi resolves trust for the Session working directory. `agent_start` reads the
decision through `ctx.isProjectTrusted()` and stores it in `SubagentContext`.
The decision stays fixed for the subagent, including resumed Runs.

In a trusted directory, Claude loads its user, project, and local settings. In
an untrusted directory, Claude loads only the user setting source. Project and
local settings, instructions from those sources, and project `.mcp.json` are
excluded. User MCP servers and cloud connectors remain available.

Claude bypasses permission prompts in both cases. **Trust is not a sandbox.** It
does not restrict filesystem, shell, network, or other ambient access.
