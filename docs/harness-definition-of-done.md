# Harness abstraction — definition of done

Acceptance criteria for the harness milestone (ADR-0007). Written for two
readers: the implementer, who needs to know what to test, and the code
reviewer, who needs to know what to check. Checked items are permanent
invariants, not one-time gates; every item below is checked only where
production behavior and regression evidence support it.

## Scope rule (read first)

"Pi" below means **pi as a harness**: the wire vocabulary in
`@earendil-works/pi-ai` (`Message`, content parts, usage payloads), the pi
CLI protocol, and the pi executor module. It does **not** mean pi as the
host: `ExtensionAPI`, pi-tui components, `Theme`, and host event names are
how this extension exists at all and are allowed everywhere. A reviewer
checking items 1–3 is looking for wire/message types, not host-API imports.

"Claude" means everything from `@anthropic-ai/claude-agent-sdk`. "Codex" means
Codex CLI JSONL events and invocation policy, all confined to its adapter.

## The ten criteria

1. [x] **`runner.ts` imports no pi-harness or Claude types.**
   No `runPiAgent` import, no pi `provider/id` model building, no pi
   thinking-scale vocabulary — resolution lives in the harness.
   *Test:* the boundaries test parses real import specifiers and walks the
   dispatcher's transitive core-module graph; it contains neither `pi-agent`
   nor `@earendil-works/pi-ai` nor the claude SDK.
   *Review:* the executor arrives via the harness resolved from the profile;
   any `if (harness === ...)` branch in the dispatcher is a defect.

2. [x] **Run state imports no pi-harness or Claude types.**
   `run.ts`, `types.ts`, and `runs.ts` speak only the domain Fact type;
   `SingleResult.messages` is facts, and usage extraction reads typed domain
   units, never a widened cast of a wire payload.
   *Test:* the same AST-based boundaries test covers these files and every
   reachable core module; fold/usage tests are written against fact builders.
   *Review:* no `as Message`, no hand-narrowing of wire content parts, in
   source or in tests.

3. [x] **Tool registration and rendering import no pi-harness or Claude types.**
   `index.ts`, `render.ts`, `widget.ts`, `presentation.ts`, `messages.ts`
   consume facts and `RunView` only. (Host API and pi-tui are allowed —
   see the scope rule.)
   *Test:* the transitive boundaries test covers these files; the
   composition root may register adapters, but tool registration and rendering
   have no backend edges. Presentation/notification tests use fact builders.
   *Review:* `getFinalOutput`/`deriveActivity` narrow domain fact parts,
   not wire shapes.

4. [x] **Removing the Claude harness does not change core code.**
   The core has no Claude/SDK edge: removing the Claude adapter and its direct
   registration import/entry in `composition.ts` is the only core-code change.
   Removing `@anthropic-ai/claude-agent-sdk` from `package.json` and the lockfile
   is a separate packaging-metadata change, not a core-code change.
   *Test:* `composition.test.ts` runs a Pi-only composition, and the
   boundaries suite statically proves the production core graph has no Claude
   SDK edge while a disposable composition may retain only direct adapter
   registration edges.
   *Review:* `composition.ts` is the only permitted adapter-registration edge;
   core execution and the graph checker do not require Claude.

5. [x] **Adding a fake harness requires no core changes.**
   *Test:* `harness.test.ts` runs a fake through dispatcher, registry,
   delivery, presentation, and widget, including cancellation, without
   starting a Pi child or loading the Claude SDK. Its shared **Harness
   Conformance** battery also covers backend-crash executor resolution,
   cancellation normalization, usage folding, child-depth transport, configuration
   immutability, clean answerless termination, and failure after an answer. The
   battery has nine scenarios: backend-crash, abort-mid-run,
   terminal-answer-then-abort, usage-totals, child-depth, config-immutable,
   no-terminal-answer, post-answer-failure, and terminal-transcript-healing.
   That battery is part of the one-adapter cost,
   not a core change.
   *Review:* the fake implements only the public `Harness` contract; profile
   loading also asks a fake-owned validator to reject an unknown field.

