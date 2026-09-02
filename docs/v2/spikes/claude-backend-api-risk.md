# Claude backend API-risk spike (M0)

**Status:** Complete. **Verdict: viable with a documented exception.**
**Date:** 2026-09-02
**SDK under test:** `@anthropic-ai/claude-agent-sdk` 0.3.245 (the version
already in this repository), driven through `query()`.
**Spike code:** `.scratch/v2-m0-baseline-skeleton/spikes/claude-ownership-spike.ts`.
Disposable, imported by neither extension tree, excluded from lint
(`biome.json` ignores `.scratch`) and from every test glob.

## What this spike asks

Can a **Subagent-scoped BackendAgent** own a retained Claude conversation
identity while each **Run** owns exactly one streaming `Query`, with open, run,
resume, steer, cancel, close, event bridging, and usage all reachable under that
model?

The spike reuses v1's knowledge of how to reach the native API. It modifies no
v1 adapter and imports no v1 module.

## How to rerun

```bash
node --import tsx \
  .scratch/v2-m0-baseline-skeleton/spikes/claude-ownership-spike.ts
```

Credentials follow the existing live-smoke conventions: an authenticated Claude
Code SDK environment, the same one `npm run claude:steering-smoke` needs. The
spike spends provider quota, runs seven Queries (one of which uses the Bash
tool), and is not part of any automated lane.

---

## open

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** The SDK has **no open call**. `query({ prompt, options })` is the
only entry point, and calling it starts an execution immediately. A conversation
identity (`session_id`) first becomes visible on the `system`/`init` frame or
the `result` frame of the first Run — never before one.

**Risk to the ownership model — the exception.** A Claude BackendAgent cannot
be *opened* in the provider sense when its Subagent Scope opens. Opening is a
purely local act: the BackendAgent starts life holding no identity, and acquires
one as a side effect of its first Run.

This does not break Subagent-scoped ownership — the retained thing is the
identity string, and it is genuinely Subagent-scoped — but it does mean the
BackendAgent contract must tolerate an **unopened** state in which resume is not
yet possible. This is the exception recorded in
[ADR-0023](../../adr/0023-v2-scope-ownership.md).

## run

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** One `query()` per Run completed in 7643 ms. Frame types seen:
`command_lifecycle`, `system`, `rate_limit_event`, `assistant`, `result` —
7 frames total. The answer was correct and the conversation identity was
`ba5a6f16-…`.

**Risk to the ownership model.** None. One Query is one adapter execution, with
a `result` frame to derive an Ending from. The Query lives entirely inside the
Run Scope.

## resume

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** Passing `options.resume = "<identity from run 1>"` produced the
**same** identity on run 2 and answered from run 1's context. In this
observation the resumed Query replayed **zero** history frames.

**Risk to the ownership model.** Low. Native continuation is a single opaque
string that never needs to cross the adapter boundary, which is exactly what the
model wants.

One caution: zero replay frames is what was observed here, not a guarantee. v1's
adapter defends against replayed user, assistant, and system history before the
attachment boundary (`isReplay`, plus the identity-boundary check). That defence
is still warranted — the spike did not prove replay never happens, only that it
did not happen for a short two-Run conversation.

