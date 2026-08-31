# 21. Retain one ephemeral Codex Conversation per Subagent

Date: 2026-08-31

## Status

Accepted. This ADR supersedes only the obsolete Codex process-lifetime,
thread-persistence, and continuation-attachment consequences of
[ADR-0009](0009-codex-trust-posture-and-environment-inheritance.md),
[ADR-0011](0011-codex-app-server-migration.md),
[ADR-0015](0015-codex-conversation-across-disposable-attempts.md), and
[ADR-0016](0016-codex-resume-release-contract.md). Their App Server protocol,
provider-identity confinement, ordered steering and cancellation,
one-Conversation, one-Run/one-Result, and parent-Session ownership decisions
remain in force.

## Context

Disposable App Server processes required a stored provider thread and native
continuation attachment. That design left a private rollout listable outside
the Subagent and could interfere with Codex Desktop. The App Server instead
supports multiple sequential Turns on one client-created ephemeral root while
one stdio process remains alive.

Resume admission also needs to distinguish a Harness that never offered Resume
from a previously usable process-local Conversation that has been destroyed.
A boolean capability cannot make that distinction atomically with preparation
of the next Run.

## Decision

One prepared Codex adapter owns one App Server process and one ephemeral,
client-created root Conversation. The process and root are retained while the
Subagent is idle and close only at parent Session shutdown or terminal process
or transport loss. The first Run initializes the connection, creates the root
with `ephemeral: true`, and starts the first Turn. Every later Run starts a new
Turn on that same root. Production performs no live-session `thread/resume`.

Every Run owns a fresh Turn-scoped Attempt: translator, ordered reducer,
Control correlations, accounting delta, Activity, reporter, Ending, Result,
and Notification. Matching `turn/completed` settles that Attempt after its
ingress has been reduced; it does not close a healthy retained process. Late
events cannot enter a later Attempt or mutate a terminal Result.

The Harness adapter synchronously admits Resume with exactly one of three
neutral outcomes: an admitted prepared Run, unsupported, or Conversation loss.
Admission performs no provider I/O. The manager claims admission before asking
the adapter, so concurrent calls have one winner. Unsupported means the
Harness never offered Resume. Conversation loss means provider semantic
context that was available to this Subagent is irrecoverably gone.

Conversation loss is monotonic. Loss known at admission creates no Run,
Notification, provider request, or provider work. Loss after admission belongs
to the admitted Run, which fails once with retained partial output and bounded,
redacted diagnostics. A terminal answer reduced before loss remains
authoritative and immutable. A failed or successfully interrupted Turn does
not itself imply loss while the process reaches a healthy terminal state;
signal escalation that destroys the process does.

The adapter never creates a replacement Conversation, replays prompts, Facts,
Results, or Notifications, attaches to a durable thread, or claims continuity
after loss. Recovery is a new Subagent. There is no idle expiry, heartbeat,
speculative watchdog, automatic Turn timeout, or public manual-close operation.
Explicit cancellation and bounded interrupt/process escalation remain the
liveness mechanism.

Ephemeral means the client-created root has no stored/listable rollout. It does
not mean zero shared-home I/O, and it does not prohibit provider-native child
threads or tool processes. Auth, configuration, logs, plugins, MCP startup, and
other process-global services may still use shared resources.

## Consequences

N idle Codex Subagents may retain N App Server processes until Session
shutdown. Process loss sacrifices recovery in exchange for honest semantic
continuity, provider-identity confinement, and a root that Codex Desktop cannot
list or attach to as stored history.

The retained lifecycle is accepted architecture but not a completed release
claim. Release still requires the pinned-CLI authenticated repeated-Turn smoke,
complete process-tree cleanup evidence, and a recorded human Codex Desktop
coexistence pass before, while idle, during an overlapping later Turn, and
after Session cleanup.
