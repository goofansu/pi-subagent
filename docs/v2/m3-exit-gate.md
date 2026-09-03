# M3 exit gate

**Status:** Passed. **M3 is complete.**
**Date:** 2026-09-03
**Verified against:** [the v2 roadmap](roadmap.md), milestone M3.

This document verifies every M3 exit-gate item against the merged work, so that
M4 starts from an explicitly closed milestone. It follows the shape of
[the M2 exit gate](m2-exit-gate.md).

M3 is the milestone where v2 becomes reachable. After M2 the runtime had a
complete Run lifecycle and no user could get at it; launching Pi with only the
v2 entry point now gives a working subagent extension — six model tools, the
`/agents` command, the active widget, completion Notifications in the
conversation, and two demo backends behind all of it, with nothing to configure.

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
| `npm run test:v2` | 658 tests, 650 pass, 8 skipped |
| `npm run test:v2:conformance` | 77 tests, 69 pass, 8 skipped |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` |

The v1 lane's numbers are byte-identical to M2's: **M3 changed no v1 file.**
Outside the v2 tree, M3 changed exactly two things — `CONTEXT.md` (the glossary's
v2 section) and the `Makefile` (`dev-v2` now mirrors the v1 target's `--tools`
list, because there are now tools to mirror) — plus this record and the roadmap.

The v2 lane grew from 452 tests to 658. The skip list is unchanged at eight, all
of them `FakeOneShotBackend conformance: …` scenarios about capabilities that
backend declares it does not have.

## 2. Every public operation works through the actual host handlers with both fake backends ✅

Each of the six tools is driven through the `execute` Pi would call, with the
arguments Pi would pass, against a Session built from both fakes. The seam is
[`testing/stand-in-host.ts`](../../extensions/subagent/testing/stand-in-host.ts)
and [`testing/host-rig.ts`](../../extensions/subagent/testing/host-rig.ts);
nothing in a host test reaches past the host boundary into the supervisor, the
repository, or the store.

| Operation | Success path | At least one rejection path |
| --- | --- | --- |
| `agent_start` | `agent_start returns a Subagent id and a first Run id a model can act on` | `agent_start refuses an unknown agent and names the ones that exist` |
| `agent_resume` | `agent_resume starts a second Run on the same Subagent` | `the one-shot backend proves resume unsupported at the surface`; `agent_resume refuses a Subagent that is already running`; `agent_resume tells an unknown Subagent from a Run id` |
| `agent_steer` | `agent_steer accepts a message and says acceptance is local admission only` | `the one-shot backend proves unsupported steering at the surface`; `agent_steer rejects empty guidance before it looks the Run up`; `agent_steer names a terminal Run's status rather than calling it unknown` |
| `agent_cancel` | `agent_cancel reports request admission, not terminal cancellation` | `agent_cancel tells a finished Run from an id that never existed`; `a repeated agent_cancel is idempotent and the first request stands` |
| `agent_wait` | `agent_wait names each terminal Run by agent and status` | `agent_wait reports an unknown id rather than blocking on it`; `aborting the turn ends only the wait: the Run settles and its result stands` |
| `agent_result` | `agent_result returns the full stored output with its Run identity` | `agent_result on a live Run says it has not finished, distinctly from unknown` |

All in [`host/tools.test.ts`](../../extensions/subagent/host/tools.test.ts).
Both fakes are then swept in one table-driven pass —
`every public operation answers for the pi backend` and `… for the one-shot
backend` in
[`host/end-to-end.test.ts`](../../extensions/subagent/host/end-to-end.test.ts).

**Live, in a real Pi process.** `pi --offline -np -nc -ns -ne -e
extensions/subagent/index.ts` with the six tools allowlisted, against a real
provider. Quoted verbatim from the run:

`agent_start` on a demo Profile, which is the whole of gate item 2 in one
answer — ids, not the answer, and a promise about the notification:

