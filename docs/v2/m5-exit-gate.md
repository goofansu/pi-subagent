# M5 exit gate

**Status:** Passing. Every item is closed.
**Date:** 2026-09-03
**Verified against:** [the v2 roadmap](roadmap.md), milestone M5.

M5 is the milestone that tests the abstraction rather than the product. M4
proved the backend contract could carry the backend v2 was designed around;
this one asks whether a *second*, differently-shaped provider fits through the
same seam — and the roadmap is explicit that the answer is the program-level
health signal:

> If Claude and Codex can be ported through adapter-local work plus new
> conformance fixtures, the seam is healthy. If each backend changes the Run
> lifecycle, pause the port and repair the abstraction before continuing.

**The seam is healthy.** The generic Run lifecycle, the settlement path,
arbitration, the mailbox, the intake, the repository, the result store,
delivery, the domain, presentation, and the façade are byte-identical to M4.
The backend contract is unchanged: not one member added, removed, or re-typed.
Section 11 below enumerates everything M5 touched outside
`extensions/subagent/backend/claude/` and classifies each entry.

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
| `npm run test:v2` | 979 tests, 971 pass, 8 skipped |
| `npm run test:v2:conformance` | 153 tests, 145 pass, 8 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` |

The three v1 lanes are byte-identical to M4's: **M5 changed no v1 file.** The
v2 lane grew from 807 tests to 979, and the conformance lane from 115 to 153 —
the 38 new ones being the Claude rig's, which is the shared suite plus its own
no-skips assertion.

The skip list is unchanged at eight, all of them `FakeOneShotBackend
conformance: …` scenarios about capabilities that backend declares it does not
have. **The Claude rig skips nothing**, and a test asserts the empty list.

## 2. Claude passes all shared conformance suites ✅

All 37 shared scenarios pass for the real Claude backend, registered as
`ClaudeBackend conformance: <scenario>` by
[`testing/conformance-claude.test.ts`](../../extensions/subagent/testing/conformance-claude.test.ts).

What makes the pass mean something is what is *not* stubbed. The rig builds the
production `createClaudeBackend` and injects a scriptable stand-in through the
loader the adapter already has for that purpose, so validation, the identity
state machine, the per-Run Query, the client-owned input stream, the steering
correlation, the translation, and the cancellation path are all the real code.
The rig supplies two things and only two: the resource counters the suite asks
every rig for, and the correlation that tells the stand-in which Run each
execution belongs to.

**The spec allowed for skips and none was needed.** Ticket 05 permitted skips
"where the terminal transcript snapshot capability gates a scenario". No shared
scenario turns out to be gated on that capability. The two that come closest
are worth naming, because a reader will look for them:

- `reconciliation-does-not-double-count` passes because Claude's terminal
  reconciliation carries **turns and the model and no usage at all**. The
  frames were the transcript and there is no authoritative message list to
  recompute a total from, so there is nothing to double count and the streamed
  figure is the reported one exactly.
- `a-replayed-transcript-adds-no-usage` is the one scenario Claude demonstrates
  *literally* rather than by analogy: the fixture's resumed Query replays
  history the provider flags, and the live frames answer from what the
  conversation already holds without spending anything. Pi's fixture had to
  approximate this.

Every scenario is also a leak test: `assertNoLeaks` runs after each one and
requires opens minus closes to be zero, live executions zero, live
subscriptions zero, and the runtime probe clear.

## 3. Claude-specific tests cover the spike's findings ✅

The M0 spike recorded two exceptions and several behaviours v1 earned the hard
way. [`testing/claude/claude-backend.test.ts`](../../extensions/subagent/testing/claude/claude-backend.test.ts)
covers each, named for what it proves so that none can be mistaken for a
duplicate of a shared scenario and deleted:

| Finding | Test |
| --- | --- |
| The SDK has no open call, so a BackendAgent begins holding no identity (ADR-0023 exception 1) | `a BackendAgent that has never run holds no conversation to resume`; `opening loads the SDK and starts no Query, because there is nothing else to open` |
| The identity arrives as a side effect of the first Run | `the first Run's identity frame is what makes a later Run resumable` |
| A resumed Query can replay history before its attachment boundary | `a resumed Query's replayed history is not part of the resumed Run` |
| Attachment must never fall back to a fresh conversation | `an identity that differs from the retained one fails without falling back`; `a boundary frame with a malformed identity fails the Run` |
| A result frame is a Turn boundary, not settlement | `a result frame with guidance still outstanding is a Turn boundary, not settlement` |
| Confirmation needs provider evidence | `guidance becomes a user observation only when the provider echoes it`; `guidance the provider never acknowledges is delivered and never claimed` |
| One Control provider-visible at a time | `only one Control is provider-visible at a time` |
| `modelUsage` reports models the Run never asked for (ADR-0027) | `every model the Query ran is charged, including one the Profile never asked for` |
| A Query aborted early produces no frames at all | `a Run cancelled before any frame settles cancelled with nothing at all` |
| A terminal answer survives a later cancel | `a successful result already observed survives a later cancel` |
| Provider text never crosses | `a result the provider marked as an error fails with a confined diagnostic`; `SDK stderr becomes one bounded diagnostic and keeps not a word of itself` |
| Delivery failure is diagnostic-only | `guidance the input stream will not take is a control diagnostic and nothing else` |
| Nothing is retained between Runs but the identity | `nothing is left iterating or open once a Run has settled` |

