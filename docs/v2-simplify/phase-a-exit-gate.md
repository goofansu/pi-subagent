# Phase A exit gate — notification semantics and UX

**Status: not started.** **Verified against:** [the roadmap](roadmap.md),
Phase A; [the notification semantics](notification-semantics.md);
[the presentation ledger](presentation-ledger.md).
**Closing this gate unlocks:** the 2.0 stable release from the notification
side. The three release items the v2 roadmap left open (live gates on the
cutover build, the Codex Desktop coexistence record, the soak) are separate
and unchanged.

## How to read this

Each item is **PASS**, **CARRIED**, **OPEN**, or **NOT MET**, with the same
meanings as [the M7 gate](../v2/m7-exit-gate.md), and every one names what
was actually run. Items are written now, before the work, so the work is
judged against a list it did not write.

## The deterministic gate

```
npm run check   →  exit 0
```

| Step | Result |
| --- | --- |
| `npm run typecheck` | |
| `npm run lint` | |
| `npm test` | |
| `npm run test:conformance` | |
| `npm run codex:protocol:check` | |

**Status:** OPEN.

## The items

### 1. The delivery module does not say "landed"

`runtime/delivery.ts` exposes `handedOff()` and keeps `DeliveryState.handedOff`;
no inflection of *land* appears in the file. A boundary rule in
`boundaries.test.ts` enforces it and has a negative-case fixture that the
checker fails on purpose. The push sink's `hasLanded`, `landed()`, and
`onLanding` are unchanged. `CONTEXT.md` defines handed off, landed, lost after
hand-off, and exhausted.

**Evidence to name:** the boundary rule and fixture; `runtime/delivery.test.ts`
diff limited to the rename.

**Status:** OPEN.

### 2. The Run label is bounded at admission and recorded when shortened

A description of 10 KB with newlines yields a Run whose label is one line of at
most 200 bytes, whose Result carries a diagnostic saying the label was
shortened, and whose Result stays within the byte budget with every removable
section cut. The tool schemas' description fields state the bound.

**Evidence to name:** the bounds-lane test driving the label past its limit;
the schema copy test.

**Status:** OPEN.

### 3. Every terminal notice points at `agent_result` with the exact argument shape

Completed, failed, and cancelled notices all end with a pointer of the form
`Call agent_result with {"id":"…"}.` prefixed by the availability sentence.
The cancelled golden that asserted no pointer is replaced.

**Evidence to name:** `presentation/notification-text.test.ts`, one golden per
status and availability.

**Status:** OPEN.

### 4. The notice carries the label, the duration, and bounded accounting, and not the backend

`RunNotification` has `label`, `durationMillis`, `resultAvailability`, and
`accounting`, and has no `backendId`, `description`, `usage`, or `model`. The
backend-independence golden still passes and is now structural.

**Evidence to name:** the notice-shape assertions; the three-backend golden.

**Status:** OPEN.

### 5. The preview is labelled and quoted

A completed notice's body reads `Preview from the subagent:` followed by the
preview in straight double quotes. The preview bound is still 500 bytes.

**Evidence to name:** N-1 and N-3 in the ledger, confirmed.

**Status:** OPEN.

### 6. The collapsed summary identifies the work

The transcript's collapsed line reads agent, label, verb with duration, and
cost when non-zero; it carries no id and no character count. The expanded text
carries both ids.

**Evidence to name:** `host/notification-message.test.ts` and
`presentation/renderers.test.ts`; S-1 and S-2 in the ledger.

**Status:** OPEN.

### 7. The operator namespace is `/subagent`

Bare `/subagent` prints the shallow status; `/subagent profiles` is the
Profile list; `/subagent diagnostics` is the counters and probes; `/agents`
still works and produces the same list. The compatibility matrix's `/agents`
row says when the alias goes.

**Evidence to name:** `host/agents-command.test.ts`,
`host/diagnostics-command.test.ts`; C-1 and C-2 in the ledger.

**Status:** OPEN.

### 8. Notification text depends on `RunNotification` alone, and it is fenced

A boundary rule forbids `presentation/notification-text.ts` from importing
anything outside `domain/` and `presentation/`. Negative fixture present.

**Evidence to name:** the rule and its fixture.

**Status:** OPEN.

### 9. Every ledger row is confirmed

Each row of [the presentation ledger](presentation-ledger.md) names the golden
that now asserts its after column. No row is left "not yet" except W-2, which
is Phase C's.

**Status:** OPEN.

### 10. The compatibility matrix cites this phase

The Notification, widget, and `/agents` rows cite
[notification-semantics.md](notification-semantics.md) for every cell Phase A
changed, and the proof tables name the new goldens.

**Status:** OPEN.

### 11. The change-surface baseline is measured

[change-surface.md](change-surface.md) has a Phase A row with all six cells
filled from real diffs or, for R5 and R6, from a written module list, and the
estimated column is marked superseded.

**Status:** OPEN.

### 12. The architecture note has its map, and the recipes exist

[architecture.md](../architecture.md) opens with the compact block diagram and
its writes/reads/host-only legend. [change-recipes.md](change-recipes.md) has
a recipe for each representative change. contributing.md carries the freeze
rule.

**Status:** OPEN.

### 13. ADR-0033 is accepted

An ADR records the delivery-state vocabulary, the decision that every terminal
notice carries a pointer with availability, and the Run label bound.

**Status:** OPEN.

### 14. The live gates are re-run on this build

Model-facing text changed and the host smoke lanes assert on it. All six
(`pi:smoke`, `pi:host-smoke`, `claude:smoke`, `claude:host-smoke`,
`codex:smoke`, `codex:host-smoke`) are run on the commit that closes this
gate and their pass markers recorded here.

**Status:** OPEN.

### 15. No runtime behaviour changed

The diff of Phase A touches `runtime/delivery.ts` for the rename only, and
touches no other file under `runtime/` and nothing under `backend/`. Every
runtime test passes unmodified apart from the rename.

**Status:** OPEN.

## Verdict

To be written when the items above are verified: which pass, which are
carried, which are open, and whether the gate is closed.
