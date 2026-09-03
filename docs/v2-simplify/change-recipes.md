# Change recipes

**Status:** Current as of Phase A. Every phase of
[the simplification roadmap](roadmap.md) updates the recipes it affects, and a
recipe that names a file that no longer exists is a bug in this document.

A recipe says, for one kind of change, which files are expected to move, which
must not, which tests prove it, and which invariants it touches. It is
[the change-surface table](change-surface.md) in operational form, and it is
the smell test a reviewer applies before reading a diff: if the diff touches a
file in the "must not change" list, the question is *why*, before anything
else.

The recipes cite files because that is what makes them useful. That is also
what makes them go stale, so each phase gate re-reads them.

---

## Change the wording of a completion notice

**Expected to change**

- `presentation/notification-text.ts`
- `presentation/notification-text.test.ts`
- [the presentation ledger](presentation-ledger.md), one row per sentence
- `docs/v2/compatibility-matrix.md`, the Notification row, if the matrix
  quoted the sentence

**Must not change**

- anything under `runtime/`
- anything under `backend/`
- `domain/notification.ts` — wording is not a field
- `presentation/renderers.ts` — the collapsed summary reads the host payload,
  field by field, and not the notice's sentence

**Tests** — `npm test` (the goldens); the host smoke lanes if the smoke
asserts on the text.

**Invariants** — F9 (presentation depends only on projections). The formatter
takes `RunNotification` and nothing else, and since Phase A a boundary rule in
`boundaries.test.ts` says so: `presentation/notification-text.ts` may import
only from `domain/` and `presentation/`. So the "must not change" list above is
enforced rather than advisory — a wording change that reached for a runtime
module would fail the checker before it failed review.

---

## Add a field to the completion notice

**Expected to change**

- `domain/notification.ts` — the field and its derivation in
  `toRunNotification`
- `presentation/notification-text.ts` — if the model reads it
- `host/notification-message.ts` — only if the collapsed summary shows it,
  where the field joins `NotificationDetails`
- `presentation/renderers.ts` — only then, and only to read the new payload
  field
- tests for each

**Must not change**

- `runtime/delivery.ts` — delivery builds the notice by calling one function
  and does not read its fields
- `runtime/result-store.ts`, `runtime/supervisor.ts`
- `domain/result.ts` — unless the field is genuinely new information the
  Result does not hold, in which case this is a different recipe (below)
- `domain/usage.ts` — the notice carries `NotificationAccounting`, which is
  the four figures the line prints; a usage figure the line does not print is
  not a notice field
- `presentation/run-card.ts` — unless the field is an *accounting* figure. The
  card shows the same four figures in the same grammar for a Run that has not
  settled and has no notice, so it is a second **caller** of
  `toNotificationAccounting` and not a second conversion: one place decides
  whether there is anything to account for, two surfaces read the answer

**Tests** — `npm test`; the notice-shape assertions in
`presentation/notification-text.test.ts`.

**Invariants** — F4 (the notice is derived from the stored Result; nothing is
invented); F9.

---

## Add a Profile option that one backend understands

**Expected to change**

- `profiles/*` — only if the generic parser needs to pass the field through;
  it understands `description`, `backend`, and the body, and passes the rest
- `backend/<name>/*` — the validator and whatever consumes the option
- that backend's tests and, if the option changes observable behaviour, its
  conformance fixture

**Must not change**

- `runtime/*`
- `domain/*`
- `backend/<other>/*`
- `host/*`

**Tests** — `npm test`; `npm run test:conformance`; that backend's live smoke
if the option changes what the provider is asked.

**Invariants** — F7 (no new generic capability); F8 (the option's vocabulary
stays in the adapter). A field the backend does not recognise is a diagnostic,
not a silent pass-through.

---

## Add a display-only column to the widget

**Expected to change**

- `presentation/rows.ts` and its test
- `host/widget.ts` and its test, if the layout changes
- `docs/v2/compatibility-matrix.md`, the widget row

**Must not change**

- `runtime/supervisor.ts`
- `runtime/repository.ts` — the widget reads the snapshot the repository
  already publishes
- `domain/projection.ts`, `domain/reduce-run.ts` — if the column needs a
  field the snapshot does not carry, that is the "add an observation or
  snapshot field" recipe and it is allowed to be more expensive

**Tests** — `npm test`; the widget rows in `host/widget.test.ts`.

**Invariants** — the widget never determines lifecycle state (matrix, widget
row); F9.

---

## Add a backend

**Expected to change**

- `backend/<name>/*` — the adapter: `Backend`, `BackendAgent`, `execute`,
  Profile validation, observation translation
- `runtime/composition.ts` and `host/production-backends.ts` — registration
- a conformance test file under `testing/` wiring the shared scenarios to the
  new adapter, with skips declared by capability
- a live smoke script and a `*:host-smoke` lane, and the matrix's proof
  tables

**Must not change** — and this is the whole test of the seam:

- `runtime/*` beyond the one registration line
- `domain/*`
- `presentation/*`
- `host/*` beyond the one registration line
- `backend/<other>/*`

**Tests** — `npm run check`; the new conformance lane; the new live gates.

