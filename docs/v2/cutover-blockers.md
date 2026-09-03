# The cutover blockers, evaluated

**Status:** Evaluated 2026-09-03. **Conclusion: none of the nine is
reproducible.** **Milestone:** M7, ticket 05.

The roadmap's [immediate cutover blockers](roadmap.md#immediate-cutover-blockers)
say: *"Do not enable or continue a cutover if any of these is reproducible."*
Nine conditions, and this document is the checklist rather than a judgement. For
each one it names the deterministic test, live gate, or recorded evidence that
rules it out, so that the decision to point the manifest at v2 is something a
reader can re-check rather than something they have to take on trust.

## How to read a row

**Evidence** names what was actually run. Three kinds appear:

- **deterministic** — a test in `npm run check`, which every change runs. Named
  by test and file, or by conformance scenario. A conformance scenario named
  here runs against **all five** rigs: both fakes and all three real adapters,
  with no skips.
- **live** — a credentialed gate. `pi:smoke`, `claude:smoke`, and
  `codex:smoke` are the runtime gates over each adapter;
  `*:host-smoke` are the same backends through the surface a user has. These
  spend provider quota and are not in `check`.
- **structural** — a fact about the tree that a check enforces, rather than a
  behaviour a test drives.

**Residual risk** is what the evidence does *not* cover. A blocker with no
residual risk is unusual and the row says so.

---

## 1. One user request executes twice

**Not reproducible.**

**Evidence — deterministic.** A Run settles exactly once and its result is
stored exactly once, both by construction and by test.
`settlement-stores-the-result-exactly-once` and
`exactly-one-ending-wins` (conformance, all five rigs) drive competing
completion, failure, cancellation, timeout, and transport-loss signals into one
Run and assert that exactly one ending wins and one result is committed. The
`duplicateSettlements`, `duplicateCommits`, and `conflictingCommits` counters
exist so a second attempt is *counted* rather than silently absorbed, and the
M7 stress lane asserts all three read zero across 300 lifecycle cycles per fake
(`runtime/stress.test.ts`).

Delivery is the other place a request could be executed twice, because a model
told twice would act twice. `CompletionDelivery` deduplicates by Run id with an
atomic claim, so a settlement wake-up and a sweep arriving together produce one
push: `a-notification-retry-cannot-duplicate-or-alter-settlement` (conformance),
and the stress lane asserts the notification count equals the settlement count
over 900 Runs.

**Evidence — live.** Each of the three runtime gates asserts that every settled
Run produced exactly one notification, by comparing the notified ids against the
settled ids.

**Residual risk.** A *provider* that executed one Turn twice would be invisible
here: the core would see one Run and one ending. Nothing in this architecture
can detect that, and nothing in v1 could either.

## 2. A terminal snapshot appears before its result is retrievable or cleanup completes

**Not reproducible.**

**Evidence — deterministic.** This is invariant 12 and it is the ordering
settlement is built around: `result-follows-scope-closure` (conformance, all
five rigs) holds the Run Scope's finalizers open and asserts that no terminal
snapshot is published until they have finished. `wait-and-result-observe-the-same-value`
asserts the two readers cannot disagree.

At the surface, `when the widget stops listing a Run, agent_result returns its
result` (`host/end-to-end.test.ts`) asserts the same thing from the other
direction: a Run that has left the widget has been announced, and a Run that
has been announced was stored before its notice was built.

**Evidence — structural.** The `unreadableResults` counter fires when the
repository says a Run settled and the store cannot read it back. The stress lane
asserts it reads zero across every cycle.

**Residual risk.** None identified.

## 3. A late observation mutates terminal state

**Not reproducible.**

**Evidence — deterministic.** `late-events-cannot-mutate-a-terminal-run`
(conformance, all five rigs) emits after the ending and asserts the projection
is unchanged. Two counters keep the two cases apart — `lateEvents` for an emit
the sealed intake dropped, `lateObservations` for one that reached the reducer
and changed nothing — so "nothing happened" is distinguishable from "nothing was
noticed". The M7 stress lane emits from a finalizer on **every** Run of every
cycle, so `lateEvents` rises past 300 per fake, and asserts that no terminal
Run's result differs for it.

