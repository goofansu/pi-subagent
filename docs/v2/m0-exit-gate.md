# M0 exit gate

**Status:** Passed. **M0 is complete.**
**Date:** 2026-09-02
**Verified against:** [the v2 roadmap](roadmap.md), milestone M0.

This document verifies every M0 exit-gate item against the merged work, so that
M1 starts from an explicitly closed milestone.

---

## 1. v1 baseline tests are green ✅

`npm run check` exits 0. It runs, in order:

| Step | Result |
| --- | --- |
| `npm run typecheck` (both trees plus `tools/`) | clean |
| `npm run typecheck:v2` (v2 tree alone) | clean |
| `npm run lint` (Biome, whole repository) | clean |
| `npm run test:conformance` | 164 tests, 163 pass, 1 skipped |
| `npm run test:managed-conformance` | 6 tests, 6 pass |
| `npm test` (v1 suite, repository scripts, `tools/`) | 540 tests, 539 pass, 1 skipped |
| `npm run test:v2` | 24 tests, 24 pass |
| `npm run codex:protocol:check` | `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1` |

The single skip is `claude conformance: terminal-transcript-healing`, which the
Claude adapter deliberately declares unimplemented because it has no wire
transcript snapshot. It is a visible skip, not a silent one.

The freeze policy and the commit at which this gate was recorded green are in
[`freeze.md`](freeze.md).

## 2. Every compatibility-matrix cell has an explicit outcome and a cited v1 test ✅

[`compatibility-matrix.md`](compatibility-matrix.md) covers eleven rows —
`agent_start`, `agent_resume`, `agent_steer`, `agent_cancel`, `agent_wait`,
`agent_result`, Subagent close, `/agents`, the active widget, completion
Notification messages, and Profile loading and validation — across the Pi,
Claude, and Codex columns.

Checked at this gate:

- No cell says `TBD`, and no cell says only "same as v1". Cells that read "Same"
  state that the expected outcome is the same as this row's Pi column, with the
  proof named there applying unchanged — an explicit statement, not a deferral.
- Every cell cites at least one v1 test by name and file. Citations were checked
  mechanically against the set of test names registered in
  `extensions/**/*.test.ts` plus the names the conformance and managed
  conformance batteries generate; every cited name exists.
- Three cells had no proof and now do. The tests were added under the freeze's
  testability exception, assert existing behaviour, and change no v1 runtime
  code:
  - `a run line names each harness the same way` (`extensions/subagent/widget.test.ts`)
  - `the agents list is identical whichever harness a profile names` (`extensions/subagent/agents-command.test.ts`)
  - `completion notification prose is identical whichever harness ran the Run` (`extensions/subagent/presentation.test.ts`)
- Five cells are marked **[v2 change]** and each points at
  [`operation-semantics.md`](operation-semantics.md) or
  [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md). No v1 behaviour
  was changed to match.
- The Subagent-close row documents the existing Session-shutdown surface and
  records that no new model tool is introduced.

[`operation-semantics.md`](operation-semantics.md) specifies all eight roadmap
operation-semantics bullets before any v2 code implements them, and each section
records its difference from current v1 behaviour or states that v1 already
behaves that way.

## 3. All three backend spikes carry a verdict, and every exception is covered by an ADR ✅

| Spike | Verdict | Exceptions |
| --- | --- | --- |
| [Pi](spikes/pi-backend-api-risk.md) | **Viable** | One implementation constraint: a disposed Pi session still accepts `prompt()`, so closure must be enforced by the adapter's own state. Recorded as a consequence in [ADR-0023](../adr/0023-v2-scope-ownership.md). |
| [Claude](spikes/claude-backend-api-risk.md) | **Viable with a documented exception** | (1) No provider-side open; the BackendAgent starts unopened — resolved in [ADR-0023](../adr/0023-v2-scope-ownership.md). (2) `modelUsage` reports models the Run did not request — resolved in [ADR-0027](../adr/0027-v2-usage-normalization.md). |
| [Codex](spikes/codex-backend-api-risk.md) | **Viable with documented exceptions** | (1) The event stream is Subagent-scoped, not Run-scoped — resolved in [ADR-0023](../adr/0023-v2-scope-ownership.md) and [ADR-0024](../adr/0024-v2-observation-ordering.md). (2) Usage is Conversation-cumulative and absent from the terminal frame — resolved in [ADR-0027](../adr/0027-v2-usage-normalization.md). (3) Process loss produces no protocol signal at all: no terminal Turn frame, and later requests hang without resolving or rejecting — resolved in [ADR-0023](../adr/0023-v2-scope-ownership.md) and [ADR-0025](../adr/0025-v2-terminal-settlement.md). |

