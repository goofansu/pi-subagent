# 1. Unbounded subagent concurrency

Date: 2026-08-23

## Status

Accepted.

## Context

The extension previously held every run to a process-wide cap of four, with a
queue in `concurrency.ts` admitting waiters as slots freed. The cap protected
local resources: each slot is a child pi process, not a coroutine, and pi's
agent defaults `toolExecution` to `"parallel"`, so a turn emitting five tool
calls really does start five children at once.

Moving to fire-and-forget delegation (`agent_start`) changed what a queue means.
The model receives a run id immediately and treats the run as started. A queued
run is therefore a receipt for work that is not running: the widget shows a row
doing nothing, `agent_wait` blocks on a child that has not spawned, and the
model's model of the world is wrong in a way it cannot detect.

A cap with immediate refusal instead of queueing was considered. It keeps the
resource bound and stays honest, at the cost of a failure path the model has to
understand and handle.

## Decision

No cap. `agent_start` always spawns. `concurrency.ts` and its tests are deleted,
along with the `queued` lifecycle status, `queuedAt`, `markResultRunning`, and
the queued-state guards in `settleResultLifecycle`.

The bound is now the operator's judgement, made visible: the widget shows a
running total so the cost of a wide fan-out is on screen rather than implied.

## Consequences

Nothing prevents a model from accumulating many child pi processes across turns.
This is accepted deliberately in exchange for deleting an entire lifecycle state
from every module that reasons about runs.

Do not re-introduce a limiter without also deciding what a queued run means to a
model that has already been told its run started. That question, not the
resource bound, is what made the queue untenable.
