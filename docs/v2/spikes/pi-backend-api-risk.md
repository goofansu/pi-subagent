# Pi backend API-risk spike (M0)

**Status:** Complete. **Verdict: viable.**
**Date:** 2026-09-02
**SDK under test:** `@earendil-works/pi-coding-agent` 0.84.4 (the version already
in this repository), driven through `createAgentSession`.
**Model used:** `openai-codex/gpt-5.4-mini`.
**Spike code:** `.scratch/v2-m0-baseline-skeleton/spikes/pi-ownership-spike.ts`.
Disposable, imported by neither extension tree, excluded from lint
(`biome.json` ignores `.scratch`) and from every test glob (its name matches no
`node --test` pattern).

## What this spike asks

Can one retained Pi SDK conversation be owned by a **Subagent Scope** while each
**Run** owns one execution plus a nested native scope? The eight surfaces below
are the ones the v2 core contract depends on.

The spike reuses v1's knowledge of how to reach the native API. It modifies no
v1 adapter and imports no v1 module.

## How to rerun

```bash
PI_SUBAGENT_DEPTH=0 node --import tsx \
  .scratch/v2-m0-baseline-skeleton/spikes/pi-ownership-spike.ts
```

Credentials follow the existing live-smoke conventions: a usable model and
credentials in the normal Pi agent directory (`pi auth check --provider
openai-codex` must report ready). Override the model with `PI_SPIKE_MODEL`. The
spike spends provider quota, runs six model turns, and is not part of any
automated lane.

---

## open

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** `createAgentSession(options)` resolved in 2–3 ms and performed no
provider I/O. The returned handle exposes `prompt`, `steer`, `subscribe`,
`abort`, `waitForIdle`, `clearQueue`, `dispose`, `messages`, and an `isIdle`
getter. `bindExtensions({ mode: "print" })` resolved immediately and left the
session idle (`isIdle === true`).

**Risk to the ownership model.** None. Opening is cheap, local, and separable
from running, which is exactly what a Subagent-scoped BackendAgent needs: the
BackendAgent can be constructed when the Subagent Scope opens and still perform
no provider work until the first Run. `isIdle` gives the adapter a cheap check
that no Run is in flight.

Note that 0.84.4 names this abstraction `AgentSession`. Nothing about the eight
surfaces depends on that name; the whole handle sits behind the adapter, so a
later rename to `AgentHarness` or another abstraction is an adapter-internal
change.

## run

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** `prompt(text)` followed by `waitForIdle()` completed one Run in
3016 ms and produced 16 events of these types: `agent_start`, `turn_start`,
`message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`,
`agent_settled`. Exactly one `agent_end` frame was observed for the Run.
`session.messages` grew from 0 to 2.

**Risk to the ownership model.** None. One `prompt()` call is one adapter
execution from the core's perspective, with one terminal frame to derive a Run
Ending from. Provider retries stay inside the SDK and never surface as a second
Run.

## resume

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** A second `prompt()` on the same retained session resolved in
3450 ms, grew `messages` from 2 to 4, and answered with the word established by
the first Run. **No continuation token exists.** The conversation is entirely
process-local state inside the retained handle.

**Risk to the ownership model.** None, and the ownership model is what makes
this work: because the BackendAgent is Subagent-scoped, resume is simply another
`prompt()` on the retained handle. There is nothing for core to carry across
Runs and nothing that could leak a provider continuation identity through the
adapter boundary. The corollary is that losing the handle loses the
conversation, which is the Conversation-loss outcome the core contract already
has a place for.

## steer

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** `session.steer(text)` called ~1.5 s into an active `prompt()`
resolved without error, and the terminal assistant message contained the steered
word. Native steering is serialized by the SDK.

**Risk to the ownership model.** Low. Steering is a method on the retained
handle, not on a per-Run object, so the adapter — not the SDK — must ensure a
Control belongs to the Run that is currently active. That is already the
adapter's job under a Run-scoped Control mailbox: the mailbox closes when the
Run settles, so no admission can reach a later Run.

## cancel

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** `clearQueue()` + `abort()` + `waitForIdle()` settled in 1504 ms.
The terminal message carried `stopReason: "aborted"`. `isIdle` returned true
afterwards. **The retained session then accepted a new Run and answered it
correctly**, so cancellation destroys neither the handle nor the conversation.

**Risk to the ownership model.** None. Cancellation is Run-scoped: the nested
native execution ends, the Subagent-scoped BackendAgent survives, and the
Subagent returns to idle and stays resumable. This is the shape the roadmap
assumes.

## close

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** Emitting `{ type: "session_shutdown", reason: "quit" }` through
`extensionRunner` and then calling `dispose()` took 1 ms.

**Risk to the ownership model — the one real finding.** After `dispose()`,
calling `prompt()` again **did not throw**. The SDK does not defend a disposed
session; the call was accepted silently.

This does not break the ownership model, but it does place a requirement on the
adapter: **a closed Subagent Scope must be enforced by the adapter's own closed
flag, not by trusting the SDK to reject work after disposal.** v1 already does
exactly this (`createPiManagedAdapter` checks `closed` before every execution
and inside `initialize`), and v2 must keep that guard. Recorded here so M4 does
not drop it as redundant.

## event bridging

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** `session.subscribe(handler)` returns an unsubscribe function
synchronously. Run 1's subscription received 16 events; after unsubscribing, a
fresh subscription received 16 events for Run 2 while the released subscription
stopped growing.

**Risk to the ownership model.** None. A per-Run subscription attached inside
the Run Scope and released by a Run-scope finalizer is directly supported. Late
events cannot reach a terminal Run because the subscription is gone.

## usage

**SDK:** `@earendil-works/pi-coding-agent` 0.84.4.

**Observed.** Each assistant message carries a `usage` object with keys
`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, and a
nested `cost` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`). Example
from run 1:

```json
{"input":209,"output":44,"cacheRead":0,"cacheWrite":0,"reasoning":37,
 "totalTokens":253,
 "cost":{"input":0.000157,"output":0.000198,"cacheRead":0,"cacheWrite":0,
         "total":0.000355}}
```

**Risk to the ownership model.** Low. Usage arrives per message, so it is
naturally additive and naturally Run-local once the adapter takes a message
baseline when the Run begins — which is how v1's Pi Attempt already works.
`totalTokens` is a per-message figure, so it reads as a **context occupancy
gauge** (latest value wins) rather than something to sum. That matches the
roadmap's usage rule. Nothing forces prior-Conversation usage onto a resumed
Run.

---

## Verdict

**Viable.** The Subagent-scoped BackendAgent and Run-scoped execution ownership
model holds for Pi on every surface. Open is cheap and provider-free, one
`prompt()` is one Run, resume is another `prompt()` on the retained handle,
steering and cancellation are Run-scoped, event subscriptions attach and release
per Run, and usage is per-message and therefore Run-local.

### Exceptions to record

None that change the model. One implementation constraint carries forward into
[ADR-0023](../../adr/0023-v2-scope-ownership.md):

- **A disposed Pi session still accepts `prompt()`.** Closure must be enforced
  by the adapter's own state, not by the SDK. This is a consequence of the scope
  hierarchy, not an exception to it, so it is recorded as a consequence in
  ADR-0023 rather than as its own ADR.
