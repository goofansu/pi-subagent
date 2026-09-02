# v1 knowledge inventory

**Status:** Complete for M0.
**Date:** 2026-09-02
**Purpose:** classify every module in the frozen v1 tree so later milestones know
exactly what to port and what to delete.

Each module carries exactly one classification:

- **Reusable** — pure, lifecycle-free, and portable into v2 core more or less
  as it stands.
- **Adapter** — provider-specific knowledge that moves into the named v2
  adapter rather than into core.
- **Rewrite** — lifecycle machinery that v2 replaces with Effect-scoped
  equivalents.
- **Obsolete** — nothing in v2 needs it.

Test files are classified alongside the modules they prove: a test of a reusable
pure function is itself reusable; a test of lifecycle machinery is rewritten
with that machinery. Repository scripts that belong to v1 are listed at the end.

---

## Core

| Module | Class | Reason |
| --- | --- | --- |
| `types.ts` | Reusable | Plain domain shapes (`UsageStats`, lifecycle status, `AgentConfig`, `SingleResult`). v2's M1 domain types supersede the names, but the field semantics port directly. |
| `run.ts` | Rewrite | Mixes reusable pure pieces (the fact fold, `settleResultLifecycle`, usage accumulation) with the mutable shared Run record that [ADR-0004](../adr/0004-shared-mutable-run-record.md) chose and v2 replaces with an immutable projection driven by a pure `reduceRun`. Port the fold's rules, not the record. |
| `runner.ts` | Rewrite | The Dispatcher: Run record ownership, `AbortController` wiring, control-gate lifecycle, terminal settlement. All of this becomes the Run Scope. |
| `runs.ts` | Rewrite | The live Run registry, its cancellation linearization point, and its listener fan-out. v2 replaces it with the `RunRepository` plus a `SubscriptionRef` projection. |
| `subagents.ts` | Rewrite | Subagent ownership, the synchronous resume claim, and shutdown. Becomes the Subagent Scope and the supervisor's admission path. The *rules* (one active Run, closed-before-cancel ordering) carry forward as specification. |
| `control-source.ts` | Rewrite | Bounded Control admission with a single synchronous consumer, built on callbacks. v2 rebuilds it on a bounded `Queue` inside the Run Scope. The bounds (16 pending, 16 KiB per message, 64 KiB total) and the `accepted`-means-admitted-only rule carry forward. |
| `delivery.ts` | Rewrite | Notification landing/retry state machine, the Result store with its eviction policy, and `wait`. v2 splits it into a Result store, a delivery service, and a waiter registry. The eviction policy and the one-landing invariant carry forward as specification. |
| `session-lifecycle.ts` | Rewrite | Session start/shutdown ordering against a process-lifetime runtime. v2's Session Scope replaces the manual re-aiming and unbinding entirely. |
| `index.ts` | Rewrite | Tool registration plus runtime composition. The tool schemas, descriptions, and prompt guidelines are worth porting verbatim as product copy; the composition around them is not. |
| `composition.ts` | Rewrite | The one production edge that names concrete adapters. v2 needs the same seam, expressed as a Layer over the backend registry. |
| `agents.ts` | Reusable | Profile discovery, frontmatter parsing, generic-versus-backend field split, and diagnostics. Pure and lifecycle-free. One change: v2 reads `backend`, not the v1 field name — see [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md). |
| `agents-command.ts` | Reusable | `/agents` list, filter, detail, and action prose plus its TUI composition. No lifecycle state; it reads a `ReadonlyMap` of Profiles. |
| `presentation.ts` | Reusable | Status tones, verbs, tool-outcome prose, notification text, and every public-tool outcome sentence. The single richest piece of reusable product knowledge in the tree. |
| `messages.ts` | Reusable | Pure translation from Facts to a one-line activity summary. |
| `render.ts` | Reusable | Tool call/result renderers built from `pi-tui` primitives and a `RenderableTheme`. No lifecycle state. |
| `notification-message.ts` | Reusable | The custom-message contract: build, parse, and render a completion Notification. Pure. |
| `widget.ts` | Reusable | Run-line formatting, column alignment, ordering, and truncation, plus a thin install/uninstall over the registry's subscribe. The formatting is reusable as is; the ten-line install shim follows whatever v2's projection looks like. |
| `pi-child-extension-load.ts` | Adapter → `pi` | An `AsyncLocalStorage` discriminator that keeps this package out of a child Pi's extension discovery. Pi-specific mechanism; belongs inside the v2 Pi adapter. |
| `standalone-run-helper.ts` | Obsolete | A one-Run composition that exists only so Dispatcher and Harness tests can run without the manager. v2's fake backends and scoped supervisor make it unnecessary. |
| `suite-setup.ts` | Obsolete | Clears `PI_SUBAGENT_DEPTH` for the v1 suite. v2 has its own setup module; this one dies with v1. |

