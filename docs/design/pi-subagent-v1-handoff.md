# pi-subagent Version 1 Handoff: Multi-Backend Subagents

## Status

Implemented. The backend seam introduced in version 1 now ships the `pi`,
`claude`, and `codex` harnesses.

**Partly superseded.** This document records the v1 design as handed off. Two of
its decisions have since changed, and the README is the current source of truth:

- The claude tool policy is now an allowlist, not "everything minus the
  agent-spawning tools". Withholding `Agent`/`Task`/`Workflow` proved
  insufficient — `CronCreate`, `RemoteTrigger`, and `SendMessage` remained
  reachable through `ToolSearch`, none of them bounded by the nesting guard.
  See "Tools" in the README.
- Concurrent runs are capped at four. There is deliberately no wall-clock
  deadline: the tool blocks the calling turn, so a run going nowhere is visible
  and cancellable. See "Limits" in the README.
- Reasoning depth is the `effort` field, and `model` is handed to the harness exactly
  as written — no provider stripping, no suffix parsing. pi takes the level via
  `--thinking`, so nothing is spliced into a model id. See "Reasoning effort" in
  the README.
- Settings isolation is no longer unconditional. What a claude subagent loads
  from disk follows pi's trust decision for the directory: a trusted one loads
  normally, an untrusted one gets user scope and no MCP. See "Isolation" in the
  README.

## Goal

Extend `pi-subagent` from a Pi-only subprocess runner into a backend-neutral
subagent execution framework, while preserving the existing user experience:

- named agent profiles
- a single `subagent` tool
- `/agents` discovery command
- profile-driven configuration

The parent agent chooses **which role to delegate**, not how to configure the
execution backend.

---

## Design principles

### Agent profiles define identity

A profile defines role, system instructions, backend, model, reasoning effort,
and — on pi — tools:

```yaml
---
description: Implements approved plans and verifies changes
harness: claude
model: claude-opus-4-5
effort: high
---
You are an implementation agent.
Follow the approved plan and verify your work.
```

The parent agent invokes:

```json
{
  "agent": "implementer",
  "description": "Implement OAuth callback",
  "prompt": "Implement the approved design..."
}
```

It does not choose the harness, model, or permission mode — those belong to the
profile, because a named agent is a stable capability.

---

## Model-facing API

Unchanged:

```ts
subagent({
  agent: string,
  description: string,
  prompt: string,
});
```

`harness`, `model`, `effort`, and `tools` are deliberately *not* invocation
parameters.

---

## Architecture

```
              Parent Agent
                   |
             subagent tool          extensions/subagent/index.ts
                   |
              Dispatcher           extensions/subagent/runner.ts
                   |               (depth guard, progress)
             Agent Profile         extensions/subagent/agents.ts
                   |
        +----------+----------+    extensions/subagent/backend.ts
        |          |          |
       v          v          v
       Pi       Claude     Codex    extensions/subagent/backends/*.ts
        |          |          |
        +----------+----------+
                   |
            Normalized Result      SingleResult in types.ts
                   |
             Parent Agent
```

### The backend seam

```ts
interface SubagentBackend {
  readonly name: Harness;
  isAvailable(): Promise<boolean>;
  run(ctx: SubagentRunContext): Promise<SingleResult>;
}
```

Backends own everything harness-specific: process or SDK lifecycle, option
mapping, permission wiring, and translation of native events into pi
`Message`s. Everything harness-neutral stays in the dispatcher so it cannot
drift between backends:

- the `PI_SUBAGENT_DEPTH` nesting guard
- progress emission to the TUI

### Normalized result

`SingleResult` is the single result shape, extended with `harness`. It keeps
`messages: Message[]` rather than collapsing to a final string, so external
harness runs render in the existing transcript UI identically to a pi run.

---

## Backend notes

### Pi

`backends/pi.ts` is the original runner moved behind the seam with no behavior
change: spawn `pi --mode json -p --no-session`, prompt over stdin, fold NDJSON
events into the result.

