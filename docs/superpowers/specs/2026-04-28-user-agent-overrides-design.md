# User Agent Overrides Design

## Goal

Load user-defined subagents from Pi's agent directory and let them override bundled `pi-subagent` agents with the same name.

## Approach

Use Pi's exported `getAgentDir()` as the source of the user configuration directory. The subagent extension will load bundled agents first, then load agents from `path.join(getAgentDir(), "agents")`, merging the user map last so same-name entries replace bundled entries.

## Components

- `extensions/subagent/agents.ts`
  - Keep `parseAgentConfig`, `getDefaultAgentsDir`, and `loadAgentConfigs`.
  - Add a merge helper that accepts a base agents directory and an override agents directory.
  - The helper returns all bundled agents plus all user agents, with user agents taking precedence by agent name.
- `extensions/subagent/index.ts`
  - Import `getAgentDir` from `@mariozechner/pi-coding-agent`.
  - Initialize `agentConfigs` with bundled agents and `${getAgentDir()}/agents` as overrides.

## Error Handling

Missing bundled or user directories continue to behave like `loadAgentConfigs`: they contribute no agents and do not throw.

## Testing

Add tests in `extensions/subagent/agents.test.ts` for:

- user agents override bundled agents with the same file/name
- bundled agents remain available when not overridden
- user-only agents are included
- missing override directories are harmless