## Harness seam

| Module | Class | Reason |
| --- | --- | --- |
| `harnesses/contract.ts` | Rewrite | The Harness/HarnessAdapter interface and registry. v2's backend contract replaces it, but the shared profile accessors it also holds (`parseTools`, `shouldAppendSystemPrompt`, `validateCommonProfileFields`, effort validation) are **reusable** and should be lifted out before the rest is rewritten. |
| `harnesses/conformance.ts` | Reusable | The thirteen-scenario capability-aware battery. The scenarios are the executable statement of what a backend owes the core; v2 keeps them and adds to them. |
| `harnesses/managed-conformance.ts` | Reusable | Repeated stable-identity and managed-resume conformance across adapters. Same reasoning. |
| `harnesses/provider-diagnostic.ts` | Reusable | Bounded, category-only confinement of provider-authored error text. Pure, tiny, and load-bearing for the no-provider-identity rule. |

## Pi adapter

| Module | Class | Reason |
| --- | --- | --- |
| `harnesses/pi/harness.ts` | Adapter → `pi` | Profile validation and adapter preparation for Pi. Ports to the v2 Pi adapter. |
| `harnesses/pi/agent.ts` | Adapter → `pi` | Retained `AgentSession` ownership, SDK options construction, child-extension filtering, per-spawn depth, bounded disposal. The single densest piece of Pi knowledge in the repository. Its lazy-open and closed-flag discipline is required by the Pi spike's disposal finding. |
| `harnesses/pi/attempt.ts` | Adapter → `pi` | Per-Run subscription, message baseline, fact translation, native steering delivery, and cancellation ordering. Becomes the Pi adapter's Run-scoped execution. |

## Claude adapter

| Module | Class | Reason |
| --- | --- | --- |
| `harnesses/claude/harness.ts` | Adapter → `claude` | Model-alias validation, thinking budgets, permission and depth policy, options construction. Ports directly. |
| `harnesses/claude/attempt.ts` | Adapter → `claude` | One streaming Query per Run, streamed-input steering with uuid correlation, replay filtering, identity-boundary checks, turn counting, and cumulative-usage differencing. Ports into the v2 Claude adapter. |

## Codex adapter

| Module | Class | Reason |
| --- | --- | --- |
| `harnesses/codex/harness.ts` | Adapter → `codex` | Profile validation, effort mapping, prompt composition, adapter preparation. Ports directly. |
| `harnesses/codex/app-server.ts` | Adapter → `codex` | The App Server transport: process spawn, JSON-RPC framing, ephemeral `thread/start`, `turn/start`/`steer`/`interrupt`, server-request answering, and bounded SIGTERM/SIGKILL escalation. Ports as the v2 Codex adapter's transport. |
| `harnesses/codex/attempt.ts` | Adapter → `codex` | One Turn per Run: the ordered ingress reducer, item translation, correlation, and Run-local accounting delta. Ports as the Codex adapter's Run-scoped execution. |

## Tests