### Claude Code

`backends/claude.ts` uses the Claude Agent SDK's `query()`. The SDK is imported
lazily and declared an *optional dependency* — not an optional peer, which npm
skips, and not a dev dependency, which `pi install`'s production install omits.
A missing SDK is reported at session start naming the affected agents.

| Agent setting | Claude Code |
| --- | --- |
| `model` | `options.model`, passed exactly as written |
| `effort` | `options.effort`, or `options.thinking` for `off`/`minimal` |
| `systemPrompt` | `options.systemPrompt` (string, or `claude_code` preset + append) |
| — | `permissionMode: bypassPermissions` + `allowDangerouslySkipPermissions`, always |
| `tools` | not mapped — a pi-only field; a claude subagent runs Claude Code's own tool set |
| `cwd` | `options.cwd` |
| — | `persistSession: false`, so the one-shot run is not written to Claude's session store |

`Agent`, `Task`, and `Workflow` are withheld unconditionally, keeping delegation
under this extension. `Agent` and `Task` are two names for the one tool that
spawns Claude Code's native subagents, so both are listed; `Workflow` spawns them
from a script. This is exactly what the reference implementation's own skill
promises — a subagent "cannot spawn subagents or workflows" — though that
implementation blocks only the first two. Matching is exact, so the unrelated
`Task*` tracker tools are unaffected.

Otherwise v1 left the tool set unrestricted (since superseded — see Status): the
point of delegating to another harness is to let it work with its own tools and
skills. `tools` is therefore a pi-only field, and setting it on a claude profile
is rejected rather than silently ignored — reading as a restriction while being
none is the misreading most likely to matter. Only `model` and `effort` shape a
claude agent; everything else about how it works is Claude Code's.

A delegated subagent's tokens are still billed to the run if one ever appears,
but its messages stay out of the transcript and out of occupancy.

v1 set `settingSources: []` unconditionally (since superseded — see Status): a
subagent runs with approvals bypassed, and a repository's `.claude/settings.json`
can register hooks, which run arbitrary commands no tool policy intercepts.
`CLAUDE.md` and `.mcp.json` were not loaded either. This also kept a subagent
from seeing the user's own skills, which is why it is now gated on pi's trust
decision instead of set flat.

This is settings isolation, not total isolation. Claude Code's own skills load
from disk, and so do slash commands — both verified. Neither executes on its
own, so the code-execution path is closed.

### Codex

`backends/codex.ts` runs `codex app-server --stdio`, with
`approvalPolicy=never` + `sandbox=danger-full-access` for the same reason the
claude harness bypasses. It maps base versus appended system instructions onto
`baseInstructions`/`developerInstructions`, maps effort on `turn/start`, folds
structured app-server items into the common transcript, and starts the thread
with `ephemeral: true` so it is not retained for resume.

The process starts with both `multi_agent` and `multi_agent_v2` disabled,
keeping native Codex delegation under the same one-level guard. Pi's trust
decision is forwarded as a process-local Codex project trust level. For an
untrusted task the child process starts in the task directory, but
`thread/start` omits its optional `cwd`; app-server otherwise persists an
explicit full-access cwd as trusted. Untrusted runs also disable hooks, plugins,
and apps at startup, then use `config/read` to enumerate and explicitly disable
every effective MCP server and app. An empty `mcp_servers` overlay is not
sufficient because Codex merges tables across layers.

The availability probe requires app server and both multi-agent feature names,
so an older CLI is reported before delegation instead of failing when the
backend supplies an unknown `--disable` value.

---

## Approvals

Not configurable. A `claude` subagent always runs `bypassPermissions`; a
`codex` subagent always runs with `approvalPolicy=never` and
`sandbox=danger-full-access`.

