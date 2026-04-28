# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in Pi.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

After installation, pi registers:

- `/subagent <task>` command
- `subagent` tool

## Agent format

Agents are Markdown files in an `agents/` directory. The agent name is the filename without `.md`.

```markdown
---
description: Describes when to use this agent.
model: inherit
tools: read,grep,find,ls
---

System prompt for the agent.

Describe the agent's role, constraints, workflow, and expected output.
```

Supported frontmatter fields:

| Field | Required | Description |
| --- | --- | --- |
| `description` | No | Describes when to use the agent. |
| `model` | No | Model override. Use `inherit` to use the caller's model. |
| `tools` | No | Comma-separated tool allowlist for the agent, e.g. `read,grep,find,ls`. |

This package ships default agents from `agents/`. You can add or override agents by creating Markdown files with the same format in your Pi agent directory:

```text
~/.pi/agent/agents/<agent-name>.md
```

For example, `~/.pi/agent/agents/security-reviewer.md` creates an agent named `security-reviewer`.
