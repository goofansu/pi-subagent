# M4 exit gate

**Status:** Open on one item — the daily-driver soak. Everything else passes.
**Date:** 2026-09-03
**Verified against:** [the v2 roadmap](roadmap.md), milestone M4.

M4 is the milestone where v2 stops being a demonstration. After M3 the product
was complete and had nothing real behind it; it now runs actual work through the
host-native backend, and the abstraction the whole rewrite rests on has been
tested against a provider rather than against two fakes written to fit it.

This document verifies each exit-gate item against the merged work. It follows
the shape of [the M3 exit gate](m3-exit-gate.md). The one item that cannot be
closed by a commit is the soak, which is counted by usage rather than by days
and is logged in [`soak.md`](soak.md).

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
| `npm run test:v2` | 807 tests, 799 pass, 8 skipped |
| `npm run test:v2:conformance` | 115 tests, 107 pass, 8 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` |

The v1 lane's numbers are byte-identical to M3's: **M4 changed no v1 file.** The
v2 lane grew from 658 tests to 807, and the conformance lane from 77 to 115 —
the 38 new ones being the Pi rig's, which is the shared suite plus its own
no-skips assertion.

The skip list is unchanged at eight, all of them `FakeOneShotBackend
conformance: …` scenarios about capabilities that backend declares it does not
have. **The Pi rig skips nothing**, and a test asserts the empty list rather
than leaving it to be read off the output.

## 2. Pi passes the shared Subagent, BackendAgent, Run, Control, Usage, and cleanup conformance suites ✅

All 37 shared scenarios pass for the real Pi backend, registered as `PiBackend
conformance: <scenario>` by
[`testing/conformance-pi.test.ts`](../../extensions/subagent/testing/conformance-pi.test.ts).

What makes the pass mean something is what is *not* stubbed. The rig builds the
production `createPiBackend` and injects a stand-in session through the factory
the adapter already has for that purpose, so validation, the retained session,
the per-Run execution, the translation, the steering consumer, and the
cancellation path are all the real code. The rig supplies two things and only
two: the resource counters the suite asks every rig for, and the correlation
that tells the stand-in which Run each execution belongs to — because a native
session has no idea, and it should not.

`the Pi backend skips nothing, because it declares every capability` asserts the
empty skip list, so a scenario could not be quietly dropped by having the rig
return `undefined` for it.

Every scenario is also a leak test: `assertNoLeaks` runs after each one and
requires opens minus closes to be zero, live executions zero, live subscriptions
zero, and the runtime probe clear.

## 3. Pi-specific tests cover the spike's findings ✅

The M0 spike found one thing that places a requirement on the adapter, and three
more behaviours v1 earned the hard way.
[`testing/pi/pi-backend.test.ts`](../../extensions/subagent/testing/pi/pi-backend.test.ts)
covers each, named for what it proves so that none can be mistaken for a
duplicate of a shared scenario and deleted:

| Finding | Test |
| --- | --- |
| A disposed Pi session still accepts `prompt()`, so closure must be the adapter's own flag | `a disposed Pi session is refused by the adapter, not by the SDK` |
| A stalled native steer must never block cancellation | `a stalled native steer does not delay a cancel` |
| Cancellation destroys neither the handle nor the conversation | `a cancelled Run leaves the session resumable on the same conversation` |
| A terminal answer observed before the abort is authoritative | `a terminal answer observed before the abort settles answered` |
| A model missing from the catalogue is a rejection, not a failed Run | `a model the Session's catalogue does not hold is a rejection, not a Run` |
| A Control reaches the Run it was admitted to and no other | `a Control admitted to one Run is delivered only to that Run` |
| Native delivery failure is diagnostic-only | `a native steer that rejects is a control diagnostic and no user message` |
| A steer the session never takes must not stop the Run settling | `a steer the session never takes does not stop the Run from settling` |

The stand-in reproduces the SDK's disposal behaviour deliberately — `a disposed
session still accepts a prompt, exactly as the SDK does`
([`stand-in-session.test.ts`](../../extensions/subagent/testing/pi/stand-in-session.test.ts))
— because a politer double would make the adapter's guard untestable: the test
would pass because the double refused, not because the adapter did.

The inert-in-child guard was also confirmed **live**, in a real Pi child, on
2026-09-03. Driving `agent_start` directly in a real Pi host (no orchestrating
model) and logging the guard's inputs at extension load produced two loads: the
parent's, and then the child's when the Pi backend opened its session.

```
install guard: childLoad=false depth=0
registered six tools          # the parent registers everything
...
install guard: childLoad=true depth=0
                              # the child registers nothing at all
