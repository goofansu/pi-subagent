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
model: openai-codex/gpt-5.5:high
tools: read, grep, find, ls
skills: summarize, commit
appendSystemPrompt: false
---

Describe the agent's role, constraints, workflow, and expected output.
```

Supported frontmatter fields:

`description` and the prompt body are required. Agent files missing either are skipped and reported in the UI at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. Free-form text. | `Fast codebase exploration` |
| `model` | No | Model override. Omit or use `inherit` to use the caller's model. | `inherit`, `openai-codex/gpt-5.5:high`, `anthropic/claude-opus-4-7` |
| `tools` | No | Tools the agent can use. Omit to inherit Pi's default tools. | `read, grep, find, ls, bash`, `read, bash, edit, write` |
| `skills` | No | Comma-separated skill names. When set, only the listed skills are available to the child process. When omitted, the child discovers skills normally. Skills are resolved from user and project scope. | `summarize, commit` |
| `appendSystemPrompt` | No | When `true`, the agent prompt is appended to Pi's base system prompt. When `false` or omitted, the agent prompt replaces it. | `true`, `false` |

This package ships with default agents in the `agents/` directory. You can add or override agents by creating Markdown files with the same format in your Pi agent directory:

```text
~/.pi/agent/agents/<agent-name>.md
```

For example, `~/.pi/agent/agents/security-reviewer.md` creates an agent named `security-reviewer`.

## Nesting prevention

Subagents are not allowed to spawn other subagents. A depth guard using the `PI_SUBAGENT_DEPTH` environment variable limits nesting to one level. If a subagent attempts to call the `subagent` tool, the call is rejected with an error.
