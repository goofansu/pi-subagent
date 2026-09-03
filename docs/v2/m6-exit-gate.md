# M6 exit gate

**Status:** Passing. Both live gates were run and passed. Item 12, the Codex
Desktop coexistence evidence, remains an M7 question by design — and item 10
now carries an environment finding rather than a failure: the `codex` CLI on
the verification machine was upgraded from the pinned 0.150.1 to 0.153.0
part-way through the milestone, which the byte-for-byte protocol pin correctly
detected. See item 10.
**Reviewed:** a two-axis review of the whole change ran before this record was
finalized. It found one real bug — a signal-escalation stand-down kept per
BackendAgent rather than per Turn, which would have disarmed the ladder for
every Run after the first cancelled one — plus a forked copy of the shared
Profile validator, a hand-narrowed wire payload, a gap in the new confinement
rule, and two missing proofs. All are fixed or recorded; sections 5, 11, and 13
say where.
**Date:** 2026-09-03
**Verified against:** [the v2 roadmap](roadmap.md), milestone M6.

M6 is the third and last time the abstraction is tested before cutover, and it
is the hardest of the three. The M0 spike found Codex the most demanding
backend by a distance, and recorded three exceptions no other provider needed:

1. the event stream is **Subagent-scoped**, so it outlives every Run and late
   events are a routing decision rather than a closed channel;
2. usage is **conversation-cumulative** and absent from the terminal frame;
3. **process loss produces no protocol signal at all** — no terminal Turn
   frame, and a later request that neither resolves nor rejects.

The roadmap is explicit about what M6 is really asking:

> If Claude and Codex can be ported through adapter-local work plus new
> conformance fixtures, the seam is healthy. If each backend changes the Run
> lifecycle, pause the port and repair the abstraction before continuing.

**The seam is healthy.** Not one file under `runtime/`, `domain/`,
`presentation/`, or `application/` changed. The backend contract is unchanged:
not one member added, removed, or re-typed. **The shared conformance suite is
unchanged** — M4 and M5 each loosened one check in it, and M6 loosened none.
Section 11 below enumerates everything M6 touched outside
`extensions/subagent-v2/backend/codex/` and classifies each entry; there are
three, and exactly one of them is a product semantic: the shared Profile field
module learned that a backend can support a *subset* of the shared four
fields.

---

## 1. The repository quality gate is green ✅

`npm run check` exits 0. It runs, in order:

| Step | Result |
| --- | --- |
| `npm run typecheck` (both trees plus `tools/`) | clean |
| `npm run typecheck:v2` (v2 tree alone) | clean |
| `npm run lint` (Biome, whole repository) | clean |
| `npm run test:conformance` | 164 tests, 163 pass, 1 skipped |
| `npm run test:managed-conformance` | 6 tests, 6 pass |
| `npm test` (v1 suite, repository scripts, `tools/`) | 540 tests, 539 pass, 1 skipped |
| `npm run test:v2` | 1,148 tests, 1,140 pass, 8 skipped |
| `npm run test:v2:conformance` | 191 tests, 183 pass, 8 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` when the milestone's work was verified; red afterwards, because the CLI was upgraded on the machine. See item 10. |

The three v1 lanes are byte-identical to M5's: **M6 changed no v1 file.** The
v2 lane grew from 979 tests to 1,148, and the conformance lane from 153 to 191
— the 38 new ones being the Codex rig's, which is the shared suite plus its own
no-skips assertion.

The skip list is unchanged at eight, all of them `FakeOneShotBackend
conformance: …` scenarios about capabilities that backend declares it does not
have. **The Codex rig skips nothing**, and a test asserts the empty list.

## 2. Codex passes all shared conformance suites ✅

All 37 shared scenarios pass for the real Codex backend, registered as
`CodexBackend conformance: <scenario>` by
[`testing/conformance-codex.test.ts`](../../extensions/subagent-v2/testing/conformance-codex.test.ts).

What makes the pass mean something is what is *not* stubbed. The rig builds the
production `createCodexBackend` and injects a scriptable stand-in through the
same `spawn` option the real `codex app-server` fills, and the stand-in speaks
the wire: requests arrive as JSON-RPC lines on stdin and answers go back as
JSON-RPC lines on stdout. So the framing, the bounded requests, the
client-request answering, the exit watch, the Subagent-scoped reader and its
routing table, the translation, the steering correlation, the usage
differencing, and the cancellation path are all production code. A test that
got the wire shape wrong fails in the adapter rather than in a mock's
expectations.

Three scenarios are shaped differently for Codex than for the other two rigs,
and each difference is a Codex fact rather than a concession:

- **Steering scenarios are gated on the steer, not on timing.** The stand-in's
  `await-steer` frame makes the Turn's next frame depend on the guidance having
  reached the server, so "delivered serially, in admission order" is a fact
  about the script rather than a hope about fiber scheduling.
- **A competing ending is a final answer plus a cancel.** Codex announces an
  ending in the stream only when a final agent message was already observed and
  a cancel then arrives, which is exactly the shape
  [ADR-0012](../adr/0012-ordered-codex-steering.md) is about — and the only
  shape that produces two endings for arbitration to choose between.
- **`a-replayed-transcript-adds-no-usage` is Codex's *retained context*.**
  There is no replay: the spike found that a second Turn on a retained root
  answers from the conversation without the client resending it. So the fixture
  is a resumed Turn whose cumulative reading has not moved, and it is charged
  nothing. The scenario also asks for a turn count of zero, and a *completed*
  Codex Turn is always one turn, so the fixture's answer is observed and the
  Turn is then cut short — a real Codex shape, because a final answer already
  observed is the Run's answer whatever stops the Turn afterwards.

The Codex rig needed one thing the other two did not: a **delivery gate**.
Codex's stream is read by a Subagent-scoped fiber, so "the server wrote the
answer" and "the Run has the answer" are two different moments, and a fixture
that cancelled between them would be asserting on a race. The rig counts
observations at the seam and `untilUnderWay` waits for the count the fixture
declares. It is the same kind of gate as the Claude rig's `await-input` step,
and it is rig-side: no production line knows about it.

## 3. Codex-specific tests cover the spike's findings ✅

Everything provider-neutral is the suite's business. These are the cells that
are Codex's own, in
[`testing/codex/codex-backend.test.ts`](../../extensions/subagent-v2/testing/codex/codex-backend.test.ts),
[`backend/codex/transport.test.ts`](../../extensions/subagent-v2/backend/codex/transport.test.ts),
[`backend/codex/translate.test.ts`](../../extensions/subagent-v2/backend/codex/translate.test.ts),
[`backend/codex/protocol.test.ts`](../../extensions/subagent-v2/backend/codex/protocol.test.ts),
[`backend/codex/profile.test.ts`](../../extensions/subagent-v2/backend/codex/profile.test.ts),
and
[`testing/codex/stand-in-app-server.test.ts`](../../extensions/subagent-v2/testing/codex/stand-in-app-server.test.ts).

| The spec's finding | Where it is proven |
| --- | --- |
| Process loss mid-Turn | `a process that dies mid-Turn fails the Run with its partial output`; `a spontaneous exit settles every pending request and completes the loss signal` |
| A hung request | `a request the server never answers cannot hold a Run open`; `a request the server never answers expires and escalates` |
| An ignored interrupt escalating | `a Turn that ignores its interrupt is escalated to SIGTERM and then SIGKILL`; `an ignored SIGTERM is followed by SIGKILL, with no real time passing` |
| A client-bound request answered | `the reader answers a client-bound request that arrives between Runs`; `every client-bound request is answered with a JSON-RPC error` |
| A late frame dropped and counted, a current one applied | `a frame for a settled Turn reaches no Run and is counted`; `a frame for a turn nobody ever listened to reaches no Run` |
| A steer confirmed by client id | `guidance becomes a user observation only when the server echoes its id`; `guidance the server never echoes is delivered and never claimed`; `a steer sent before a cancel still confirms afterwards` |
| A usage baseline across Runs | `a resumed Run is charged for its own work only`; `a resumed Run's baseline excludes the Run before it`; `two usage frames in one Turn are differenced, not summed twice` |
| A background command awaited | `a result is unavailable while a background command the Run started is running` |
| An over-long line | `a line past the framing bound fails the Run rather than being truncated`; `a line past the framing bound is transport loss, not a silent truncation` |
| Stderr confined | `the child's stderr is one bounded diagnostic with its identities removed`; `provider identities are stripped from text on its way across` |
| An escalation armed for one Turn does not disarm the next | `an interrupt one Turn honoured does not disarm the ladder for the next` |
| A background terminal past the cleanup budget | `a background command past the cleanup budget escalates, and the Run still settles` |