The stand-in reproduces the SDK's behaviour deliberately rather than politely —
`a Query aborted before it is iterated produces no frames at all`
([`stand-in-query.test.ts`](../../extensions/subagent/testing/claude/stand-in-query.test.ts))
— because a double that always emitted an init frame would make the adapter's
zero-observation path untestable.

Pure translation is proven separately from recorded frame shapes in
[`backend/claude/translate.test.ts`](../../extensions/subagent/backend/claude/translate.test.ts):
32 tests covering every observation kind produced, tool-use id merging, the
two-model usage sum, nonnegative differencing across two result frames, the
derived gauge and its omission, and turn counting with its sidechain and
tool-parented exclusions.

## 4. Start, resume, steer, cancel, timeout, and shutdown pass live smoke tests ✅

`npm run v2:claude:smoke` builds a real Session runtime over the production
backend set and drives all six against a real streaming Query. Recorded run,
2026-09-03, model family `haiku`:

```
v2 Claude runtime live gate (model family: haiku)
  ok — start settles completed
  ok — start returns the answer
  ok — resume answers from the first Run's retained conversation
  ok — resume uses a distinct Run id
  ok — a resumed Run is charged only for its own work
  ok — steering is admitted
  ok — steering reaches the answer
  ok — a confirmed steer produced exactly one user observation (1)
  ok — cancel is admitted and the Run settles cancelled
  ok — a cancelled Query leaves the conversation resumable (started, completed)
  ok — shutdown refuses new work
  ok — every settled Run produced exactly one notification (run-ka06-1, …, run-ka06-5)
  ok — no notification carries a provider identity
  ok — the runtime probe is clear after closure ({...all zero})
  ok — both adapter probes are clear after closure ({...all zero})
  ok — a Run past its default timeout is cancelled with reason timeout (cancelled, timeout)
  ok — the runtime probe is clear after the timeout Session ({...all zero})
  ok — both adapter probes are clear after the timeout Session ({...all zero})

V2_CLAUDE_LIVE_SMOKE_PASS
```

`npm run v2:claude:host-smoke` drives the other half — the surface a user has —
by launching Pi in RPC mode with only the v2 entry point loaded and a Profile
naming `backend: claude`. Recorded run, same day:

```
v2 host live gate (claude)
  ok — the Pi process exited cleanly
  ok — agent_start was called
  ok — agent_result was called
  ok — the subagent's answer came back
  ok — no v1 module was loaded

V2_CLAUDE_HOST_LIVE_SMOKE_PASS
```

`npm run v2:pi:host-smoke` was re-run after the host gate became one script
taking the backend as an argument, and still passes:
`V2_PI_HOST_LIVE_SMOKE_PASS`.

All three are in `npm run release:check` and none is in `npm run check`:
provider quota is spent on release, not on every commit.

### One live finding, and it was the gate's mistake rather than the adapter's