```

That is the child-load discriminator doing the job the extensions filter cannot
do on its own — Pi initializes an extension's factory while the loader is still
discovering resources, and the filter is applied only afterwards.

Child isolation and the depth environment are proven against fixture paths in
[`backend/pi/options.test.ts`](../../extensions/subagent/backend/pi/options.test.ts):
`both of this package's extension directories are filtered from a child`, `the
Bash spawn carries the child depth without mutating the environment`, and `the
resource load runs inside the child-load discriminator`.

## 4. Start, resume, steer, cancel, timeout, and shutdown pass live smoke tests ✅

`npm run v2:pi:smoke` builds a real Session runtime over the real adapter and
drives all six against a real model. Recorded run, 2026-09-03, against
`openai-codex/gpt-5.6-sol`:

```
v2 Pi runtime live gate
  ok — start settles completed
  ok — start returns the answer
  ok — resume runs on the retained conversation
  ok — resume uses a distinct Run id
  ok — a resumed Run is charged only for its own work
  ok — steering is admitted
  ok — steering reaches the answer
  ok — cancel is admitted and the Run settles cancelled
  ok — shutdown refuses new work
  ok — every settled Run produced exactly one notification (run-2, run-3, run-5, run-7)
  ok — no notification carries a provider identity
  ok — the runtime probe is clear after closure ({...all zero})
  ok — the Pi adapter probe is clear after closure ({...all zero})
  ok — a Run past its default timeout is cancelled with reason timeout
  ok — the runtime probe is clear after the timeout Session ({...all zero})
  ok — the Pi adapter probe is clear after the timeout Session ({...all zero})

V2_PI_LIVE_SMOKE_PASS
```

`npm run v2:pi:host-smoke` launches Pi in RPC mode with only the v2 entry point
loaded and drives the other half — the surface a user has. Recorded run, same
day, same model:

```
v2 Pi host live gate
  ok — the Pi process exited cleanly
  ok — agent_start was called
  ok — agent_result was called
  ok — the subagent's answer came back
  ok — no v1 module was loaded

