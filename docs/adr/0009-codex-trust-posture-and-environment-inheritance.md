# 9. Codex trust posture and environment inheritance

Date: 2026-08-26

## Status

Accepted.

## Context

The harness seam carries the session's resolved `projectTrusted` value into
every run (ADR-0007), but the existing Claude adapter deliberately does not
consult it and always bypasses permissions. Codex's non-interactive CLI cannot
answer an approval prompt, so it needs a posture before the child starts.
Codex also has operator configuration that is useful to a child, including
MCP servers and hooks. Isolating that configuration would make the Codex
harness behave unlike the operator's installed CLI and would require a second
configuration registry.

## Decision

The Codex adapter consults `projectTrusted` up front:

- trusted runs use `--dangerously-bypass-approvals-and-sandbox`;
- untrusted runs use `-s read-only`.

Every Codex child runs `codex exec --json --ephemeral`; ephemeral mode avoids
session files for one-shot runs. The child inherits the operator environment
and Codex user configuration. The adapter does not pass an ignore-user-config
flag, so configured MCP servers and hooks remain available deliberately.

The Codex adapter accepts `model` and `effort`. Model values are passed through
unvalidated for Codex to check. The shared seven-value effort scale maps
`off` to Codex's `none` and passes every other value through. Codex has no
per-run system-prompt append channel and no supported tool allowlist in this
adapter: `appendSystemPrompt` and `tools` are diagnostics. The profile system
prompt is prepended to the stdin prompt.

## Consequences

Codex has a posture that follows the parent session's trust decision, unlike
Claude's intentionally unconditional bypass. This makes an untrusted Codex
run conservative while preserving Claude's existing policy and ADR.

The operator's Codex configuration is part of a child run's capability surface
and can change without a profile changing. A Codex run is still one-shot and
has no session files. Child processes inherit `PI_SUBAGENT_DEPTH`, so shell
children cannot restart delegation at depth zero.

The Codex CLI remains responsible for validating model names and provider
support. The adapter's accepted profile fields intentionally do not promise a
`tools` or `appendSystemPrompt` feature that the CLI does not provide.

## Re-open triggers

Re-open this decision if Codex exposes a supported per-run instructions or
tool-policy override, if profiles need deterministic capability declarations
outside one operator's machine, if the CLI changes the meaning of its trust
flags, or if ambient MCP servers or hooks cause a child to exceed the intended
capability surface. Revisit Claude's unconditional policy separately if the
untrusted-directory policy carried since ADR-0007 becomes a shared harness
requirement; Codex is the worked example for that future posture change.