The late-frame pair is the one worth naming, because it is the only place the
first spike exception is checked. Both tests assert **positively in both
directions**: the current Turn's frames arrive *and* the stale one reached no
Run and was counted. A test that only asserted the second half would pass for
an adapter that dropped everything.

## 4. Start, resume, steer, cancel, timeout, and shutdown pass live smoke tests ✅

Both scripts were run against a real, authenticated `codex app-server` on
2026-09-03 and both printed their success marker:

| Gate | Result |
| --- | --- |
| `npm run v2:codex:smoke` | `V2_CODEX_LIVE_SMOKE_PASS` — 21 checks, exit 0 |
| `npm run v2:codex:host-smoke` | `V2_CODEX_HOST_LIVE_SMOKE_PASS` — 5 checks, exit 0 |

The CLI in use was **codex-cli 0.153.0**, which is *newer* than the pinned
0.150.1 the deterministic protocol check compares against. That is worth
recording rather than tidying away: it means the adapter was proven live
against a release its vendored schema snapshot does not describe, and it
passed — which is the first-hand evidence that "an undeclared method is
ignored rather than rejected" is a real property and not just a comment. The
0.153.0 protocol adds four client requests and two server notifications and
removes nothing; every method and field this adapter declares is still there.

Two scripts, both opt-in, both in `release:check`:

- `npm run v2:codex:smoke`
  ([`scripts/v2-codex-live-smoke.mjs`](../../scripts/v2-codex-live-smoke.mjs))
  builds a real Session over the production set and drives all six operations
  against a real `codex app-server`, then reads the runtime probe and all three
  adapter probes after the Session Scope has closed.
- `npm run v2:codex:host-smoke`
  (`scripts/v2-pi-host-live-smoke.mjs codex`) launches Pi in RPC mode with only
  the v2 entry point and delegates to a Profile naming `codex`.

All 21 runtime checks passed, including the four that are Codex's own — one per
spike finding, plus one the spike could not have:

- the resumed Run answers from the first Turn's context on the same retained
  root, which is what resume *is* for a backend with no `thread/resume`;
- one steer confirmed by client message id produces exactly **one** user
  observation — two would mean the adapter counted an echo twice, none would
  mean guidance the model read went unrecorded;
- an interrupted Turn leaves the process, the root, and the Subagent alive;
- **the child process is actually gone**, read from `ps` rather than from the
  adapter's own counter. Codex is the one backend that owns an operating-system
  process, and "my probe reads zero" is the adapter's word for it. The gate
  reported `no App Server child remains after closure ([])` for both Sessions,
  alongside all three adapter probes reading zero.

The host gate additionally confirmed `no v1 module was loaded`: the answer came
back through `agent_start`, `agent_wait`, and `agent_result` with only the v2
entry point in the process.

## 5. A result is unavailable until background terminals are closed ✅

The spike found that asking Codex to run a shell command produces a
`commandExecution` item carrying a `processId`, and that such a command can
outlive the Turn that started it. So the execution tracks the command items it
started and **waits for them in a scope finalizer** rather than in its body.

That placement is the whole design. Waiting in the body would be waiting with
no bound at all, which
[ADR-0025](../adr/0025-v2-terminal-settlement.md) forbids outright. Waiting in
the execution scope's finalizer puts it under the runtime's **cleanup budget**,
so a wedged terminal escalates through M2's existing path — a
`cleanup-escalation` diagnostic, the BackendAgent closed, the conversation
marked lost — which kills the process and thereby ends the terminal. The
user-visible consequence is exactly the roadmap's wording: a result is
unavailable while a background terminal the Run started is still running.