V2_PI_HOST_LIVE_SMOKE_PASS
```

Both are in `npm run release:check` and neither is in `npm run check`: provider
quota is spent on release, not on every commit.

## 5. A cleanup probe shows no retained native listener or session after Subagent or Session closure ✅

This is the exit-gate item that cannot be argued from code, so it is measured
from two directions.

The **runtime probe** counts what the core holds: Run fibers, reducer fibers,
observation queues, mailboxes, waiters, repository subscriptions, and open
BackendAgents. The **adapter probe**, which lives outside the backend contract
in [`backend/pi/probe.ts`](../../extensions/subagent/backend/pi/probe.ts),
counts what the adapter holds: open native sessions, live event subscriptions,
and native cleanups still in flight.

Both are asserted zero after the Session Scope closes, in three places: every
one of the 37 conformance scenarios (`assertNoLeaks`), the Pi-specific tests
that read `piProbeIsClear`, and both live-gate Sessions above.

The probe is deliberately *not* on the contract. A probe on the contract would
be a field every adapter had to invent something for, and a number the core
could start believing; it is reachable only through the handle the composition
root holds.

## 6. No Pi event or session type leaks into the generic runtime or presentation ✅

Four new boundary rules in
[`boundaries.test.ts`](../../extensions/subagent/boundaries.test.ts), each
with a fixture test that proves the rule rejects what it is for and admits what
it is not:

| Rule | Fixture test |
| --- | --- |
| Pi's SDK session symbols stay inside the adapter; Pi's *host* API does not | `a Pi session symbol outside the adapter is rejected, its host API is not` |
| Pi's message and event types stay inside the adapter | `a Pi message type outside the adapter is rejected` |
| Only the composition root may import the adapter | `only the composition root may import the Pi adapter` |
| The adapter may not import the runtime, host, presentation, or façade | `the Pi adapter may not import the runtime, the host, or presentation` |

The first rule is by *binding* rather than by package, and that is the whole
reason it needed thought: `@earendil-works/pi-coding-agent` is both the host API
this product is written against and the native session machinery the adapter
drives. Naming `createAgentSession` outside `backend/pi/` is a violation; naming
`ExtensionAPI` is not.

`the real v1 and v2 trees hold the boundary` runs every rule against the actual
trees.

## 7. All state visible in the UI comes from the repository and the result store ✅

Unchanged from M3 and re-checked: the presentation rule in the boundary test
still admits only the domain and Pi's TUI primitives, and the expanded card M4
added is built from a published index row or an immutable stored Result and
nothing else. `PiBackend conformance: only-the-repository-writes-snapshots`
asserts that the widget row and the stored result agree, because both came from
the one fold the repository was told about.

## 8. The Pi compatibility matrix is complete ✅

[The matrix](compatibility-matrix.md) gains a section — *The Pi column, proven
in v2* — with one v2 proof per Pi row, citing a conformance scenario, a named v2
test, or one of the two live gates. Rows already proven at M3 cite those tests,
because a backend-independent behaviour proven against the fakes is proven for
Pi too; what M4 adds is that the Pi backend is what the Session was running.

## 9. v1 remains available only as a Session-level fallback ✅

The published manifest still exposes only `./extensions/subagent`; nothing about
what the package installs changed, and `packaging.test.ts` still asserts it.

The switch is local and reversible:
`make dogfood-v2` rewrites this package's entry in Pi's settings to disable
**its** extension alone and adds the v2 entry point to the settings' extension
paths, so plain `pi` loads v2 beside every other extension the maintainer has.
`make dogfood-v1` restores the settings file exactly. The round trip was
verified byte for byte.

**No fallback limitation was needed.** The spec allowed for one — if Pi's
per-package override could not disable a single manifest entry, the fallback was
the all-extensions-disabled target. It can: `PackageSource`'s object form takes
an `extensions` list, and an empty one disables the package's extensions while
leaving its skills, prompts, and themes alone.

## 10. Use v2 with the Pi backend as the default local daily driver ⏳

**Open.** The switch works and was verified live on 2026-09-03; the soak has not
been run. [`soak.md`](soak.md) is the record, with the tally the gate asks for —
each of start, resume, steer, cancel, shutdown, and a Session switch, several
times, across distinct days — and the severity scale for what turns up.

## 11. No known severity-1 or severity-2 lifecycle defect remains ⏳

**Open with the soak.** None was found while building M4. One severity-1 defect
was found on 2026-09-03 by using the extension by hand, and has since been
fixed: identifiers restarted at one when a session was reloaded while the
conversation transcript kept the old ones, so a Run id written before the reload
could silently resolve to a *different* Run afterwards. Every identifier now
carries a nonce minted once per Session runtime, so a stale id is reported as
unknown — see [the findings](m4-live-findings.md#3-ids-restart-at-1-on-a-session-reload-and-the-transcript-does-not)
and [the soak record](soak.md).

Nothing else is known. But a soak that has not happened cannot be evidence that
nothing is there, and the one defect that was found came from exactly the
hand-driving the soak asks for.

## 12. The generic runtime contract is marked stable ✅

[ADR-0028](../adr/0028-v2-backend-contract.md) is marked **Stable** as of this
milestone, and the reason is section 13 below: the contract itself did not
change to accommodate Pi. Not one member was added, removed, or re-typed.

---

## 13. Every change M4 made outside the Pi adapter directory

This is the roadmap's most important program-level signal, so it is enumerated
rather than summarised. The rule the roadmap sets is that each change must be
classifiable as **(a)** a missing provider-neutral product semantic, backed by a
fake-backend test, or **(b)** provider-specific leakage, which must be pushed
back into the adapter.

**Nothing was classified (b).** Nothing had to be pushed back, and the backend
contract is unchanged.

### (a) Missing provider-neutral semantics — four

**1. `MessageRole` gains `tool`** (`domain/transcript.ts`).

A tool result is not something the assistant said. v2 had two roles, so the port
had a choice between attributing a tool's output to the model — which would make
the Run look as though it had claimed something it only read — and dropping it,
which loses the part of a tool call a reader usually wants. Every backend that
runs tools produces tool results, so this is a gap in the domain rather than
Pi's shape leaking in.

*Fake-backend proof:* `a tool result is its own transcript item and is not the
Run's answer` (`testing/scenarios.test.ts`), driven through the resumable fake.
The final output still comes from assistant items alone.

