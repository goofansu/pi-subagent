# 32. A Result-store reservation evicts rather than refusing

Date: 2026-09-03

## Status

Accepted. Reverses one consequence of
[ADR-0006](0006-completion-notifications-and-result-store.md) — the rule that
only a commit evicts — while leaving everything else it decided in force.

## Context

`ResultStore.reserve` took `maxResultBytes` of headroom at admission or refused,
and refusing is what produces `at capacity`. Eviction ran only from `commit` and
`releasePin`, and only while the budget was already *exceeded*. The comment on
`reserve` argued the trade explicitly:

> Nothing is evicted to make room for a *reservation*: an unpinned stored result
> is a result somebody may still ask for, and throwing it away to admit a Run
> that has not started is the wrong trade. Only a commit evicts.

That reasoning is defensible about one reservation and does not survive being
run for long, because **nothing else in a Session ever frees a stored result**.
The steady state of a long Session is therefore: stored results accumulate to
just inside `resultStoreBytes`, the next reservation does not fit, and every
later `agent_start` answers `at capacity` — permanently, with nothing running,
and with unpinned results sitting there the store was entitled to evict.

**Found by measurement, not by reading.** The M7 stress lane lowered every bound
and ran the lifecycle in a loop; the fifth cycle's `start` came back
`at capacity` and the sixth never happened. At the default bounds — 256 KiB per
result against a 4 MiB budget — it takes on the order of a thousand stored
results in one Session to reach, which is why nothing before had noticed, and
why "several hundred cycles with every bound lowered" is a different test from
"one cycle".

## Decision

**A reservation that does not fit evicts the oldest unpinned stored output until
one fits.** It refuses `at capacity` only when there is nothing evictable left.

Pins stay absolute. A result still being delivered, still being read by a
registered waiter, or not yet published is not evictable, so a store whose every
entry is pinned refuses exactly as before. Eviction order is unchanged —
oldest first by commit sequence — and an evicted result keeps its entry and
answers by id with `ResultExpired`.

## Alternatives rejected

**Keep refusing, and document the ceiling.** Honest, and useless: a Session that
cannot start a Run and cannot be made to is a Session the user has to restart,
and the diagnostic would say `at capacity` while nothing was running. The
capacity outcome exists for *concurrent* pressure, and using it for accumulated
history overloads it into a lie.

**Evict on a timer, or on Run settlement.** Both add a second policy for when a
result dies, on top of the budget. The budget is already the policy; the defect
was that one caller could not reach it.

**Raise the default budget.** Moves the wedge further out and does not remove
it. The store is bounded on purpose, and any bound is reachable.

## Consequences

**What it costs.** A Run's stored output can now be evicted by a *later Run
starting*, where before only a later Run *finishing* could do it. A model that
started a Run, was told the answer was ready, started eight more, and then asked
for the first result can be told the output expired where previously it would
have been told there was no capacity for the eight. That is the trade, and it is
the right way round: `ResultExpired` is a documented outcome that names the Run,
its owner, and its status, and it is already distinct from an unknown Run in
the `agent_result` outcome union. `at capacity` with nothing running is not a documented
outcome of anything — it is a stall.

**What it does not change.** Storage still precedes notification. Delivery still
reads the store. `wait` and `result` still observe the same immutable value.
Reservations are still taken at admission, so `at capacity` is still an honest
answer for concurrent pressure rather than a discovery at settlement.

**The architecture challenge gate**, the four questions a structural change
has to answer:

- *What does this delete?* Nothing structural — it deletes a stall. No
  abstraction is added: `evict` already existed, with the budget it needed, and
  `reserve` now calls it.
- *Is it provider-neutral?* Yes. The store knows nothing about backends, and the
  change is proven against the fakes.
- *What breaks if it is wrong?* A result is evicted that should have been kept.
  Which is why pins are absolute and the refusal path is tested directly.

**Proof.** `a reservation evicts old unpinned output rather than wedging the
Session` and `a reservation still refuses when nothing can be freed`
(`runtime/result-store.test.ts`); under load, `a store full of unread results
evicts the oldest rather than refusing the next Run` (`runtime/bounds.test.ts`);
and across 300 cycles per fake with the smallest legal budget
(`runtime/stress.test.ts`), which is the test that found the defect.
