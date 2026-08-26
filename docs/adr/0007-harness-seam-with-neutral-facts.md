# 7. Harness seam with a neutral fact vocabulary

Date: 2026-08-25

## Status

Accepted. Supersedes the fact-vocabulary consequence of
[ADR-0005](0005-executor-reports-facts.md). [ADR-0010](0010-run-endings.md)
supersedes only the executor-resolution consequence inherited from ADR-0005;
this ADR's neutral-fact decision remains in force.

## Context

ADR-0005 deliberately let pi-ai's `Message` cross the executor seam while pi
was the only harness, and named a second harness actually being built as the
trigger to re-open it and design the domain fact vocabulary. That trigger has
fired: subagents are to run on the Claude Agent SDK and Codex CLI as well as
on child pi processes, with the orchestration core importing zero backend wire
types.

Today the pi wire shape is consumed above the seam in four places: the fold's
usage extraction in `run.ts`, the content-part narrowing in `messages.ts`,
`SingleResult.messages` in `types.ts`, and — transitively —
`presentation.ts`, whose notification text reads the stored transcript. Core
also speaks pi vocabulary on the input side: model resolution builds pi's
`provider/id` form and `effort` is pi's thinking scale.

## Decision

A **Harness** is a named backend (`pi`, `claude`, `codex`) that validates the
harness-owned parts of a profile (`model`, `effort`, `tools`,
`appendSystemPrompt` keep one name, harness-local meaning), resolves model and
effort in its own vocabulary, and supplies an **Executor** per run. Profiles
name their harness (frontmatter `harness`, default `pi`); the composition
root registers harnesses in a registry and core resolves the name without
branching on backend. Model inheritance from the parent session becomes pi
harness policy, not a core rule.

The fact vocabulary crossing the seam becomes a domain message type owned by
the run contract: a role, parts (text, tool call with name and arguments),
and usage, model, and stop reason in domain units. Each harness translates
its wire format into facts inside its own module — pi-ai `Message` never
leaves `pi-agent.ts`, `SDKMessage` never leaves the claude executor. The
reporter verbs are unchanged (`message`, `transcript`, `stderr`);
`transcript` remains an optional terminal-snapshot correction: Pi uses it for
its terminal message list, while a harness without such a wire snapshot may
omit it and must not fabricate one. Derivation (activity, final output) stays
in the fold — the ADR-0005 single-derivation-site property is kept; only the
wire knowledge moves out.

Input/output/cache counters, turns, and cost on a fact are **additive
deltas**; the shared fold sums them. `contextTokens` is a latest-value gauge,
so the fold replaces it with the newest reported context size. A harness that
only knows totals reports one usage-bearing fact, and never reports the same
run's usage both per-message and cumulatively.

The claude harness executes via `@anthropic-ai/claude-agent-sdk`'s `query()`
rather than spawning the CLI and re-parsing stream-json. The run's existing
`AbortSignal` drives the SDK abort. The adapter resolves to an ending, with
cancellation normalized to the `cancelled` ending before it reaches the
domain result; SDK stderr feeds `report.stderr`. Claude children always run
with permissions bypassed in this version — trust is still forwarded in the
request but not yet consulted —
and have their agent-spawning tool disallowed so the Depth constraint holds.
One-shot children (ADR-0003) bind every harness: one-shot is a property of
Run.

## Considered alternative

A semantic event stream (`assistant-text`, `activity`, `usage`,
`diagnostic`) instead of a message-shaped fact. Rejected: it deletes the
stored transcript that presentation, the result store, and the widget feed
on, forces a separate channel for final output, and duplicates activity
derivation into every harness.

## Consequences

Core tests run against a fake harness without importing any backend wire;
the four test files that fabricate pi-ai messages via casts switch to domain
fact builders. Adding a backend is one adapter module, one registry entry,
and its own tests — no dispatcher or lifecycle changes.

The accepted sharp edge: an untrusted working directory still gets a
fully-bypassing claude child. The trust value flows through the request so a
later version can consult it without reshaping the seam.

Deliberately lossy: provider-specific detail (content-block ids, permission
denials, session ids) stays behind the harness. Growing the fact type toward
the union of every backend's message shape is the failure mode this ADR
exists to prevent.
