# 12. Ordered Codex steering stays inside the one-shot adapter

Date: 2026-08-29

## Status

Accepted. Supersedes ADR-0003 only where it ruled out guidance during a
running child; the one-shot Run remains in force. ADR-0014 and ADR-0016
supersede the absence of idle resume, while ADR-0017 and ADR-0018 extend
ordered steering to Pi and Claude without changing Codex's reducer.
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
`AbortSignal`, a Control source, and one `RunEnding`; no provider ordering type
or runtime framework crosses it. The source has one synchronous subscriber:
an accepted admission reaches that subscriber before its offer returns and
remains bounded until the executor acknowledges or discards it.

The subscriber records each Control as an occurrence in that same ordered
Attempt reducer. The reducer retains pre-identity Controls until the active
thread and Turn are safe, owns the serial pending/in-flight steering state, and
is the only code allowed to initiate `turn/steer`. There is no asynchronous
Control pump or direct steering side channel. When an active Turn is ready, an
accepted Control is reduced and initiates `turn/steer` before a synchronously
later cancellation can initiate `turn/interrupt`; cancellation-first closes
admission, and pre-identity cancellation may discard an already ordered but
unsent Control. Once native steering has been sent, cancellation closes only
admission: its provider correlation remains live until Attempt settlement or
failure so a later provider-confirmed user item remains transcript truth.

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

At this decision, Codex could accept guidance during its one active Turn while
Pi and Claude were unsupported. Runs were still the only identity:
there was no stable Subagent distinct from the Run id, no retained idle child,
and no `agent_resume` or provider-session handle. ADR-0013 later adds the local
Subagent identity and retains an adapter, but still no idle child, resume
operation, or provider-session handle.

Harness Conformance can test capability rather than adapter names. Deterministic
fixtures use the real Control gate and fake App Server to repeat both
Control-first and cancellation-first order for first and resumed Attempts at
least 32 times with explicit Turn latches; they do not sleep or retry until
green. Late steering-response races remain separate from that admission-order
law. ADR-0013 later adds a stable local
Subagent above the one-shot Run and retains its adapter while idle, without yet
adding resume or exposing provider identity. A live pinned-CLI smoke remains
part of the release gate because generated schemas and fake transports cannot
prove provider consumption.
