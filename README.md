# pi-subagent

Delegate tasks to specialized subagents with isolated context windows in Pi.

Each agent runs on a **harness** — Pi itself, or Claude Code. The harness is part
of the agent's profile, so the calling agent picks a role to delegate and never
has to configure a backend.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

After installation, Pi registers:

- `/agents` command for listing loaded subagents and viewing their prompts
- `subagent` tool

Agents that set `harness: claude` need the Claude Agent SDK. It is installed
with the package, so there is no extra step. If it ever goes missing, `/agents`
still works and a warning at session start names the agents that cannot run;
reinstalling pi-subagent restores it. Installing Claude Code separately, or
`npm install -g`, will not be picked up.

## Agent format

Agents are Markdown files in an `agents/` directory. The agent name is the filename without `.md`.

```markdown
---
description: Describes when to use this agent.
harness: pi
model: openai-codex/gpt-5.5
effort: high
tools: read, grep, find, ls
skills: summarize, commit
appendSystemPrompt: false
---

Describe the agent's role, constraints, workflow, and expected output.
```

Supported frontmatter fields:

`description` and the prompt body are required. Agent files missing a required field, or naming a value its harness cannot express, are skipped and reported in the UI at session start.

| Field | Required | Description | Example |
| --- | --- | --- | --- |
| `description` | Yes | When to use the agent. Free-form text. | `Fast codebase exploration` |
| `harness` | No | Execution backend. Defaults to `pi`. | `pi`, `claude` |
| `model` | No | The model id, handed to the harness **exactly as written** — nothing is stripped or parsed. `inherit` is the one reserved value: on `pi` it takes the calling agent's model, on `claude` your own Claude Code's. | `inherit`, `openai-codex/gpt-5.5`, `claude-opus-4-5`, `arn:aws:bedrock:…` |
| `effort` | No | Reasoning depth, independent of `model`. Every value works on either harness; if the model cannot do the level, the harness settles for the nearest one it can. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | No | Tools the agent can use. **`pi` only** — a `claude` agent runs the fixed set in [Tools](#tools), so the field is rejected there. Omit to inherit Pi's defaults. | `read, grep, find, ls, bash` |
| `skills` | No | Comma-separated skill names. **`pi` only** — a `claude` agent manages its own skills, so the field is rejected there. When set, the agent sees exactly these skills; when omitted, it discovers skills normally. | `summarize, commit` |
| `appendSystemPrompt` | No | When `true`, the agent prompt is appended to the harness's base system prompt. When `false` or omitted, the agent prompt replaces it. | `true`, `false` |

### Harnesses

| Harness | Runs on | Notes |
| --- | --- | --- |
| `pi` | Pi itself | The default. |
| `claude` | Claude Code | Always runs with approvals bypassed; what it loads from disk follows Pi's trust decision — see [Isolation](#isolation). |

`harness: codex` is recognized but not implemented yet; an agent that requests it
is reported as unsupported rather than silently falling back.

A Claude Code implementer agent, for example:

```markdown
---
description: Implements approved plans and verifies changes
harness: claude
model: claude-opus-4-5
effort: high
---

You are an implementation agent. Follow the approved plan and verify your work.
```

The calling agent invokes it the same way as any other agent — `subagent` takes
only `agent`, `description`, and `prompt`, so backend choice never leaks into the
tool call.

### Limits

**At most four subagents run at once.** Pi executes a turn's tool calls concurrently, so a parent that asks for six subagents in one turn starts six — each a full harness process with its own model traffic. Beyond the fourth, runs queue and start as slots free; they show up straight away as pending rather than appearing only once they begin. Cancelling a queued run drops it from the queue without ever starting it.

**There is no time limit.** A subagent call blocks the turn that made it, so a run going nowhere is visible while it happens and cancelling ends it — promptly, keeping whatever transcript it had produced. A wall-clock deadline would mostly kill long work that was going fine. The one thing to know: a wedged run holds its slot until you cancel it, so four of them will leave later subagents queued.

### Approvals

A `claude` subagent always runs with approvals bypassed, and this is not configurable.

A headless subagent has nobody to ask, so anything needing approval would simply be refused. Bypassing is the only setting that leaves it able to work.

**So a `claude` agent can change things.** It reads, writes, edits, searches, runs commands, browses, and uses its own skills — `Write`, `Edit`, and `Bash` included. Only `model` and `effort` shape it; how it does the work is Claude Code's business, which is the point of delegating to another harness. If you need a subagent that cannot change anything, use `harness: pi` with a read-only `tools` list.

What it cannot do is start or reach another agent — see [Tools](#tools).

### Inspecting a finished Claude run

Claude Code keeps a transcript per session, so a `claude` subagent's whole conversation survives the run. The expanded tool result prints the command that reopens it:

```
claude -r 829ca214-fb0c-403d-a816-df0299483db0
```

Sessions are resolved per project directory, so this only works from the directory the subagent ran in — when that is somewhere else, the hint includes the hop:

```
(cd /path/to/project && claude -r 829ca214-...)
```

Running `claude` subagents does not put a `claude` command on your PATH. If you have none, the hint names the bundled executable by absolute path instead — the same CLI, and the command still works exactly as printed.

Transcripts live under `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`, alongside your own interactive Claude Code sessions for that directory. Note this means a subagent's prompt and system prompt persist in plaintext after the run. Nothing is ever resumed automatically — every delegation starts a fresh session.

A `pi` subagent keeps no transcript, so there is nothing to reopen.

### Isolation

What a `claude` subagent loads from disk follows **Pi's own trust decision** for the working directory. Delegating never grants a directory more than working in it already did, and there is no separate switch to get wrong.

| | trusted directory | untrusted directory |
| --- | --- | --- |
| `~/.claude/` settings, your skills and plugins | loaded | loaded |
| `.claude/settings.json`, `.claude/settings.local.json` | loaded | **not loaded** |
| Project hooks | loaded | **not loaded** |
| `CLAUDE.md` | loaded | **not loaded** |
| MCP servers (`.mcp.json`, plugins) | loaded | **not loaded** |

**Trusted** is the useful case and the common one: a subagent sees your skills, your plugins, and the project's own instructions, because a subagent that cannot see your skills is a worse version of you.

**Untrusted** matters because a subagent runs with approvals bypassed. A checkout you have not trusted can register hooks in its `.claude/settings.json` — arbitrary commands nothing intercepts — and its `.mcp.json` can name a server that is itself a command to launch. Loading either would mean cloning a repository and delegating one task ran that repository's code. So an untrusted directory gets user scope only, and no MCP at all.

If Pi cannot report a trust decision, the untrusted shape applies. A host that cannot say is not read as saying yes.

Two things reach the child regardless, and neither runs on its own:

- **Skills** — from user scope always, and from the project too when it is trusted.
- **Slash commands** — loaded, but a subagent is driven by a prompt rather than typed commands, so nothing invokes them.

### Tools

A `claude` subagent's tools are an explicit allowlist, not Claude Code's whole set minus a few:

| Allowed | |
| --- | --- |
| `Bash`, `BashOutput`, `KillShell` | Run commands, including in the background. |
| `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | Change files. |
| `Glob`, `Grep` | Search. |
| `WebFetch`, `WebSearch` | Reach the network. |
| `TodoWrite` | Track its own work. |
| `Skill` | Use its own skills. |

**It has to be an allowlist.** Claude Code's tool set is open and grows with every release, so naming the spawn tools to withhold leaves the next one reachable — which is what happened here. Withholding `Agent`, `Task`, and `Workflow` still left `CronCreate` (schedules a recurring cloud agent), `RemoteTrigger` (launches a remote one), and `SendMessage` (reaches an existing one) available through `ToolSearch`, each running with approvals bypassed and none of them inheriting the nesting guard — a scheduled agent outlives the Pi session entirely. `ToolSearch` is withheld for the same reason: it is the gateway to the whole deferred tool set, so leaving it in would re-open the set the allowlist exists to close. Bounding the set also drops about 13k tokens of tool definitions from every run.

Two limits worth stating plainly. `Bash` is on the list, and `Bash` can run `claude -p`, so no tool policy makes this a hard recursion bound — what it bounds is the durable, invisible case, an agent that outlives the session and shows up in no transcript. And the base set is not perfectly closed: the CLI surfaces its background-task pair (`TaskOutput`, `TaskStop`) alongside `Bash` regardless, and those only observe and stop work this session already started.

The nesting guard is separate and applies to both harnesses: a subagent cannot call this extension's `subagent` tool at all.

## Discovery rules

### Agents

This package ships with default agents in the `agents/` directory. It also loads agents from installed Pi packages that contain an `agents/` directory, such as packages installed with `pi install https://github.com/goofansu/pi-stuff`. You can add or override agents at the user or project level by creating Markdown files with the same format. Higher-priority agents override lower-priority ones with the same name.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/agents/` |
| 2 | user | `~/.pi/agent/agents/` |
| 3 | package | installed package `agents/` directories, for example `~/.pi/agent/git/github.com/goofansu/pi-stuff/agents/` |
| 4 | bundled | `agents/` |

For example, `~/.pi/agent/agents/security-reviewer.md` creates a user-scoped agent named `security-reviewer`. If you create `.pi/agents/general-purpose.md` in a project, it overrides the user, package, and bundled `general-purpose` agents for that project.

### Skills

`skills` is a **`pi`-only** field. A `pi` agent that declares it sees exactly those skills and nothing else; omit it and the agent discovers skills normally. A skill is a directory containing a `SKILL.md`, found under project and user scope — if the same name appears in more than one place, the highest-priority location wins.

A `claude` agent manages its own skills: Claude Code discovers and invokes them itself. Declaring `skills` on a `claude` profile makes the agent file invalid.

| Priority | Scope | Location |
| --- | --- | --- |
| 1 | project | `.pi/skills/` |
| 2 | project | `.agents/skills/` |
| 3 | user | `~/.pi/agent/skills/` |
| 4 | user | `~/.agents/skills/` |

## Nesting prevention

Subagents cannot spawn subagents. Nesting is limited to one level, which keeps context growth, delegation loops, and tool costs bounded.

A `pi` subagent that calls the `subagent` tool gets an error. A `claude` subagent has its agent-spawning tools withheld instead (see [Isolation](#isolation)).

This is a guard against runaway delegation, not an adversarial sandbox: a subagent with shell access can always start a fresh agent itself.

## Using with the Pi SDK

Most users do not need this section. It is for programs that import `pi-subagent` and register it with a Pi SDK session.

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
  extensionFactories: [
    // Choose one:
    //
    // Use this when the target project owns its own .pi/agents and .pi/skills.
    createSubagentExtension({ cwd, agentDir }),

    // Or use this when another directory owns the agents and skills.
    // The child subagent works in cwd, but project agents are loaded from
    // /path/to/another/directory/.pi/agents and project skills are loaded from
    // /path/to/another/directory/.pi/skills and .agents/skills.
    // createSubagentExtension({
    //   cwd,
    //   agentDir,
    //   configCwd: "/path/to/another/directory",
    // }),
  ],
});

const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader,
});

await session.prompt("Use the subagent tool to review this project.");
```
