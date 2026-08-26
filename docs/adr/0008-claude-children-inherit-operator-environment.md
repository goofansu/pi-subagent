# 8. Claude children inherit the operator's Claude Code environment

Date: 2026-08-26

## Status

Accepted.

## Context

The claude harness builds its SDK options without `settingSources` and
without `mcpServers`. What that means was established empirically against
the installed `@anthropic-ai/claude-agent-sdk`:

- When `settingSources` is omitted, the SDK loads **all** filesystem
  settings — user, project, and local — matching CLI defaults. (Earlier SDK
  versions documented isolation as the default; the installed one does not.)
- A live child was probed twice for its own toolset. With no MCP servers
  configured on the machine, it saw only built-ins. After one user-scoped
  server was registered via `claude mcp add`, the child listed that server's
  `mcp__*` tools — and the operator's claude.ai **cloud connectors** (Google
  Calendar, Google Drive, and the rest of the account's connectors) appeared
  as well.
- Connector attachment was not identical between runs: the ambient toolset
  can vary with account state and fetch timing.

Combined with the harness's unconditional `bypassPermissions` (ADR-0007),
this means a claude child can call any tool the operator's machine and
account provide — including write-capable connector tools — without
prompting, and a profile's frontmatter does not reveal that surface.

The obvious "fix" was designed and considered: pass `settingSources: []`
for deterministic isolation, and add a claude-owned `mcpServers` frontmatter
field as a per-profile opt-in resolved from Claude Code's own registry,
keeping the profile the sole statement of a child's capabilities.

## Decision

Keep the inheritance. The claude harness continues to omit `settingSources`
and `mcpServers`, so claude children see whatever tools, MCP servers, and
connectors the operator's Claude Code environment has — deliberately.

The operator's rationale: different harnesses exist precisely to bring
different toolsets to the work. "A claude child works with my Claude Code
environment" is the feature being bought; per-profile capability declaration
would recreate, in frontmatter, configuration the operator already maintains
in Claude Code itself. The isolation + opt-in design adds a second registry
and a second thing to keep in sync, and is not wanted now.

What still holds regardless of inheritance: `disallowedTools: ["Agent",
"Task"]` is always forced (Depth binds every harness), and the profile's
`tools` field still narrows the built-in set when present.

## Consequences

A claude profile's frontmatter understates the child's real capability
surface: MCP servers and cloud connectors ride in from the environment, they
can change without any profile changing, and they execute unprompted under
`bypassPermissions`. This is accepted, documented in the README, and owned
by the operator: registering an MCP server in Claude Code is understood to
also grant it to every claude-harness subagent.

The child's toolset is not fully deterministic — connector auto-fetch varies
with account state. Tests must therefore never assert the ambient toolset,
only the options the harness sets.

Re-open this when subagent profiles need to be shared beyond a single
operator's machine, when an untrusted-directory policy arrives for the trust
value already carried in the request, or if a child misusing an ambient
connector actually bites. The rejected design (deterministic
`settingSources: []` plus a `mcpServers` opt-in field resolved from Claude
Code's registry) is the starting point then.