**Evidence — live.** Each runtime gate reads every probe after the Session Scope
has closed, which is after every finalizer that could have emitted.

**Residual risk.** None identified.

## 4. Shutdown leaks or hangs on a fiber, listener, Query, session, process, or background terminal

**Not reproducible.**

**Evidence — deterministic.** Every test that builds a Session reads the runtime
probe *after* the Session Scope has closed — the Session rig does it for the
caller, so forgetting is the only way to have a leak go unnoticed. Seven
resources are counted: live Run fibers, live reducer fibers, open observation
queues, open mailboxes, unresolved waiters, repository subscriptions, and open
BackendAgents.

The M7 stress lane is the accumulation test this blocker needs: 300 cycles per
fake with the probe asserted **zero after every cycle**, 60 Sessions built and
disposed in turn each leaving a clear probe, and 40 rounds of shutdown arriving
with a Run mid-execution (`runtime/stress.test.ts`). Fault injection covers the
hanging case: `runtime/faults.test.ts` holds a native finalizer past the cleanup
budget and asserts the core closes the BackendAgent out from under it, counts a
`cleanupEscalation`, and still settles — so a hung finalizer is bounded rather
than terminal.

**Evidence — live.** All six live gates read every probe after closure: the
runtime's, and one block per backend adapter for that provider's own handles.
Codex is the one backend that owns an operating-system process, and its gate
asks `ps` rather than the adapter — both for the child and, since M7, for every
descendant ever observed alive.

**Residual risk.** A background terminal is Pi's own surface rather than this
extension's, and nothing here opens one.

## 5. Cancellation cannot terminate within the backend's declared cleanup policy

**Not reproducible.**

**Evidence — deterministic.** `cancellation-terminates-with-partial-output`
(conformance, all five rigs) cancels a Run and asserts it settles `cancelled`
with whatever output it had produced. The cleanup budget is policy rather than
hope: `runtime/faults.test.ts` drives a finalizer past it and asserts the
escalation. The stress lane cancels one Run per cycle — 300 per fake — and
asserts each settles and leaves the probe clear.

**Evidence — live.** Each runtime gate cancels a Run and asserts it settles
`cancelled`; the Codex gate additionally asserts that an interrupted Turn leaves
the process, the root thread, and the Subagent alive, because `turn/interrupt`
stops only the Turn.

**Residual risk.** A provider that ignored its own interrupt would be caught by
the escalation rather than by cancellation, and the Subagent's conversation is
then honestly reported lost. That is the documented cost, not a silent one.

## 6. Resume targets the wrong native conversation

**Not reproducible.**

**Evidence — deterministic.** `resume-or-honest-refusal` (conformance, all five
rigs) requires a subsequent Run to continue the retained conversation or report
`unsupported` / `conversation lost` — never to silently start a new one.
`a-resumed-run-excludes-prior-usage` is the corroborating measurement: a resume
charged for the whole conversation would be a resume that had replayed it.
Identifiers cannot be confused across Sessions either, which was the M4
severity-1 defect: every identifier carries a per-Session nonce
([ADR-0031](../adr/0031-v2-session-scoped-identifiers.md)), so a stale id is
reported unknown rather than resolving to a different Run.

**Evidence — live.** All three runtime gates plant a random marker in the first
Run and assert the resumed Run recalls *that* marker. For Codex the claim is
stronger and is checked on the wire: exactly one `initialize`, exactly one
`thread/start`, no `thread/resume` ever, and every `turn/start` on the one root
thread — read from the captured JSON-RPC transcript by
`scripts/codex-smoke-contract.mjs`, whose reasoning has its own deterministic
test.

**Residual risk.** None identified.

## 7. An accepted semantic observation is silently lost or reordered

**Not reproducible.**

**Evidence — deterministic.** `observations-reduce-in-accepted-order`
(conformance, all five rigs) is the ordering claim. The bounded intake **waits**
rather than dropping, which is what makes "never silently lost" true of a burst:
`a burst far beyond the queue bound applies backpressure and loses nothing`
(`runtime/backpressure.test.ts`) drives 40 messages through a queue of two, and
the M7 bounds lane drives 200 through a queue of one and asserts all 200 arrive
in order with `queueOverflows` at zero (`runtime/bounds.test.ts`).

