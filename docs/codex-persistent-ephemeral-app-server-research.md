# Persistent ephemeral Codex App Server research

**Status: historical.** Implemented by
[ADR-0021](adr/0021-retained-ephemeral-codex-conversation.md), and every
"current" code description below records the *pre-implementation* baseline —
the 1.x Codex harness, which was deleted at M7. The modules it names are gone
and are left as plain names rather than links, because there is nothing to link
to; [the deletion ledger](v2/deletion-ledger.md) says what replaced each of
them.

The normative sources for how Codex works now are ADR-0021,
[the architecture note](architecture.md), and [the glossary](../CONTEXT.md).
This document is kept for the research it records: it is where the question was
answered, and the answer is why the adapter is shaped as it is.

## Question

Can the Codex harness use one `codex app-server` process for each Session-scoped
Subagent, create one ephemeral root thread, and execute the first and resumed
Runs as sequential `turn/start` calls on that thread?

## Verdict

**Yes. This is supported by Codex CLI 0.150.1 and is a better fit for the
project's existing Session-scoped adapter seam than the current disposable
App Server Attempt design.**

Adopt it with these boundaries:

- one stdio App Server connection per Codex `HarnessAdapter`;
- one client-created root `thread/start` with `ephemeral: true`;
- exactly one active `turn/start` per adapter;
- one fresh Run-local reducer/translator/Result for every turn;
- no `thread/resume` while the process lives;
- process and thread death are conversation loss, not transparent recovery;
- adapter shutdown owns interruption, stdin closure, and bounded kill
  escalation.

This removes the persisted rollout that currently makes the private Codex
conversation visible to other Codex clients and can retain a per-thread writer.
It does **not** mean the Codex process performs no shared-home I/O at all: it
still reads shared auth/configuration, can initialize shared services, and some
App Server operations can update user configuration. The precise claim is
"no persisted/listable rollout or per-thread persistence attachment for this
root thread," not "zero writes under `CODEX_HOME`."

## Evidence from the pinned Codex release

The repository's generated protocol snapshot targets `codex-cli 0.150.1`
([`docs/codex-protocol/README.md:3`](codex-protocol/README.md)), and the locally
installed binary reports the same version. The source references below are
pinned to the immutable commit behind OpenAI's `rust-v0.150.1` tag,
`90854393966b21e9ebfd21b122334eb09a20c93d`.

### 1. The connection and thread are intended to survive multiple turns

OpenAI's lifecycle says to initialize once per connection, start or resume a
thread, call `turn/start` with that thread ID, stream notifications, and wait
for `turn/completed` ([App Server README lines 76-83][codex-lifecycle]). This is
the exact lifecycle option 1 needs.

The pinned integration suite makes the contract concrete. It starts one
thread, completes one turn, then sends a second `turn/start` with the same
`thread.id`; each turn has a distinct ID and reaches `turn/completed`
([turn-start test lines 1686-1787][codex-two-turn-test]). No `thread/resume` or
second App Server process is involved.

### 2. `thread/start` supports an ephemeral thread

`ThreadStartParams` includes `ephemeral: Option<bool>`
([protocol source lines 100-116][codex-thread-params]); the checked-in generated
request schema also contains the nullable boolean
([`docs/codex-protocol/ClientRequest.json:4988`](codex-protocol/ClientRequest.json)).
The App Server README defines an ephemeral thread as intentionally in-memory
only and says its returned `thread.path` is `null`
([README lines 78-83][codex-lifecycle]).

The pinned test `thread_start_ephemeral_remains_pathless` sends
`ephemeral: true` and asserts both `thread.ephemeral === true` and
`thread.path === None`
([thread-start test lines 1071-1114][codex-ephemeral-test]).

The implementation goes further than a response flag:

- it propagates `ephemeral` into the thread configuration
  ([thread processor lines 1168-1174][codex-thread-config]);
- it does not reserve/stage persisted project metadata for an ephemeral thread
  ([thread processor lines 1399-1409][codex-thread-stage]);
- Core skips creation of the persistent `LiveThread`
  ([session lines 843-852][codex-thread-persistence]);
- Core also skips the thread's state-database attachment
  ([session lines 937-946][codex-thread-state-db]);
- consequently, `SessionConfigured.rollout_path` is `None`
  ([session lines 1000-1004][codex-rollout-path]).

Therefore another Codex process, including Desktop, has no rollout path or
stored thread record through which to discover/resume this private root thread.
The state remains usable only through the process that owns the loaded thread.

### 3. Keeping the stdio process alive is valid

The protocol's "initialize once per connection" rule means a client should not
repeat the handshake for each turn. In stdio mode, closing the connection is
what tells the single-client server to leave its main loop
([App Server source lines 1019-1040][codex-stdio-close]). Its normal shutdown
path drains connection/background work and calls `shutdown_threads()`
([lines 1180-1189][codex-shutdown-threads]).