6. [x] **The Codex harness costs one adapter, one registration, its own
   tests — and no dispatcher/lifecycle changes.**
   *Test:* `codex-harness.test.ts` runs the real Codex adapter through the
   shared **Harness Conformance** battery (all nine scenarios; Claude alone
   visibly skips snapshot healing). Codex has no transcript snapshot, so its
   `terminal-transcript-healing` case asserts that multiple terminal JSONL
   items remain streamed facts and that the final item determines final output,
   without inventing a transcript replacement. Wire fixtures and argv
   validation cover the adapter's remaining protocol. The one-adapter cost is
   therefore the adapter, its registration, and its battery tests.

7. [x] **Pi wire `Message` objects never leave the pi harness.**
   Translation to facts happens inside the pi executor module, at the edge.
   *Test:* pi adapter tests feed NDJSON fixtures and assert emitted *facts*;
   the boundaries test directly assigns Pi wire ownership to the Pi harness,
   while the neutral process source is checked as core and owns no wire. It
   rejects Pi wire imports from Claude and other adapters (and rejects Claude
   SDK imports from the Pi side).
   *Review:* the translator is the only consumer of the wire shape.

8. [x] **Claude SDK message objects never leave the claude harness.**
   Same rule, same checks: SDK fixtures in, facts out; `SDKMessage` types
   confined to the Claude adapter, and the parsed graph directly rejects
   Claude SDK imports from the Pi or any other adapter.

9. [x] **`AbortSignal` is the only cancellation mechanism core exposes.**
   Core says *why* (cancel reason recorded in the registry, before abort
   fires); the harness owns *how* (SIGTERM/SIGKILL for pi, SDK abort for
   Claude). Cancellation is normalized to the `cancelled` ending at the seam: backend
   stop words never persist in `SingleResult.stopReason` or presentation, while
   lifecycle `cancelled` and its reason remain authoritative (see Cancel in
   `CONTEXT.md`).
   *Test:* the shared **Harness Conformance** battery's `abort-mid-run` and
   `terminal-answer-then-abort` scenarios assert cancellation normalization
   and terminal-answer precedence; adapter tests assert each backend's kill path
   fires on signal abort.
   *Review:* no harness-specific stop verbs in core; no second cancellation
   channel (no `harness.cancel()` method, no shared flags).

10. [x] **Harness-specific config is validated and interpreted by the harness.**
    Generic profile parsing understands `description`, `harness`, and the
    body; `model`, `effort`, `tools`, `appendSystemPrompt` are validated by
    the named harness, and a field the harness does not recognize is a
    diagnostic.
    *Test:* profile-loading tests per harness: pi accepts its fields, the
    fake harness rejects an unknown field with a diagnostic, claude validates
    its own model aliases.
    *Review:* `agents.ts` contains no field semantics beyond the common
    three; no central config union type enumerating every backend's options.

Criteria 1–3, 7, and 8 should share one mechanical **boundaries test**: parse
each core source file's real import specifiers, follow the transitive core
module graph, and assert the forbidden modules (`@earendil-works/pi-ai`
message exports, the pi harness modules, and the Claude SDK) are absent. It
also checks adapter ownership directly: Pi wire is confined to the Pi
harness, Claude SDK wire to the Claude adapter, and other adapters own
neither; the neutral process source remains in the core graph and owns no
backend wire. The composition module is the sole registration edge;
it is allowed to name the adapters. Tool registration and every other core edge
fail loudly in CI instead of silently in review. Static module forms are edges too;
comments and ordinary string literals are not.

## Milestone-agreed additions (from the design session, ADR-0007)

- [x] **Usage deltas** — input/output/cache counters, turns, and cost on a
  fact are additive deltas and the shared fold sums them. `contextTokens` is
  different: it is a latest-value gauge, so the fold replaces it with the
  newest reported context size rather than adding it. A harness that only
  knows totals reports one usage-bearing fact, and never reports the same
  run's usage both per-message and cumulatively. *Test:* the shared **Harness
  Conformance** battery's `usage-totals` scenario runs both real adapters
  through the dispatcher and fold, asserting additive deltas; the Pi and fake
  rigs also prove latest-context replacement, while the Claude rig proves no
  double count between per-message usage and the terminal result.
