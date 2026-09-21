# Architecture

## Project trust flow

```text
Pi session (trust already resolved)
        │  ctx.isProjectTrusted()
        ▼
sessionFactsOf() → SessionFacts.projectTrusted
        ▼
supervisor.ts → SubagentContext.projectTrusted (fixed per Subagent)
        ▼
   ┌────────────┴────────────┐
   ▼                         ▼
Claude adapter           Pi adapter
settingSources:          SettingsManager.create({ projectTrusted })
  trusted → omitted      resolveProjectTrust: () => projectTrusted
  untrusted → ["user"]
```

## Module map and deepening review (2026-09-21, at `ffd2ad2`)

A map of where the seams are and how deep the modules behind them are, so the
next architecture review starts here instead of re-walking the tree. Line
numbers are as of `ffd2ad2` and will drift; the module names will not.
Vocabulary is the codebase-design skill's: module, interface, depth, seam,
adapter, leverage, locality, and the deletion test.

### Depth by directory

| Area | Verdict | Why |
| --- | --- | --- |
| `domain/` | deep | `reduceRun` is the Projection's only writer; `interpretFinalOutput` (`domain/final-output.ts`) is the single writer of the retention kind, but has no direct test and two presentation modules still read raw bytes past it. |
| `backend/contract.ts` | deep in type, wide in knowledge | 3+4 members; Sealing, Arbitration and reconciliation application are hidden. But an adapter must know Arbitration's announced-wins rule to keep a finished answer through a cancel (see candidate 2). |
| `backend/pi/run-evidence.ts` | deep | Three-member interface; landing it removed ~350 lines from `execution.ts` (`4a2eb28`). `execution.ts` still holds evidence state and the two nine-arm reading unions in `translate.ts` duplicate each other. |
| `backend/claude/` | deep, self-contained | Identity boundary, Turn boundary, client-owned input stream are legitimately Claude-only. Shares byte-identical confinement helpers with the Pi adapter. |
| `runtime/run-scope.ts` | deep, wide input | `RunHandle` has 8 members and passes the deletion test; `RunContext` has 15 fields, six of them per-supervisor constants. |
| `runtime/supervisor.ts` | mostly sequencing | After ADR-0034, start/resume share one spine. One un-extracted mechanism remains: cleanup-under-budget and escalation (`:410-585`), written as closures the boundary test cannot see. |
| `runtime/admission.ts`, `subagent-records.ts`, `waiters.ts`, `result-store.ts` | deep | Decided by ADR-0032/0034; leave alone. |
| `host/push-sink.ts` | deep | Seven Notification states inside, four out; two production callers with narrowed views. ADR-0033/0035/0036. |
| `presentation/dashboard-page.ts` | deep | One clamp, named pure moves, thin dispatch; reads only through the Observation seam. The host transport around it (`host/dashboard-command.ts`) is the shallow part. |
| `presentation/run-card.ts` | shallow as an interface | 11 exports, zero external field readers; inspection assembles the same terminal Result a second way. |
| `presentation/tool-row-facts.ts` | shallow where it decodes | ~310 lines of hand validation restate the outcome unions; the Notification payload already does this once with Effect Schema (`host/notification-message.ts`). |
| `presentation/result-body.ts`, `inspection.ts`, `notification-text.ts` | shallow, duplicated | Three phrasings of "removed", three sets of "absent" sentences, two byte formatters. |

### Deepening candidates (open)

Ordered by recommendation. Each is a plain-English shape, not an interface
design. The four Strong candidates have specs and tickets under `.scratch/`:
`final-output-section-owner/`, `decided-bundle-survives-interruption/`,
`tool-row-facts-schema/`, `run-cleanup-escalation-module/` (2026-09-21, all
`ready-for-agent`, none started). Candidates 5 to 9 have no spec; run the
grilling and design-it-twice steps before building one.

