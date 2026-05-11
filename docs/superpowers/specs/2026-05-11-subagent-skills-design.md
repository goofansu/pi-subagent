# Subagent Skills Support

## Overview

Add a `skills` field to agent frontmatter that accepts comma-separated skill names. When specified, the child pi process gets `--no-skills` (suppressing auto-discovery) plus `--skill <path>` for each resolved skill. When omitted, the child discovers skills normally (current behavior).

## Behavior

| Frontmatter | Child pi receives |
|---|---|
| `skills:` omitted | Normal auto-discovery (no change from today) |
| `skills: safe-bash, tdd` | `--no-skills --skill /path/to/safe-bash/SKILL.md --skill /path/to/tdd/SKILL.md` |

The child pi process handles skills natively — name + description + location in its system prompt, model reads full content on demand via `read` tool.

## Changes by File

### `extensions/subagent/types.ts`

Add `skills?: string[]` to `AgentConfig`.

### `extensions/subagent/agents.ts`

- Parse `skills` from frontmatter as optional comma-separated string → trimmed `string[]`.
- Add `validateAgentSkills(configs, cwd)` function:
  - Accepts the loaded agent configs and the current working directory.
  - Uses pi's `loadSkills()` from `@earendil-works/pi-coding-agent` with `includeDefaults: true` to discover all available skills.
  - For each agent with `skills` defined, checks that every name exists in the discovered set.
  - Returns an array of warning strings for missing skills, e.g. `"Agent 'worker': skills not found: nonexistent-skill"`.

### `extensions/subagent/runner.ts`

- Add `resolveSkillPaths(skillNames, cwd)` function:
  - Uses pi's `loadSkills()` to discover all skills.
  - Maps each name to its `filePath`.
  - Returns `{ resolved: Array<{ name: string; path: string }>, missing: string[] }`.
- Modify `buildPiArgs`:
  - Accept optional `skillPaths?: string[]` parameter.
  - When `skillPaths` is provided (even if empty): push `--no-skills`, then `--skill <path>` for each entry.
  - When `skillPaths` is undefined: no skill flags (current behavior).
- Modify `runSingleAgent`:
  - If `config.skills` is defined, call `resolveSkillPaths`.
  - If any skills are missing, throw an error: `"Cannot run agent '<name>': skills not found: <missing>"`.
  - Pass resolved paths to `buildPiArgs` via the new `skillPaths` parameter.

### `extensions/subagent/index.ts`

- After loading agent configs at startup, call `validateAgentSkills(agentConfigs, cwd)`.
- For each warning returned, emit via `ctx.ui.notify(warning, "warning")`.

## Agent Frontmatter Example

```yaml
---
description: Implementation agent
skills: safe-bash, tdd
---

You are an implementation agent...
```

## Skill Resolution

Resolution uses pi's `loadSkills()` from `@earendil-works/pi-coding-agent`. This searches all standard skill locations:

- `.pi/skills/` (project)
- `~/.pi/agent/skills/` (user)
- `~/.agents/skills/` (user)
- Package `pi.skills` entries
- Settings `skills` arrays

Skills are matched by name (the `name` field from the skill's frontmatter, or the parent directory name for `SKILL.md` files).

## Error Handling

- **Startup**: warn per agent — `"Agent 'worker': unknown skills: nonexistent-skill"`. Does not prevent agent from being listed or used.
- **Runtime**: fail the tool call with thrown error — `"Agent 'worker': unknown skills: nonexistent-skill"`. Child process is not launched.

## Scope Boundaries

- No per-invocation `skills` override on the tool call (frontmatter only).
- No `inheritSkills` toggle. Behavior is implicit: `skills` defined = exclusive mode, `skills` omitted = normal auto-discovery.
- No skill content injection into the system prompt. Pi handles skills natively via its progressive disclosure mechanism.