So the harness should stop closing stdin after every Run. It should close stdin
once, from `HarnessAdapter.close()`, after interrupting an active turn if
necessary. Existing SIGTERM/SIGKILL escalation remains a fallback for bounded
shutdown.

### 4. Turns on one thread must be serialized by the client

The project already enforces the right admission rule: an active Subagent
rejects resume instead of queueing it
([`CONTEXT.md:26-29`](../CONTEXT.md),
`docs/runtime-invariants.md`, since replaced by [the architecture note](architecture.md)). Preserve that
rule at the transport layer too.

This is more than defensive programming. In the pinned Codex suite, a second
`turn/start` sent while a turn is active is accepted as steering and returns
the active turn ID
([turn-start test lines 315-384][codex-active-turn-test]). Accidentally issuing
a resumed Run early could therefore merge its prompt into the previous Run and
break Result identity. Do not rely on App Server rejection; gate on the prior
`turn/completed` and the Run's completed settlement.

## Fit with this repository

### Existing seam already has the required lifetime

The Subagent manager creates one adapter, retains it while the Subagent is idle,
and closes it only on Session shutdown
(`extensions/subagent/subagents.ts:115-176`,
`extensions/subagent/subagents.ts:223-255`).
`HarnessAdapter.close()` is explicitly the release point for adapter-owned
provider state
(`extensions/subagent/harnesses/contract.ts:31-44`).
No manager-level redesign is needed to retain a Codex process.

### Pre-implementation Codex transport lifetime was the part that changed

Before ADR-0021, each `prepareRun().execute()` called `runCodexAppServer()`
(`extensions/subagent/harnesses/codex/harness.ts:408-467`).
That function:

- spawns `codex app-server` for the Run
  (`app-server.ts:732-758`);
- starts a durable thread with `ephemeral: false`
  (`app-server.ts:610-621`);
- uses `thread/resume` on later Runs
  (`app-server.ts:1169-1178`);
- closes stdin or escalates process signals as that Run settles
  (`app-server.ts:910-1002`).

The adapter retains only the thread ID and cumulative usage baseline between
Runs (`harness.ts:386-445`). Consequently, changing only `ephemeral: false` to
`true` would fail: the first Run would kill the only process that can still see
the ephemeral thread, and the second process could not resume it.

The necessary change is a **lifetime split**, not a flag flip.

## Recommended design

### Process-scoped owner

Create a Codex session/client owned by `createCodexHarness().prepare(...)`. It
owns:

- the child process and stdio framing;
- one initialization handshake;
- monotonically unique JSON-RPC request IDs and pending-request correlation;
- one ephemeral root thread ID;
- the single stdout notification loop;
- the cumulative token-usage baseline;
- active-turn admission and the terminal process-failure state;
- idempotent adapter shutdown and kill escalation.

A useful internal state model is:

```text
unstarted -> starting -> idle <-> turning -> closing -> closed
                         |         |
                         +-------> failed
```

Spawn lazily on the first `execute()` or eagerly during adapter preparation;
either works. Lazy spawn avoids creating a process if dispatch fails before the
executor starts. In the normal path, one adapter must call spawn exactly once.

### Run-scoped turn owner

Keep these objects fresh for every Run:

- translator maps and item tails;
- reporter and Run control stream;
- turn ID and steering correlations;
- cancellation ordering state;
- terminal-answer/error state;
- immutable Run ending and Result.

The first Run performs:

```text
initialize -> initialized -> thread/start(ephemeral: true) -> turn/start
```

Every resumed Run performs only:

```text
turn/start(existing threadId)
```

Each Run resolves from its own matching `turn/completed`. Route notifications
by both root `threadId` and active `turnId`, as the current transport already
does (`app-server.ts:1325-1342`). Do not let late notifications from turn N
mutate turn N's stored Result or enter turn N+1's reducer. Token-usage updates
carry a `turnId`, so retain a process-level cumulative baseline while emitting
only the current turn's delta.

Preserve the current prompt behavior: the first turn receives
`systemPrompt + task.prompt`, while resumed turns receive only their new task
prompt (`harness.ts:366-373`, `harness.ts:421-435`). Moving the profile prompt
to Codex `developerInstructions` may be worthwhile separately, but would be a
behavior change rather than a prerequisite for this lifecycle migration.

### Cancellation, crash, and shutdown policy

- **Run cancellation:** send `turn/interrupt` for the active turn, settle that
  Run once its terminal ordering is known, and leave the process/thread alive
  so a later Run can resume the same conversation.
- **Session shutdown while active:** close admission, interrupt the active
  turn, await bounded settlement, close stdin, await child exit, then escalate
  SIGTERM/SIGKILL if needed.
- **Session shutdown while idle:** close stdin and await the child; escalate
  only if it does not exit.
- **Unexpected process exit:** fail the active Run once and make atomic Resume
  admission return Conversation loss. Do not silently create a new root under
  the same stable Subagent: ephemeral history is gone, so that would falsely
  claim continuity. A new Subagent is the honest recovery path unless replay
  is deliberately designed later.

