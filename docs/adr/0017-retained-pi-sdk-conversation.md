# 17. Pi retains one safe in-process SDK Conversation

**Status:** Accepted.

## Context

The one-shot Pi CLI preserved isolation but could not accept guidance after
startup or retain semantic context for a later Run. Reusing that process model
would either expose a Pi-specific control channel to core or pretend resume was
possible by replaying transcript history.

## Decision

One prepared Pi adapter lazily creates one in-process `AgentSession` and owns it
until Session shutdown. Construction preserves normal Pi resources and project
trust, uses memory-only session storage, binds extensions in headless `print`
mode, denies every orchestration tool, filters this package by package identity,
and replaces Bash only to inject `PI_SUBAGENT_DEPTH` per spawn. Because Pi
initializes extension factories before applying the child resource filter, an
adapter-owned asynchronous load context makes this extension's child factory
invocation inert without suppressing parent reattachment on reload, new,
switch, or fork.

Every Run owns a fresh event subscription, transcript/usage baseline, reporter,
AbortSignal, and one serial FIFO Control consumer. Native steering success is
not transcript truth; only provider user-message events are. Cancellation
closes admission, discards local and native queues, aborts, and waits for idle.
Earlier session messages remain provider context but are not emitted or charged
again. The retained session is shut down with a bounded extension event and is
disposed exactly once.

## Consequences

Pi now truthfully supports Session-scoped steering and Resume while every Run
still has one goal, lifecycle, Result, notification, and accounting fold. The
idle resource is an SDK session rather than a child process. Cross-Session
resume, persistence, concurrent prompts, provider identity in core, and nested
delegation remain unsupported. This deliberately gives up process crash
isolation: an extension that crashes synchronously executes in the host process,
so adapter boundaries catch ordinary initialization, binding, prompt, steering,
and cleanup failures, but cannot recover from a fatal runtime crash.
Removing the former CLI path does not add process isolation. Future isolation
would require a purpose-built child SDK protocol that preserves retained-session
resume and steering semantics.