**Invariants** — F7, F8; the contributing rule *Adding a backend*. If adding
the backend requires a new Run phase, a new store behaviour, or a supervisor
branch on the backend's name, stop and repair the seam before continuing —
that is the v2 roadmap's programme-level signal and it still applies.

---

## Add an observation or a snapshot field

**Expected to change**

- `domain/observations.ts` — the observation
- `domain/reduce-run.ts` — how the projection absorbs it
- `domain/projection.ts` — the field
- `backend/*` — each adapter that can emit it
- presentation that shows it
- tests for each, and the conformance scenario if every backend must emit it

**Must not change**

- `runtime/supervisor.ts`, `runtime/run-scope.ts` — the reducer is pure and
  the runtime feeds it; a new observation is not a new lifecycle
- `runtime/result-store.ts`

**Tests** — `npm run check`; `runtime/bounds.test.ts` if the field is a list
or text, because every one has a bound.

**Invariants** — invariants 5 and 6 (backends emit observations; observations
are ordered and lossless); F10 (bounded).

---

## Add a Result field

**Expected to change**

- `domain/result.ts` — the field
- `domain/result-bounding.ts` — whether bounding may cut it, and in what order
- wherever the Result is assembled at settlement
- `domain/notification.ts` — only if the notice should carry it
- presentation of the result body, and tests

**Must not change**

- `runtime/result-store.ts` — the store holds encoded results and does not
  read their fields
- `runtime/delivery.ts`
- `backend/*` — a Result field is neutral; if only one backend can supply it,
  it is optional and the adapter emits an observation for it

**Tests** — `npm run check`; the result-bounding tests driven past the byte
budget with the new field present.

**Invariants** — F10; identity, status, and timestamps are never removed by
bounding.

---

## Change terminal lifecycle

Allowed to be expensive. Expect `domain/phases.ts`, `domain/reduce-run.ts`,
`domain/reconcile-run.ts`, `domain/result.ts`, `runtime/arbitration.ts`,
`runtime/run-scope.ts`, `runtime/supervisor.ts`, every status helper in
`presentation/status.ts`, the conformance scenarios, and an ADR. The freeze
rows F2 and F3 apply in full. Nothing in this programme does this.

---

## Rename a runtime concept

Phase A's `delivered` → `handedOff` is the model: the delivery module's state
set, its accessor, and the local that receives a push result, plus boundary
rule 20 forbidding any inflection of *land* in `runtime/delivery.ts` and its
test.

**Expected to change**

- the module that owns the name, and its test
- `CONTEXT.md`, the glossary entry
- a boundary rule fencing the old word out of the module, with its negative
  fixture, when the old word was wrong rather than merely worse — and a
  *positive* fixture too, so the rule is shown not to fire on the vocabulary
  that replaced it

**Must not change**

- any behaviour. The test diff is the rename and the fence and nothing else.

**Tests** — `npm run check`; `boundaries.test.ts` with the new fixture.

**Invariants** — whichever the module enforces; the freeze rule that a rename
is a simplification only if its test diff is empty apart from itself.

---

## Extract a mechanism from the supervisor

Phase B's recipe.

**Expected to change**

- `runtime/supervisor.ts` — the mechanism leaves; a call to the new module
  replaces it
- the new module under `runtime/`, with its own unit test
- nothing else

**Must not change**

- every existing test under `runtime/` — they pass unmodified, or the
  extraction changed behaviour and goes back
- anything outside `runtime/`

**Tests** — `npm run check`; `runtime/races.test.ts` and
`runtime/stress.test.ts` are the detector for ordering changes under
contention.

**Invariants** — F2, F3, and whichever the mechanism carries (invariant 2 for
the registry, invariant 12 for admission). No new Effect Layer.

---

## Add or change an operator command

Phase A's `/subagent` namespace is the model.

**Expected to change**

- `host/diagnostics-command.ts` — the `/subagent` namespace root: the shallow
  status, the subcommand parse, and the report beneath it
- `host/agents-command.ts` — only if the Profile *flow* itself changes. It
  registers no command: `openProfilesUi` is the flow and `/subagent` owns the
  registration, so one place decides what a Profile list looks like and one
  place decides what an operator can type
- `index.ts` — only when a command is registered or unregistered
- `docs/v2/compatibility-matrix.md`, the `/agents` section, which is where a
  command's lifetime is decided

**Must not change**

- `runtime/*` — a command reads the live runtime through `SessionHandle.run`
  and never installs anything into it
- `application/*` — a command that called the façade would be a second caller
  with its own idea of a good brief; `/agents`'s work action sends a *user*
  message instead

**Tests** — `npm test`; `host/diagnostics-command.test.ts` and
`host/agents-command.test.ts`.

**Invariants** — F9 for anything the command formats. A removal is a
compatibility-matrix decision and needs a named version: 2.0 removes `/agents`
and the matrix marks it **[v2 change]**, which is the mechanism. An *alias* is
the thing to be suspicious of — it keeps two ways to do one thing in `/help`
and makes the user relearn the name twice, once when the second way appears
and again when the first goes.
