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

## Module map and deepening review (2026-09-21, at `ce1f429`)

A map of where the seams are and how deep the modules behind them are, so the
next architecture review starts here instead of re-walking the tree. This is
the second map; the first was taken at `ffd2ad2` earlier the same day, and
its four Strong candidates all landed between the two (`git log --oneline
ffd2ad2..ce1f429`). Line numbers are as of `ce1f429` and will drift; the
module names will not. Vocabulary is the codebase-design skill's: module,
interface, depth, seam, adapter, leverage, locality, and the deletion test.

### What landed since `ffd2ad2`

| Candidate | Landed as | Verified by |
| --- | --- | --- |
| One owner of the final output section | `presentation/final-output-section.ts`: the only switch on retention kind in `presentation/`; card, inspection, notice and tool row ask it. | Zero reads of `truncatedOutputBytes` or `finalOutput.length` outside it. |
| A decided Terminal bundle survives interruption | `ExecutionIO.recordDecision`; the core builds reconciliation then ending inside `intake.sealWith` (`run-scope.ts:604-631`). | Adapters construct no `ending` or `reconciliation` observation; no once-only flags remain. Boundary rule enforces it. |
| Tool-row facts declared once, decoded by Schema | One Schema per facts kind; 25 pass-through outcomes declare sentence, row phrase and tone together. | Aggregate kinds (collection, cancel, result) are still phrased in the renderer, see candidate 4 below. |
| Cleanup escalation as a module; RunContext narrows | `runtime/cleanup-escalation.ts` (2 members); `RunContext` 15 → 5 fields; `RunEnvironment` (10 fields) composed once at `supervisor.ts:414-425`. | Boundary rule names five decisions the supervisor may not hold. |

### Depth by directory

| Area | Verdict | Why |
| --- | --- | --- |
| `domain/` | deep where used, padded | `reduceRun` is the Projection's only writer; `usage.ts` and `bounding.ts` are never reimplemented outside. 155 exported names, 69 with zero non-test callers. `phases.ts` declares a Subagent transition table nobody calls (candidate 10). |
| `backend/contract.ts` | deep | An adapter author needs 3 + 4 + 3 members and the Terminal bundle shape; the other exports are shape-test data. Stable per ADR-0028. |
| `backend/pi/` | deep, one seam unfinished | `run-evidence.ts` is the fold; `execution.ts` keeps only delivery bookkeeping (5 variables). `translate.ts` still carries two nine-arm reading unions with the same labels (candidate 11). |
| `backend/claude/execution.ts` | shallow | One 450-line closure holds 9 mutable flags and writes the shutdown ritual at 5 sites; tested only through the 1156-line conformance rig. The Pi fold's shape is the precedent (candidate 1). |
| `runtime/run-scope.ts` | deep | `RunHandle` has 8 members over 11 private resources and passes the deletion test. |
| `runtime/supervisor.ts` | mostly sequencing | Three residual mechanisms (~100 lines): fork-and-lease hand-over `:431-476`, open under budget `:718-754`, default timeout `:522-541`. Terminal status of a settled Run is derived three ways (candidate 8). |
| `runtime/admission.ts`, `subagent-records.ts`, `waiters.ts`, `result-store.ts`, `arbitration.ts`, `cleanup-escalation.ts`, `observation-intake.ts` | deep | Decided by ADR-0025/0032/0034 or landed this round; leave alone. |
| `host/push-sink.ts`, `notification-message.ts`, `session-handle.ts` | deep | Unchanged verdicts. The hold and consumption mechanism in `host/tools.ts` is ADR-0035/0036 done right. |
| `host/tools.ts` + `tool-copy.ts` + `tool-schemas.ts` + renderer map + façade | wide | The seven-tool family is enumerated five times; the newest tool is named in 8 production files (candidate 7). |
| `host/dashboard-command.ts` | shallow transport | Re-derives page kind at 3 sites after the step answered `read`, opens a second lease per read, repeats the staleness guard 5 times (candidate 6). |
| `index.ts` + `host/session.ts` | leaky | Four process-level variables beside the "exactly one" the Session handle promises; the three test seams are spelled field-by-field in four places (candidate 9). |
| `presentation/index.ts` | shallow as an interface | Re-exports 20 files, 156 names; about 38 are read outside the module. The barrel's header admits the rule is unchecked (candidate 3). |
| `presentation/run-card.ts`, `inspection.ts` | two assemblies of one Result | 7 and 9 direct Result field reads; shared only the section, diagnostic, link and truncation lines. `completion-view.ts` is a 77-line pass-through (candidate 5). |
| `presentation/agent-tool-renderers.ts` | shallow on the call side | Five call-row classes, five hand argument parsers, one line written four times (candidate 12). Aggregate phrasing for 3 of 6 facts kinds (candidate 4). |
| `presentation/final-output-section.ts`, `run-presentation.ts`, `run-line.ts`, `dashboard-page.ts` reducer, `status.ts`, `rows.ts` | deep | One switch, four callers; the deletion test reintroduces four switches. Leave alone. |
| `testing/conformance.ts` | deep | 40 scenarios as data, a 2-member rig interface, one driver, four adapters: a real seam. |
| `testing/*/conformance-rig.ts` | three copies | Each rig is a 40-arm switch (~800 lines); 117 non-trivial lines are byte-identical in all three; a new scenario is 4 to 5 files (candidate 2). |
| `boundaries.test.ts` | one checker, hand-written rules | 24 rule blocks as loops over one graph; 12 of them fit two row shapes. Fixture tests are required per ADR-0033 either way. |