Both halves are proven. `a result is unavailable while a background command
the Run started is running`: the Turn's completion frame arrives, the Run
reaches `finalizing`, `agent_result` answers `RunNotTerminal`, and only once
the command's completion frame arrives does the Run settle and the result
appear. And `a background command past the cleanup budget escalates, and the
Run still settles`: with the budget lowered and a command that never completes,
advancing the clock past it settles the Run with a `cleanup-escalation`
diagnostic, ends the process the terminal belonged to, and makes the next
resume answer `conversation lost`.

**One exemption, and it is deliberate: a cancelled Turn does not wait.**
`execution.ts` guards the wait on the Turn having finished on its own
(`completed` or `failed`). A cancelled Run is one the caller asked to stop, and
making it wait would make cancellation as slow as the command and then — past
the budget — destroy the conversation, which contradicts both the spike's
finding that `turn/interrupt` stops only the Turn and the matrix row that says
the Subagent stays resumable. A cancelled Run's result is explicitly partial
and says so; it never claims to be a complete account. The specification's
wording for user story 25 is unconditional, so this is recorded as a departure
in section 13 rather than left to the code comment that explains it.

The two finalizers are registered in the order their release order requires.
Scope finalizers run in reverse, so the **routing entry is acquired first** and
released last, and the command wait is acquired second and runs first — because
the wait needs frames to keep arriving while it waits.

## 6. Retained process and thread state never enter generic repositories ✅

Three checks, in `boundaries.test.ts`, and the third is new in kind:

- `a child process is spawned in the Codex adapter and nowhere else` —
  `node:child_process` is admitted inside `backend/codex/` and nowhere else in
  v2, by specifier, with no exceptions. Unlike Pi's package there is no host
  half of it that belongs elsewhere.
- `only the composition root may import the Codex adapter`, and
  `the Codex adapter may not import the runtime, the host, or presentation` —
  the same two directions the Pi and Claude adapters have.
- `App Server protocol and transport vocabulary stays inside the Codex adapter`
  — **by binding, even against the composition root.** This is the one the
  roadmap item is really about: "only the composition root may import the
  adapter" is not enough on its own, because the composition root legitimately
  names `createCodexBackend` and the probe, and if it could *also* name a
  transport, a JSON-RPC frame, a notification, or a child process then retained
  process state would have a path into the module that wires the Session. The
  confined list is the transport, the reader's routing table, the protocol
  shapes, and the child-process types; what is deliberately not on it is the
  factory, the id, the options, the probe, and the display name.

Each rule has a fixture test that shows it rejecting a violation and admitting
the legitimate case, and the real tree passes all three.

The repository's own snapshot is unchanged: `RunSnapshot` holds identity,
phase, cancellation, activity, usage, tool count, timestamps, and terminal
status, and no thread id, turn id, request id, or process id appears in it —
because none of those can leave the adapter to reach it.

## 7. The generic Run lifecycle and result model require no Codex-specific branch ✅

Stronger than at M5. `git status` for M6 lists **no file at all** under
`runtime/`, `domain/`, `presentation/`, or `application/`, and no change to
`backend/contract.ts`. The generic core is byte-identical to M5's, which was
byte-identical to M4's.

Three places where a Codex-specific branch would have been the easy answer, and
what was done instead:

- **Codex has no terminal transcript snapshot.** `turn/completed` carries the
  Turn's items, but they have already been reported one by one as they
  happened, so replaying them would duplicate the transcript rather than
  reconcile it. The adapter declares `terminalTranscriptSnapshot: false` and
  its reconciliation carries turns alone. No core branch; the capability was
  already there.
- **Codex's ending arrives on a stream that outlives the Run.** Both endings —
  the completion frame and the transport's own loss frame — reach the execution
  through the reader, in the reader's order. The core still receives one
  `TerminalBundle`.
- **Codex's cancellation needs signals the core has never heard of.** The
  SIGTERM/SIGKILL ladder is a fiber the adapter forks into its own Subagent
  Scope, armed by the interrupt handler and never awaited by it — because
  `agent_cancel` awaits the interruption of the execution fiber, and a handler
  that waited for the ladder would hold the caller's answer for as long as the
  ladder took.