Each document has a section for every one of the eight required surfaces — open,
run, resume, steer, cancel, close, event bridging, usage — recording what was
observed, the SDK version, and the risk to the ownership model. The Codex
document carries a ninth section for process loss, and the Claude document folds
Query loss into its cancel section, because those are the loss paths their
ticket bodies name. Every exception is resolved in an ADR **before** the core
contract is implemented, which is what the gate requires.

All three spikes were run live against the SDK versions this repository already
carries: `@earendil-works/pi-coding-agent` 0.84.4,
`@anthropic-ai/claude-agent-sdk` 0.3.245, and `codex-cli` 0.150.1.

Spike code lives under `.scratch/v2-m0-baseline-skeleton/spikes/`, is imported by
neither extension tree, is excluded from lint (`biome.json` ignores `.scratch`),
and matches no test glob. Rerun instructions and credential requirements are in
each findings document. No v1 adapter was modified.

## 4. v2 builds and runs a placeholder extension without importing v1 runtime modules ✅

**Launch, verified live.** Pi launched with every extension disabled and only
the v2 entry point loaded runs the placeholder command and reports the pinned
Effect version:

```
$ printf '{"id":"r1","type":"prompt","message":"/subagent-v2"}\n' \
  | pi --offline -np -nc -ns -ne --no-session \
       -e extensions/subagent/index.ts --mode rpc

{"type":"extension_ui_request","method":"notify",
 "message":"pi-subagent v2 skeleton active — Effect 4.0.0-rc.112",
 "notifyType":"info"}
{"id":"r1","type":"response","command":"prompt","success":true}
```

`make dev-v2` runs the interactive equivalent.

**Registration.** `extensions/subagent/index.test.ts` asserts against a
stand-in host that the entry registers exactly one slash command and no model
tools, message renderers, or session event handlers. A widget needs no separate
assertion: `setWidget` lives on the UI context a session event hands out, so an
extension with no session event handler cannot install one.

**Import boundary.** `extensions/subagent/boundaries.test.ts` walks the
transitive import graph from the v2 entry point and additionally scans every v2
source file, and fails when:

- a v2 module imports a v1 module, directly or transitively (naming the edge);
- a v1 module imports `effect`, `effect/*`, or any `@effect/*` package;
- a v1 module imports the v2 tree;
- any file in the v2 tree, whatever its extension — tests, notes, and fixtures
  included — contains the legacy Profile backend field name. The one compound the scan removes first is
  `AgentHarness`, which [ADR-0022](../adr/0022-v2-terminology-and-backend-field.md)
  reserves for Pi's own native abstraction, so both rules hold at once.

Each rule has a controlled fixture proving it fires, and
`the real v1 and v2 trees hold the boundary` proves the production graphs pass.
The syntax-based specifier reader is shared, neutral repository tooling in
`tools/import-specifiers.ts` with its own tests; the v1 boundary test uses it and
stays green. The boundary test runs in the v2 lane of `npm run check`.

**Lanes.** v2 has its own project file (`tsconfig.v2.json`), its own test target
(`npm run test:v2`) with its own setup module
(`extensions/subagent/suite-setup.ts`), and both are part of `npm run check`.
The repository-wide typecheck still covers both trees.

## 5. The Effect version is exact-pinned and the primitive set compiles ✅

`effect` is a regular dependency at exactly `4.0.0-rc.112`, with no range
operator, and the lockfile matches. No other Effect ecosystem package was added;
`TestClock` comes from the core package's own `effect/testing` entry point.

