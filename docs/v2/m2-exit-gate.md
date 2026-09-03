# M2 exit gate

**Status:** Passed. **M2 is complete.**
**Date:** 2026-09-02
**Verified against:** [the v2 roadmap](roadmap.md), milestone M2.

This document verifies every M2 exit-gate item against the merged work, so that
M3 starts from an explicitly closed milestone. It follows the shape of
[the M1 exit gate](m1-exit-gate.md).

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
| `npm run test:v2` | 452 tests, 444 pass, 8 skipped |
| `npm run test:v2:conformance` | 77 tests, 69 pass, 8 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` |

The v1 lane's numbers are unchanged from M1: **M2 changed no v1 file.** Outside
the v2 tree, M2 changed `tools/import-specifiers.ts` (a named-import reader the
boundary test needed), the operation-semantics document, ADR-0028 (an amendment
notice), ADR-0029 (its status), ADR-0030, the Schema spike findings, this
record, the roadmap, and the glossary.

### The skips are all visible and all explained

| Lane | Skip | Why |
| --- | --- | --- |
| v1 conformance | `claude conformance: terminal-transcript-healing` | Unchanged from M0. The Claude adapter has no wire transcript snapshot. |
| v1 suite | the same scenario, reached through the full suite | As above. |
| v2 | 8 × `FakeOneShotBackend conformance: …` | The one-shot backend declares no resume, no steering, and no snapshot. |

The one-shot skip list grew from six to eight, and both new ones are about a
mailbox a backend with no steering capability has no way to have: `a-full-
mailbox-answers-immediately` and `a-closed-mailbox-refuses-after-cancel`.
`FakeResumableBackend` skips **nothing**, and both rig test files assert their
own skip list, so a skip appearing for a new reason fails the lane.

## 2. The complete public lifecycle works against both fake backends ✅

All six public operations plus shutdown, driven through
[`SubagentSupervisor`](../../extensions/subagent/runtime/supervisor.ts):

| Operation | Where it is exercised end to end |
| --- | --- |
| `start` | every conformance scenario; `supervisor.test.ts` |
| `resume` | `resume-or-honest-refusal`, the usage section, `scenarios.test.ts` |
| `steer` | the six Control scenarios; `lifecycle.test.ts` |
| `cancel` | `cancellation-terminates-with-partial-output`; `lifecycle.test.ts` |
| `wait` | `wait-and-result-observe-the-same-value`, `a-late-waiter-reads-the-stored-result` |
| `result` | every scenario that settles a Run |
| `shutdown` | `shutdown-rejects-new-work`; `lifecycle.test.ts`; `scenarios.test.ts` |

The [conformance suite](../../extensions/subagent/testing/conformance.ts)
runs all of it against both fakes: 37 scenarios in five sections, all 37 of
which the resumable fake passes, and 29 of which the one-shot fake passes with
8 visible skips.

## 3. Every race ends with one terminal result and a zero probe ✅

The eleven races the roadmap names are one test each in
[`races.test.ts`](../../extensions/subagent/runtime/races.test.ts), and each
one ends with the same three assertions: one terminal result per Run, at most
one notification, and a runtime probe that reads zero once the Session Scope
has closed.

| Race | Test |
| --- | --- |
| Complete versus cancel | a cancel arriving after the execution returned |
| Timeout versus complete | a Run that answers before its timeout |
| Shutdown versus start | a start issued alongside shutdown |
| Steering versus terminal settlement | a steer arriving as a Run settles |
| Subagent close versus resume | a resume issued as its Subagent closes |
| Backend loss versus cancel | a backend that dies as it is cancelled |
| Result storage versus notification failure | a push that fails while the result is stored |
| Late callback versus Run Scope closure | an observation emitted from a finalizer |
| Capacity admission versus concurrent completion | a start issued as the last Run completes |
| Waiters versus settlement, abort, timeout, eviction | early, aborted, timed-out, and late waiters |
| Store pressure versus publication and pending delivery | a store with room for barely one result |

Several of them assert a **disjunction** rather than a winner, and that is
deliberate: whether a cancel that arrives as an execution returns wins is
genuinely a race, and pinning one answer would be pinning the scheduler rather
than the rule. What is not a disjunction is the part that matters — one status,
one result, one notification, and nothing left running.

No test in the lane lets real time pass. The
[timing lint](../../extensions/subagent/timing.test.ts) enforces it. Its
timer rule is unchanged and applies to every v2 file; its **sleep** rule was
narrowed in M2 to files whose name ends `.test.ts`, which exempts production
modules *and* test-support modules such as the conformance suite, the session
rig, and the fakes. The narrowing is deliberate for production — a module that
sleeps does so against the runtime `Clock`, which is exactly the thing a test
replaces — and is wider than it needs to be for test support. None of those
modules sleeps today; if one starts to, the lint will not catch it.

## 4. Closing the Session Scope closes everything beneath it ✅

Structural rather than procedural: a Subagent Scope is forked from the Session
Scope, and a Run fiber is forked *into* it. Nothing has to remember them.

Proven three ways: `close-releases-every-resource` in the conformance suite,
`a Run that outlives the body is still closed by the Session Scope` in
`supervisor.test.ts`, and the probe assertion at the end of every test that
uses [the session rig](../../extensions/subagent/testing/session-rig.ts),
which reads it *after* the scope has closed.

The [runtime probe](../../extensions/subagent/runtime/counters.ts) reports
live Run fibers, live reducer fibers, open observation queues, open mailboxes,
unresolved waiters, repository subscriptions, and open BackendAgents. A
subscription is counted because a raw `SubscriptionRef.changes` would be
invisible to it, and a subscription that outlives its consumer is exactly the
leak the probe exists to catch: the repository hands out a *scoped* view
instead.

## 5. Notification failures are retryable independently of settlement ✅

[`CompletionDelivery`](../../extensions/subagent/runtime/delivery.ts) reads
what settlement stored rather than being handed it, which is what makes a
failure survivable: a retry re-reads the same immutable result, so it cannot
announce something different from what `agent_result` returns, and it has
nothing with which to alter settlement. It never calls the repository writer
and never re-enters settlement; the only thing it does to the store is release
the pin it was given.

`delivery.test.ts` covers a push that fails and then lands, one that exhausts
its budget, and a retry running while another Run settles.

## 6. Delivery recovers a missed wake-up from stored results ✅

`sweep()` compares what is stored against what has been announced. Settlement
runs one after its own delivery, so a missed wake-up costs one extra pass
rather than a notification. `a sweep delivers a stored result whose wake-up
never arrived` commits a result with no settlement behind it and shows the
sweep finding it — once, not twice.

## 7. The forbidden vocabulary appears nowhere it should not ✅

All enforced by [the boundary test](../../extensions/subagent/boundaries.test.ts)
on the real tree, each with a fixture proving the rule fires:

| Rule | Scope |
| --- | --- |
| No `Effect.runPromise`, `AbortController`, or `AbortSignal` | every production file under `domain/`, `backend/`, and `runtime/` |
| `Layer` only in the composition module and the services it wires | every production file under `runtime/` |
| A domain file may name only `Schema` from `effect` | every file under `domain/`, tests included |
| A domain file may name no runtime primitive | every production file under `domain/` |
| No provider SDK | every v2 file |
| No v1 import, and no v2 import from v1 | both trees |
| The legacy Profile backend field name | every file in the v2 tree, whatever its extension |

The named-import rule reads the name the module *exports*, so renaming `Layer`
on the way in does not hide it. One fixture checks a rule that must **not**
fire: the domain's own `queue-overflow` diagnostic category is a domain word,
not machinery.

## 8. No Subagent, BackendAgent, or Run is a Layer ✅

Enforced twice.
[`composition.test.ts`](../../extensions/subagent/runtime/composition.test.ts)
reads the context keys the runtime actually provided and asserts they are
exactly the six named services, so a Layer for something shorter-lived than the
Session shows up as a service nobody named. The boundary test stops a module
that owns one of those from importing `Layer` at all.

## 9. The scenario driver is gone ✅

`extensions/subagent/testing/driver.ts` no longer exists and nothing imports
it. Its three pieces of product knowledge moved rather than being deleted:
classifying a defect as failed and first-ending-wins are now the pure
[`arbitrate`](../../extensions/subagent/runtime/arbitration.ts), and the
running → finalizing → terminal transition is the settlement path in
[`run-scope.ts`](../../extensions/subagent/runtime/run-scope.ts). Its stage
trace is replaced by the supervisor's `stages()` hook, which the conformance
suite uses for ordering assertions.

## 10. The Schema work landed first, and the spike gated it ✅

[The Schema spike](spikes/effect-schema.md) answered ADR-0029's three questions
against the pinned release before any declaration was written. The gating
question — whether a decode failure's text is free of the offending value —
cleared without qualification, with a stand-in secret planted in seven
positions appearing in no message.

What the spike deleted: the phantom identifier brand with its four constructors
and four identical guards, the ten-arm observation validator, the usage and
gauge validators, the compile-time exact-key-set table, and the runtime
forbidden-key walker. What it added: one declaration per domain type, an
encoder for the stored result, and `EXACT_KEYS` — one named decode option that
*is* the exact-key-set rule.

## 11. ADR-0030 decided the open failure channel ✅

[ADR-0030](../adr/0030-v2-backend-open-failure.md) records why ADR-0028's
deferral did not survive contact with operation semantics section 1, gives
`open` a typed failure carrying exactly one redacted diagnostic, adds `backend
unavailable` to `StartOutcome`, and states that an execution still has no error
channel. The semantics document gained the outcome, the bounded open, and the
difference from v1 in the same change as the union — which is what the M0
phrase test exists to force.

## 12. The glossary and the roadmap are updated ✅

[`CONTEXT.md`](../../CONTEXT.md)'s v2 vocabulary section gains **Session
runtime**, **runtime policy**, **Run Scope**, **settlement coordinator**,
**terminal candidate**, **arbitration**, **sealing**, **cleanup escalation**,
**reservation**, **pin**, **delivery sweep**, and **runtime probe**. Its
description of how the no-provider-vocabulary rule is enforced was corrected:
it is a decode at the seam now, not a type-level key-set test.

[`roadmap.md`](roadmap.md) section 5, milestone M2, carries a status line
pointing at this document, ADR-0030, and the spike.

---

## Deliberate deviations from the spec's letter

Four, each a decision with its reason rather than an omission.

**1. A result's reservation is `maxResultBytes`, not "the maximum encoded size
a bounded result can reach under the policy's projection bounds".** That phrase
does not name a computable number: the projection bounds bound *items and
texts*, and a transcript item may carry any number of parts, so their product
is unbounded. The policy carries `maxResultBytes` as its own bound and
settlement cuts a candidate result down to fit it, deterministically and least
loss first, recording every cut. That serves the purpose the phrase was for —
a reservation is a guarantee rather than an estimate — and it is the only way
to serve it.

**2. Admission is one atomic claim followed by a compensating reservation, not
one indivisible step across both.** The capacity claim and the result
reservation belong to different owners, and a single `Ref.modify` cannot span
two. A Run that cannot reserve a result releases its capacity claim and is
refused, so the invariant that matters — never admitting a Run whose result
could never be stored, and never over-admitting — holds. The failure mode of
the window between them is a *spurious* `at capacity` under contention, which
is an answer operation semantics already tells callers to retry.

**3. The Subagent's one-active-Run claim is taken after the open, not at
admission.** Until the open succeeds there is no Subagent to claim, because a
`start` creates the Subagent and its first Run together. Global capacity is
still claimed before the open, so an open cannot exceed it, and `resume` — the
only operation that contends for an *existing* Subagent — takes both claims in
the one atomic step.

**4. "A failing sink cannot strand the execution" changed meaning.** M1's
observation sink could fail; M2's cannot, because `emit` never fails by
contract and a late one is a counted no-op. That is a strengthening, not a gap,
so the scenario now drives the other half of the same property: an execution
that dies still settles its Run and strands no native resource. The scenario
name is kept because it is the roadmap's, and the change is written where the
check is.

## Gaps carried into M3

**1. The Profile frontmatter reader is still a documented YAML subset.**
Recorded at the M1 gate and unchanged: the domain module now imports `Schema`,
but a frontmatter reader is a *parser* rather than a decoder, and ADR-0029
explicitly leaves it out. If a real Profile needs more, the parser grows or the
reader moves out of the domain.

**2. `typebox` is still a dependency.** The spike cleared JSON Schema output
for tool parameters, with two shape notes — `Schema.Number` must be
`Schema.Finite`, and the emitted `additionalProperties: false` is stricter than
what v1 allowed. Replacing `typebox` at the one call site is M3's work.

**3. Profile reload during a Session is out of scope and stays out.**
`ProfileCatalog` discovers once when the Session Scope opens. A Profile that
changed under a running Subagent would either be ignored — the Subagent's
Profile is fixed for its lifetime — or would make two Runs of one Subagent
disagree about what they are.

**4. Adapter-specific forced termination is M4 to M6.** M2 decided the cleanup
policy and the `cleanup-escalation` diagnostic, and closes the BackendAgent
itself when a finalizer outlives its budget. What a real adapter does to a
process that ignores that is adapter work.

**5. A public Subagent close tool does not exist and is not planned.** The
supervisor has `closeSubagentById` internally, because shutdown uses it and one
race test needs it, but no tool exposes it.

**6. Conflating the Run index *stream* is left to its consumer.** The roadmap
asks for conflated activity state, and the *snapshot* is conflated: a row holds
one activity value, replaced rather than appended, so a hundred progress
updates grow the index by nothing. The change **stream** is a separate matter,
and `SubscriptionRef.changes` does not conflate: it delivers one element per
change however far behind a consumer is. `subscribe` therefore reads the
current index at the moment of each delivery, so a slow consumer is never
handed a value that has already been superseded — but it is still handed one
element per change, some of them repeats. A backpressure test pins exactly
that. M3 has the first real consumer and is the right place to decide whether
it needs to throttle.

## What M3 starts from

- One managed Effect runtime per Session, composed in one module from six
  session-long services, a policy value, and the ambient clock.
- Six public operations returning the M1 outcome unions, with admission that is
  atomic, non-blocking, and free of provider I/O.
- A settlement path that runs in the roadmap's order and makes the user-visible
  invariant true: a Run that reads as terminal has a retrievable result.
- A Result store that reserves, commits idempotently, holds results encoded,
  evicts oldest-unpinned-first, and answers `ResultExpired`.
- Completion delivery behind a `NotificationSink` interface, with a fake in
  tests, so M3 supplies the real Session push without changing delivery.
- A conformance suite of 37 scenarios in five sections that both fakes pass —
  with only capability-driven skips — and that every real adapter will run,
  driven entirely through the public operations.
- Eleven race tests, six backpressure tests, seven fault tests, and a runtime
  probe that turns "nothing leaked" into an assertion.
- Boundary rules that make the milestone's architectural decisions checked
  rather than reviewed.
