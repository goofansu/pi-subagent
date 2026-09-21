# pi-subagent

Run and orchestrate specialised agents in separate conversations from Pi, backed
by Pi or Claude. Fan out work in parallel, keep track of every Run from the live
dashboard, and resume, steer, or cancel agents without interrupting your main
conversation.

## Install

```bash
pi install npm:@goofansu/pi-subagent
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

Pi-backed subagents do not load extensions. Their Profile controls their model,
prompt, and tools without extension startup hooks changing them. Models from
Pi's built-in catalogue, including Radius, remain available; extension-defined
providers and extension tools do not. Consequently, if a Profile omits its
model while the parent uses an extension-defined provider, `agent_start` fails
because that provider is unavailable to the child. Pin a built-in or
`models.json` model in the Profile instead.

## Agent profile format

To add an agent or replace a bundled one, create a Markdown file in
`~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/` if configured). The
filename is the agent name: `reviewer.md` defines `reviewer`. Profiles are not
loaded from individual projects.

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
| `description` | A short explanation of when to use this agent. Required. |
| `backend` | `pi` (default) or `claude`. |
| `model` | For Pi, a model ID or `provider/model-id`; omitted, it uses the caller's model. For Claude, use `fable`, `opus`, `sonnet`, or `haiku`; omitted, it uses Claude's default. Full Claude model IDs are not accepted. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | A comma-separated list of tool names for that backend. Omit to use its defaults. Pi and Claude use different tool names. |
| `appendSystemPrompt` | Defaults to `true`, adding the profile's instructions to the backend's standard instructions. Set `false` to replace them. |

The text below the frontmatter is the agent's required system prompt. Profiles
are loaded and validated when the Session starts; invalid profiles are reported
then. A same-name user Profile replaces the complete bundled Profile.

## Trust and Claude settings

For the safest default, I recommend setting Pi's `defaultProjectTrust` to
`"never"` in `~/.pi/agent/settings.json` (or through `/settings`):

```json
{
  "defaultProjectTrust": "never"
}
```

This declines trust when no saved decision applies; explicitly trust projects
whose project-level settings and instructions you want subagents to load.

Pi resolves trust for the Session working directory. `agent_start` reads the
decision through `ctx.isProjectTrusted()` and stores it in `SubagentContext`.
The decision stays fixed for the subagent, including resumed Runs.

In a trusted directory, Claude loads its user, project, and local settings. In
an untrusted directory, Claude loads only the user setting source. Project and
local settings, instructions from those sources, and project `.mcp.json` are
excluded. User MCP servers and cloud connectors remain available.

Claude bypasses permission prompts in both cases. **Trust is not a sandbox.** It
does not restrict filesystem, shell, network, or other ambient access.
