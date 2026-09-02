# Codex backend API-risk spike (M0)

**Status:** Complete. **Verdict: viable with documented exceptions.**
**Date:** 2026-09-02
**SDK under test:** `codex-cli` 0.150.1 (the version this repository already
pins for its protocol check), driven as `codex app-server` over stdio JSON-RPC.
**Spike code:** `.scratch/v2-m0-baseline-skeleton/spikes/codex-ownership-spike.ts`.
A hand-written JSON-RPC client. Disposable, imported by neither extension tree,
excluded from lint (`biome.json` ignores `.scratch`) and from every test glob.

## What this spike asks

Can a **Subagent-scoped BackendAgent** own one App Server process plus one
ephemeral root Conversation while each **Run** owns exactly one Turn, with open,
run, resume, steer, cancel, process loss, close, event bridging, and usage all
reachable under that model?

The spike reuses v1's knowledge of the App Server protocol. It modifies no v1
adapter and imports no v1 module.

## How to rerun

```bash
node --import tsx \
  .scratch/v2-m0-baseline-skeleton/spikes/codex-ownership-spike.ts
```

Credentials follow the existing live-smoke conventions: an authenticated `codex`
CLI on `PATH` (`~/.codex/auth.json`), the same environment
`npm run codex:smoke` needs. The spike spends provider quota, runs seven Turns (one of
which runs a shell command and one of which is killed mid-Turn), and is not part
of any automated lane.

---

## open

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** `initialize` resolved in 53 ms, returning `userAgent`,
`codexHome`, `platformFamily`, and `platformOs`. After the `initialized`
notification, `thread/start` with `{ ephemeral: true, approvalPolicy: "never",
sandbox: "danger-full-access" }` returned a root thread id
(`01a061ef-9f62-…`). **Nothing in the protocol ties the process or the root's
lifetime to a Turn**: both are retained entirely at the client's discretion.

**Risk to the ownership model.** None. This is the strongest fit of the three
backends: process plus ephemeral root map exactly onto a Subagent-scoped
BackendAgent, and the roadmap's model is what the protocol already assumes.

## run

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** `turn/start` returned a turn id **immediately**, before any model
work. The Turn completed 4732 ms later with a `turn/completed` notification
carrying `status: "completed"`. Frame methods for the Run:
`mcpServer/startupStatus/updated`, `thread/status/changed`, `turn/started`,
`item/started`, `item/completed`, `item/agentMessage/delta`,
`thread/tokenUsage/updated`, `turn/completed`.

**Risk to the ownership model.** None. One Turn is one adapter execution, and
the immediate turn id gives the adapter a correlation key for the Run Scope
before any event can arrive.

## resume

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** A second `turn/start` on the same root resolved in 3533 ms, was
issued a **different** turn id, and answered from the first Turn's context.

**Risk to the ownership model.** None. Sequential Turns on one retained root are
the resume mechanism, exactly as
[ADR-0021](../../adr/0021-retained-ephemeral-codex-conversation.md) records.
No `thread/resume` and no stored rollout is involved.

## steer

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** `turn/steer` with `expectedTurnId` set to the active turn id was
**accepted**, returning `{ "turnId": "…" }`. The Turn then completed with
`status: "completed"` and the final agent item honoured the steering.

**Risk to the ownership model.** None, and `expectedTurnId` actively helps:
the protocol itself refuses to apply guidance to a Turn other than the one
named, which is the Run-scoped Control mailbox invariant enforced on the wire.

## cancel

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** `turn/interrupt` was **accepted** (empty result). A
`turn/completed` frame with `status: "interrupted"` arrived **2 ms** later. The
process stayed alive, and the retained root then **accepted a new Turn** which
completed normally.

**Risk to the ownership model.** None. Cancellation is Turn-scoped and does not
destroy the process, the root, or the Conversation. The Subagent returns to idle
and stays resumable — the shape the roadmap assumes.