```
Started demo-one-shot:
subagent id subagent-1
run id run-2

Use run id run-2 for agent_wait, agent_result, agent_cancel, and agent_steer.
Its notification will arrive when the Run finishes; carry on until then.
```

`agent_result` after the Run, proving the brief made the whole round trip —
through the backend, the projection, the Result store, and back out as prose:

```
demo-resumable (subagent subagent-1), run run-2:

The demo subagent was asked: count to three
```

`agent_resume` on the one-shot Profile, refused without starting anything:

```
Cannot resume subagent subagent-1: its backend does not support resume. No Run
or provider work was started. Start a new Subagent to continue this work.
```

And the completion Notification, as it reached the conversation — a custom
message of this extension's type, shown, carrying exactly the four identity
fields and an accounting line, which then triggered a turn the model
acknowledged:

```json
{"customType":"subagent-v2-notification",
 "content":"Subagent demo-resumable (subagent-1), run run-2 completed.\n\nThe demo subagent was asked: ping\n\nUse agent_result with id run-2 to retrieve the full result.\n\n12 in / 8 out · 1 turn",
 "display":true,
 "details":{"runId":"run-2","subagentId":"subagent-1","agent":"demo-resumable","status":"completed"}}
```

A disposable probe extension loaded alongside it in the same process reported
all six tools registered with the Effect-emitted JSON Schema documents, the
`agents` command registered, and the Session's Profile catalog holding the two
demo Profiles merged with the five in the operator's own agent directory.

## 2a. A Run inherits the facts of the Session that started it ✅

The working directory, the project-trust decision, and the parent model and
thinking level are read from the live Session at execute time rather than at
Session start, because the model and thinking level change during a Session and
a Run should inherit what was true when it began
([`host/tools.ts`](../../extensions/subagent/host/tools.ts),
`sessionFactsOf`).

The Session's **model catalogue** goes the other way — it is read once at
`session_start` and handed to the Profile catalog as a
`BackendValidationContext`, because validating a Profile is what a Session start
does. An adapter that pins a model has to check it against what *this* Session
can reach, and a Session that never handed its catalogue over would leave every
pinned model either unvalidated or wrongly rejected. Asserted end to end with a
backend that validates against the list it is given:

- `the Session's model catalogue reaches the backend that validates a Profile`
- `a Profile pinning a model this Session cannot reach is a diagnostic`

Both in [`host/session.test.ts`](../../extensions/subagent/host/session.test.ts).
The fakes themselves validate nothing, so the *content* of a real backend's
model validation is M4 to M6; what is proven here is that the catalogue arrives.

## 3. A terminal snapshot and its immutable result are visible together ✅

The invariant is a user-visible one, so it is asserted where a user would see
it: the widget lists live Runs, so a Run that has left the widget is terminal at
the surface — and a Run that is terminal at the surface has a retrievable
result, never `RunNotTerminal`.

- `when the widget stops listing a Run, agent_result returns its result`
- `a Run that is still on the widget has no result yet, and says so`

Both in [`host/end-to-end.test.ts`](../../extensions/subagent/host/end-to-end.test.ts).
The M2 gate proves the same invariant at the runtime seam; this proves it has
survived the trip to the surface.

## 4. Result storage always precedes notification, and missed or failed delivery cannot lose the result ✅

| Claim | Test |
| --- | --- |
| A settled Run sends exactly one follow-up notice that triggers a turn, built from the stored Result | `a settled Run sends exactly one follow-up notice that triggers a turn` |
| A push that throws leaves the Result byte-for-byte retrievable | `a push that fails leaves the Result retrievable and unchanged` |
| A notice an interrupted turn discarded is pushed again and lands exactly once | `a notice an interrupt discarded is pushed again and lands exactly once` |
| A notice that landed the first time is never sent twice | `a notice that landed the first time is never sent twice` |
| Shutdown drops an unlanded notice rather than sending it into the next Session | `shutting down drops an unlanded notice rather than sending it into the next Session` |
| A cancelled Run still notifies, terse and with no partial output | `a cancelled Run still notifies, and its notice is terse` |