### Deepening candidates (open)

Ordered by recommendation. The four Strong candidates have specs and tickets
under `.scratch/` and are being implemented in parallel on four branches (see
"In flight"). Candidates 5 to 12 have no spec; run the grilling and
design-it-twice steps before building one.

1. **Give the Claude adapter a Run evidence fold — Strong.** A synchronous
   fold consumes `ClaudeFrameReading` plus the few execution-witnessed facts
   and answers continue, await Turn boundary, decided, or fatal; execution
   keeps the stream, the Query, the abort linkage and `ExecutionIO`. Second
   adapter of the shape `pi/run-evidence.ts` already has. ADR-0018/0028 hold.
   Spec: `.scratch/claude-run-evidence/`.
2. **One conformance scenario table, three provider-shaped rigs — Strong.**
   Scenario → plan / expected / policy lives once in `testing/conformance.ts`;
   rigs keep scripts, counters, correlation and reasoned overrides. ADR-0020
   and 0028 unchanged. Spec: `.scratch/conformance-scenario-table/`.
3. **Presentation publishes what the host reads — Strong.** The barrel becomes
   a named list of the ~38 names production reads; the boundary checker forbids
   by-path imports from outside `presentation/` and drops the rule that every
   file be listed. Spec: `.scratch/presentation-public-interface/`.
4. **One agent-tool operation answers text + facts from one place — Strong.**
   Aggregate facts (collection, cancel, result) declare phrases and tone beside
   their Schema like pass-through outcomes do; the renderer reads them and stops
   re-phrasing; each façade operation makes one presentation call.
   `deliveredRuns` does not move (ADR-0035/0036).
   Spec: `.scratch/agent-tool-outcome-presentation/`.
5. **One assembly of a terminal Run's Result — Worth exploring.** Either
   inspection consumes RunCard sections with block kinds, or RunCard goes
   private to `formatResult` and CONTEXT stops claiming it is the one assembly.
   Delete `completion-view.ts`; make the notification Schema the one
   declaration of the six terminal facts. Cheaper after candidate 3.
6. **Subagent dashboard transport: the ask names the read — Worth exploring.**
   `dashboard-command.ts:118-166`; one lease, no re-derivation, dispose/close/
   finish from `session-observation.ts`.
7. **One declaration per agent tool — Worth exploring.** Name, copy, Schema,
   façade operation and renderer key in one row; registration, prompt text and
   renderer map derived. Pairs with candidate 4.
8. **One read for a settled Run's status — Worth exploring.**
   `terminalStatus ?? "failed"` at `supervisor.ts:333-345,936,1147`, plus
   `runtime/inspection.ts:82`; one read answers status, reason and
   Result-if-held. ADR-0036 fixes that a wait delivers; this moves where status
   is decided.