## process loss

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed — the most consequential finding in this spike.** The spike started a
long Turn, waited three seconds, and sent `SIGKILL` to the App Server process.

- **No terminal Turn frame ever arrived.** The active Turn was never reported as
  `failed`, `interrupted`, or anything else. The client waited 15 seconds and
  gave up.
- The process exit was observable (`code: null`, `signal: "SIGKILL"`), but only
  because the client owns the child and watches its `exit` event.
- A request issued **after** the process died neither resolved nor rejected. It
  simply never came back; the spike's own 10-second timeout is what ended it.
  The protocol has no error for "the peer is gone".

**Risk to the ownership model — the third exception.** Codex is the one backend
where a Run can be orphaned with no provider-side signal at all. The protocol
will not tell the adapter that its Conversation has died, and a pending request
will hang forever rather than fail.

*Resolution:* the Codex adapter must treat **process exit as the authoritative
loss signal** and derive the Run's ending from it itself, rather than waiting
for a terminal frame that will never arrive. Every outstanding request must be
settled by the adapter when the process dies, and every request must carry its
own bound so that a wedged-but-alive process cannot hold a Run open forever.
v1 already does exactly this — it settles pending requests on transport loss and
escalates SIGTERM to SIGKILL on a bounded timer — and the v2 adapter must port
that discipline rather than trusting the protocol. Recorded in
[ADR-0023](../../adr/0023-v2-scope-ownership.md) and
[ADR-0025](../../adr/0025-v2-terminal-settlement.md).

This is also what makes Conversation loss real for Codex: process death ends the
retained root, the Subagent becomes non-resumable, and recovery is a new
Subagent — the behaviour
[ADR-0021](../../adr/0021-retained-ephemeral-codex-conversation.md) already
chose.

## close

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** In the first run of this spike, ending the child's stdin closed the
process in 13 ms with exit code 0 and no signal. In the extended run, close was
called after the process had already been killed and returned in 1 ms with the
exit already recorded, so closing is idempotent against a process that is
already gone. No stderr output was produced across either session.

**Risk to the ownership model.** None. A graceful close is a Subagent-scope
finalizer that ends stdin and awaits exit. v1's bounded SIGTERM/SIGKILL
escalation remains the right backstop for a process that does not exit, but the
happy path is clean.

## event bridging

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** All events arrive on **one process-wide stdout stream**. Every
Turn-related frame carries `threadId`, and Turn frames carry `turnId`. Across
four Turns on one process the spike saw **191 frames** with these methods:
`remoteControl/status/changed`, `thread/started`,
`mcpServer/startupStatus/updated`, `thread/status/changed`, `turn/started`,
`item/started`, `item/completed`, `item/agentMessage/delta`,
`thread/tokenUsage/updated`, `account/rateLimits/updated`, `turn/completed`.

The App Server also issues **server-to-client requests**. The spike answered
every one with a JSON-RPC error; had it ignored them, the server would have
stalled waiting for a response.

**Tool and background-terminal items.** Asking Codex to run a shell command
produced two `item/*` frames for the command — `item/started` and
`item/completed` — carrying a `commandExecution` item with the resolved
`command`, its `cwd`, and a **`processId`**. Seven frames in that Turn mentioned
a terminal or background process. So background terminal tracking is a
first-class item type on the same stream, correlated by `threadId` and
`turnId` like everything else, and the child process id is visible to the
client. Nothing extra is needed to bridge it: it is one more item kind for the
adapter's demultiplexer, and the exposed `processId` gives an adapter a handle
for cleanup evidence should it ever need one.

**Risk to the ownership model — the first exception.** The event source is
**Subagent-scoped, not Run-scoped**. Unlike Pi (per-Run subscription) and Claude
(per-Run Query), Codex has one stream for the whole BackendAgent, and the
adapter must demultiplex it by `threadId` and `turnId` and route each frame into
the correct Run Scope.