All in [`host/end-to-end.test.ts`](../../extensions/subagent/host/end-to-end.test.ts).
The landing state machine itself is exercised event by event in
[`host/push-sink.test.ts`](../../extensions/subagent/host/push-sink.test.ts) —
thirteen tests including `a notice that lands synchronously inside the push is
not re-pushed later`, which is the ordering bug the sink records a notice
*before* handing it over in order to avoid.

**`CompletionDelivery` is unchanged.** M3 supplied the real Session push without
touching it, which was the point of putting a `NotificationSink` interface there
in M2. That is now a boundary rule rather than an observation: `a runtime module
importing the host, presentation, or the façade is rejected` in
[`boundaries.test.ts`](../../extensions/subagent/boundaries.test.ts), checked
against the real tree.

## 5. The presentation layer folds no backend events and owns no lifecycle state ✅

Enforced rather than reviewed. The boundary test's presentation rule admits only
the domain and Pi's own packages — not the runtime, not a backend, not a fake,
not even `effect`:

- `a presentation file importing the runtime, a backend, or a fake is rejected`
  (with a fixture, and the real tree passes)
- `a managed runtime or a signal outside the host module is rejected`

A presentation module that cannot name the runtime cannot reach the repository,
and one that cannot name `effect` cannot run anything. What it reads instead is
declared in
[`presentation/views.ts`](../../extensions/subagent/presentation/views.ts) in
domain types only, so a `RunSnapshot` is structurally assignable and no mapping
layer exists to drift.

The widget is the one consumer of that layer with a lifetime of its own, and it
is worth being precise about what it does and does not hold. It lives in the
**host** module, not in presentation, so it does name `Effect`, `Stream`,
`Scope`, and `RunRepository` — a subscriber has to. What it holds is one
variable caching the latest published index, and that is a cache rather than
state: throwing it away and re-reading the repository would produce the same
rows. It folds nothing, and it decides no Run's lifecycle.

What is asserted, rather than argued:

- `the widget lists only Runs that are not terminal` — the phase filter is the
  whole of its "which Runs exist" logic, and it reads the published phase
  rather than deciding one;
- `the widget appears with the first live Run and its row reads as the matrix
  says`, `the widget redraws on a change instead of reinstalling`, `a terminal
  Run leaves the widget at publication, and the last one takes it away` — every
  transition follows from the index it was handed;

both in [`host/widget.test.ts`](../../extensions/subagent/host/widget.test.ts),
with the row text itself fixed by
[`presentation/rows.test.ts`](../../extensions/subagent/presentation/rows.test.ts),
which runs against a theme that paints nothing and a fixed instant.

## 6. Repeated fake Sessions start and shut down without retained fibers, queues, subscriptions, or waiters ✅

- `ten consecutive Sessions each start, run, and shut down with a zero probe`
- `a Session shutdown disposes the runtime and leaves nothing alive`
- `a Session shutdown closes an active Run and its retained BackendAgent` —
  which also reads the fake's own counters from the far side of the contract
- `two Session starts in one process leave exactly one runtime alive`
- `a shutdown with no Session is a no-op rather than an error`

All in [`host/session.test.ts`](../../extensions/subagent/host/session.test.ts).
The probe is read *after* the Session Scope has closed, through a reader
captured while it was live — a probe read during a Session proves nothing.

## 7. Tool inputs are declared once as Schema, and the second schema library is gone from v2 ✅

Each of the six inputs is one declaration in
[`host/tool-schemas.ts`](../../extensions/subagent/host/tool-schemas.ts),
read three ways: the JSON Schema document Pi validates against, the runtime
check at `execute`, and the TypeScript type the façade takes.

