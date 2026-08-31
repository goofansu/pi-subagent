# 9. Codex trust posture and environment inheritance

Date: 2026-08-26

## Status

Accepted. Codex execution details are refined by
[ADR-0011](0011-codex-app-server-migration.md) and
[ADR-0021](0021-retained-ephemeral-codex-conversation.md); the latter
supersedes this ADR's non-ephemeral Conversation consequence. This ADR's trust
posture and environment-inheritance decision remains in force.

## Context

The harness seam carries the session's resolved `projectTrusted` value into
every run (ADR-0007), but the existing Claude adapter deliberately does not
consult it and always bypasses permissions. Codex's non-interactive CLI cannot
answer an approval prompt, so it needs a posture before the child starts.
Codex also has operator configuration that is useful to a child, including
MCP servers and hooks. Isolating that configuration would make the Codex
harness behave unlike the operator's installed CLI and would require a second
configuration registry.

The Codex harness was added primarily as the trigger ADR-0007 anticipated: to
prove the seam's one-adapter cost with a real third backend, not to introduce
a new security posture.

## Decision

Every Codex App Server thread uses `approvalPolicy: "never"` and
`sandbox: "danger-full-access"`, regardless of the forwarded trust value —
parity with the Claude harness's unconditional bypass. The `projectTrusted`
value stays in the run request, forwarded but not consulted, reserved for a
future policy change that should arrive for the non-pi harnesses together
rather than one adapter at a time.

Every Codex Run starts a fresh `codex app-server` Attempt attached to the
adapter's non-ephemeral Conversation. Each child inherits the operator
environment and Codex user configuration. Configured MCP servers and hooks
remain available deliberately — the same inheritance rationale as ADR-0008.

The Codex adapter accepts `model` and `effort`. Model values are passed through
unvalidated for Codex to check. The shared seven-value effort scale maps
`off` to Codex's `none` and passes every other value through. Codex has no
per-run system-prompt append channel and no supported tool allowlist in this
adapter: `appendSystemPrompt` and `tools` are diagnostics. The Profile system
prompt initializes the Conversation on its first successful attachment.

## Considered alternative

A trust-consulting posture — trusted runs bypass, untrusted runs use
`-s read-only` — was designed, implemented, and then reverted before this
milestone shipped. Codex's sandbox flags make it the cheapest harness to
consult the forwarded value, and it worked. Rejected for now because the
operator wants one uniform posture across the non-pi harnesses: Codex exists
here to evaluate the seam, and a posture asymmetry between Claude and Codex
children is a behavioral difference profiles do not express. The reverted
implementation is the worked example when an untrusted-directory policy
arrives for every harness.

## Consequences

Codex children share Claude's sharp edge: an untrusted working directory
still gets a fully bypassing child, and the operator's Codex configuration is
part of a child run's capability surface that can change without any profile
changing. This is accepted and documented in the README, matching ADR-0008's
framing for Claude.

A Codex run is still one-shot and has no session files. Child processes
inherit `PI_SUBAGENT_DEPTH`, so shell children cannot restart delegation at
depth zero.

The Codex CLI remains responsible for validating model names and provider
support. The adapter's accepted profile fields intentionally do not promise a
`tools` or `appendSystemPrompt` feature that the CLI does not provide.

## Re-open triggers

Re-open this decision when an untrusted-directory policy is designed for the
non-pi harnesses (apply it to Claude and Codex together; the reverted
trust-consulting implementation is the starting point), if Codex exposes a
supported per-run instructions or tool-policy override, if profiles need
deterministic capability declarations outside one operator's machine, if the
CLI changes the meaning of its sandbox flags, or if ambient MCP servers or
hooks cause a child to exceed the intended capability surface.
