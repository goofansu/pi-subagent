# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in Pi.

Each agent runs on a **harness** — Pi itself, Claude Code, or Codex. The harness
is part of the agent's profile, so the calling agent picks a role to delegate to
without having to configure a backend.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

After installation, Pi registers:

- `/agents` command for listing loaded subagents and viewing their prompts
- `subagent` tool

`claude` agents use the Claude Agent SDK bundled with this package; reinstall
pi-subagent if Pi reports that the SDK is missing. A separately installed global
Claude Code CLI is not used.

`codex` agents require a current `codex` CLI on `PATH`, authenticated and
configured as usual. Pi reports incompatible or missing CLIs at session start.

## Agent format

Agents are Markdown files in an `agents/` directory. The filename without
`.md` is the name passed to the `subagent` tool.

The supported frontmatter fields are listed below. `description` and the prompt
body are required. Invalid files are skipped and reported at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. | `Implement and verify a scoped change` |
| `harness` | No | Execution backend. Defaults to `pi`. | `pi`, `claude`, `codex` |
| `model` | No | Passed exactly to the selected harness. `inherit` uses the parent model on Pi and the harness default on Claude or Codex. | `inherit`, `opus`, `gpt-5.6-sol` |
| `effort` | No | Reasoning depth, independent of `model`. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | No | **Pi only.** Comma-separated tool names. Omit to use Pi's defaults. | `read, grep, find, ls` |
| `appendSystemPrompt` | No | Append the prompt to native instructions. Defaults to `true`; set to `false` to replace them. | `false` |

Declaring `tools` on a Claude or Codex profile makes the file invalid.

Profile prompts append to the harness's native instructions by default. Set
`appendSystemPrompt: false` only when the profile prompt should replace those
native instructions.

### Harnesses

| Harness | Runs on | Notes |
| --- | --- | --- |
| `pi` | Pi itself | Default; supports profile-controlled tools. |
| `claude` | Claude Code | Native Claude tools with approvals bypassed. |
| `codex` | Codex CLI | Native Codex tools with approvals and sandboxing bypassed. |

### Examples

The examples use the same role and prompt so the harness-specific differences
are easy to see.

#### Pi

```markdown
---
description: Implements approved plans and verifies changes
harness: pi
model: openai-codex/gpt-5.5
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

#### Claude

```markdown
---
description: Implements approved plans and verifies changes
harness: claude
model: opus
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

Claude also accepts aliases such as `opus`, `sonnet`, and `haiku`; use a full
model ID when you need a fixed version.

#### Codex

```markdown
---
description: Implements approved plans and verifies changes
harness: codex
model: gpt-5.6-sol
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

Every profile is invoked the same way: the `subagent` tool accepts only
`agent`, `description`, and `prompt`. Use `/agents` to inspect the profiles Pi
loaded.

## Runtime and safety

### Scheduling and cancellation

At most four subagents run concurrently. Additional runs remain visible as
queued work and start when a slot opens. Cancelling a queued run prevents it
from starting.

Runs have no automatic time limit. Cancel a stuck run manually; cancellation
keeps any transcript already produced.

### Permissions and tools

`claude` and `codex` run headlessly with approvals bypassed; Codex also uses
full-access sandbox mode. They can read and modify files, execute commands, and
use their native coding tools. Use a `pi` profile with a read-only `tools` list
when you need a restricted agent.

A child Pi process does not register this extension's tool or commands. Claude
receives an explicit allowlist of working tools, with agent-spawning and
deferred tool discovery excluded. Codex's native multi-agent delegation is
disabled.
Every harness also enforces the extension's one-level nesting guard as a
backstop, so a subagent cannot call the `subagent` tool.

This prevents accidental delegation loops, not adversarial recursion: an agent
with shell access can still invoke another CLI directly.

### Project trust

Subagents use Pi's trust decision for the working directory; unknown trust is
treated as untrusted.

- **Trusted:** the selected harness loads its project settings and resources
  normally.
- **Untrusted:** project settings and executable integrations are not loaded.

Project context differs by harness. Pi still loads context files such as
`AGENTS.md` and `CLAUDE.md`, and Codex still loads `AGENTS.md`. Claude excludes
project `CLAUDE.md` along with its project settings source.

Trust controls automatic loading only. It does not restrict file access, tools,
commands, or network access.

### Session persistence

Every harness runs one-shot tasks with no session to resume.

## Agent discovery

Pi discovers bundled agents, agents from installed packages, and user and
project agents. A higher-priority file replaces a lower-priority file with the
same name.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/agents/` |
| 2 | user | `~/.pi/agent/agents/` |
| 3 | package | installed package `agents/` directories |
| 4 | bundled | `agents/` |

Project agents and project-scoped package agents are discovered only when Pi
trusts the working directory. For example,
`~/.pi/agent/agents/security-reviewer.md` defines a user agent, which a trusted
project can override with `.pi/agents/security-reviewer.md`.