There is no interactive channel to a headless child, so Claude Code cannot ask
anyone: an operation needing approval is denied outright, so any other mode means
"deny everything that asks" — the model burns a turn discovering the refusal and
reports a misleading "you haven't granted it yet". (v1 argued this from settings
never loading, and therefore no pre-approval rules existing. Trusted directories
now do load `permissions.allow`, so the argument is narrower: rules could cover
some calls, never all of them, and the ones they miss are still dead ends.)

On pi, restriction belongs in `tools`, which sets the child's available tool set:
withholding a tool is stronger than refusing it at call time. A claude subagent
had no equivalent in v1 — it ran Claude Code's own tool set minus the
agent-spawning tools. It now has one: the backend's own allowlist, which is not
author-configurable. See Status.

A `permissions` field was designed and briefly implemented, then removed: its
only non-default value was not a useful shape for a subagent. Codex maps its
`approvalPolicy`/`sandbox` pair the same way — bypassed, not configurable.

---

## Reasoning effort

One neutral scale, `off … max`, mapped per harness:

| Neutral | Pi | Claude Code | Codex |
| --- | --- | --- | --- |
| `off` | `:off` | `thinking: { type: "disabled" }` | `effort: "none"` |
| `minimal` | `:minimal` | `thinking: { type: "enabled", budgetTokens: 1024 }` | `effort: "minimal"` |
| `low`–`xhigh` | `:<level>` | `effort: <level>` | `effort: <level>` |
| `max` | `:max` | `effort: "max"` | `effort: "max"` |

All harnesses cover the whole scale: pi's `model:<level>` suffix accepts every
level in `PI_THINKING_LEVELS`, and pi clamps a level the chosen model does not
support. A value outside the scale is rejected at load time with a reason naming
the accepted set, so an agent file never silently means something else.

---

## Skill handling

Every harness manages its own skills. The extension does not discover, validate,
select, or inject them. Pi children receive the parent's trust decision through
`--approve` or `--no-approve`, then Pi's native discovery loads user skills and
loads project skills only for trusted projects. External harnesses similarly use
the trust-gated configuration described above.

---

## Non-goals for Version 1

Deliberately absent: background execution (spawn ids, `wait`, `cancel`,
`status`), steering (`send`, resume), and predefined agent chains. Execution is
synchronous, and the parent model decides each delegation step.

---

## Version 1 acceptance criteria

| Criterion | Where it holds |
| --- | --- |
| Existing Pi agents work unchanged | `backends/pi.ts`, `runner.test.ts` |
| Profiles select `pi`, `claude`, or `codex` | `agents.ts`, `dispatch.test.ts` |
| Parent still uses only the `subagent` tool | `index.ts` |
| Backend config stays inside profiles | `index.ts` tool parameters |
| Claude agents run without permission prompts | `buildPermissionOptions` (always bypassed) |
| A Claude agent cannot spawn further agents | `buildClaudeOptions` (`tools` allowlist + `disallowedTools`) |
| A Codex agent cannot spawn further agents | `buildCodexAppServerArgs` (`multi_agent` and `multi_agent_v2` disabled) |
| `tools` is rejected rather than silently ignored on external harnesses | `parseTools` (pi-only field) |
| No configuration is loaded from an untrusted checkout | `buildClaudeOptions` (`settingSources: ["user"]` + `strictMcpConfig` when untrusted) |
| All backends return a common result | `SingleResult`, `createEmptyResult` |
| Pi skill discovery follows project trust | `buildPiArgs` (`--approve` / `--no-approve`, no skill flags) |
| Codex streams into the common result and can be cancelled | `backends/codex.ts`, `backends/codex.test.ts` |
| `/agents` discovery keeps working | `agents-command.ts` |

---

## Future direction

- **Background runs** — `subagent(action=run|status|wait|cancel)`.
- **Persistent sessions** — intentionally unsupported: every backend is an
  ephemeral one-shot and normalized results expose no native session identity.
- **Supervisor communication** — child agents requesting decisions from the
  parent.

The backend seam is the extension point for all three: each is a capability a
`SubagentBackend` either advertises or does not.
