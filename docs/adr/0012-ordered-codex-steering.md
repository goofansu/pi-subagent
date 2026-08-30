# 12. Ordered Codex steering stays inside the one-shot adapter

Date: 2026-08-29

## Status

Accepted. Supersedes ADR-0003 only where it ruled out guidance during a
running child; the one-shot Run and absence of idle resume remain in force.
ADR-0013 supersedes only this ADR's claim that no stable Subagent identity
exists. Refines ADR-0011's Codex ordering and provider-identity decisions.

## Context

The shared One-shot protocol historically decided answer-before-cancellation
at its sink: a terminal event reported before abort could answer, while one
reported after abort could not. Codex App Server now has more than a translated
event stream. Provider notifications, locally admitted Controls, cancellation,
JSON-RPC responses, process outcomes, and escalation timers all affect one
active semantic Turn, and asynchronous translation or request continuations can
otherwise reorder occurrences that already entered the same connection.

Native `turn/steer` can also be refused even though the original Turn remains
healthy and later answers. Treating that refusal as a `RunEnding` would let an
optional correction erase useful work. Correlation needs thread, Turn, item,
request, and client-message ids, but exposing those ids would make a neutral
one-shot Run look like a persistent provider session.

## Decision

Codex owns one ordered Run engine inside its adapter. A complete provider
message, Control, cancellation request, process outcome, or escalation outcome
receives stable ingress order before asynchronous interpretation. The engine
alone settles the source. This is a deliberate Codex-owned refinement outside
the older sink-timing rule: the shared seam still receives Facts, Activity,
`AbortSignal`, a Control stream, and one `RunEnding`; no provider ordering type
or runtime framework crosses it.

Steering admission and steering rejection are independent of `RunEnding`.
`accepted` means bounded local admission only. A server-authored refusal may
produce one bounded redacted diagnostic, but cannot by itself answer, fail, or
cancel the Run. Semantic completion preserves its answer when it races a
Control response, and cancellation preserves cancellation.

All provider identity remains adapter-local. Codex correlates an admitted
Control with an authoritative provider `userMessage` item and emits one neutral
user Fact containing only provider-confirmed text. Thread, Turn, item, request,
session, and client-correlation ids never enter Facts, Results, presentation,
or a resume surface.

## Consequences

Codex may accept guidance during its one active Turn while Pi and Claude remain
truthfully unsupported. At this decision, Runs were still the only identity:
there was no stable Subagent distinct from the Run id, no retained idle child,
and no `agent_resume` or provider-session handle. ADR-0013 later adds the local
Subagent identity and retains an adapter, but still no idle child, resume
operation, or provider-session handle.

Harness Conformance can test capability rather than adapter names. Deterministic
fixtures control ingress directly and repeat terminal and cancellation races;
they do not sleep or retry until green. ADR-0013 later adds a stable local
Subagent above the one-shot Run and retains its adapter while idle, without yet
adding resume or exposing provider identity. A live pinned-CLI smoke remains
part of the release gate because generated schemas and fake transports cannot
prove provider consumption.