Where something *is* given up — past a projection bound — it is recorded: every
projection bound has a test in the bounds lane asserting the newest is kept and
the count dropped appears in the `TruncationRecord`, and every byte bound has
one asserting the bytes cut are recorded to the byte. A bound that discarded
without saying so is worse than no bound, and that is the property those tests
are for.

**Evidence — live.** Each runtime gate asserts a confirmed steer produced
exactly one user observation — two would mean an echo counted twice, none would
mean guidance the model read went unrecorded.

**Residual risk.** None identified.

## 8. Usage is materially double-counted

**Not reproducible.**

**Evidence — deterministic.** The whole usage conformance section, against all
five rigs: `usage-deltas-are-run-local`,
`reconciliation-does-not-double-count`, `context-occupancy-is-a-gauge`,
`a-replayed-transcript-adds-no-usage`, and
`a-resumed-run-excludes-prior-usage`. The last two are the two ways a provider
actually causes this — replaying history, and reporting cumulative totals — and
[ADR-0027](../adr/0027-v2-usage-normalization.md) is the decision they enforce.
The `reconciliationDifferences` counter records a terminal reconciliation that
changed something streamed, and the stress lane asserts it reads zero.

**Evidence — live.** Each runtime gate asserts a resumed Run's input tokens are
greater than zero and less than the sum of both Runs' — that is, that it was
charged for its own work and not for the conversation.

**Residual risk.** A provider that reported its own totals wrongly would be
believed. The gauge-versus-delta distinction is where that would show, and the
soak's "what to watch for" names a context figure that grows without bound as
the symptom.

## 9. A public tool schema or profile contract breaks without the agreed migration

**Not reproducible, and the one agreed migration is documented.**

**Evidence — deterministic.** The six tool names, their parameters, and their
descriptions are asserted by `host/tool-schemas.test.ts` and
`host/tools.test.ts`; the registration surface itself by `index.test.ts`. The
`agent_resume` tool is not new in v2 — v1 exposes it too — so the tool set is
unchanged.

The Profile contract has exactly one break, and it is the agreed one: a Profile
names its backend with `backend:` where v1 used a differently-named field. That
is [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md), a documented
configuration migration with **no alias**, with
[the migration note](profile-backend-field-migration.md) as the user-facing
instruction and a **[v2 change]** marker on the matrix's Backend field name
cell. The README's `## Upgrading from 1.x` section names it as the one breaking
change and links the note, asserted by `packaging.test.ts`. A Profile still
using the old field fails validation as an unrecognised field and is reported at
Session start rather than ignored.

**Evidence — structural.** The boundary test rejects the legacy field name
anywhere in the v2 tree, in a file of any kind, so the old name cannot creep
back in as a quiet alias.

**Evidence — live.** Each host gate drives the six tools through the surface a
user has, against a Profile directory written for the run.

**Residual risk.** Every other wording difference between v1 and v2 is
classified in [the presentation ledger](presentation-ledger.md) — 65 pairs, 33
identical, 32 different, every difference intentional with its reference or
fixed. None of them is a schema or contract change.

---

## Conclusion

None of the nine blockers is reproducible. The manifest names the v2 entry, the
package is `2.0.0-rc.1`, and v1 remains in the tree as a Session-level fallback
for the length of the release-candidate soak.

Two things are **outstanding rather than clear**, and neither is a blocker on
this list:

1. **The live gates have not been re-run on the cutover build.** Every gate
   passed at M6 and nothing in M7's changes touches a backend adapter, but a
   cutover build's live gates are the release gate's business and are recorded
   in the milestone's final exit gate rather than here.
2. **The Codex Desktop coexistence evidence does not exist for any CLI
   version**, so `npm run codex:retained-release:check` is red. That gate was
   red before M6 as well; it is a human-only procedure and its state is recorded
   in [the coexistence document](../codex-desktop-coexistence-release.md).

The soak that follows is the rollback window. Any blocker that turns out to be
reproducible during it stops the cutover, and the fallback switch is how.