1. **One owner of the "final output section" — Strong.** One presentation
   module answers everything a surface says about a Run's answer, given the
   retention interpretation plus its framing (status, active/terminal,
   inlined). Card, inspection, notice body and pointer, and the tool row ask
   it; none switch on `kind` or read `truncatedOutputBytes` or
   `finalOutput.length`. Evidence: `ffd2ad2` touched 13 files for one rule;
   one card prints the same cut twice (`run-card.ts:358` and `:363`).
   ADR-0033/0037 fix what the notice says; this moves where it is made.
2. **A decided Terminal bundle survives interruption, once — Strong.** Both
   adapters hand-emit reconciliation then ending on interrupt with their own
   once-only flags (`pi/execution.ts:190-216`, `pi/run-evidence.ts:278-294`,
   `claude/execution.ts:587-607`) because `arbitration.ts:98` lets an
   in-stream ending win; the core also emits the same pair from the bundle
   (`run-scope.ts:625-636`). The core should own ordering, dedupe and
   precedence. ADR-0025/0028 hold: a bundle stays a report.
3. **Tool-row facts declared once, decoded by Schema — Strong.** One Schema
   per facts kind gives type, constructor target and total decoder; each
   outcome's collapsed-row phrase sits beside its sentence so the renderer is
   generic. Today one new `StartOutcome` member is four edits.
4. **Cleanup-under-budget as its own module; RunContext narrows — Strong.**
   Compose the Run environment once per supervisor; hand each Run only what
   names it; bounded close and escalation move to where their counter and
   diagnostic are decided. `run-scope.test.ts:38-100` rebuilds all 15 fields.
5. **Finish the Pi execution ↔ Run evidence seam — Worth exploring.**
   Execution hands raw native facts (prompt returned, idle, pending count) and
   keeps no evidence state; one reading union. Do after candidate 2.
6. **One terminal-Result assembly — Worth exploring.** Either inspection
   consumes RunCard sections (with block kinds for the viewport) or RunCard
   becomes private to `formatResult` and CONTEXT stops claiming it is the one
   assembly. ADR-0036 keeps `formatResult` as the one text for `agent_result`
   and waits.
7. **Shared adapter confinement primitives — Worth exploring.** `confined`,
   `confinedControl`, `isRecord`, `readCounter`, `readCost` are byte-identical
   in `pi/translate.ts:41-91` and `claude/translate.ts:52-108`; one module in
   `backend/` beside `activity.ts` and `native-bridge.ts`.
8. **Dashboard transport: the step names the read — Worth exploring.**
   `openDashboardUi` re-derives page kind after the reducer answered
   `ask: "read"`, opens a second lease per read, and is testable only through
   the host rig.
9. **Cancellation in three modules — Speculative.** Reason on the row
   (supervisor), stop on the handle (run-scope), reason read back from the
   snapshot (arbitration input). Constrained by ADR-0025/0026/0034; pursue
   only with a failing race in hand.

### Looked at, left alone

Push sink, dashboard step, profile fields and options, usage normalisation,
Ending classification, Identity boundary, admission lease, Subagent records,
reservation eviction, notice inlining: either deep already or decided by an
ADR named above. Small pass-throughs to delete when nearby: `backend/pi/depth.ts`
(re-export), `presentation/completion-view.ts` (rename layer), the 30+
test-only exports in `backend/pi/index.ts`. One doc fix: `projection.ts:33-37`
says `truncatedOutputBytes` is replaced, `result-bounding.ts:173` adds to it.

### How to refresh this map

Run `git log --oneline ffd2ad2..HEAD --stat` and re-check only the rows
whose files changed; re-verify a candidate's line citations before citing them
again. Tests that assert domain rules as prose strings across surfaces
(`host/absent-output.test.ts`, `host/answer-retention.test.ts`,
`host/inspect-*.test.ts`) are the canary for candidate 1: when they stop
needing three regexes for one fact, it is done.