**2. `BackendSet` gains two host facts** (`runtime/composition.ts`):
`isChildLoad()` and `childDepth()`.

Only a backend knows how a child of *its own* processes reports itself: for Pi
that is an `AsyncLocalStorage` flag scoped to the resource-load chain and an
environment variable on Bash spawns, and for Claude and Codex it will be
something else or nothing at all. The host needs both answers and must not
import an adapter to get them, so they hang off the set the composition root
already hands over.

*Fake-backend proof:* the demo set answers never-a-child and depth zero, and the
host rig can say otherwise — `a process the backend set calls a child registers
nothing at all`, `a process the backend set reports as nested registers nothing
at all`, and `a parent process registers everything`
(`host/inert-guard.test.ts`), all three driven with no Pi adapter involved.

**3. `DEFAULT_MAX_DELEGATION_DEPTH` becomes 1** (`runtime/composition.ts`).

M2 set it to two. That was unobservable, because the host reported a constant
depth of zero and nothing could exceed anything; once the host read the real
depth the number became load-bearing, and two would have allowed a second level
of delegation that v1 forbids and [the matrix](compatibility-matrix.md) promises
against.

*Fake-backend proof:* `a start past the delegation depth is refused before anything is allocated`
(`runtime/supervisor.test.ts`) already drove the rule against a fake with the
bound set explicitly; what changed is the default it now matches.

**4. One shared conformance check widened** (`testing/conformance.ts`).

`late-events-cannot-mutate-a-terminal-run` required `lateObservations >= 1`. It
now accepts `lateObservations + lateEvents >= 1`, because where a late report is
stopped depends on how far settlement had got when it arrived and not on the
backend: a backend still talking while the reducer drains is caught by the
reducer, and one whose provider says its last word during native cleanup —
after the intake has been sealed — is caught at the seam. Both are the property;
neither is a leak.

*Fake-backend proof:* both fakes still pass the scenario unchanged, by the
`lateObservations` half.

Ticket 05 offered two ways to satisfy its rule — no change to the shared suite,
or a change that is a provider-neutral scenario both fakes also pass — and this
is strictly neither: it is a **loosened existing check**, made because Pi's last
event arrives during native cleanup rather than while the reducer is still
draining. It is recorded here as a loosening rather than dressed up as a new
scenario. What justifies it is that the original assertion encoded an assumption
the property never had: the scenario is "a late report changes nothing", and
`lateObservations` alone additionally required that the report arrive early
enough to reach the reducer, which is a fact about settlement's progress and not
about the backend. A reviewer who disagrees should reach for a separate
`late-events-are-counted-at-the-seam` scenario rather than restore the narrower
assertion, because the narrower one is not satisfiable by an adapter whose
provider speaks last during cleanup.

### Changes that are not semantics at all

For completeness, the rest of what M4 touched outside `backend/pi/`:

| File | What changed |
| --- | --- |
| `host/demo-backends.ts` | The demo set answers the two new host facts: never a child, depth zero. |
| `host/pi-backends.ts` | New. The Pi backend set, in the composition root beside the demo set. |
| `host/diagnostics-command.ts` | New. `/subagent-v2` reports the runtime counters and both probes. |
| `host/tools.ts` | `sessionFactsOf` reads the child depth from the set instead of returning zero. |
| `index.ts` | Uses the Pi set; returns without registering when the set says this is a child or a nested process. |
| `presentation/run-card.ts` | The expanded card: recent transcript, tools, context gauge, diagnostics, links, truncation. |
| `testing/fakes/script.ts` | `emitText` accepts the new `tool` role. |
| `testing/host-rig.ts` | A rig can say the process looks like a child, or is nested. |
| `testing/presentation-fixtures.ts` | A fixture Result can carry a transcript, tools, links, and a truncation record. |
| `boundaries.test.ts` | The four adapter-confinement rules and their fixtures. |
| `package.json`, `Makefile` | The Pi conformance rig in the conformance lane; the two live gates in the release gate; the dogfood targets. |

Nothing in the runtime's Run lifecycle, settlement path, arbitration, mailbox,
intake, repository, result store, or delivery changed. **The seam is healthy by
the roadmap's own measure**, and M5 should be able to add Claude through
adapter-local work plus new conformance fixtures.

---

## Recorded v2 differences from v1

Two, both deliberate, both already decided before M4 began.