`extensions/subagent/index.test.ts` asserts the pin three ways: against the
declared dependency, against the installed package's version, and that `effect`
is the only Effect package in `dependencies`.

`extensions/subagent/effect-primitives.test.ts` exercises the whole initial
primitive set — `Scope`, `Deferred`, a bounded `Queue`, `Fiber`,
`SubscriptionRef`, a `Layer` for one session-long service, and `TestClock` — and
passes in the v2 lane. `npm run typecheck:v2` passes with the primitive set
imported, with no `any`, no `@ts-expect-error`, and no compiler-option change.

[`effect-compatibility-spike.md`](effect-compatibility-spike.md) records the
toolchain checked against and the two v4 API details worth knowing (`Exit.void`
rather than `Effect.exitVoid`; `SubscriptionRef.changes` needs a readiness
handshake). Neither is an incompatibility with the pinned version, so nothing
was escalated as an ADR and nothing was worked around silently.

## 6. The package manifest exposes only v1 ✅

`package.json` now carries an explicit Pi extension list:

```json
"pi": { "extensions": ["./extensions/subagent"] }
```

Pi auto-discovers every directory under an installed package's extensions folder
*unless* the manifest lists extensions explicitly, so without this the v2
directory would load for every installed user. `the package manifest exposes
only the v1 extension` in `extensions/subagent/packaging.test.ts` asserts it,
so v2 cannot be exposed from an installed package by accident.

Because a Pi process loads either v1 (installed, or `make dev`) or v2
(`make dev-v2`), the two are never registered together, Pi never sees two
`agent_start` tools, and the implementation never switches per Run.

## 7. No v1 source file changed during M0 except tests added as matrix proof ✅

`extensions/subagent/` changes in M0, in full:

| File | Change | Why it is permitted |
| --- | --- | --- |
| `boundaries.test.ts` | Uses the shared specifier reader from `tools/import-specifiers.ts` instead of its own private copy | Testability change; the v2 boundary test must not import a v1 test file |
| `widget.test.ts` | Added `a run line names each harness the same way` | Matrix proof |
| `agents-command.test.ts` | Added `the agents list is identical whichever harness a profile names` | Matrix proof |
| `presentation.test.ts` | Added `completion notification prose is identical whichever harness ran the Run` | Matrix proof |

No v1 runtime module changed. Repository-level files that changed —
`package.json`, `tsconfig.json`, `tsconfig.v2.json`, `biome.json`, `Makefile`,
`package-lock.json` — are not v1 source.

## 8. The v1 inventory classifies every module ✅

[`v1-inventory.md`](v1-inventory.md) lists every module in the v1 extension tree
— core, harness seam, all three adapters, every test file, and the repository
scripts that belong to v1 — each exactly once, with one of the four
classifications and a one-line reason. Portable provider-specific items name the
v2 adapter they move into.

It confirms all seven of the roadmap's reuse candidates, with a correction to
"model and effort validation" (shared accessors are core-reusable; each
backend's model validation is adapter knowledge) and a caveat on "pure message
translators" (the activity translator is reusable; the three fact translators are
adapter knowledge).

It confirms five of the roadmap's six rewrite items and **disputes one in part**:
provider Attempt cancellation and cleanup. The generic cancellation contract is
indeed rewritten as Run-scope finalizers, but the 2007 lines across the three
`attempt.ts` modules are hard-won provider-specific ordering that must be
*ported* into the v2 adapters rather than rewritten from the roadmap.

Three items in neither roadmap list are recorded so they are not lost:
`standalone-run-helper.ts` and `suite-setup.test.ts` are obsolete;
`pi-child-extension-load.ts` is Pi adapter knowledge, not core; and `index.ts`'s
tool schemas, descriptions, and prompt guidelines are reusable product copy.

## 9. Architecture decision records ✅

Six ADRs, continuing the existing numbered sequence after ADR-0021:

| ADR | Subject |
| --- | --- |
| [0022](../adr/0022-v2-terminology-and-backend-field.md) | v2 terminology and the Profile backend field migration |
| [0023](../adr/0023-v2-scope-ownership.md) | Scope ownership, written after the three spikes and incorporating every exception |
| [0024](../adr/0024-v2-observation-ordering.md) | Observation ordering |
| [0025](../adr/0025-v2-terminal-settlement.md) | Terminal settlement |
| [0026](../adr/0026-v2-control-admission.md) | Control admission |
| [0027](../adr/0027-v2-usage-normalization.md) | Usage normalization |

Each names which consequences of the earlier ADRs it carries forward. None
supersedes ADR-0007, ADR-0013, ADR-0014, ADR-0019, or ADR-0020, all of which
remain in force. ADR-0026 matches the mailbox and shutdown semantics of
[`operation-semantics.md`](operation-semantics.md) exactly, and ADR-0027 cites
the usage surfaces observed in all three spikes. None contains provider wire
vocabulary.

## 10. The Profile backend field migration ✅

Decided as a **documented configuration migration with no alias**
([ADR-0022](../adr/0022-v2-terminology-and-backend-field.md)). v2 understands
`description`, `backend` (default `pi`), and the body; every other frontmatter
field goes to the named backend, so a Profile still using the old name fails
validation as an unrecognized field without v2 ever spelling it. No migration
tool is written and v1 reads its field unchanged.

The author-facing note is
[`profile-backend-field-migration.md`](profile-backend-field-migration.md),
linked from the README's agent-format section. The check that keeps the old name
out of the v2 tree is in `extensions/subagent/boundaries.test.ts`, which is
the only v2 file permitted to spell it and which excludes itself from its own
scan.

## 11. The domain glossary has a v2 section ✅

`CONTEXT.md` gains a **v2 vocabulary** section defining backend, adapter,
BackendAgent, SubagentId, RunId, Attempt, Scope, Observation, and the reserved
`AgentHarness`, and marking Harness, Executor, Dispatcher, Registry, and
Subagent manager as v1-only and scheduled for deletion at M7.

## 12. The roadmap marks M0 complete and links each artifact ✅

[`roadmap.md`](roadmap.md) now reads **Accepted; M0 is complete**, the milestone
table marks M0 passed, the M0 section carries a completion note, and the exit
gate lists every item as passed with a table linking all fifteen M0 artifacts.

---

## Gaps found at this gate

Four, all fixed in place:

1. **`agent_cancel` / unknown Run id cited no test.** Every other matrix cell
   named one. Now cites `a cancel tells a finished run apart from an id that
   never existed` and `presentation owns every agent_cancel outcome`.
2. **The v1 Effect ban missed the ecosystem packages.** `isEffectPackage` matched
   `effect` and `effect/*` but not `@effect/*`, so a v1 module could have
   imported `@effect/platform` unnoticed. Widened, with a fixture.
3. **The legacy-name scan covered only `.ts` files.** "Nowhere in the v2 tree"
   has to include a Markdown note or a JSON fixture. Widened to every file in
   the tree, with a fixture.
4. **Two spike surfaces named in the ticket bodies were not exercised** — Codex
   process loss and background terminal tracking, and Claude tool event bridging
   and Query loss. Both spikes were extended and re-run live. Codex process loss
   turned out to be the most consequential finding of the three spikes and is
   now its own exception, resolved in
   [ADR-0023](../adr/0023-v2-scope-ownership.md) and
   [ADR-0025](../adr/0025-v2-terminal-settlement.md).

The three missing matrix proofs were found while writing the matrix and were
added as v1 tests at that point (item 2), which is the mechanism the ticket
anticipated rather than a gap left to this gate.

## What M1 starts from

- A frozen v1 with a written policy and a recorded green baseline.
- A public compatibility matrix that is executable, not aspirational: every cell
  points at a test in the `npm run check` lane.
- Public operation semantics decided before implementation.
- A v2 construction site that typechecks, tests, and loads on its own, with an
  import boundary that cannot be crossed by accident.
- A pinned Effect runtime whose whole initial primitive set is proven to compile
  and run under this toolchain.
- Six ADRs that turn the roadmap's invariants into citable decisions, with every
  backend exception resolved before the core contract is written.