## 8. A cleanup probe shows no retained process, reader, request, root, or steer ✅

The Codex native probe counts five things:
`liveProcesses`, `readerFibers`, `pendingRequests`, `retainedRoots`, and
`inFlightSteers`. A companion tally counts what *happened* and can never read
zero: `opens`, `closes`, `lateFrames`, `malformedFrames`, and
`oversizedLines`.

The split is the point. A probe carrying a count of past events could never
read clear, and the late-frame count is precisely a count of past events that a
maintainer needs.

`/subagent-v2` now prints three probe blocks, one per backend, proven by
`every backend's probe is reported beside the runtime's own, one block each` and
`the live report carries one block per backend, straight from the set`.

Every Codex test that builds a Session asserts
`codexProbeIsClear(nativeProbeAfterClose)`, and the conformance suite's own
leak check reads the same numbers through the rig — with `liveSubscriptions`
mapped to the reader-fiber count, because Codex's stream is Subagent-scoped and
there is one reader per BackendAgent rather than one subscription per Run.

## 9. The Codex compatibility matrix is complete ✅

[The compatibility matrix](compatibility-matrix.md) gains a Codex column with
one v2 proof per row, in the same three citation kinds the Pi and Claude tables
use: a shared conformance scenario, a named v2 test with its file, or one of
the two live gates. Every cited test name exists in the tree.

## 10. The pinned protocol check still guards the wire ✅ — and it fired ⚠️

`npm run codex:protocol:check` stays in `check`, unchanged by M6: neither the
script nor the vendored snapshot under `docs/codex-protocol/` is in this
milestone's diff. It is what proves the pinned binary still emits the methods
and fields the adapter declares; the adapter's own Schema declarations are what
prove it consumes nothing else.

**It passed for the whole of M6's development and then went red, and the cause
is not this milestone.** The `codex` CLI on the verification machine was
upgraded from 0.150.1 to 0.153.0 at 16:10 on 2026-09-03, part-way through the
work. The check compares the *installed* binary's generated schema
byte-for-byte against the vendored snapshot, so it now reports drift in
`ClientRequest.json` and `ServerNotification.json`.

The drift is **entirely additive**:

| Kind | Added in 0.153.0 | Removed |
| --- | --- | --- |
| Client requests | `plugin/reconcile`, `thread/items/list`, `thread/revert`, `thread/turns/list` | none |
| Server notifications | `modelProvider/authRecoveryStarted`, `modelProvider/authRecoveryCompleted` | none |

Every one of the eight notification methods and five request methods this
adapter uses is still present, and the live gate passed against 0.153.0.

**This is not M6's to close.** Bumping the pin is the documented six-step
procedure in `.agents/skills/codex-upgrade/SKILL.md`, and steps 4 and 5 of it
are the two v1 credentialed Codex gates and a *human* Desktop-coexistence
record. Re-vendoring the snapshot without those would replace a detector that
works with a green tick that means nothing. It is recorded in item 14 as
carried work.

The declarations are deliberately narrow. Eight notification methods and eight
item kinds are declared, an **undeclared method is ignored** rather than
rejected — a protocol addition must not be able to fail a Run — and a declared
method whose payload does not fit is one bounded diagnostic rather than a
crash. `an undeclared method is ignored rather than rejected` names the six
methods the spike saw and this adapter does not read.

## 11. Every change M6 made outside the Codex adapter directory ⚠️

Three changes to v2 code outside `backend/codex/` and `testing/codex/`. One is
the composition root doing its job, one is a genuinely missing
provider-neutral semantic, and one is test infrastructure. **None is
leakage** — nothing Codex-shaped left the adapter.

### (a) The composition root gains the backend — expected, not a finding

`host/production-backends.ts` builds a third backend and reports a third probe
block. This is the file whose entire purpose is to name backends, and the
boundary test's `COMPOSITION_ROOT_FILES` list already admitted it. The
confinement rule added in item 6 is what keeps this from being a hole: the
composition root may name the factory, the id, the options, and the probe, and
is rejected if it names a transport, a frame, a protocol shape, or a child
process.