The first live run failed `a cancelled Query leaves the conversation resumable`.
The gate was cancelling the **first** Run of a fresh Subagent, and a Subagent
whose first Run is aborted before its identity-bearing frame arrives never
acquired an identity at all — the spike's Query-loss shape. Reporting that
conversation as lost is correct, not a defect. The gate now cancels a Run on a
Subagent that already holds an identity, which is the finding it is actually
about, and the check passes.

The second first-run failure was the timeout Session's bound. Eight seconds was
long enough for a `haiku` Run to finish; three is inside the first turn, given
that a Claude Query spends seconds starting its subprocess before the first
frame arrives. Both checks now print what actually came back, so a future
failure says why.

## 5. Resume does not charge prior conversation usage to the new Run ✅

Two proofs, and they measure different things.

`ClaudeBackend conformance: a-resumed-run-excludes-prior-usage` drives two Runs
on one conversation and asserts each is charged its own figure.

The mechanism is worth stating, because it is *not* subtraction. Claude's
`modelUsage` and `total_cost_usd` are cumulative across the turns of one Query
and start fresh on a resumed one. The adapter's translator is created **inside
the execution and discarded with it**, so a resumed Run's first cumulative
reading is charged in full and every later one within that Run is differenced
against the previous — which makes Run-locality true by construction rather
than by a baseline the adapter has to remember to subtract. `two result frames
in one Run are differenced, not summed` and `a provider reset charges the new
reading rather than a negative delta`
([`translate.test.ts`](../../extensions/subagent/backend/claude/translate.test.ts))
prove the two halves.

Live: `a resumed Run is charged only for its own work` in the runtime gate.

## 6. Provider replay does not create duplicate transcript items or usage ✅

Two filters, because the provider marks only one of the two kinds:

- A frame carrying `isReplay` is dropped outright.
- On a resumed Query, **every** frame before the identity boundary is dropped,
  flagged or not. That is the filter that matters, because the M0 spike
  observed zero replay frames and explicitly did not prove replay never
  happens.

`a resumed Query's replayed history is not part of the resumed Run` drives both
through the Session runtime: the resumed Run's transcript holds exactly its own
answer, with no replayed history item and no duplicate of the first Run's, and
its usage is its own figure.
`ClaudeBackend conformance: a-replayed-transcript-adds-no-usage` is the shared
scenario, which for Claude is the literal case rather than an analogue.

## 7. The generic Run lifecycle and result model require no Claude-specific branch ✅

Proven two ways.

**By enumeration.** Section 11 lists every file M5 touched outside the Claude
adapter directory. Nothing in `domain/`, `runtime/`, `presentation/`, or
`application/` changed at all, and `git diff` over those four directories plus
`backend/contract.ts` since M4 is empty.

**By the boundary test.** Four new rules, each with a fixture proving it rejects
what it is for and admits what it is not. Three are confinements; **the fourth
is a relaxation, and it is named as one below rather than smuggled in with
them**:

| Rule | Kind | Fixture test |
| --- | --- | --- |
| The Claude SDK is named inside `backend/claude/` and nowhere else — not even by the adapter's own test doubles, and not another package under the same scope | confinement | `the Claude SDK is rejected outside the Claude adapter, and admitted inside it` |
| Only the composition root may import the adapter | confinement | `only the composition root may import the Claude adapter` |
| The adapter may not import the runtime, host, presentation, the façade — or the *other adapter* | confinement | `the two adapters are siblings and neither may name the other` |
| `AbortController` and `AbortSignal`, previously confined to the host boundary, are admitted inside the Claude adapter | **relaxation** | `the provider's cancellation primitive is admitted in the Claude adapter and nowhere else` |

The relaxation is classified in section 11 as a provider-neutral change, with
its reasoning. It is narrow in three ways: it is by *directory* rather than by
dropping the words from the list, it admits only those two words and not
`Effect.runPromise` or `ManagedRuntime`, and the core still cannot name either.

The SDK confinement is by the **exact specifier** rather than the
`@anthropic-ai/` prefix, because the exemption is for that SDK and not for the
scope it happens to live in; the fixture proves a sibling package under the
same scope is still rejected inside the adapter.

`the real v1 and v2 trees hold the boundary` runs every rule against the actual
trees.

## 8. A cleanup probe shows no retained Query, input stream, or identity ✅

