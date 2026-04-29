# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in Pi.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

After installation, Pi registers:

- `/agents` command for listing loaded subagents and viewing their prompts
- `subagent` tool

## Agent format

Agents are Markdown files in an `agents/` directory. The agent name is the filename without `.md`.

```markdown
---
description: Describes when to use this agent.
model: inherit
tools: read,grep,find,ls
appendSystemPrompt: false
---

Describe the agent's role, constraints, workflow, and expected output.
```

Supported frontmatter fields:

`description` and the prompt body are required. Agent files missing either are skipped and reported in the UI at session start.

| Field | Required | Description |
| --- | --- | --- |
| `description` | Yes | When to use the agent. |
| `model` | No | Model override. Omit or use `inherit` to use the caller's model. |
| `tools` | No | Tools override. Omit to use Pi's user-scoped tools. Any defined value is passed as-is with `--no-tools --tools <tools>`. |
| `appendSystemPrompt` | No | System prompt override. Omit or use `false` to replace Pi's system prompt with the agent prompt. Use `true` to append the agent prompt to Pi's system prompt. |

This package ships with default agents in the `agents/` directory. You can add or override agents by creating Markdown files with the same format in your Pi agent directory:

```text
~/.pi/agent/agents/<agent-name>.md
```

For example, `~/.pi/agent/agents/security-reviewer.md` creates an agent named `security-reviewer`.