Its tests changed with it: `host/production-backends.test.ts` (three backends
rather than two, plus a Codex end-to-end Run through the production set) and
`host/diagnostics-command.test.ts` (a third probe block in the fixture).

### (b) `backend/profile-fields.ts` gains `sharedFields` — a missing provider-neutral semantic

Codex recognizes `model` and `effort` and **not** `tools` or
`appendSystemPrompt`: a Codex thread carries its own tool set, and the
Profile's prompt is composed into the first Turn's input rather than
configured. It is the first backend to support a *subset* of the shared four,
and the shared module had no way to say so.

The first attempt reimplemented the shared validator inside the adapter, which
was a fork of the one module whose stated job is to be "the one place that
catches, so validation stays deterministic and total" — and it broke that
module's other promise, that "adding a fifth shared field is a change to this
module and nothing else". The review caught it. What is there now is a
`sharedFields` option: the backend names the shared fields it can express, the
others earn the ordinary unrecognized diagnostic, and — the part worth having
in one place — they are *not also validated*, so a Profile with an unsupported
`tools` hears one diagnostic rather than two.

This is category (a): what it means for a shared field to be unsupported is the
same wherever it happens. Proven through all three adapters' Profile tests,
which are unchanged for Pi and Claude because the default is still all four.

### (c) `testing/backend-session.ts` gains a `testClock` option — test infrastructure

The shared per-adapter Session helper could not provide a test clock, and Codex
is the first adapter whose *own* bounds live on the runtime clock: a per-request
budget and a two-rung signal ladder. The only honest way to prove either is to
advance a clock the test controls, and the lane forbids real sleeping outright.

The option is four lines, mirrors the one `session-rig.ts` has had since M2, and
changes nothing for a caller that does not pass it. Both existing rigs are
unaffected.

### The shared conformance suite was not touched

M4 loosened one shared check and M5 loosened the same one again. **M6 loosened
none.** `testing/conformance.ts` is byte-identical to M5's, which is the
strongest available answer to the M6 ticket's question about suite changes:
there were none to classify.

### Changes that are not semantics at all

- `boundaries.test.ts` — three new confinement rules and four fixture tests.
- `extensions/subagent-v2/testing/conformance-codex.test.ts` — the rig
  registration.
- `package.json` — the Codex rig in `test:v2:conformance`, and
  `v2:codex:smoke` / `v2:codex:host-smoke` in `release:check`.
- `scripts/v2-codex-live-smoke.mjs` — new; `scripts/v2-pi-host-live-smoke.mjs`
  accepts `codex`.
- `Makefile`, `README.md`, `CONTEXT.md`, `docs/v2/compatibility-matrix.md`,
  `docs/v2/roadmap.md` — the third backend, the M6 glossary terms, the Codex
  matrix column, and the milestone status.

## 12. The Codex Desktop coexistence evidence gate — an M7 question ⏳

`docs/codex-desktop-coexistence-release.md` records a human-only gate: the v1
Codex resume smoke, run with an idle-process pause, while Codex Desktop stays
open. It exists because a retained ephemeral App Server process must not
disturb a Desktop session sharing the same Codex home.

**M6 changes nothing that gate evaluates.** The v2 adapter retains the same
design the evidence is about — one `codex app-server` child per Subagent, one
ephemeral root thread, `ephemeral: true`, and no stored rollout — and the v1
adapter and its recorded evidence are untouched. `npm run
codex:retained-release:check` is unchanged, and it is red for the reason it was
red before M6 began: the human Desktop evidence for `codex-cli` 0.150.1 has
never been recorded, which the README already states. M6 neither closed that
nor made it worse.

Re-recording the evidence against the v2 adapter is deliberately **out of M6's
scope** and is an M7 cutover question: it is only worth spending a human's
attention on once v2 is the implementation that ships. M7's own gate should
either re-run it against v2 or record why the v1 evidence carries over.

## 13. Recorded departures — from the M6 specification, and from v1

Read this section if you are checking compliance. It has two halves, and the
first is the one a reader is likely to want: the three places this
implementation knowingly does something other than what the M6 specification
text says.

### From the specification

**The context gauge is `tokenUsage.last`, not the cumulative total.**