The emitted documents are asserted against Pi's own `validateToolArguments`
rather than against a guess at what Pi accepts — `Pi's own tool-argument
validation accepts a well-formed call for each tool` — and the reason decoding
is still the real check is pinned by `a coerced argument that Pi would have let
through is rejected at the decode`: Pi's JSON-Schema fallback turns a number
into a string for a string field, so a call it lets through is stopped at the
decode.

The two shape notes the M2 spike left are honoured and tested: `the wait timeout
is emitted as a plain positive number, not a union with strings`, and
`additionalProperties: false` is asserted on every document (see the recorded
differences below).

The ban is a boundary rule: `the second schema library is rejected anywhere in
v2, tests included`. The dependency itself stays in the manifest until M7,
because v1 uses it.

## 8. The façade is the only caller of the supervisor from the host ✅

[`application/subagents.ts`](../../extensions/subagent/application/subagents.ts)
is a frozen object of six functions with no fields. The boundary test fixes both
of its edges — `an application file importing the host, a backend, or a Pi
package is rejected` — so it cannot become the host and the host cannot bypass
it.

`Effect.runPromise`, `ManagedRuntime`, `AbortSignal`, and `AbortController` are
confined to the host module and the test boundary, checked over the whole
production tree rather than the three modules M2 checked.

---

## Recorded v2 differences

Five places where M3 deliberately differs from v1 or from the letter of its own
spec. None is a regression; each is a decision with a reason.

**1. Tool parameters are strict.** v1's `Type.Object` permitted unlisted keys;
the Effect-emitted document carries `additionalProperties: false`, so a call
carrying an excess argument is rejected — by Pi's own validation and again at
the decode. An argument a tool does not understand is far more likely to be a
mistake than a courtesy, and a silently ignored one is a mistake nobody sees.
Asserted by `every tool's parameters are a JSON Schema object document with no
unlisted keys` and `Pi's own validation rejects an excess argument and a
malformed id`.

**2. A widget row leaves at publication.** v1 kept a settled row until its
notification landed. v2's row shows what is *live*, so a terminal Run leaves the
widget the moment its terminal snapshot is published. That is what makes gate
item 3 assertable at the surface — a Run that has left the widget has a result —
and it means the widget never shows a Run as finished, which the completion
notice already says. Asserted by `a terminal Run leaves the widget at
publication, and the last one takes it away`.

**3. A notification preview is one bounded line.** v1 previewed up to 1,000
characters of the completed output, preferring to cut at a nearby newline. The
v2 domain bounds a notice's preview to one line of at most 500 bytes, decided in
M2 at the point the notice is built rather than at the point it is rendered.
A notice is an orientation message pointing at `agent_result`; the whole answer
is one tool call away either way. Asserted by `a long answer is previewed rather
than delivered`.

**4. The domain Notification carries accounting, the primary error, and the
cancellation reason.** M3 extended `RunNotification` — a domain type — beyond
what M2 left there. Two things made it necessary and one keeps it honest. The
matrix's Notification row requires the accounting line and the primary error, so
the notice has to carry them; and a notice that had to re-read the store to say
what it was about would be a notice that could say something different from what
was stored, which is the one thing "storage precedes notification" exists to
prevent. What stayed exactly as the ticket specified is the *custom message's*
details — Run id, Subagent id, agent, and status, and nothing else — because
details that repeated the text would be a second copy that could disagree with
it. Asserted by `the details carry identity only, never the text`.

**5. Presentation names one Pi package beyond the TUI one.** The spec says
presentation imports "the domain and Pi's TUI primitives". Two of the helpers
the ported renderers need — `getMarkdownTheme` and `keyHint` — ship from
`@earendil-works/pi-coding-agent` rather than `@earendil-works/pi-tui`, exactly
as they do in v1. The boundary rule is therefore written as "the domain and Pi",
admitting `@earendil-works/*` and nothing else: not the runtime, not a backend,
not a fake, not `effect`. The property the spec's wording was protecting — that
presentation cannot reach state — is unaffected by which of Pi's two packages a
markdown theme comes from.

