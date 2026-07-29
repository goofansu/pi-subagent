# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in Pi.

Each agent runs on a **harness** — Pi itself, Claude Code, or Codex. The harness
is part of the agent's profile, so the calling agent picks a role to delegate
and never has to configure a backend.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

After installation, Pi registers:

- `/agents` command for listing loaded subagents and viewing their prompts
- `subagent` tool

`claude` agents use the Claude Agent SDK bundled with this package; reinstall
pi-subagent if Pi reports that it is missing. A separately installed global
Claude Code CLI is not used.

`codex` agents require a current `codex` CLI on `PATH`, authenticated and
configured as usual. Pi reports incompatible or missing CLIs at session start.

## Agent format

Agents are Markdown files in an `agents/` directory. The filename without
`.md` is the name passed to the `subagent` tool.

Supported frontmatter fields:

`description` and the prompt body are required. Invalid files are skipped and
reported at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. | `Implement and verify a scoped change` |
| `harness` | No | Execution backend. Defaults to `pi`. | `pi`, `claude`, `codex` |
| `model` | No | Passed exactly to the selected harness. `inherit` uses the parent model on Pi and the harness default on Claude or Codex. | `inherit`, `opus`, `gpt-5.6-sol` |
| `effort` | No | Reasoning depth, independent of `model`. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | No | **Pi only.** Comma-separated tool names. Omit to use Pi's defaults. | `read, grep, find, ls` |
| `skills` | No | **Pi only.** Exact comma-separated skill set. Omit for normal discovery. | `summarize, commit` |
| `appendSystemPrompt` | No | Append the prompt to native instructions when `true`; replace them when `false` or omitted. | `true` |

Declaring `tools` or `skills` on a Claude or Codex profile makes the file
invalid.

### Harnesses

| Harness | Runs on | Notes |
| --- | --- | --- |
| `pi` | Pi itself | Default; supports profile-controlled tools and skills. |
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
appendSystemPrompt: true
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
appendSystemPrompt: true
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
appendSystemPrompt: true
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

Claude receives an explicit working-tool allowlist, with agent-spawning and
deferred tool discovery excluded. Codex's native multi-agent delegation is
disabled. Every harness also enforces the extension's one-level nesting guard,
so a subagent cannot call the `subagent` tool.

This prevents accidental delegation loops, not adversarial recursion: an agent
with shell access can still invoke another CLI directly.

### Project trust

External harnesses follow Pi's trust decision for the working directory:

- **Trusted:** user and project instructions, skills, settings, hooks, plugins,
  and configured integrations may load normally.
- **Untrusted or unknown:** project configuration and executable integrations
  are excluded. User instructions and skills remain available, but MCP servers
  and apps are disabled.

This matters because external harnesses bypass approvals. Delegating from an
untrusted checkout must not execute a project hook or launch a project-defined
MCP server. For untrusted Codex runs, the backend also avoids persisting the
directory as trusted while retaining the requested working directory.

### Transcripts

Claude and Codex persist their native sessions, including prompts and system
instructions in plaintext. The expanded result prints a copy-pasteable resume
command such as `claude -r <session-id>` or `codex resume <thread-id>`, including
a directory change when required. Runs are never resumed automatically.

Pi runs without a persistent session.

## Discovery rules

### Agents

Pi loads bundled agents, agents contributed by installed packages, and your
user and project agents. A higher-priority file replaces a lower-priority file
with the same name.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/agents/` |
| 2 | user | `~/.pi/agent/agents/` |
| 3 | package | installed package `agents/` directories |
| 4 | bundled | `agents/` |

For example, `~/.pi/agent/agents/security-reviewer.md` defines a user agent
named `security-reviewer`. A project file at `.pi/agents/security-reviewer.md`
overrides it.

### Skills

`skills` is a Pi-only field. Declaring it selects the exact skill set; omitting
it uses normal discovery. Claude and Codex manage their own skills, so
declaring `skills` on those profiles is an error.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/skills/` |
| 2 | project | `.agents/skills/` |
| 3 | user | `~/.pi/agent/skills/` |
| 4 | user | `~/.agents/skills/` |

## Using with the Pi SDK

Applications embedding Pi can register the extension directly:

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createSubagentExtension } from "pi-subagent";

const cwd = process.env.PI_PROJECT_DIR ?? process.cwd();
const agentDir = getAgentDir();

const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [createSubagentExtension({ cwd, agentDir })],
});

const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader,
});

await session.prompt("Use the subagent tool to review this project.");
```

Set `configCwd` in `createSubagentExtension` when agents and skills belong to a
different directory from the child's working directory.