The Claude adapter keeps its own probe, outside the backend contract, in
[`backend/claude/probe.ts`](../../extensions/subagent/backend/claude/probe.ts):
live Queries, open input streams, and retained conversation identities. It is
asserted zero after the Session Scope closes in three places — all 37
conformance scenarios, the Claude-specific tests that read
`claudeProbeIsClear`, and both live-gate Sessions.

Beside it, and deliberately **not** part of it, is a lifecycle **tally**:
BackendAgents opened, and closes that took effect. It is separate because it
answers a different question and never returns to zero, so a probe carrying it
could never read clear. It exists because Claude has no SDK close call to count
twice, and "close is idempotent" needs a number rather than a claim:
`ClaudeBackend conformance: close-is-idempotent` reads one effective close
against two calls.

`nothing is left iterating or open once a Run has settled` checks the shape
between Runs specifically: the identity is retained across a resume, and the
Query and its input stream are not.

## 9. The Claude compatibility matrix is complete ✅

[The matrix](compatibility-matrix.md) gains a section — *The Claude column,
proven in v2* — with one v2 proof per Claude row, citing a conformance
scenario, a named v2 test, or one of the two live gates. It also adds five rows
the M0 matrix had no column shape for and that are Claude's own: environment
inheritance, the depth and delegation policy, the three usage rows, replay
filtering, the failure endings, and the open failure.

## 10. The compatibility matrix's `agent_steer` delivery gap is closed ✅

Not an exit-gate item, but the M4 gate carried it into M5 explicitly:

> `controlsByRun` is not a real assertion in the shared suite for Pi. …
> A rig for a backend whose consumer is not eager will not have this problem.

Claude is that backend, and the gap is closed.
`ClaudeBackend conformance: a-control-cannot-leak-into-the-next-run` asserts
the **delivery** side — `controlsReceived: ["only for the first Run"]` — as
well as the leak side. It can, because the fixture does not cancel the first
Run: the script's `await-input` step cannot finish until the Control has
actually been pushed, so the Run reaches its result frame only after delivery
has happened. A fixture that cancelled would be racing the cancel against the
consumer, which is exactly the race the Pi gate recorded.

---

## 11. Every change M5 made outside the Claude adapter directory

This is the roadmap's most important program-level signal, so it is enumerated
rather than summarised. The rule the roadmap sets is that each change must be
classifiable as **(a)** a missing provider-neutral product semantic, backed by
a fake-backend test, or **(b)** provider-specific leakage, which must be pushed
back into the adapter.

**Nothing was classified (b).** Nothing had to be pushed back, and the backend
contract is unchanged.

### (a) Missing provider-neutral semantics — four

**1. The depth environment key moved to `backend/depth.ts`** (from
`backend/pi/depth.ts`).

The **Depth** constraint binds every backend, not one of them: delegation is
one level deep whichever backend ran the parent, and a Bash-launched grandchild
Pi has to read the same variable whichever adapter set it. Two adapters each
spelling their own constant would be two places for the two to drift, and the
drift would only ever show up as a grandchild that started at depth zero. This
is the entry the spec predicted would be first, and it was.

`backend/pi/depth.ts` re-exports the moved symbols, so the Pi adapter's own
surface is unchanged and its tests are untouched.

*Fake-backend proof:* none is possible or needed — the constant has no
behaviour. What it has instead is a proof on each side: `the Bash spawn carries
the child depth without mutating the environment`
(`backend/pi/options.test.ts`) and `the child environment is the operator's,
plus the depth key` (`backend/claude/options.test.ts`) read the *same* exported
key, so a rename that broke either would fail both.

**2. The diagnostics command reports one probe block per backend**
(`host/diagnostics-command.ts`).

`AdapterProbe` was one flat block of counts. A Session is built from a *set*,
and a set holds as many backends as it likes; merging their probes would make
"which adapter is still holding something" unanswerable, which is the only
question a probe exists to answer. It is now a record keyed by backend name,
and the report prints `Backend probe (pi):` and `Backend probe (claude):`.

*Fake-backend proof:* `every backend's probe is reported beside the runtime's
own, one block each` and `a set with no probe of its own reports the two
runtime blocks alone` (`host/diagnostics-command.test.ts`) drive the formatter
directly, including the empty-record case a set with no probes supplies.

