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

`description` and the prompt body are required. Agent files missing any required field are skipped and reported in the UI at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. Free-form text. | `Fast codebase exploration` |
| `model` | No | Model override. Omit or use `inherit` to use the caller's model. | `inherit`, `openai-codex/gpt-5.5:high`, `anthropic/claude-opus-4-7` |
| `tools` | No | Tools the agent can use. Omit to inherit Pi's default tools. | `read, grep, find, ls, bash`, `read, bash, edit, write` |
| `skills` | No | Comma-separated skill names. When set, only the listed skills are available to the child process. When omitted, the agent discovers skills normally. Skills are resolved from project and user scope. | `summarize, commit` |
| `appendSystemPrompt` | No | When `true`, the agent prompt is appended to Pi's base system prompt. When `false` or omitted, the agent prompt replaces it. | `true`, `false` |

## Discovery rules

### Agents

This package ships with default agents in the `agents/` directory. You can add or override agents at the user or project level by creating Markdown files with the same format. Higher-priority agents override lower-priority ones with the same name.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/agents/` |
| 2 | user | `~/.pi/agent/agents/` |
| 3 | bundled | `agents/` |

For example, `~/.pi/agent/agents/security-reviewer.md` creates a user-scoped agent named `security-reviewer`. If you create `.pi/agents/general-purpose.md` in a project, it overrides both the user and bundled `general-purpose` agent for that project.

### Skills

When an agent declares a `skills` field, the named skills are resolved before the subagent is spawned. Skills are discovered from directories containing `SKILL.md`. If a skill name appears in multiple locations, the highest-priority location wins.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/skills/` |
| 2 | project | `.agents/skills/` |
| 3 | user | `~/.pi/agent/skills/` |
| 4 | user | `~/.agents/skills/` |

## Nesting prevention

Subagents are not allowed to spawn other subagents — this prevents runaway context growth, infinite delegation loops, and unpredictable tool costs. A depth guard using the `PI_SUBAGENT_DEPTH` environment variable limits nesting to one level. If a subagent attempts to call the `subagent` tool, the call is rejected with an error.