- [x] **One-shot binds every harness** — one prompt in, one terminal answer
  out (ADR-0003 is a property of Run). *Test:* `one-shot.test.ts` has
  compile-time exact `keyof` assertions for `Harness`, `HarnessRun`, and
  `SubagentTask`, plus runtime checks covering both adapters and the absence
  of send, steer, and persistent-session surfaces.
- [x] **Depth binds every harness** — Claude children have their
  agent-spawning tools disallowed, and every executor copies
  `task.childDepth` into its child's environment so a Bash-launched
  grandchild pi cannot restart at depth zero. *Test:* the shared **Harness
  Conformance** battery's `child-depth` scenario runs both real adapters and
  observes the child depth; adapter policy tests assert Claude disallows
  `Agent` and `Task`, while the adapter rigs assert `PI_SUBAGENT_DEPTH` and
  preserved `process.env` inheritance. The dispatcher depth guard remains
  separately tested.
- [x] **Trust posture is harness policy** — the request carries
  `projectTrusted`; the Claude and Codex harnesses bypass unconditionally in
  this version (deliberate parity, ADR-0009), with the forwarded value
  reserved for a future shared posture. *Test:* Claude adapter tests assert
  bypass regardless of the forwarded value; Codex argv tests assert the
  bypass flag for either value. *Review:* the sharp edge is documented, not
  hidden.
- [x] **Transcript healing is authoritative** — a terminal transcript
  replaces streamed facts and all derived error/metadata state, so a transient
  streamed error cannot survive a clean replacement. A model reported by a
  metadata, assistant, or terminal fact is authoritative over the
  harness-resolved baseline; healing resets to that baseline, then terminal
  facts may replace it. Absent or ambiguous evidence retains the baseline; if
  there is no baseline, healing removes stale model metadata. A retained
  provider error still wins over a generic process-exit diagnostic. *Test:*
  the Pi and fake harness `terminal-transcript-healing` conformance scenarios
  cover clean replacement. Codex has no transcript snapshot, so its same named
  scenario covers terminal-item authority and explicitly retains streamed facts
  rather than pretending a snapshot exists; Claude is the only visible skip.
  Adapter and dispatcher fold tests cover the error paths, authoritative-baseline
  replacement, stale-model removal, and baseline preservation.
- [x] **Empty terminal accounting reaches presentation** — a successful Claude
  result with no text remains a fact, including usage, turns, cost, and stop
  reason. Model provenance comes from the SDK init message, an assistant fact,
  or the harness-resolved baseline; `modelUsage` is accounting only because
  even its sole entry can be an auxiliary model. Undeclared terminal model
  metadata is tolerated for wire compatibility but is not required.
  *Test:* the pinned widget fixture renders nonzero cost, the unpinned
  integration retains streamed provenance and accounting, and single-entry,
  multiple-entry, and auxiliary-only error coverage proves terminal usage
  cannot overwrite model provenance.
- [x] **Claude model validation is aliases-only** — exactly the SDK's
  documented family aliases (`fable`, `opus`, `sonnet`, `haiku`) validate
  synchronously at session start; the alias is passed through unresolved and
  the SDK maps it to the family's current default ID, so no local alias→ID
  mapping or full-ID allowlist can go stale. Full, dated, and invented IDs
  are diagnosed with their value and the accepted aliases. *Test:* Claude
  harness validation accepts each alias case-insensitively, passes it
  through unresolved, and rejects full IDs and misspellings.
- [x] **The boundary test proves its negative case** — the production parser,
  resolver, and graph walker reject controlled core-to-adapter and crossed
  adapter-wire edges without changing the working tree. Static imports,
  no-substitution dynamic imports, and property-access requires are covered;
  comments and ordinary strings remain ignored. *Test:* the checker runs
  against disposable fixture roots and the real production graph.