**3. The Run correlation helper became provider-neutral**
(`testing/correlate.ts`, new; `testing/pi/correlate.ts` now re-exports it).

`correlateRuns` was typed against `StandInPiSession`. It now reaches a stand-in
through a two-method `RunCorrelation` interface that names no provider, so one
copy serves all four rigs. A second copy per adapter would have been a second
place for the two to drift.

*Fake-backend proof:* the two fake rigs do not use it (they know their own Run
ids), and both Pi rigs continue to pass unchanged through the re-export.

**4. The provider's own cancellation primitive is admitted inside an adapter**
(`boundaries.test.ts`).

`AbortController` and `AbortSignal` were confined to the host boundary, along
with `Effect.runPromise` and `ManagedRuntime`. The rule's purpose is that the
*core* is never handed a signal to poll: the contract expresses cancellation as
interruption, and ADR-0028 says so in as many words. A provider whose only
cancellation surface is an `AbortController` — which the Claude SDK's options
bag is — is exactly the case an adapter exists to absorb, so the adapter
constructs one, owns it for the Run, and aborts it in a scope finalizer.

Admitting the two words **by directory** rather than dropping them from the
list is what keeps the rule doing its job. `Effect.runPromise` and
`ManagedRuntime` stay forbidden in the adapter too: an adapter that started its
own runtime would have stopped living inside the caller's Effect, and the
fixture proves that half as well as the admitted half.

This is provider-neutral rather than Claude-specific because the rule it
changes is about the core, not about Claude: any adapter for any provider whose
cancellation is a signal will need the same admission, and `CONTEXT.md`'s **Host
boundary** entry now records the exception where the rule itself is documented.

*Fake-backend proof:* none applies — a boundary rule is not runtime behaviour.
What it has instead is the fixture above, which is a proof in both directions
on a disposable pair of trees.

**5. The Session wiring for an adapter's own tests became shared**
(`testing/backend-session.ts`, new; both adapter rigs now call it).

`withPiSession` and `withClaudeSession` had the same forty lines of Session
wiring — six services, a policy, a sink, a counter set, and a probe read after
the Scope closes — differing only in which backend they built. With one real
adapter that was a copy; with two it is a place for the two to drift, and with
Codex at M6 it would be three. The shared function names no provider and takes
a `Backend` it never looks inside; everything provider-shaped stayed with each
rig.

*Fake-backend proof:* not applicable, and not needed — the two fake rigs use
`testing/session-rig.ts`, which is untouched, and both adapter rigs' full test
files pass unchanged through the extraction.

### One shared conformance check loosened — the same one M4 loosened

`late-events-cannot-mutate-a-terminal-run` (`testing/conformance.ts`).

The scenario's own assertions about *what* the Run says are unchanged. What
changed is the **non-vacuity** check — the one that insists something late
actually happened, so the scenario is not passing for free. M1 required
`lateObservations >= 1`; M4 widened it to `lateObservations + lateEvents >= 1`
because Pi's provider says its last word during native cleanup, after the
intake has been sealed. M5 widens it again, to include `lateEndings`.

The reason is structural rather than convenient. Claude's event channel is the
Query's async iterable, created and destroyed with the Run Scope — the M0 spike
says so in as many words: *"late events cannot reach a terminal Run by
construction."* So nothing of Claude's can reach the seam late. The late thing
in a Claude fixture is the **interruption**, arbitrated against an ending the
Run already had and counted as a late ending. That is the strongest of the
three cases rather than a weaker pass: a channel that cannot talk late cannot
mutate a terminal Run at all.

Ticket 05 offered two ways to satisfy its rule — no change to the shared suite,
or a change that is a provider-neutral scenario every existing rig also passes
— and this is strictly neither, exactly as M4's was. It is recorded here as a
loosening rather than dressed up as a new scenario. **Both fakes and Pi still
pass the scenario by their original counters**, so the widening admits a third
shape without weakening the two it already accepted. A reviewer who disagrees
should reach for a separate `a-terminal-run-absorbs-a-late-ending` scenario
rather than restore the narrower assertion, because the narrower one is not
satisfiable by a backend whose event source dies with its Run.

### Changes that are not semantics at all