| Test file | Class | Reason |
| --- | --- | --- |
| `agents.test.ts` | Reusable | Proves pure Profile parsing and diagnostics. |
| `agents-command.test.ts` | Reusable | Proves pure `/agents` prose and item construction. |
| `presentation.test.ts` | Reusable | Proves every public-tool outcome sentence and notification shape. |
| `messages.test.ts` | Reusable | Proves pure activity summarisation. |
| `render.test.ts` | Reusable | Proves pure tool renderers. |
| `notification-message.test.ts` | Reusable | Proves the custom-message contract. |
| `widget.test.ts` | Reusable | Proves row formatting, alignment, ordering, truncation. |
| `control-source.test.ts` | Rewrite | Proves the callback-based bounded source that v2 rebuilds on a `Queue`. The assertions about bounds and admission semantics carry forward. |
| `runs.test.ts` | Rewrite | Proves the registry v2 replaces. |
| `runner.test.ts` | Rewrite | Proves the Dispatcher v2 replaces. Its invariant assertions (INV-1, INV-3) become v2 supervisor tests. |
| `delivery.test.ts` | Rewrite | Proves the delivery/result-store machinery v2 replaces. Its INV-4, INV-5, INV-6, and INV-9 assertions become v2 tests. |
| `session-lifecycle.test.ts` | Rewrite | Proves the manual session seam v2 replaces with a Scope. |
| `index.test.ts` | Rewrite | Proves tool registration against a stand-in host plus end-to-end lifecycle. The registration half is a pattern v2 reuses (v2's `index.test.ts` already does); the lifecycle half is rewritten. |
| `composition.test.ts` | Rewrite | Proves the v1 registry composition. |
| `boundaries.test.ts` | Rewrite | The v1 import-boundary rules. v2 has its own boundary test; the shared specifier reader has already been lifted into `tools/import-specifiers.ts` and is neutral repository tooling, not v1 code. |
| `suite-setup.test.ts` | Obsolete | Proves the v1 depth-clearing setup module, which dies with v1. |
| `harnesses/contract.test.ts` | Rewrite | Proves the v1 Harness contract and registry. Its shared-profile-accessor assertions are reusable; its fake-harness end-to-end scenarios become v2 fake-backend tests. |
| `harnesses/managed-conformance.test.ts` | Reusable | Fixtures plus the shared conformance run for every adapter. Rig construction is rewritten with the adapters; the scenarios are kept. |
| `harnesses/pi/agent.test.ts` | Adapter → `pi` | Pi adapter behaviour, including the fake-SDK rigs. Moves with the adapter. |
| `harnesses/claude/harness.test.ts` | Adapter → `claude` | Claude adapter behaviour and its fake Query rigs. Moves with the adapter. |
| `harnesses/codex/harness.test.ts` | Adapter → `codex` | Codex adapter behaviour and its fake process rigs. Moves with the adapter. |
| `harnesses/codex/app-server.test.ts` | Adapter → `codex` | Transport behaviour: framing, escalation, foreign-notification filtering. Moves with the adapter. |
| `harnesses/codex/transport-seam.test.ts` | Adapter → `codex` | Transport seam boundary. Moves with the adapter. |

## Repository scripts that belong to v1

| Script | Class | Reason |
| --- | --- | --- |
| `scripts/check-codex-protocol.mjs` | Reusable | Byte-for-byte check of the generated Codex protocol types against the pinned CLI. Independent of lifecycle; v2 keeps it. |
| `docs/codex-protocol/ClientRequest.json`, `docs/codex-protocol/ServerNotification.json` | Reusable | The generated protocol schemas themselves. |
| `scripts/codex-live-smoke.mjs` | Reusable | Live steering/interruption proof. Rewritten against the v2 entry point at cutover, but the scenario is kept. |
| `scripts/codex-resume-live-smoke.mjs` | Reusable | Two Runs on one retained ephemeral Conversation, plus cleanup evidence. Same reasoning. |
| `scripts/managed-provider-live-smoke.mjs` | Reusable | Pi and Claude steering and resume gates. Same reasoning. |
| `scripts/check-codex-retained-release.mjs` | Reusable | Runs the human-evidence gate for Codex Desktop coexistence. Independent of implementation. |
| `scripts/codex-retained-release-contract.mjs` | Reusable | Pure evidence-shape rules that gate reads. |
| `scripts/codex-retained-release-contract.test.mjs` | Reusable | Proves those pure rules. |
| `scripts/codex-resume-smoke-contract.mjs` | Reusable | Pure contract helpers for the resume smoke. |
| `scripts/codex-resume-smoke-contract.test.mjs` | Reusable | Proves those helpers. |
| `docs/codex-protocol/README.md` | Reusable | How the protocol schemas are generated and pinned. |

---

## The roadmap's reuse candidates, confirmed or disputed

| Roadmap candidate | Verdict | Note |
| --- | --- | --- |
| Profile parsing and schema rules | **Confirmed** | `agents.ts` is pure and portable. One deliberate change: v2 reads `backend`. |
| Model and effort validation | **Confirmed, with a correction** | The roadmap implies one place; it is actually two. The *shared* accessors and effort scale live in `harnesses/contract.ts` (reusable), while each backend's model validation is genuinely provider-specific and moves into its adapter: Pi checks a loaded catalogue, Claude checks a family-alias list, Codex validates in its adapter. |
| Provider diagnostic confinement | **Confirmed** | `harnesses/provider-diagnostic.ts` is 39 lines, pure, and load-bearing. |
| Pure message translators | **Confirmed, with a caveat** | `messages.ts` is genuinely pure and reusable. The *fact translators* the roadmap may also mean (`piFact`, the Claude translator, the Codex item translator) are not core-reusable — they are adapter knowledge and move with their adapters. |
| Generated Codex protocol types | **Confirmed** | `docs/codex-protocol/*.json` plus `scripts/check-codex-protocol.mjs` are implementation-independent. |
| Presentation formatting with no lifecycle state | **Confirmed** | `presentation.ts`, `render.ts`, `notification-message.ts`, `widget.ts`, and `agents-command.ts` are all lifecycle-free. This is the largest reusable block in the tree. |
| Existing conformance scenarios and release smoke tests | **Confirmed** | `harnesses/conformance.ts` and `harnesses/managed-conformance.ts` plus the five live-smoke scripts. The scenarios outlive both implementations. |

## The roadmap's rewrite list, confirmed or disputed

| Roadmap item | Verdict | Note |
| --- | --- | --- |
| `SubagentManager` and `SubagentRuns` ownership | **Confirmed** | `subagents.ts` and `runs.ts`. Both become Scopes plus a repository. Their *rules* are specification worth keeping even though the code is not. |
| Dispatcher and runner orchestration | **Confirmed** | `runner.ts`, plus the mutable-record half of `run.ts`. |
| `ControlSource` lifecycle | **Confirmed** | `control-source.ts`. The bounds and the local-admission-only meaning of `accepted` carry forward. |
| Delivery orchestration | **Confirmed** | `delivery.ts`. The Result store's budget and oldest-first eviction, and the one-landing-per-Notification invariant, carry forward as specification. |
| Provider Attempt cancellation and cleanup | **Disputed, in part** | The roadmap lists this as rewrite. The *generic* cancellation contract is indeed rewritten — it becomes Run-scope finalizers. But the three `attempt.ts` modules are 2007 lines of hard-won provider-specific ordering (Pi's stalled-steer bounding, Claude's uuid correlation and replay filtering, Codex's single ordered ingress reducer). That knowledge must be **ported into the v2 adapters**, not rewritten from the roadmap. Classified **Adapter** above. |
| Session shutdown machinery | **Confirmed** | `session-lifecycle.ts` plus the shutdown paths in `subagents.ts` and `delivery.ts`. The Session Scope replaces the manual re-aim/unbind dance entirely. |

## Not in either roadmap list

Three items belong in neither list and are recorded here so they are not lost:

- **`standalone-run-helper.ts` and `suite-setup.test.ts`** are **obsolete**: they
  exist only to serve v1's own test composition.
- **`pi-child-extension-load.ts`** is **adapter** knowledge, not core: it is the
  Pi-specific half of the delegation-depth constraint.
- **`index.ts`'s tool schemas, descriptions, and prompt guidelines** are
  **reusable product copy** even though the module around them is rewritten.
  They are the tools' public contract with the model and should be ported
  verbatim rather than re-derived.
