# Subagent Extension Refactor Design

## Goal

Refactor the subagent extension for maintainability and testability while preserving behavior. Small behavior-preserving cleanups are allowed when they reduce complexity.

## Approach

Use a testability-first module extraction. Keep the extension's public behavior stable, but split the current monolithic `extensions/subagent/index.ts` into focused modules with clear responsibilities and targeted tests for pure logic.

## Module structure

```text
extensions/subagent/
  index.ts        # extension registration only
  types.ts        # shared interfaces/types
  formatting.ts   # token/usage/tool-call formatting
  messages.ts     # message traversal helpers
  agents.ts       # AgentConfig parsing/loading for all agents
  runner.ts       # spawning pi, temp prompt file handling, streaming updates
  render.ts       # renderCall/renderResult UI logic
  *.test.ts       # node:test coverage for pure modules
```

## Responsibilities

- `index.ts` registers the `/subagent` command and `subagent` tool, wires modules together, and owns no low-level helper logic.
- `types.ts` exports `UsageStats`, `SingleResult`, `SubagentDetails`, `DisplayItem`, `AgentConfig`, and callback/result types shared between modules.
- `formatting.ts` exports formatting helpers such as `formatTokens`, `formatUsageStats`, and `formatToolCall`.
- `messages.ts` exports helpers that derive final output and display items from pi messages.
- `agents.ts` exports `parseAgentConfig`, `loadAgentConfigs`, and a default agents-directory resolver if useful.
- `runner.ts` owns prompt temp-file creation, pi invocation construction, process spawning, streaming JSON event parsing, cleanup, and abort handling.
- `render.ts` owns TUI rendering for the tool call and tool result.

## Testing

Use the existing test command:

```sh
node --import tsx --test
```

Add focused tests for pure behavior:

- token and usage formatting
- tool-call formatting with a small theme stub where practical
- final assistant output extraction
- display item extraction
- agent frontmatter parsing using temporary markdown fixtures
- loading all agents from a temporary directory

Avoid direct process-spawn integration tests in this refactor unless they become straightforward, because mocking process lifecycle would add risk and complexity.

## Error handling and behavior preservation

- Preserve current unknown-agent errors, subagent failure reporting, abort behavior, and rendering states.
- Keep temp prompt files private (`0o600`) and cleanup best-effort.
- Keep lazy/initial config loading behavior equivalent to today unless a test exposes an issue.

## Success criteria

- `index.ts` is small and orchestration-focused.
- Extracted modules have clear imports and no circular dependencies.
- `npm test`, `npm run typecheck`, and `npm run lint` pass.
- Added tests cover key pure functions without adding dependencies.