The implemented adapter's synchronous `admitResume` operation projects
terminal process state as neutral Conversation loss without provider I/O. The
manager claims admission first and dispatches only the prepared Run returned by
an admitted outcome; unsupported remains reserved for a Harness that never
offered Resume.

## Important qualifications

1. **Ephemeral means process-local, not recoverable.** A crash, kill, machine
   restart, or Session shutdown permanently loses the Codex conversation.
2. **No rollout pollution is not no shared-home access.** Auth, config, logs,
   MCP/plugin startup, trust/config operations, and process-global services can
   still touch shared resources. Avoid claiming total isolation from Desktop.
3. **"One thread" should mean one client-created root thread.** Codex-native
   review or multi-agent behavior may create child threads. Tests should assert
   one outbound root `thread/start`, not that Codex can never create internal
   children.
4. **"One process" should mean one `codex app-server` parent.** Commands and
   tools can legitimately create descendant processes during turns.
5. **Memory cost changes intentionally.** Idle Codex Subagents now retain an
   App Server and model/thread context until Session shutdown. This supersedes
   the prior decision to retain no idle Codex process.

## Required tests before release

### Deterministic transport and harness tests

1. Two Runs produce one spawn, one initialize, one
   `thread/start { ephemeral: true }`, two `turn/start` requests using the same
   thread ID, zero `thread/resume` requests, and distinct turn IDs.
2. The child remains alive after both clean and cancelled Run settlement and
   exits exactly once on adapter close.
3. A second Run cannot start until the first matching `turn/completed`; an
   accidental concurrent `turn/start` is never emitted.
4. Run-local output, Activity, steering correlation, errors, and cancellation
   do not leak between turns; the first stored Result remains immutable.
5. Cumulative provider usage is converted into the correct per-Run delta across
   two turns.
6. Idle close, active close, stdin-close timeout, SIGTERM escalation, SIGKILL
   escalation, and unexpected process exit all settle once and leave no child.
7. Two different Codex Subagents each own one independent App Server and
   ephemeral root thread.

### Authenticated live release smoke

Rewrite `scripts/codex-resume-live-smoke.mjs`, whose current assertions require
two started and disposed Attempts (`lines 102-142`), to prove all of the
following against the pinned real binary:

- Run 1 establishes a random marker and Run 2 recalls it without prompt replay;
- exactly one App Server child is spawned;
- that same child is alive while the Subagent is idle and after Run 2;
- outbound protocol contains one ephemeral `thread/start`, two `turn/start`,
  and no `thread/resume`;
- the first Result remains immutable and each Run has one independent Result and
  notification;
- a second App Server using the same `CODEX_HOME` cannot list/read the ephemeral
  root thread (or, at minimum, the first response reports `path: null` and no
  new rollout appears);
- Session shutdown terminates the complete App Server/tool process tree;
- the smoke still passes while Codex Desktop is open.

The smoke should assert one App Server parent, not prohibit temporary tool
children. It spends real quota and should remain in `release:check`, matching
the existing release-smoke policy.

## Documentation decision

Implementation added ADR-0021, which supersedes the
Codex-specific process/persistence consequences of ADR-0011, ADR-0015, and
ADR-0016 while preserving their one-Conversation, one-Run/one-Result, ordered
cancellation, and Session-boundary decisions. Update:

- `CONTEXT.md` (`Attempt`, Conversation, and shutdown definitions);
- `docs/runtime-invariants.md` (Codex lifecycle and persistence sections), since replaced by `docs/architecture.md`;
- `docs/adr/0015-codex-conversation-across-disposable-attempts.md` and
  `docs/adr/0016-codex-resume-release-contract.md` with supersession links;
- the Codex upgrade protocol checks/smokes so a CLI bump re-verifies ephemeral
  pathlessness, repeated turns, active-turn behavior, and stdin shutdown.

## Recommendation

Proceed with option 1. The protocol and pinned implementation support it, and
the repository already has the correct Session-scoped owner. Treat the work as
a transport-lifetime refactor with explicit crash semantics and a live
coexistence test—not as an `ephemeral` boolean change.

[codex-lifecycle]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/README.md#L76-L83
[codex-thread-params]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L100-L116
[codex-two-turn-test]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/tests/suite/v2/turn_start.rs#L1686-L1787
[codex-ephemeral-test]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/tests/suite/v2/thread_start.rs#L1071-L1114
[codex-thread-config]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/src/request_processors/thread_processor.rs#L1168-L1174
[codex-thread-stage]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/src/request_processors/thread_processor.rs#L1399-L1409
[codex-thread-persistence]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/session/session.rs#L843-L852
[codex-thread-state-db]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/session/session.rs#L937-L946
[codex-rollout-path]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/session/session.rs#L1000-L1004
[codex-stdio-close]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/src/lib.rs#L1019-L1040
[codex-shutdown-threads]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/src/lib.rs#L1180-L1189
[codex-active-turn-test]: https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/tests/suite/v2/turn_start.rs#L315-L384