## steer

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** Pushing a second user message into the streamed input with
`priority: "later"` while the Query was active was **confirmed by a provider
event** (the echoed `user` frame carried the client's uuid), and the final
answer honoured the steering. The steered Run produced **two `result` frames**.

**Risk to the ownership model.** Low, and it confirms an existing decision. A
provider `result` frame is a **Turn boundary, not Run settlement**: the Run
stayed active across the first `result` because guidance was still outstanding,
and settled on the second. This is precisely
[ADR-0018](../../adr/0018-ordered-claude-query-conversation.md), and the v2 Run
Scope must keep that distinction. Steering requires the Query's input channel to
stay open, so the input channel is Run-scoped, not Subagent-scoped.

## cancel

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** Closing the input, aborting the `AbortController`, and calling
`stream.close()` about 4 s into a long Run settled it in 6012 ms. The cancelled
Run saw **no `result` frame** and retained **no partial assistant text** — the
abort landed before any assistant text frame arrived. No error was raised.

**Query loss.** A Query aborted 50 ms after it started settled in 2061 ms
having produced **no frames at all** — not even the `system`/`init` frame, so no
conversation identity was ever seen for that Run. No error was raised.

The SDK gives a client no handle on the transport, so a *spontaneous* Query loss
cannot be provoked from a spike; a deliberate abort before any frame arrives is
the closest observable analogue, and it produces the same shape the adapter must
handle — a Run that ends with nothing.

**Risk to the ownership model.** Low, with one requirement. Cancellation is
Run-scoped and clean, but it can produce a Run with **zero observations** and,
if it lands early enough, a BackendAgent that never acquired an identity at all.
The core must be able to settle such a Run without fabricating an answer and
without treating the absence as a failure, and a Subagent whose first Run died
before its identity frame must be reported as non-resumable rather than as
broken. v1 already does this; v2's reducer and terminal settlement must keep
it.

## close

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** After the cancelled Query, resuming the **same** identity started a
new Query that answered correctly, so a cancelled Query does not destroy the
retained conversation. The SDK exposes **no session close call**.

**Risk to the ownership model.** Low. Closing a Claude BackendAgent means
dropping the retained identity string and aborting any live Query — both purely
local acts. Nothing survives the Subagent Scope that a finalizer cannot release.

## event bridging

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** The `Query` async iterable is the **only** event channel, and it
is per-Run: run 1 produced 7 frames, run 2 produced 7. There is no session-level
subscription to attach or release.

**Tool events.** A Run given the `Bash` tool and asked to run a shell command
produced one `tool_use` block on an assistant frame and a matching `tool_result`
block on a subsequent `user` frame, with the model's answer quoting the command
output correctly. Frame types for that Run were `command_lifecycle`, `system`,
`assistant`, `rate_limit_event`, `user`, `result`. So tool calls and their
results arrive interleaved on the same per-Run channel as messages, and a `user`
frame is the carrier for a tool result — which is why an adapter must
distinguish a tool-result `user` frame from a steering echo before treating one
as evidence that guidance was consumed.

**Risk to the ownership model.** None — this is the easiest of the three
backends. The event source is created and destroyed with the Run Scope, so late
events cannot reach a terminal Run by construction.

## usage

**SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.245.

**Observed.** The `result` frame carries three usage surfaces:

- `usage` — raw provider usage for the Run: `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens_details.thinking_tokens`, `server_tool_use`, `service_tier`,
  and a per-message `iterations` array.
- `modelUsage` — a **per-model** map with `inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`,
  `contextWindow`, and `maxOutputTokens`.
- `num_turns` — 1 for the simple Run.

**Risk to the ownership model — the second finding.** `modelUsage` for a
single-model Run contained **two models**: the requested model and
`claude-haiku-4-5`, which the SDK used internally. Any normalization that sums
`modelUsage` charges the Run for models the caller never asked for, and any
normalization that reads only the requested model's entry undercounts.

Usage is nonetheless **Run-local**: run 2's `usage` reported
`cache_read_input_tokens: 935` against run 1's `cache_creation_input_tokens:
935`, so the resumed Run was charged for its own reads rather than re-charged
for the prior Conversation. `contextWindow` in `modelUsage` gives the
denominator for a context-occupancy gauge.

This is a normalization decision, not an ownership problem, and it is recorded
in [ADR-0027](../../adr/0027-v2-usage-normalization.md).

---

## Verdict

**Viable with a documented exception.** Every surface fits Subagent-scoped
BackendAgent plus Run-scoped execution, and Claude is in fact the cleanest of
the three for event bridging and cancellation.

### Exceptions to record

1. **A Claude BackendAgent has no provider-side open.** Its retained identity
   comes into existence only as a side effect of its first Run, so the
   BackendAgent contract must allow an unopened state in which resume is not yet
   possible. Recorded as a decision in
   [ADR-0023](../../adr/0023-v2-scope-ownership.md).
2. **`modelUsage` reports models the Run did not request.** Usage normalization
   must define which entries are charged to the Run. Recorded in
   [ADR-0027](../../adr/0027-v2-usage-normalization.md).

Neither exception requires the ownership model to change.