The M6
specification text asks twice for "the cumulative total as the context gauge",
and this adapter does not do that. The two numbers measure different things:
`total.totalTokens` is what the whole thread has been billed for and grows
without bound, while occupancy is what the model is carrying right now and is
bounded by `modelContextWindow`. A gauge built from the cumulative figure would
exceed its own denominator after two Turns, and the domain describes a
`ContextGauge` as "how much of a Conversation's context window is occupied
right now" with `window` as its denominator. v1 chose `last` for exactly this
reason and said so in a comment; the port keeps it, and
`the context gauge is the last request's total, and its window when there is
one` states it as an assertion.

**Tool progress is reported for tool-shaped items only.** User story 17 reads
"item start and completion translated to `tool_progress` by item id, with
command execution, file change, MCP tool call, and web search items *also*
producing a tool-call message part", which taken literally asks for progress on
every item kind. Only those four get it. A plan or a reasoning summary produces
activity instead, because `mergeToolEntry` in the domain *creates* a tool entry
for a `callId` it cannot join — so progress on a reasoning item would put a
nameless entry in the Run's tool list, and a Run whose tool list held its own
thinking would read as a Run that had called a tool nobody can name.

**A cancelled Turn does not wait for its background terminals.** User story 25
is unconditional; the implementation exempts cancellation. Section 5 has the
reasoning.

**`turn/interrupt` carries no request bound.** User story 13 asks that "every
JSON-RPC request to carry a bound", and the interrupt is written through
`transport.send`, which allocates an id and registers no pending entry and no
timer. The story's purpose is met — its "so that" is "a wedged-but-alive
process cannot hold a Run open", and nothing waits on this request, so it
cannot hold anything open — and the bound it has instead is a better one: if
the interrupt is not honoured within a rung, SIGTERM follows. Routing it
through the bounded `request` path would mean either awaiting it inside an
interrupt handler, which would hold `agent_cancel`'s answer for as long as the
server took, or forking from that handler, which is what the ladder already is.

### From v1

**Stderr is one diagnostic per Run, with provider identities removed.** v1
reported every chunk. The first thing a child says on stderr is the one that
explains it, and the identities — the root thread, the turn, the item ids, the
client message ids, and the id-bearing JSON keys — are stripped longest-first
so a turn id containing a thread id as a prefix cannot leave half of itself
behind.

## 14. Gaps carried into M7

- **The `codex` CLI has moved past the pinned protocol version** (item 10). The
  installed CLI is 0.153.0 and the vendored snapshot describes 0.150.1, so
  `npm run check` is red on this machine at the protocol step and nowhere else.
  The drift is additive and the live gate passed against the newer release, but
  bumping the pin is the `codex-upgrade` procedure — two v1 credentialed gates
  and a human Desktop record — and it is deliberately not folded into M6.
- **The Codex Desktop coexistence evidence has not been re-recorded against
  v2** (item 12), by design. The CLI upgrade above now makes this the same
  piece of work rather than two.
- **M4's daily-driver soak is still open.** Neither M5 nor M6 closed it and
  neither was meant to; see [the soak record](soak.md).
- **M5's five Claude gaps are still Claude's.** M6 touched no Claude code, so
  every entry in [the M5 exit gate](m5-exit-gate.md), section 13, carries
  forward unchanged.
- **The signal ladder has no test for a *server-initiated* interrupt.** The
  ladder stands down when the Turn it was armed for reports itself interrupted,
  and `an interrupt one Turn honoured does not disarm the ladder for the next`
  covers the case where this adapter asked for it. A Turn the *server* decides
  to interrupt with no cancel outstanding arms no ladder at all, so there is
  nothing to stand down — correct by construction, and untested because there
  is no observable difference to assert on.
- **`AbortController` and `AbortSignal` stayed a Claude-only admission.** The
  M6 specification allowed the Codex adapter to name them under the same
  directory admission M5 established. It does not need to: cancellation is
  interruption plus `turn/interrupt` plus a signal ladder, and no provider
  cancellation primitive appears anywhere in `backend/codex/`. The admission
  was therefore **not** widened, and `the provider's cancellation primitive is
  admitted in the Claude adapter and nowhere else` still says exactly that.