9. **The Session handle carries what the Session owns — Worth exploring.**
   Profiles, prompt fragment, widget and `live` move onto the binding; runtime
   options travel as one value (`index.ts:138-153`, `session.ts:171-175`,
   `testing/host-rig.ts:325-336`).
10. **Subagent transitions: use the domain table or delete it — Worth
    exploring.** `phases.ts:65-83` has zero production callers;
    `subagent-records.ts:139-194` mutates phase inline at four sites.
11. **Pi adapter: one reading union — Worth exploring.** `PiEventReading` and
    `PiRunReading` share 9/9 arm labels; `createPiRunReadingTranslator`
    (`translate.ts:363-394`) rewraps 2 arms. Do alongside candidate 1.
12. **Five call-row classes, one job — Worth exploring.**
    `agent-tool-renderers.ts:228-576,694-768,950-1025`; decode arguments with
    the tool Schemas; `submittedCallLines` is already the shape for three.

Speculative: boundary rules as rows for 12 of 24 blocks; how numbers and the
Cancellation reason parenthetical are written (3 count formatters, 2 cost
sites, 4 reason sites); shared adapter confinement primitives (downgraded: 37
shared lines, not ~100); cancellation in three modules (leave without a
failing race).

### In flight (2026-09-21)

| Branch | Worktree | Spec |
| --- | --- | --- |
| `spec/claude-run-evidence` | `~/.herdr/worktrees/pi-subagent/spec-claude-run-evidence` | `.scratch/claude-run-evidence/` |
| `spec/conformance-scenario-table` | `~/.herdr/worktrees/pi-subagent/spec-conformance-scenario-table` | `.scratch/conformance-scenario-table/` |
| `spec/presentation-public-interface` | `~/.herdr/worktrees/pi-subagent/spec-presentation-public-interface` | `.scratch/presentation-public-interface/` |
| `spec/agent-tool-outcome-presentation` | `~/.herdr/worktrees/pi-subagent/spec-agent-tool-outcome-presentation` | `.scratch/agent-tool-outcome-presentation/` |

Merge order where files overlap: the Claude fold before the conformance table
(both edit `testing/claude/conformance-rig.ts`); the presentation interface
before the tool outcome presentation (both edit `tool-row-facts.ts` and
`prose.ts`).

### Prune when nearby

Not deepening, deletion: 69 dead `domain/` exports (`RUN_OBSERVATION_KINDS`,
ten per-kind observation aliases, six `*_OUTCOMES` arrays, the
`boundProjectionText`/`boundParts`/`boundTranscript` trio);
`presentation/completion-view.ts`; six one-line service pass-throughs in
`application/observation.ts:217-279` (`subagentSummaries` has no caller); six
test-only members on the repository and Result store (`isSpent`,
`activeCount`, `activeRunOf`, `has`, `pinsOf`, `accountedBytes`); the
hand-built `RunEnvironment` in `run-scope.test.ts:93-124`; the identical
`Gate` in the Pi and Claude stand-ins; four formatters in
`host/subagent-command.ts` whose header says "no prose"; `backend/pi/depth.ts`
and the test-only exports in `backend/pi/index.ts`.

### Looked at, left alone

Arbitration, cleanup escalation, observation intake, RunHandle, admission
lease, waiter ledger, Result store, repository, counters, composition, Pi Run
evidence, the backend contract, native bridge, usage and bounding, push sink,
notification message, Session handle, the hold and consumption mechanism in
`host/tools.ts`, `application/subagents.ts` (the Label bound's one home),
`testing/conformance.ts`, `testing/host-rig.ts`, the boundary checker's core,
the final output section's dispatch, run presentation, run line, the dashboard
step, the `status.ts` phase table and `rows.ts` tone table. Either deep by
the deletion test or decided by an ADR named above.

### How to refresh this map

Run `git log --oneline ce1f429..HEAD --stat` and re-check only the rows whose
files changed; re-verify a candidate's line citations before citing them
again. When the four in-flight branches merge, move their rows from "In
flight" to "What landed" with the verification that proves each. Canaries:
candidate 4 is done when "Cancellation requested" (4 test files), "still
running" (9) and "Result unavailable" (3) are asserted only where the phrase
is declared; candidate 3 is done when no file outside `presentation/` imports
a presentation file by path and the boundary test says so.
