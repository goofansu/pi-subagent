# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in Pi.

Each agent runs on a **harness** selected by its profile, so the calling agent
picks a role to delegate to without having to configure a backend.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

## Command and tool

The extension provides:

- `/agents`, a command for listing loaded agent profiles, viewing their prompts,
  and asking an agent to handle a task.
- `subagent`, a tool for running a task with a selected agent profile. It accepts
  only `agent`, `description`, and `prompt`; the profile determines the harness,
  model, effort, and tools.

## Agent format

Agents are Markdown files in an `agents/` directory. The filename without
`.md` is the name passed to the `subagent` tool.

The supported frontmatter fields are listed below. `description` and the prompt
body are required. Invalid files are skipped and reported at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. | `Implement and verify a scoped change` |
| `harness` | No | Execution backend. Defaults to `pi`. | `pi`, `claude`, `codex` |
| `model` | No | Passed exactly to the selected harness. See omitted behavior below. | `opus`, `gpt-5.6-sol` |
| `effort` | No | Reasoning depth, independent of `model`. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | No | Comma-separated tool names. Harness behavior is listed below. | `read, grep, find, ls` |
| `appendSystemPrompt` | No | Append the prompt to native instructions. Defaults to `true`; set to `false` to replace them. | `false` |

Harness-specific field behavior:

- `pi`: omitting `model` uses the parent model. `tools` controls the available
  Pi tools; omit it to use Pi's defaults.
- `claude`: omitting `model` uses Claude Code's default model. Declaring `tools`
  makes the profile invalid.
- `codex`: omitting `model` uses Codex's default model. Declaring `tools` makes
  the profile invalid.

Profile prompts append to the harness's native instructions by default. Set
`appendSystemPrompt: false` only when the profile prompt should replace those
native instructions.

## Agent discovery

Pi discovers user and project agents. A project file replaces a user file with
the same name. Here, **project** means Pi's current working directory.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/agents/` |
| 2 | user | `~/.pi/agent/agents/` |

Project agents are discovered only when Pi trusts the project. For example,
`~/.pi/agent/agents/security-reviewer.md` defines a user agent, which a trusted
project can override with `.pi/agents/security-reviewer.md`.

## Agent profiles

The profiles below use the same role and prompt to highlight harness-specific
configuration and runtime behavior. Pi reports incompatible or missing
harnesses at session start.

### Pi

- Runs on Pi itself.
- Uses the current Pi installation.
- Is the default harness and supports profile-controlled tools.

```markdown
---
description: Implements approved plans and verifies changes
harness: pi
model: openai-codex/gpt-5.5
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

### Claude

- Runs on Claude Code with its native tools and approvals bypassed.
- Uses the Claude Agent SDK bundled with this package. Reinstall pi-subagent if
  Pi reports that the SDK is missing; a separately installed global Claude Code
  CLI is not used.
- Accepts aliases such as `opus`, `sonnet`, and `haiku`; use a full model ID when
  you need a fixed version.

```markdown
---
description: Implements approved plans and verifies changes
harness: claude
model: opus
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

### Codex

- Runs on Codex CLI with its native tools, approvals bypassed, and full-access
  sandbox mode.
- Requires a current `codex` CLI on `PATH`, authenticated and configured as
  usual.

```markdown
---
description: Implements approved plans and verifies changes
harness: codex
model: gpt-5.6-sol
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

## User experience

### Concurrency

At most four subagents run concurrently. Additional runs remain visible as
queued work and start when a slot opens.

Runs have no automatic time limit.

### Cancellation

Press `Esc` to cancel the current Pi turn. This cancels all of its running and
queued subagent calls; there is no per-subagent cancellation control. A queued
run that is cancelled never starts.

Cancel a stuck run with `Esc`. Output produced before cancellation remains in
the subagent tool result in the parent Pi session. A run cancelled while still
queued has no output to retain.

## Technique details

### Permissions and tools

- `pi`: supports a profile-defined `tools` list. Use a read-only list when you
  need a restricted agent. A child Pi process does not register this extension's
  tool or commands.
- `claude`: runs headlessly with approvals bypassed and receives an explicit
  allowlist of working tools. Agent-spawning tools and deferred tool discovery
  are excluded.
- `codex`: runs headlessly with approvals bypassed and full-access sandbox mode.
  Native multi-agent delegation is disabled.

All harnesses can read and modify files or execute commands when their available
tools allow it.

Every harness also enforces the extension's one-level nesting guard as a
backstop, so a subagent cannot call the `subagent` tool.

This prevents accidental delegation loops, not adversarial recursion: an agent
with shell access can still invoke another CLI directly.

### Trust mechanism

Subagents use Pi's trust decision for the project; unknown trust is treated as
untrusted.

- **Trusted:** the selected harness loads its project settings and resources
  normally.
- **Untrusted:** behavior differs by harness:

  - `pi`: does not load project settings or executable integrations, but still
    loads context files such as `AGENTS.md` and `CLAUDE.md`.
  - `claude`: does not load project `CLAUDE.md` or project/local settings, and
    disables all inherited MCP servers.
  - `codex`: marks the project as untrusted and still loads its `AGENTS.md`. It
    also disables hooks, plugins, apps, and all inherited MCP servers across
    configuration scopes.

Trust controls automatic loading only. It does not restrict file access, tools,
commands, or network access.

### Session persistence

Every harness runs one-shot tasks with no session to resume. Subagent runs are
ephemeral and do not save separate child transcripts.