This does not break the ownership model, but it does mean **the roadmap's rule
that late events cannot mutate a terminal Run must be enforced by the adapter's
own routing**, not by the event source disappearing when the Run Scope closes.
The stream outlives every Run. Recorded in
[ADR-0023](../../adr/0023-v2-scope-ownership.md) and
[ADR-0024](../../adr/0024-v2-observation-ordering.md).

A second, smaller constraint: the transport must always answer server-to-client
requests, so the transport reader is a **Subagent-scoped** fiber that must stay
alive between Runs.

## usage

**SDK:** `codex-cli` 0.150.1, driven as `codex app-server` over stdio JSON-RPC.

**Observed.** Usage arrives as `thread/tokenUsage/updated` notifications, one
per Turn in this spike, shaped like:

```json
{"threadId":"…","turnId":"…",
 "tokenUsage":{
   "total":{"totalTokens":16858,"inputTokens":16853,"cachedInputTokens":6912,
            "cacheWriteInputTokens":0,"outputTokens":5,
            "reasoningOutputTokens":0},
   "last": {"totalTokens":16858,"inputTokens":16853,"cachedInputTokens":6912,
            "cacheWriteInputTokens":0,"outputTokens":5,
            "reasoningOutputTokens":0}}}
```

**`turn/completed` carries no usage at all.** Its `turn` object has exactly the
keys `id`, `items`, `itemsView`, `status`, `error`, `startedAt`, `completedAt`,
`durationMs`.

**Risk to the ownership model — the second exception.** `tokenUsage.total` is
**Conversation-cumulative**, not Run-local: it is the running total for the
whole thread. The roadmap requires that usage crossing the adapter boundary be
Run-local and that resume never charge prior Conversation usage. For Codex that
means the adapter must:

- take a `total` baseline when the Run begins and emit the **difference**, or
- read `tokenUsage.last`, which is the per-Turn figure — but `last` is a Turn
  figure, and one Run may span several Turns, so differencing `total` against a
  Run baseline is the only shape that is correct in general.

There is also **no terminal usage reconciliation surface**, because
`turn/completed` carries none. Terminal reconciliation for Codex must use the
last `thread/tokenUsage/updated` observed before the completion frame, and the
adapter must not wait for a usage frame that will never arrive.

Recorded in [ADR-0027](../../adr/0027-v2-usage-normalization.md).

---

## Verdict

**Viable with documented exceptions.** Process and ephemeral root map cleanly
onto a Subagent-scoped BackendAgent, one Turn maps cleanly onto a Run-scoped
execution, and steer, interrupt, and close all behave as the model needs.

### Exceptions to record

1. **The event stream is Subagent-scoped.** Codex has one process-wide stream
   that outlives every Run, so ordered, lossless, Run-correlated observation and
   the "late events cannot mutate a terminal Run" rule must be enforced by the
   adapter's demultiplexer rather than by the event source closing with the Run
   Scope. The transport reader is therefore a Subagent-scoped fiber that must
   also answer server-to-client requests between Runs. Recorded in
   [ADR-0023](../../adr/0023-v2-scope-ownership.md) and
   [ADR-0024](../../adr/0024-v2-observation-ordering.md).
2. **Usage is Conversation-cumulative and absent from the terminal frame.**
   A Run-local delta must be computed by differencing `tokenUsage.total`
   against a Run baseline, and terminal reconciliation has no dedicated surface.
   Recorded in [ADR-0027](../../adr/0027-v2-usage-normalization.md).
3. **Process loss produces no protocol signal.** A killed App Server leaves its
   active Turn with no terminal frame and leaves later requests hanging with
   neither a result nor an error. The adapter must derive the ending from
   process exit itself and bound every request. Recorded in
   [ADR-0023](../../adr/0023-v2-scope-ownership.md) and
   [ADR-0025](../../adr/0025-v2-terminal-settlement.md).

None of the three exceptions requires the ownership model to change. The third
raises the stakes for the adapter: Codex is the one backend where trusting the
protocol to report a terminal outcome would hang a Run forever.
