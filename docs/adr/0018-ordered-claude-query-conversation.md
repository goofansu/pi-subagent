# 18. Claude uses one ordered streaming Query per Run

**Status:** Accepted.

## Context

Claude streaming input may consume guidance only after a successful provider
Result. Treating the first Result as public Run settlement loses accepted
guidance, while retaining a live Query while idle conflates provider execution
with semantic continuation.

## Decision

Each Claude Run owns one fresh streaming Query and one ordered input engine.
The initial Run prompt and admitted Controls enter the same async input stream;
only one correlated Control is provider-visible at a time. A successful Result
is an adapter-local Turn checkpoint while earlier guidance remains outstanding.
Provider echo or `user_message_uuid` correlation reports the neutral user Fact
exactly once. Admission, delivery, rejection, and foreign correlation do not.

The prepared adapter privately retains the authoritative Conversation UUID.
Later Runs create a new Query with native `resume`, send only their new prompt
and Controls, and ignore historical replay. Missing, malformed, or changed
identity fails attachment without fresh-session fallback. Cumulative accounting
is differenced at every Result boundary with nonnegative reset handling, and a
fresh Query starts a fresh per-Run baseline. Cancellation closes input before
later delivery, aborts and closes the Query, preserves already confirmed Facts,
and discards stale correlation.

## Consequences

Claude now truthfully supports Session-scoped steering and Resume. Provider
Result boundaries are invisible above neutral Facts and Turn accounting; one
managed Run still settles once with one immutable Result and notification. No
Query, input pump, listener, timer, or Control subscriber remains while idle.