**Eager session construction.** v1 built the Pi session lazily, on the first
Run, so a Profile pinning a model the agent directory could not resolve produced
a *failed Run* and a completion Notification for work that never started. v2
constructs it at `open`, inside the open budget, and a failure is `backend
unavailable` with no Run and no Notification. That is what
[ADR-0030](../adr/0030-v2-backend-open-failure.md) gave `open` a typed failure
channel for. Opening is cheap and provider-free — the spike measured two to
three milliseconds — so nothing is paid for the difference.

**No pending-cleanup state.** v1 tracked a native cleanup that outlived its
bound, because v1 had no bounded escalation to fall back on and a stalled steer
would otherwise have made a Subagent silently unusable. M2 has one: a finalizer
that overruns the cleanup budget causes the core to close the BackendAgent,
record a `cleanup-escalation` diagnostic, and mark the conversation lost. The Pi
adapter is therefore simpler than its ancestor on purpose, and the cleanup path
is one scope finalizer rather than a state machine.

### A divergence from ticket 03, stated plainly

Ticket 03's acceptance line reads: *"A pinned model absent from the catalogue
makes `agent_start` return `backend unavailable` whose diagnostic includes the
bounded catalogue summary."* **That is not what happens, and it is not what the
spec's own Implementation Decisions ask for.** The two disagree, and this is the
reading that was implemented.

There are two different rejections here, with two different outcome words:

- A model **the Session's catalogue does not hold** is caught at *Profile
  validation*, which is where the spec puts the bounded catalogue summary
  ("model validation accepting an exact catalogue id or a provider-qualified
  id, with the bounded catalogue summary (512 characters) in the diagnostic").
  `agent_start` answers `invalid profile`, and the diagnostic names what the
  catalogue does hold. Proven by `a model the Session's catalogue does not hold
  is a rejection, not a Run`.
- A model **the agent directory's own files cannot resolve** is caught at
  `open`, which is where the spec says "failing open with a redacted
  `backend-failure` diagnostic if absent". `agent_start` answers `backend
  unavailable` with nothing provider-authored in it, as ADR-0030 requires.
  Proven by `a failed open carries a redacted diagnostic and no provider text`.

Both paths exist, both are reachable — the Session's model registry and the
agent directory's `models.json` can disagree — and both are tested. What the
ticket asked for is the second outcome word carrying the first diagnostic, and
that combination is the one thing ADR-0030 forbids: it is provider-adjacent
detail crossing an open failure. The user is also better served by the
implemented behaviour, because `invalid profile` naming the catalogue says more
than `backend unavailable` saying `[redacted]`.

---

## Gaps carried into M5

**1. The soak has not been run.** Items 10 and 11 above.

**2. `controlsByRun` is not a real assertion in the shared suite for Pi.**
`a-control-cannot-leak-into-the-next-run` cannot deterministically say whether
the first Run's consumer took the Control before the cancel reached it, because
that is scheduling rather than behaviour. The Pi fixture therefore does not
assert the delivery side, and the real property is proven separately by `a
Control admitted to one Run is delivered only to that Run`. A rig for a backend
whose consumer is not eager will not have this problem.

**3. Pi produces no result links.** `ResultLink` exists, the expanded card
renders links, and the Pi adapter emits none: an in-memory session store has no
file to point at. Whether a native session file is worth surfacing when the
store is not in memory is an M7 question.

**4. The tool-output summary is a heuristic.** A string result is taken as it
is, an object's `output` field is used when there is one, an array becomes a
count, and anything else summarises to nothing. That is enough to be useful and
it is not a contract; a provider whose tool results are shaped differently would
show blank summaries rather than wrong ones.

**5. A steer the session is genuinely working on is still unbounded.** The
drain loop stops waiting on a delivery once the prompt has settled *and* the
session reports idle, so a Control the session will never take cannot hold a
Run open. A Control the session took and is still working on is a different
case: the Run waits, exactly as it waits for any provider turn, and
cancellation or the Session's default run timeout is what ends it. That is the
same bound every other provider turn has, but it is a bound outside the
adapter rather than inside it.

**6. The bridge buffer is a number nobody has pushed.** The adapter buffers up
to 4,096 observations between Pi's synchronous callback and the intake, and
overflows into the bridge policy's two observations rather than dropping. No
test drives it to the bound, and no real Run has come close.