The three differences the compatibility matrix already recorded for these rows —
`mailbox full` and `mailbox closed` replacing `queue full` and `not steerable`,
`ResultExpired` and `RunNotTerminal` as typed outcomes, and a distinct
shutting-down outcome — are all implemented and asserted in
[`presentation/prose.test.ts`](../../extensions/subagent/presentation/prose.test.ts).

---

## Compatibility-matrix rows now proven by v2 tests

"Proven by v2 tests" means a v2 test in the `npm run check` lane asserts the
outcome the row states, against the fake backends. It does **not** mean parity
with a real provider: every row's provider-specific half is M4 to M6.

| Matrix row | Proven in v2 by |
| --- | --- |
| `agent_start` — expected outcome, unknown agent, at capacity | `host/tools.test.ts`, `presentation/prose.test.ts` |
| `agent_resume` — expected outcome, already running, unknown Subagent, `unsupported`, during shutdown | `host/tools.test.ts`, `host/end-to-end.test.ts`, `presentation/prose.test.ts` |
| `agent_steer` — expected outcome, `unsupported`, mailbox full, mailbox closed, terminal Run, invalid text, unknown Run | `host/tools.test.ts`, `presentation/prose.test.ts` |
| `agent_cancel` — expected outcome, repeated cancel, already terminal, unknown Run, request vs. terminal | `host/tools.test.ts`, `presentation/prose.test.ts` |
| `agent_wait` — expected outcome, timeout, aborted turn, repeated wait, unknown Run, duplicate ids | `host/tools.test.ts` |
| `agent_result` — expected outcome, not yet terminal, evicted output, unknown Run, after a failed Notification, after shutdown | `host/tools.test.ts`, `host/end-to-end.test.ts`, `host/session.test.ts`, `presentation/prose.test.ts` |
| Subagent close — expected outcome, idempotence, identity cleanup | `host/session.test.ts` (`a Session shutdown closes an active Run and its retained BackendAgent`; `a shutdown with no Session is a no-op rather than an error`; `two Session starts in one process leave exactly one runtime alive`, which asserts the previous Session's Run id is unknown to the next). **Late settlement is not asserted at the host surface** — it is proven at the runtime seam by the M2 races, and no host test drives it. |
| `/agents` — expected outcome, no Profiles | `host/agents-command.test.ts` |
| Active widget — expected outcome, observation only, lifecycle | `presentation/rows.test.ts`, `host/widget.test.ts` |
| Completion Notification — expected outcome, failed Run, cancelled Run, landing, push failure, no live Session | `presentation/notification-text.test.ts`, `host/notification-message.test.ts`, `host/push-sink.test.ts`, `host/end-to-end.test.ts` |
| Active widget — the coalescing the M2 gate deferred to its first consumer | `host/widget.test.ts` (`a burst of index changes coalesces into one render request per draw`, measured against a stand-in host that draws one request in fifty) |
| Profile loading — generic parsing, unknown backend name, unrecognized field, scope, backend field name | `domain/profile.test.ts`, `profiles/discovery.test.ts`, `host/session.test.ts` |

Rows whose v2 half is **not** proven, and why:

- **Profile model validation, `tools`, `appendSystemPrompt`, `effort`.** These
  are backend-specific Profile fields, validated by the adapter that understands
  them. The fakes validate nothing, so there is nothing to assert. M4 to M6.
- **Every provider-specific cell** — the retained SDK session, the Query
  attachment boundary, the App Server process. M4 to M6.
- **Expanded result presentation** (recent transcript, tools, diagnostics,
  native links). Deferred to M4 by the spec; `RunCard` is the place it will go.

---

## Answers to the gaps M2 carried

**1. Conflating the Run index stream is the consumer's job — answered.** The
widget subscribes once, keeps only the latest index, and asks the host to render
at most once per change batch: a render request is armed, and further changes
arriving before the host renders re-arm nothing.

The measurement needed the stand-in host to *draw*, not merely to count. A host
that never draws leaves the widget's pending-render flag set forever, which
makes every subsequent change free by construction and the assertion
unfalsifiable — so the stand-in draws one request in `renderEvery`, and a slow
terminal is `renderEvery: 50`. The invariant asserted is the one that can fail:
`renderRequests <= rendersPerformed + 1`. Over a 200-change burst that is 4
requests against 4 draws; with the pending-render guard deleted it becomes 200
against 4, and the test says so. `a slow subscriber still renders the latest
state after the burst` proves the conflation is not lossy, and `a host that
draws every request still gets one request per change batch` pins the other end
of the same rule — a fast terminal is asked again immediately, which is correct.

**2. `typebox` at the tool-parameter call site — answered.** Gone from v2, and
banned by the boundary test. The dependency stays in the manifest until v1 is
deleted at M7.

**3. Pushed is not landed — answered.** The Session push sink, its four host
events, and the exactly-one-landing contract. `CompletionDelivery` is unchanged.

Gaps M2 recorded that M3 deliberately leaves open: the Profile frontmatter
reader is still a documented YAML subset; Profile reload during a Session is
still out of scope; adapter-specific forced termination is still M4 to M6; and
there is still no public Subagent close tool.

---

## Gaps carried into M4

**1. Child depth is zero and the inert-in-child guard does not exist.** Nothing
runs inside a Subagent in M3, because no adapter exists to spawn one, so
`SessionFacts.childDepth` is a constant. Real depth and the guard that makes the
extension inert inside a Pi child are Pi-adapter knowledge and arrive with it.

**2. Expanded result presentation is a stub.** `RunCard` carries identity,
status, duration, accounting, and the final output, and `agent_result`'s text is
built from it — so the card is wired rather than merely present. The recent
transcript, the tool list, diagnostics, and native links are M4, and widening
the card's view is where they go.

**3. The demo backend's script reads only the prompt.** `echo-prompt` is the one
script step that reads the Run's input; everything else a script says is decided
before the Run exists. That is enough for the demo — the answer repeats the
question, so the round trip is visible end to end — but a fake cannot *react* to
a brief, and no test here should be read as evidence that a backend which does
will behave the same way. M4 replaces the set, and the demo Profiles go with it.

**4. The `agent_start` guidelines are a live array.** Pi stores the
`promptGuidelines` array a tool was registered with, so the Session module
rewrites its contents in place rather than re-registering the tool. It works and
is asserted (`the agent_start guidelines name the Session's Profiles and follow a
Session switch`), but it depends on Pi reading the array rather than copying it.
If that changes, the guidelines silently stop following the catalog.

**5. Notification landing depends on Pi's `message_start` reporting the
extension's own custom message.** It does today, and the round trip is one
declaration so build and parse cannot drift. But if Pi stopped reporting it, a
notice would never be marked landed and would be re-pushed on the next
interrupted turn. Nothing in v2 can detect that; it would show up as a duplicate
notification.

---

## What M4 starts from

- A working fake-backed product: six tools, `/agents`, the active widget,
  completion Notifications in the conversation, and Session start and shutdown,
  all reachable by launching Pi with only the v2 entry point.
- A host boundary that is the one place a Pi callback crosses into Effect, with
  the managed runtime, the abort signal, and the schema library confined by test.
- One `Subagents` façade with no state, and one session handle whose only way to
  install a runtime also disposes the previous one.
- A presentation module that owns every model-facing sentence about a Run, with
  a golden test per outcome variant, per widget row shape, per result body, and
  per notification.
- A `RunCard` with two sources and no third, ready for M4's expanded
  presentation.
- A Session push sink that turns "exactly one landing per Notification" into an
  assertion over four host events.
- A stand-in Pi host and a host rig, so a test can call the `execute` Pi calls
  and read the text a model reads.
