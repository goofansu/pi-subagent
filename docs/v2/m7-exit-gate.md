# M7 exit gate — cutover, hardening, and v1 deletion

**Verified:** 2026-09-03. **Version:** `2.0.0-rc.2`.
**Result: the deliverables are complete; the gate is not closed.** The roadmap's
definition of done has **twelve** items. Nine **pass**. One is **carried** — the
live smoke tests, green at M6 and not re-run on this build. One is **open** —
the release-candidate soak, which is days of real usage and nobody's to fake.
One is **not met**, measured and reported rather than argued away.

That is why the version still carries a release-candidate marker. Dropping it
would assert a soak that has not happened.

---

## How to read this

Each item below is **PASS**, **CARRIED**, **OPEN**, or **NOT MET**, and every
one names what was actually run.

- **PASS** — verified on this tree, with the evidence named.
- **CARRIED** — verified at an earlier milestone and unaffected by this one's
  changes, but not re-run here. Says what would re-verify it.
- **OPEN** — not done, and cannot be done by writing code.
- **NOT MET** — measured, and the measurement does not support the claim.

## The deterministic gate

```
npm run check   →  exit 0
```

| Step | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | 224 files, no findings |
| `npm test` | **1,185 tests, 1,177 pass, 0 fail, 8 skipped** |
| `npm run test:conformance` | **191 tests, 183 pass, 0 fail, 8 skipped** |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.153.0` |

**The eight skips are the same eight in both lanes, and every one is
capability-driven.** They are the one-shot fake refusing the six Control and
two continuation-usage scenarios its declared capabilities rule out.
`FakeResumableBackend`, `PiBackend`, `ClaudeBackend`, and `CodexBackend` skip
**nothing**, and four tests assert each empty skip list by name.

`check` is five steps where M6's was nine, and it runs one typecheck, one lint,
one test lane, one conformance script, and the protocol check.

---

## The roadmap's final release gate

### 1. All three backends pass shared conformance and their live smoke gates

**Conformance: PASS.** Thirty-seven scenarios against five rigs — both fakes
and all three real adapters, each behind a scriptable stand-in provider. 183
passing assertions, no skip that a declared capability does not drive.

**Live gates: CARRIED.** All six passed at M6 (see
[the M6 exit gate](m6-exit-gate.md)) and nothing in M7 touched a backend
adapter's behaviour. They have **not** been re-run on this build. Re-verifying
is `make smoke-pi && make smoke-claude && make smoke-codex`; each prints an
exact marker and spends provider quota.

One M7 change *does* affect a live gate and needs it re-run to be proven: the
Codex runtime gate gained the nondiscoverability proof, whole-process-tree
cleanup, and the Desktop coexistence checkpoints. Its deterministic half — the
transcript reasoning in `scripts/codex-smoke-contract.mjs` — has its own tests
and is green; its live half has not been run.

### 2. Public commands and user-visible outcomes satisfy the compatibility matrix

**PASS.** [The matrix](compatibility-matrix.md) was rewritten so that every
citation is a test in this repository rather than one in the deleted tree, and
the per-backend proof tables were folded into each command's section.

Checked mechanically rather than by reading: every backtick citation in the
matrix was matched against the set of `test(...)` names in the tree and the
conformance scenario ids. Three were stale and were fixed; the rest resolve.
Six cells carry a **[v2 change]** marker with its decision, and every *other*
wording difference between the two implementations is classified in
[the presentation ledger](presentation-ledger.md) — 65 pairs, 33 identical, 32
different, each intentional with a reference or fixed.

### 3. Session shutdown leaves no known native process, Query, listener, subscription, or fiber alive

**PASS deterministically; live evidence CARRIED.**

Seven resources are counted, and the Session rig reads the probe *after* the
Scope has closed for every test that builds a Session — so forgetting is the
only way to have a leak go unnoticed. M7 added the accumulation test this item
needed: `runtime/stress.test.ts` runs 300 lifecycle cycles per fake with the
probe asserted **zero after every cycle**, 60 Sessions built and disposed in
turn, and 40 rounds of shutdown arriving with a Run mid-execution. Fault
injection covers the hung-finalizer case, and the escalation is bounded.

Live: every gate reads the runtime probe and one block per adapter after
closure, and the Codex gate asks `ps` rather than the adapter — for the child
and, since M7, for every descendant it ever observed alive. Those readings are
M6's.

### 4. Failure and cancellation preserve partial output when available

**PASS.** `cancellation-terminates-with-partial-output` and
`a-run-may-settle-with-no-observations` (conformance, five rigs). The stress
lane cancels 300 Runs per fake and every one settles with what it had. The
result bodies for both cases are golden-tested, and the presentation ledger
confirms the wording matches 1.x's apart from the cancellation reason, which
v2 adds.

### 5. Completion delivery failure never affects result retrieval

**PASS.** `a-notification-follows-storage` and
`a-notification-retry-cannot-duplicate-or-alter-settlement` (conformance);
`a push that fails leaves the Result retrievable and unchanged`
(`host/end-to-end.test.ts`); `a failing sink leaves the Run settled and the
result readable` (`runtime/faults.test.ts`). The rule it rests on is
structural: storage precedes notification, and delivery *reads* the store
rather than being handed a value, so a retry cannot deliver something
`agent_result` would not return.

### 6. No v1 production path or compatibility flag remains

**PASS**, and proven four ways rather than asserted:

- **The tree.** `extensions/` holds one directory. The 1.x tree, its four live
  smoke scripts, its two contract modules, its npm scripts, its Makefile
  targets, the fallback switch, and the second schema library are deleted.
- **The lanes.** Sixteen npm scripts and eight Makefile targets, none prefixed,
  none naming a deleted path.
- **The vocabulary ban.** The legacy Profile field name appears in exactly two
  files: `boundaries.test.ts`, which declares it in order to forbid it and
  excludes itself from the scan, and `backend/pi/session.ts`, which names
  `AgentHarness` — the one compound ADR-0022 reserves. The boundary test
  enforces it across every file in the tree whatever its extension.
- **No flag.** There is no environment variable, settings key, Profile field,
  or alias that selects an implementation. There is one.

### 7. The architecture can be explained without referencing legacy managers or dispatchers

**PASS.** [The architecture note](../architecture.md) is thirteen sections and
uses Session Scope, Subagent Scope, Run Scope, BackendAgent, observations,
reducer, repository, and immutable Result. It names the deleted abstractions in
exactly one place — a pointer to the deletion ledger — and the ledger is where
"what happened to the manager" is answered.

---

## The definition of done

| | Item | Result |
| --- | --- | --- |
| 1 | One Effect runtime owns the full Pi-session lifetime | **PASS** — one `ManagedRuntime` per Session behind the session handle; binding disposes what was bound, so a Session switch cannot leave two alive |
| 2 | Session, Subagent, Run, and native-execution scopes express all retained resource ownership | **PASS** — four nested Scopes; `Layer` confined to the composition module and its six services by a boundary rule |
| 3 | Pi, Claude, and Codex use backend-specific adapters and the same core contract | **PASS** — three directories, one contract, confinement enforced in both directions per adapter, and no adapter names another |
| 4 | All visible Run state is derived through one ordered, bounded projection path | **PASS** — `reduceRun` is the only writer, `RunRepository` the only publisher; every list and text bounded, every truncation recorded |
| 5 | Controls have bounded and truthful admission/delivery semantics | **PASS** — three mailbox bounds, immediate typed refusal, and four stages kept apart with `accepted` saying so every time |
| 6 | Results settle exactly once after cleanup and reconciliation | **PASS** — settlement coordinator plus pure arbitration; `duplicateSettlements`, `duplicateCommits`, and `conflictingCommits` all read zero across the stress lane's 1,260 settled Runs (900 resumable, 300 one-shot, 60 in the Session-churn test) |
| 7 | The public UX matches the agreed compatibility matrix | **PASS** — see gate item 2 |
| 8 | Deterministic race tests and backend conformance suites are green | **PASS** — `check` exits 0 |
| 9 | Representative live smoke tests are green | **CARRIED** — all six green at M6, not re-run on this build |
| 10 | v2 has completed daily-driver and release-candidate soak gates | **OPEN** — see below |
| 11 | v1 runtime code, flags, and duplicated lifecycle tests are removed | **PASS** — see gate item 6 |
| 12 | The final codebase contains less lifecycle machinery than v1 | **NOT MET** — see below |

### Item 10 — the soak is open

[The soak record](soak.md) is restructured for three backends with four
checkable exit criteria, and its log is **empty**. The M4 soak never
accumulated an entry either.

**And the rollback window is not what it was designed to be.** The plan put the
soak *before* the deletion, so that a defect found in it was a Session-level
switch away from being avoided. The deletion was taken first, deliberately, so
rolling back is now an ordinary release rollback to `v1.0.0` and nothing
crosses over. That raises the cost of a defect found in the soak, and the soak
record says so at the top rather than in a footnote.

**What closing it needs:** representative usage of start, resume, steer,
cancel, shutdown, and a Session switch, per backend, several times, across
distinct days — with the diagnostics command's probes read at each shutdown, no
open severity-1 or severity-2 defect, and every severity-3 fixed or marked
intentional.

### Item 12 — less lifecycle machinery: not met

The clause is *"The final codebase contains less lifecycle machinery than v1,
not merely Effect-shaped versions of the same machinery."*

It does not hold on any count that can be constructed honestly, and
[the deletion ledger](deletion-ledger.md) is the measurement. Comment lines are
excluded throughout, because this codebase's commentary is dense and counting
it would flatter the larger tree.

| | v1 | now |
| --- | --- | --- |
| generic lifecycle modules | 8 | 13 |
| generic lifecycle code lines | 1,370 | 2,163 |
| whole extension, production files / lines | 32 / 8,162 | 131 / 20,115 |
| whole extension, test files / lines | 23 / 19,249 | 77 / 21,328 |

**What is true instead**, and stated rather than substituted:

- **The mechanisms the clause is about are gone.** In generic lifecycle code:
  `AbortController` 1 → **0**, `AbortSignal` 4 → **0**, `setTimeout` 2 → **0**,
  mutable `let` bindings 21 → **9**. Seven named abstractions were deleted
  rather than translated — the manager, the registry, the dispatcher, the
  executor seam, the control source, the delivery module, and hand-ordered
  session shutdown — and the ledger records, for each, what the replacement no
  longer has to do.
- **The growth is not machinery.** `testing/` is 8,072 lines, 40% of production
  code, and it is the shared conformance kit, five rigs, two fake backends, and
  three stand-in providers that let thirty-seven scenarios run against every
  backend with no skips. `backend/codex/` is 2,254 because it is a process, a
  JSON-RPC protocol, a reader, and a signal ladder. Neither is the thing the
  clause forbids.
- **The runtime does more.** Thirteen counters and a seven-field probe, every
  bound as one configuration value, a bounded intake with backpressure,
  reservations and pins and eviction, arbitration as a pure function. Each is a
  property 1.x did not have.

**The clause as written asked for a number that does not come out.** Saying so
is worth more than finding a denominator that makes it.

---

## What M7 changed, by ticket

| # | Ticket | Landed |
| --- | --- | --- |
| 01 | Widget row lifetime | A settled Run's row lasts until its notice lands. The soak's one open severity-3 closed; a new boundary rule keeps the widget out of delivery. |
| 02 | The two Codex gates on v2 | The CLI pin moved 0.150.1 → 0.153.0, additively; the runtime gate gained nondiscoverability, whole-tree cleanup, and the Desktop checkpoints; the `codex-upgrade` procedure and the coexistence document name only current gates; the retained-release check reads the current marker and rejects the old form. **The live runs and the Desktop evidence are outstanding.** |
| 03 | Stress and bounds | 300 cycles per fake with the probe zero after each, plus every bound driven past. **It found a severity-2 defect on its fifth cycle** — the Result store could wedge a Session permanently — which is fixed. |
| 04 | The presentation ledger | 65 pairs compared while both trees existed. One regression found and fixed: `agent_wait` had stopped saying why a Run was cancelled. |
| 05 | Cutover | The manifest names one extension; `2.0.0-rc.1`; the upgrade notice; the switch inverted; the nine blockers evaluated with evidence and residual risk. |
| 06 | The soak | Restructured for three backends with four exit criteria. **Log empty.** |
| 07 | Deletion | The tree, four scripts, two contract modules, the lanes, the targets, the switch, the second schema library. Three boundary rules deleted, two re-aimed, eighteen kept. |
| 08 | The move | `extensions/subagent/`; one project file; unprefixed scripts and targets; `/subagent`; the widget key and notification type back to the names 1.x registered, so a pre-cutover transcript still renders. |
| 09 | Documentation | The glossary, a new architecture note replacing two documents, a debugging guide, contributor rules, the matrix rewritten with verified citations, the deletion ledger, thirteen ADR status notes, and the README. Every internal link resolves. |
| 10 | This document | |

## What has to happen for `2.0.0`

Three things, in this order:

1. **Run the six live gates on this build.** `make smoke-pi`,
   `make smoke-claude`, `make smoke-codex`. Each prints an exact marker.
2. **Complete the Codex Desktop coexistence record** for codex-cli 0.153.0
   against this adapter, then `npm run codex:retained-release:check`. This gate
   has never passed for any CLI version; it is human-only and it is the one
   release gate with no deterministic substitute.
3. **Soak it.** [The soak record](soak.md) says what counts and what closes it.

Then drop the release-candidate marker, and the version is the claim.

## The blockers, restated

[The nine cutover blockers](cutover-blockers.md) were evaluated one at a time
with the test, scenario, or gate that rules each out, plus the residual risk the
evidence does not cover. **None is reproducible.** Nothing in M7's later tickets
changed that, and the stress lane strengthened four of the nine.

The one blocker whose evidence is weaker than it was: *"shutdown leaks or hangs
on a fiber, listener, Query, session, process, or background terminal"* is
proven deterministically to a standard M6 could not reach, and its **live**
evidence is M6's rather than this build's.
