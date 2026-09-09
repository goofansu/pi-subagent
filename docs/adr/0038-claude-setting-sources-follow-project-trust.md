# 38. Claude setting sources follow project trust

Date: 2026-09-09

## Status

Accepted. Supersedes ADR-0007's statement that Claude forwards Trust without
consulting it and ADR-0008's decision to inherit project and local Claude
settings unconditionally. Claude's unconditional permission bypass remains in
force. ADR-0008's rationale remains in force for trusted directories and for
the operator's user environment in every directory.

## Context

Pi resolves Trust once for the Session working directory and passes that fixed,
provider-neutral fact in `SubagentContext`. The Pi adapter already applies it
when loading settings and resources, but the Claude adapter omitted
`settingSources` for every Query. That omission gives the SDK its normal Claude
Code behavior: user, project, and local settings are all loaded, including
project instructions and project `.mcp.json` configuration. Together with
unconditional `bypassPermissions`, an untrusted project could therefore add
instructions and tools to a Claude child without the operator approving that
project.

The policy must retain the reason ADR-0008 chose inheritance: a Claude child is
useful in part because it has the operator-owned Claude environment, including
user settings, MCP servers, and cloud connectors. Trust is an input-loading
choice, not a claim that the child is isolated from the working tree or other
ambient capabilities.

## Decision

The Claude adapter selects setting sources from the fixed Trust fact each time
it builds options for a Query:

- In a **trusted** directory it omits `settingSources`, preserving normal
  user, project, and local Claude inheritance.
- In an **untrusted** directory it passes `settingSources: ["user"]`. User-owned
  settings, MCP configuration, and connectors remain available, while project
  and local settings, project instructions loaded through those sources, and
  project `.mcp.json` are excluded.

The adapter owns this policy; the backend contract continues to carry only the
neutral Trust fact. Selection is recomputed for every Query from the fixed
Subagent context, so resumed Runs neither re-resolve Trust nor retain a
Run-local options decision.

Permissions remain bypassed. Trust does not govern filesystem, shell, network,
or permission access and is not a sandbox boundary.

## Considered alternatives

**SDK isolation with `settingSources: []`** was rejected because it removes the
operator's user settings along with project-owned input. That defeats the
intentional Claude Code environment inheritance retained from ADR-0008.

**Strict MCP configuration** was rejected because it would remove ambient user
MCP configuration and require an explicit second capability registry. Selecting
the user setting source directly excludes project-owned MCP configuration while
preserving the environment the operator already maintains.

## Consequences

A trusted Claude child has the same inherited setting surface recorded by
ADR-0008. An untrusted Claude child has a narrower input surface, but still has
user-configured MCP servers and connectors and still executes without permission
prompts. Profiles can therefore continue to understate ambient user-owned
capabilities, and users must not treat an untrusted Run as confined execution.