For completeness, the rest of what M5 touched outside `backend/claude/`:

| File | What changed |
| --- | --- |
| `backend/pi/depth.ts` | Re-exports the moved key, so the Pi adapter's surface is unchanged. |
| `backend/pi/options.ts` | One import line: the key now comes from `backend/depth.ts`. |
| `host/production-backends.ts` | New. The production set: Pi and Claude, host facts from Pi, one probe block per backend. |
| `host/production-backends.test.ts` | New. What the set holds, and a Profile naming `claude` run end to end through it. |
| `host/diagnostics-command.test.ts` | The per-backend probe blocks, in the formatter and through the command's own wiring. |
| `index.ts` | Uses the production set instead of the Pi-only set. |
| `testing/backend-session.ts` | New. The Session wiring both adapter rigs share. |
| `testing/correlate.ts` | New. The Run correlation, provider-neutral. |
| `testing/pi/correlate.ts` | Re-exports it, so the Pi rigs' imports are unchanged. |
| `testing/pi/pi-rig.ts` | Calls the shared Session wiring instead of its own copy. |
| `testing/host-rig.ts` | Can supply adapter probes, so the diagnostics command's wiring is testable. |
| `testing/claude/stand-in-query.ts` | New. The scriptable stand-in Query. |
| `testing/claude/stand-in-query.test.ts` | New. The stand-in, tested as the thing it is. |
| `testing/claude/claude-rig.ts` | New. One Session runtime over the real Claude backend. |
| `testing/claude/claude-backend.test.ts` | New. The Claude-specific cells. |
| `testing/claude/conformance-rig.ts` | New. The shared suite's Claude fixtures. |
| `testing/conformance-claude.test.ts` | New. Registers the suite and asserts the empty skip list. |
| `testing/conformance.ts` | The one loosened non-vacuity check, above. |
| `boundaries.test.ts` | The four rules above and their fixtures; the production set added to the composition root; the two host tests that may name the adapters. |
| `scripts/claude-live-smoke.mjs` | New. The opt-in runtime live lane. |
| `scripts/pi-host-live-smoke.mjs` | Takes the backend as an argument, so one script serves both host lanes. |
| `package.json`, `Makefile` | The Claude rig in the conformance lane; the two live gates in the release gate and behind a `make` target. |
| `README.md` | Which backends v2 offers, and the four v2 live gates. |
| `docs/v2/compatibility-matrix.md`, `docs/v2/roadmap.md`, `CONTEXT.md`, `docs/adr/0028-v2-backend-contract.md` | The Claude column, the milestone status, the M5 glossary terms, and the record that the contract held a second time. |

Nothing in the runtime's Run lifecycle, settlement path, arbitration, mailbox,
intake, repository, result store, or delivery changed. **The seam is healthy by
the roadmap's own measure, for the second provider in a row**, and M6 should be
able to add Codex through adapter-local work plus new conformance fixtures.

---

## 12. Recorded v2 differences from v1

Six, all deliberate.

**One fixed attachment-failure message instead of two.** v1 distinguished
"Claude continuation attachment failed" from "Claude query returned an invalid
conversation identity". v2 uses one message for all four ways the identity goes
wrong — a boundary frame with no identity, a malformed one, one that differs
from the retained one, and a Query that could not be started against a retained
conversation. They mean the same thing to a reader: this Run could not be tied
to the conversation it was supposed to continue, and the second message said
nothing the first did not.

**The steering consumer is not eager.** v1 subscribed to the Control source and
buffered every admitted Control in an adapter-local array. v2 takes one at a
time, and only when the provider-visible slot is free. ADR-0026's mailbox is
where pending guidance is bounded and where a caller learns at once that there
is no room; an adapter that emptied it into an unbounded array would have moved
the queue somewhere with neither a bound nor an answer for the caller. It is
also what makes `ClaudeBackend conformance: a-full-mailbox-answers-immediately`
mean something, and what closed the Pi gate's delivery-assertion gap.

**No result link.** The only link candidate a Claude Run has is the
conversation identity, and ADR-0024 forbids that from crossing the seam.
Whether a non-identifying link is worth surfacing is an M7 question, and the
adapter emits none rather than emitting something identifying.

