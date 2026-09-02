# v1 freeze policy

**Status:** In force from the commit recorded below until v1 is deleted at
milestone M7.
**Applies to:** `extensions/subagent/` — the v1 extension tree — and the
repository scripts that exist to gate it.
**Reason:** [the v2 roadmap](roadmap.md). The execution architecture is being
rewritten on Effect in `extensions/subagent-v2/`. Carrying two products forward
in parallel would split the effort that the rewrite needs, and would leave v1's
behaviour drifting out from under the compatibility matrix that defines v2's
parity target.

## The policy

**v1 is frozen.** Two kinds of change are still allowed:

1. **Critical fixes.** A correctness, data-loss, resource-leak, or security
   defect that affects users of the shipped v1 extension. "Critical" means a
   user is harmed by the current behaviour, not that the code could be better.

2. **Testability changes that add proof for a compatibility-matrix row.**
   A test that proves existing v1 behaviour a matrix cell cites, or a small,
   behaviour-preserving refactor that makes such a test possible. These may not
   change what v1 does.

**Everything else is out.** No new features, no new tools or commands, no new
backends, no performance work, no refactors for their own sake, no dependency
upgrades that are not part of a critical fix, and no adoption of Effect anywhere
in v1 — the last of these is enforced by
`extensions/subagent-v2/boundaries.test.ts`, which fails if any v1 module
imports `effect`, and equally if any v1 module imports the v2 tree.

If you are unsure whether a change qualifies, the test is: *would a user notice
if this were not made?* If no, it belongs in v2.

## What M0 changed in v1

M0 made **no v1 runtime change**. What it did touch, all under the two
exceptions above:

| File | Change | Exception |
| --- | --- | --- |
| `extensions/subagent/boundaries.test.ts` | Uses the shared specifier reader now in `tools/import-specifiers.ts` instead of its own private copy, so the v2 boundary test does not have to import a v1 test file to get it. | Testability |
| `extensions/subagent/widget.test.ts` | Added `a run line names each harness the same way`. | Matrix proof |
| `extensions/subagent/agents-command.test.ts` | Added `the agents list is identical whichever harness a profile names`. | Matrix proof |
| `extensions/subagent/presentation.test.ts` | Added `completion notification prose is identical whichever harness ran the Run`. | Matrix proof |

The three added tests assert behaviour v1 already has. `tools/import-specifiers.ts`
is neutral repository tooling that belongs to neither extension tree.

Repository-level files also changed — `package.json` (the v2 lane, the explicit
Pi extension list, the pinned `effect` dependency), `tsconfig.json`,
`tsconfig.v2.json`, `biome.json`, and the `Makefile` — none of which is v1
source.

## The recorded baseline

The baseline is the full repository quality gate, `npm run check`:

- `npm run typecheck` — the whole repository, both extension trees and `tools/`
- `npm run typecheck:v2` — the v2 tree on its own project file
- `npm run lint` — Biome across the repository
- `npm run test:conformance` — the per-Run capability-aware Harness conformance
  battery for the shared contract and all three production adapters
- `npm run test:managed-conformance` — repeated managed Subagent conformance
- `npm test` — the full v1 suite plus the repository script and tooling tests
- `npm run test:v2` — the v2 suite: entry-point registration, the Effect
  primitive smoke test, and the v2 import boundary
- `npm run codex:protocol:check` — the byte-for-byte generated Codex protocol
  check against the pinned CLI

**Recorded green at:** `__BASELINE_COMMIT__`
(`__BASELINE_SUBJECT__`)

**Result:** `npm run check` exited 0. `npm test` reported 540 tests, 539 passing
and 1 skipped — the skip is `claude conformance: terminal-transcript-healing`,
which the Claude adapter deliberately declares unimplemented because it has no
wire transcript snapshot. `npm run codex:protocol:check` printed
`CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.150.1`.

A regression in the frozen tree after this commit is attributable: the gate was
green here, and only critical fixes and matrix-proof tests are permitted since.

## Live provider gates

`npm run release:check` adds the six authenticated provider gates and the
retained-Codex evidence gate. They are not part of the recorded baseline because
they spend provider quota and require credentials; they remain the release gate,
unchanged by the freeze. See the README's release-verification section.

## When the freeze lifts

It does not lift. v1 is deleted at milestone M7, once v2 reaches full parity
against [the compatibility matrix](compatibility-matrix.md) and passes the
cutover, soak, and release gates.
