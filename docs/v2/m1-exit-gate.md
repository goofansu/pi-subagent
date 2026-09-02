# M1 exit gate

**Status:** Passed. **M1 is complete.**
**Date:** 2026-09-02
**Verified against:** [the v2 roadmap](roadmap.md), milestone M1.

This document verifies every M1 exit-gate item against the merged work, so that
M2 starts from an explicitly closed milestone. It follows the shape of
[the M0 exit gate](m0-exit-gate.md).

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
| `npm run test:v2` | 288 tests, 282 pass, 6 skipped |
| `npm run test:v2:conformance` | 49 tests, 43 pass, 6 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` |

The v1 lane's numbers are unchanged from M0: **M1 changed no v1 file.**
`git diff` between the M0 baseline commit and this gate touches nothing under
`extensions/subagent/`. Outside the v2 tree, M1 changed only the
`test:v2:conformance` script in `package.json`, a matching `Makefile` target,
and documentation: ADR-0028, this record, the roadmap's M1 status, the freeze
log, and the glossary's v2 section.

`npm run test:v2:conformance` is a subset of `test:v2` by design: the
conformance suite gets its own script so it can later be pointed at a real
adapter without running the whole lane.

### The skips are all visible and all explained

| Lane | Skip | Why |
| --- | --- | --- |
| v1 conformance | `claude conformance: terminal-transcript-healing` | Unchanged from M0. The Claude adapter has no wire transcript snapshot. |
| v1 suite | the same scenario, reached through the full suite | As above. |
| v2 | 6 × `FakeOneShotBackend conformance: …` | The one-shot backend declares no resume, no steering, and no snapshot, so six scenarios have nothing to exercise. |

`FakeResumableBackend` skips **nothing**: every scenario is written so that it
means something for whichever capabilities the backend under test declared, so
a skip always names a capability the backend does not have. Both rig test files
assert their own skip list, so a skip appearing for a new reason fails the lane.

There are no silent skips. Each one is registered by the suite as a skip with a
reason, which is the behaviour
[the conformance suite](../../extensions/subagent-v2/testing/conformance.ts)
exists to guarantee: a rig returning `undefined` for a scenario never passes it.

## 2. Both fake backends pass the initial backend conformance suite ✅

The suite is
[`extensions/subagent-v2/testing/conformance.ts`](../../extensions/subagent-v2/testing/conformance.ts):
23 scenarios across the four sections of the roadmap's conformance program that
are meaningful before a supervisor exists.

| Section | Scenarios |
| --- | --- |
| Subagent and BackendAgent | validation is deterministic; open creates no Run; capabilities are enforced; resume or honest refusal; close is idempotent; close releases every resource |
| Run | observations reduce in accepted order; exactly one ending wins; cancellation terminates with partial output; result follows scope closure; late events cannot mutate a terminal Run; a failing sink cannot strand the execution; a Run may settle with no observations; observations carry no provider vocabulary |
| Control | steering admission follows the declared capability; Controls are delivered serially in order; a Control cannot leak into the next Run; a user observation appears only on confirmation |
| Usage | usage deltas are Run-local; reconciliation does not double count; context occupancy is a gauge; a replayed transcript adds no usage; a resumed Run excludes prior usage |

`FakeResumableBackend` passes all 23. `FakeOneShotBackend` passes 17 and skips
6. Each rig's own test file asserts *which* scenarios it skips, so a skip that
appears for a new reason fails the lane.

The section lists are exported data, and a test asserts their concatenation is
exactly the scenario list — a scenario cannot be added to a section and
forgotten by the suite, or the other way round.

## 3. The reducer and reconciliation are deterministic, and the domain is plain ✅

**Deterministic.** Folding the same observation sequence twice yields
deep-equal projections *and* deep-equal applied reports. Checked on hand-written
sequences, on all four adversarial fixture generators, and on 400 seeded random
sequences. `reduceRun` reads nothing outside its arguments: no clock, no random
source, no ambient state.

**Plain.** The v2 boundary test now enforces, on the real tree:

- a production file under `domain/` may import only another file under
  `domain/` — which rules out `effect`, every SDK, and every `node:` module by
  construction rather than by enumeration;
- a *test* under `domain/` may name only `node:test` and `node:assert` as
  packages, so a domain test cannot reach for a runtime either;
- no v2 file imports a provider SDK;
- no production file under `domain/` or `backend/` contains
  `AbortController`, `AbortSignal`, or `Effect.runPromise`.

Each rule has a fixture proving it fires, including one proving tests stay
exempt from the last rule — a test has to run the Effect it is testing.

## 4. Transition-table tests cover every legal state change ✅

Both state machines are exported tables plus a pure reader that never throws.
The tests enumerate **every** `(phase, event)` cell of both tables as a flat
list of readable strings, and separately assert the table and the function
agree in every cell.

- **Subagent**: 3 phases × 3 events = 9 cells. Legal: running → idle on
  settlement, idle → running on admitted resume, running and idle → closed on
  close. `closed` is absorbing — its two meaningful events are legal no-ops
  (a Run finishing its settlement after the Subagent closed, and an idempotent
  second close) and admitting a resume there is the one illegal cell.
- **Run**: 5 phases × 4 events = 20 cells. Legal: running → finalizing when
  the native execution ends, and finalizing → exactly one terminal phase at
  settlement. `finalizing` exists so a Run is never shown as terminal while its
  cleanup is still running.

**Terminal Run states are absorbing.** All twelve cells out of the three
terminal phases are illegal, asserted in a loop over the terminal phases rather
than one at a time. Recording a cancellation request on a terminal Run is
reported illegal; on an active Run it is idempotent, leaves the phase
unchanged, and the first reason wins.

## 5. Replaying the same terminal reconciliation is idempotent ✅

`reconcileRun` applied twice yields a projection deep-equal to applying it once.
Checked three ways:

- on a projection that streamed a bit of everything, with every reconciliation
  field present;
- on a reconciliation whose replacement transcript *overflows the bounds*, which
  is the case a naive implementation gets wrong;
- across 400 seeded sequences.

The mechanism is recorded in the code: the truncation record splits its byte
counts by what they measure, and a replacement **sets** its item and byte counts
rather than adding to them. A pooled counter could not be both accumulating and
replaced, and replay would add the same cut twice.

One field is ignored rather than applied: an unusable context gauge inside a
reconciliation leaves the streamed gauge in place, exactly as an unusable turn
count does, and it does **not** make the reconciliation observation invalid.
Rejecting a whole snapshot over one unreadable field would throw away the
transcript, output, and usage healing it also carried, which is the opposite of
what a snapshot is for.

## 6. A previous conversation's usage cannot be charged to a resumed Run ✅

Proven twice, at two levels.

At the scenario level, `FakeResumableBackend` keeps a provider-cumulative token
total it never exposes across the boundary, and reports Run-local deltas by
differencing it against a baseline taken when each Run starts. The resume
scenario asserts the first Run reports 100 input tokens, the fake's hidden
cumulative reading is 175, and the second Run reports 75.

At the conformance level, `a-resumed-run-excludes-prior-usage` asserts the
second Run resumed the first Run's conversation, that the first Run spent
something (so exclusion proves something), and that the second Run's reported
figure is *not* the cumulative reading — which is exactly what a naive adapter
would have forwarded.

Three neighbouring rules are checked alongside it: reconciliation replaces
rather than adds; the context gauge is the most recent reading and not the sum
of the readings; and a replayed transcript carries no usage and reports zero.

## 7. Provider-native payloads cannot be represented in public domain types ✅

Enforced three ways at once.

1. **Exact key sets, at compile time.** A type-level test pins `keyof` for all
   ten observation kinds. Adding a field to an observation fails to compile, so
   a provider thread, turn, item, request, correlation, or session identifier
   cannot be slipped into the vocabulary.
2. **A forbidden-key walker, at runtime.** A shared walker reports any key
   naming provider bookkeeping, however deeply nested, comparing after
   normalizing away case, underscores, and dashes. A *turn count* is
   deliberately allowed and a *turn id* is not.
3. **The same two checks against a backend.** The conformance scenario
   `observations-carry-no-provider-vocabulary` runs the walker and the key-set
   check over every observation a real backend emitted, so an adapter at M4 is
   held to exactly the rule the domain types are held to.

The only provider-adjacent data that crosses is a typed `RunDiagnostic` — a
fixed category set and a byte-bounded one-line message, with a redacted form
that keeps the category and drops provider text — and a typed `ResultLink`, a
fixed kind set with a bounded label and target. Both bound at construction.

A tool call part deliberately carries no arguments: M1's vocabulary is what a
bounded projection can hold, and provider-shaped tool input is neither bounded
nor needed to prove any M1 rule. Adding it later means adding a bound for it,
which is a visible change.

## 8. No real time passes in any v2 test ✅

Every wait in the v2 lane is on an Effect `Deferred` the test completes.
[`extensions/subagent-v2/timing.test.ts`](../../extensions/subagent-v2/timing.test.ts)
is a lint the lane runs on itself: no v2 source may call `setTimeout`,
`setInterval`, or `setImmediate` or import `node:timers`, and any file that
uses `Effect.sleep` must also provide a `TestClock`.

Two tests additionally assert that wall-clock time did not pass: the M0 Effect
primitive smoke test, and the M1 scenario that advances a test clock by an hour
before cancelling a hanging backend.

## 9. Lifecycle behaviour is demonstrable without a provider SDK ✅

The roadmap's six required scenarios all run end to end through the test-only
scenario driver against `FakeResumableBackend`, in
[`extensions/subagent-v2/testing/scenarios.test.ts`](../../extensions/subagent-v2/testing/scenarios.test.ts):

| Scenario | What it proves |
| --- | --- |
| start → progress → complete → result | The result reflects every observation in order; tools merge by call id; a settled Run is quiet; the Run went running → finalizing → completed |
| start → steer → confirm/reject → complete | A confirmed Control becomes a user observation; an unconfirmed one is delivered and appears nowhere |
| start → cancel → partial result | Interruption yields a cancelled Run keeping its partial output, with unfinished tools marked cancelled and no leaked resources |
| start → fail → diagnostic + partial result | A polite failure keeps its output and its diagnostic; an uncaught defect is classified as failed with a redacted diagnostic and the defect's own words reach nothing |
| complete → resume → new Run-local usage | See gate item 6 |
| shutdown → all retained resources close | Every counter returns to zero; close counts once however many times it is called |

The driver also records its stages in a shared trace, so
`the result is produced only after the execution scope has closed` is an
assertion about ordering rather than a claim. Alongside the six, the same file
proves that a scripted late observation after an in-stream ending changes
nothing and that the bundle's later ending is reported late.

## 10. Architecture decision record ✅

[ADR-0028](../adr/0028-v2-backend-contract.md) records the backend contract:
the three interfaces and their lifetimes, why the contract is Effect-typed
while the domain beside it imports nothing, the two deliberate absences (no
cancellation object, no error channel on an execution), and the shape guard.
It carries forward ADR-0007, ADR-0014, ADR-0019, ADR-0021, ADR-0023, ADR-0025,
and ADR-0026.

## 11. The domain glossary defines the M1 terms ✅

[`CONTEXT.md`](../../CONTEXT.md)'s v2 vocabulary section gains **observation
kinds**, **projection**, **applied report**, **terminal reconciliation**,
**terminal bundle**, and **capabilities**, each pointing at the ADR that
decided it where one exists.

## 12. The roadmap marks M1 complete ✅

[`roadmap.md`](roadmap.md) section 5, milestone M1, carries a status line
pointing at this document.

---

## Deliberate deviations from the spec's letter

Four places where the merged work does not match the spec word for word. Each
is a decision, made with the reason, rather than an omission.

**1. `RunResult` carries its ContextGauge inside `usage`.** The spec lists
`UsageSnapshot` *and* `ContextGauge` among the result's fields. A snapshot
already carries the gauge, so a second top-level copy would be a gauge stored
twice, able to disagree with itself. It is at `usage.context`, and `result.ts`
says so.

**2. `ProjectionBounds` and the truncation record are a superset.** The spec
enumerates five bounds; `maxLinks` is a sixth, with `droppedLinks` and
`truncatedToolOutputBytes` alongside it in the record. Without them the claim
that a `RunResult` is fully bounded would be false. Both are tested like the
other bounds.

**3. `closed + run-settled` and `closed + close` are legal self-transitions.**
Issue 01 says "closed is absorbing; every other pair is illegal". The spec's own
prose says a closed Subagent may still have a Run finishing its settlement, and
closing is cancel-and-await-cleanup, so those two events are legal no-ops there.
Absorbing is read as "no event leaves `closed`", which is what the table
enforces; admitting a resume there is the one illegal cell.

**4. The test driver produces `SteerOutcome` values.** The spec's Out of Scope
says M1 defines the public outcome types and nothing produces them. Issue 08
requires that an unsupported Control "yields `unsupported` from the driver
without the fake receiving anything", which cannot be shown without producing
one. The driver is test code standing in for M2's admission path, and it is the
only place in the milestone that produces a public outcome.

## Gaps found at this gate

Three, all recorded rather than fixed, because each is a decision a later
milestone is better placed to make.

**1. `Backend.open` has no failure channel.** A backend whose provider I/O
fails while opening must report it through its first execution's `failed`
ending. ADR-0023's unopened-BackendAgent state makes that natural for Claude,
and it is untested for a backend that spawns a process at open. Recorded in
ADR-0028 with what would make it worth revisiting; the shape test makes adding
a failure channel a visible change.

**2. Profile frontmatter is a documented YAML subset, not YAML.** The domain
module imports nothing, so the reader is scalars, inline lists, and block
lists. A nested map or a block scalar is reported as an unsupported field
rather than misread — visible to whoever writes one, and deliberately narrower
than v1, which accepted arbitrary YAML through the host's parser. If a real
Profile needs more, the parser grows or the reader moves out of the domain.

**3. Ending arbitration is first-wins, not arbitrated.** The driver takes the
first ending to be reduced and reports any later one as late. That is the
correct *outcome* for the sequential case and it is what the conformance
scenario `exactly-one-ending-wins` checks, but concurrent competing signals —
completion racing transport loss racing a timeout — are M2's problem, along
with every race test.

## What M2 starts from

- A domain module of plain TypeScript with no runtime in it: identifiers,
  phases as tables, the observation vocabulary, usage rules, `reduceRun`,
  `reconcileRun`, `RunResult`, and the six public outcome unions.
- An Effect-typed backend contract with its shape pinned, and two fake backends
  that implement it from scripts with explicit gates and resource counters.
- A shared conformance suite that both fakes pass and that every real adapter
  will run against, with its own npm script.
- A test-only scenario driver M2 is expected to **replace**. The product
  knowledge in it — classifying a defect as failed, first-ending-wins, and the
  running → finalizing → terminal transition — is all pure domain calls, so the
  supervisor inherits the knowledge without inheriting the code.
- Four boundary rules and one timing rule the lane enforces on itself.
- One decision taken after this gate, for M2 to build against:
  [ADR-0029](../adr/0029-v2-effect-schema-at-the-boundaries.md) adopts Effect
  Schema at the backend seam and the host boundary, and leaves the domain
  module plain. It also states the standing direction — adopt Effect wherever
  it removes machinery v2 would otherwise own — and the three limits that still
  bind it.