**The result's text answers only when the last assistant frame did not.** v1
reported the result frame's `result` string as an assistant Fact
unconditionally, which put the answer in the transcript twice whenever the
model had already said it in an assistant frame. v2 emits it only when the
preceding assistant frame carried no text — a Run whose model only called tools
and whose summary lives on the result frame still gets its answer, and a Run
whose model answered normally gets it once.

**The result frame's own `model` field is not read.** v1 read it, with a
comment saying it did so "for wire compatibility even though the installed
SDK's result type does not currently declare the field". It still does not
declare it. The model a Claude Run ran is named by the init frame, which
always precedes and is provenance rather than accounting; letting an
undeclared field on a later frame override it would let *accounting* rewrite
provenance. A Run that fails before any assistant frame still names its model,
which is the case the tolerance existed for — `a Run that fails before
answering still names the model it ran`.

**A tool result's block list is read, not only its string form.** v1 read a
tool-result block's `content` only when it was a string. The SDK's own type
allows a block list, which is what a structured tool return looks like, and a
`tool` transcript item that read empty for those would lose the part of a tool
call a reader usually wants. `claudeToolResultText` joins the text blocks.

---

## 13. Gaps carried into M6

**1. The Claude context gauge is a derivation, not a provider figure.** The SDK
reports no occupancy, so the adapter computes the primary model's input plus
cache-read plus cache-creation tokens over that model's `contextWindow`. Two
things about it are worth knowing. It reads only the primary model's entry,
because occupancy is not additive and summing two models' inputs against one
model's window would report a conversation as several windows full. And the
underlying figures are *cumulative across the turns of the Query*, so on a
steered Run the gauge grows with each turn rather than tracking a true
occupancy. The live gate did not show it misleading, but nothing yet proves it
useful either. The decision is in
[`translate.ts`](../../extensions/subagent/backend/claude/translate.ts) with
its reasoning, so it is one documented rule rather than an invention per
reader.

**2. A Query that never ends its stream holds the Run open.** After the Run is
semantically complete the adapter closes the input and reads to the end of the
stream, which is how a Query shuts down gracefully rather than being aborted
from under a subprocess that was about to finish. A provider that closed the
input and never ended the stream would leave the Run active until the Session's
run timeout or a cancel. That is the same bound every other provider turn has,
but it is a bound outside the adapter rather than inside it — the same gap the
M4 gate recorded for a Pi steer the session is genuinely working on.

**3. `subagent_type` is treated as a sidechain marker on trust.** Turn counting
excludes an assistant frame that is parented to a tool use *or* carries a
`subagent_type`. The first is v1's rule and is well understood; the second is
this milestone's addition, reasoned from the SDK's own documentation rather than
from an observed frame. `Agent` and `Task` are always disallowed, so a sidechain
should be rare — but if one turns up with neither marker it would be counted as
a turn of the conversation.

**4. The primary model is matched by key or canonical name, and not otherwise.**
`modelUsage` is keyed by the raw model string, which for a gateway or a cloud
provider is not the id the init frame reported. The adapter tries the key, then
each entry's `canonicalModel`, and then gives up and omits the gauge. It does
*not* fall back to "the only entry there is", because the spike found that even
a single-entry `modelUsage` can be an auxiliary model. A Bedrock or Vertex
deployment whose entries carry no `canonicalModel` would therefore show no
context gauge. That is the honest failure rather than a wrong number.

**5. A discarded Control the provider later acknowledges is silent.** When a
successful result frame cannot be correlated to any input the Run owns, the
outstanding guidance is discarded and the Run settles — that is user story 16
and v1's rule. The consequence is that if the provider *then* echoes that
guidance, on the way down, the echo changes nothing: no user observation, no
diagnostic. Admission told the caller the Control was accepted, which was true,
and nothing else about it is.

The alternative was considered and is worse. Waiting for an echo that may never
come is not a settlement policy (ADR-0025 is explicit), and emitting the user
message when it happens to arrive would grow a transcript whose contents depend
on how a race went — with the guidance appearing *after* the answer it did not
shape. It is deterministic silence rather than nondeterministic noise, and the
code comment at the discard says so.

**6. The soak is still M4's open item.** M5 did not close it, and it was never
M5's to close. [`soak.md`](soak.md) is the record.
