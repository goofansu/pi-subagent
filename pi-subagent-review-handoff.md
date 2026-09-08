# Cancellation presentation and Run-line encapsulation handoff

This handoff records the ticket-agent reports supplied out of band and the integration-review remediation performed on `feat/cancellation-presentation-run-line`. The original workspace and planning files were not edited.

## Ticket 01 — `863fdae`

Changed `extensions/subagent/presentation/run-presentation.ts`, `run-presentation.test.ts`, `inspection.test.ts`, and `extensions/subagent/runtime/races.test.ts`.

Stored Result cancellation metadata, including absence, is authoritative. Completed and failed outcomes suppress cancellation causes. A deterministic cleanup-gated runtime → observation → inspection regression was added; runtime behavior, Notification delivery, and Result settlement were unchanged.

Reported validation: 80 focused tests passed; `npm ci` passed; `npm run check` passed with 1,441 main tests passed/8 skipped and 153 conformance tests passed/8 skipped, plus typecheck, lint, bundled-profile smoke, and commit hook. The first full gate inherited `PI_SUBAGENT_DEPTH=1` and failed; rerunning with that variable unset passed. Exact focused command lines were not supplied. No manual terminal/theme check was performed.

## Ticket 02 — `68f728a`

Changed presentation banner, dashboard-panel, history, index, inspection, renderers and tests, rows, and run-line and tests; added `text-width.ts` and its tests.

The neutral text-width utility became the single ANSI-aware fitting implementation. Completion notices now clip labels against measured fixed content, preserve the existing fixed-content overflow fallback, and use their distinct 48-column cap.

Reported validation: 169 focused tests passed; `env -u PI_SUBAGENT_DEPTH npm ci` passed with 0 vulnerabilities; `env -u PI_SUBAGENT_DEPTH npm run check` passed with 1,445 main tests passed/8 skipped and 153 conformance tests passed/8 skipped, plus typecheck, lint, bundled-profile smoke, commit hook, and `git diff --check`. Exact focused command lines were not supplied. No manual terminal/theme check was performed.

## Ticket 03 — `cb59253`

Changed presentation run-line, rows, history, and their tests.

Widget-row and dashboard-list fitting operations replaced public policy configuration. The widget owns its outer margin and history owns prefix/shared-column measurement; existing assembled layouts and threshold transitions were retained.

Reported validation: 148 focused tests passed, then 53 post-review focused tests passed; `env -u PI_SUBAGENT_DEPTH npm ci` passed with 347 packages and 0 vulnerabilities; `env -u PI_SUBAGENT_DEPTH npm run check` passed with 1,447 main tests passed/8 skipped and 153 conformance tests passed/8 skipped, plus typecheck, lint, bundled-profile smoke, commit hook, and `git diff --check`. Exact focused command lines were not supplied. Automated theme coverage passed; no manual terminal/theme check was performed.

## Integration-review remediation

Changed:

- `extensions/subagent/presentation/rows.ts` and `rows.test.ts`: public `formatRunRow` now accepts full surface width and removes both widget margins exactly once; the assembled widget path and its transitions are unchanged.
- `extensions/subagent/presentation/run-line.ts`, `run-line.test.ts`, `history.ts`, and `history.test.ts`: removed the unused standalone history-row/fitter API, retained only list fitting, and corrected threshold descriptions to state that status/activity gates measure post-prefix content while preserving full-row transitions at 26/52 columns.
- `extensions/subagent/presentation/run-presentation.ts`: all cancellation-dependent decisions use the single interpreted cancellation reason.
- `extensions/subagent/presentation/renderers.ts`: replaced obsolete share/agent-column wording with the current notice-label cap contract.
- `extensions/subagent/runtime/races.test.ts`: documented why the minimal rendered terminal-status/output/no-cancellation assertion intentionally belongs in the deterministic cross-layer race regression.
- `extensions/subagent/presentation/rows.ts` and `history.ts`: documented why the small surface-specific resolved-content assemblies remain separate (status casing and prefix differ; sharing would couple semantic presentation to geometric fitting).

Validation performed in the integration worktree with `PI_SUBAGENT_DEPTH` unset:

1. Focused command:
   `env -u PI_SUBAGENT_DEPTH node --import tsx --import ./extensions/subagent/suite-setup.ts --test extensions/subagent/presentation/run-presentation.test.ts extensions/subagent/presentation/run-line.test.ts extensions/subagent/presentation/rows.test.ts extensions/subagent/presentation/history.test.ts extensions/subagent/presentation/renderers.test.ts extensions/subagent/runtime/races.test.ts`
   - First run: 116 passed, 1 failed. Removing the unused standalone history renderer exposed a test that rendered two rows independently while asserting shared-column alignment. The test was corrected to render those rows through the supported assembled list seam.
   - Second run: 117 passed, 0 failed/skipped.
2. `env -u PI_SUBAGENT_DEPTH npm run typecheck`: passed.
3. Initial `env -u PI_SUBAGENT_DEPTH npm run lint`: failed only on formatter output in two edited declarations; formatting was corrected.
4. `env -u PI_SUBAGENT_DEPTH npm ci`: passed; 347 packages installed, 0 vulnerabilities. npm emitted deprecation and install-script approval warnings.
5. `env -u PI_SUBAGENT_DEPTH npm run check`: passed; 1,448 main tests passed/8 capability skips, 153 conformance tests passed/8 capability skips, with typecheck, lint, and bundled-profile smoke passing. Log: `/tmp/cancellation-integration-fixes-check.log` (temporary machine-local evidence).

No manual narrow/wide/theme terminal check was performed; it is optional in the specification. No provider/live smoke tests were performed. The architecture document was explicitly excluded from searches and was not read or modified.
