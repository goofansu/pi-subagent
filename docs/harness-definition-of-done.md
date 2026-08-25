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

"Claude" means everything from `@anthropic-ai/claude-agent-sdk`.

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

4. [x] **Removing the claude harness does not change core code.**
   Deleting the adapter module and its registration edge in `composition.ts`
   is the whole removal.
   *Test:* `composition.test.ts` runs the core registry with only Pi
   registered, and the boundaries suite passes a disposable composition with
   only the Pi edge.
   *Review:* production core names no adapter; `composition.ts` is the only
   permitted adapter-registration edge, and the production graph is clean.

5. [x] **Adding a fake harness requires no core changes.**
   *Test:* `harness.test.ts` runs a fake through dispatcher, registry,
   delivery, presentation, and widget, including cancellation, without
   starting a Pi child or loading the Claude SDK.
   *Review:* the fake implements only the public `Harness` contract; profile
   loading also asks a fake-owned validator to reject an unknown field.

6. [x] **A codex harness would cost one adapter, one registration, its own
   tests — and no dispatcher/lifecycle changes.**
   *Test:* the Codex-like public-contract fixture in `harness.test.ts`
   compiles and runs through the same dispatcher and lifecycle; it supplies
   only a registry entry and executor.

7. [x] **Pi wire `Message` objects never leave the pi harness.**
   Translation to facts happens inside the pi executor module, at the edge.
   *Test:* pi adapter tests feed NDJSON fixtures and assert emitted *facts*;
   the boundaries test parses the graph and forbids `@earendil-works/pi-ai`
   message imports outside the pi harness module.
   *Review:* the translator is the only consumer of the wire shape.

8. [x] **Claude SDK message objects never leave the claude harness.**
   Same rule, same checks: SDK fixtures in, facts out; `SDKMessage` types
   confined to the adapter module, and the parsed graph forbids Claude SDK
   imports outside it.

9. [x] **`AbortSignal` is the only cancellation mechanism core exposes.**
   Core says *why* (cancel reason recorded in the registry, before abort
   fires); the harness owns *how* (SIGTERM/SIGKILL for pi, SDK abort for
   Claude). Backend `aborted` is normalized at the seam: it never persists in
   `SingleResult.stopReason` or presentation, while lifecycle `cancelled` and
   its reason remain authoritative (see Cancel in `CONTEXT.md`).
   *Test:* fake-harness test aborts mid-run and asserts the lifecycle
   settles to cancelled with the recorded reason; adapter tests assert each
   backend's kill path fires on signal abort.
   *Review:* no harness-specific stop verbs in core; no second cancellation
   channel (no `harness.cancel()` method, no shared flags).

10. [x] **Harness-specific config is validated and interpreted by the harness.**
    Generic profile parsing understands `description`, `harness`, and the
    body; `model`, `effort`, `tools`, `appendSystemPrompt` are validated by
    the named harness, and a field the harness does not recognize is a
    diagnostic.
    *Test:* profile-loading tests per harness: pi accepts its fields, the
    fake harness rejects an unknown field with a diagnostic, claude maps its
    own model aliases.
    *Review:* `agents.ts` contains no field semantics beyond the common
    three; no central config union type enumerating every backend's options.

Criteria 1–3, 7, and 8 should share one mechanical **boundaries test**: parse
each core source file's real import specifiers, follow the transitive core
module graph, and assert the forbidden modules (`@earendil-works/pi-ai`
message exports, the pi harness modules, and the Claude SDK) are absent. The
composition module is the sole registration edge and is allowed to name the
adapters; tool registration and every other core edge fail loudly in CI instead
of silently in review. Comments and ordinary string literals are not import
edges.

## Milestone-agreed additions (from the design session, ADR-0007)

- [x] **Usage deltas** — input/output/cache counters, turns, and cost on a
  fact are additive deltas and the shared fold sums them. `contextTokens` is
  different: it is a latest-value gauge, so the fold replaces it with the
  newest reported context size rather than adding it. A harness that only
  knows totals reports one usage-bearing fact, and never reports the same
  run's usage both per-message and cumulatively. *Test:* fold accumulation
  and latest-context fixtures; the Claude adapter test asserts no double
  count between per-message usage and the terminal result.
- [x] **One-shot binds every harness** — one prompt in, one terminal answer
  out (ADR-0003 is a property of Run). *Test:* the dedicated public-contract
  invariant test checks both adapters and the `SubagentTask` shape for the
  absence of send, steer, and persistent-session surfaces.
- [x] **Depth binds every harness** — Claude children have their
  agent-spawning tool disallowed. *Test:* Claude adapter test asserts the
  disallowed-tools option is set.
- [x] **Trust posture is harness policy** — the request carries
  `projectTrusted`; the Claude harness bypasses permissions unconditionally in
  this version. *Test:* Claude adapter test asserts bypass regardless of the
  forwarded value. *Review:* the sharp edge is documented, not hidden.
- [x] **Transcript healing is authoritative** — a terminal transcript
  replaces streamed facts and all derived error/metadata state, so a transient
  streamed error cannot fail a clean run while a retained provider error still
  wins over a generic process-exit diagnostic. *Test:* Shadow-Pi fixtures cover
  both paths.
- [x] **Empty terminal accounting reaches presentation** — a successful Claude
  result with no text remains a fact, including model, usage, turns, cost, and
  stop reason. *Test:* the Claude integration fixture renders its nonzero cost
  in the widget.
- [x] **Claude model validation is explicit** — aliases and the documented
  allowlisted full IDs validate at session start; invented IDs are diagnosed
  with their value. *Test:* Claude harness validation fixtures cover aliases,
  full IDs, and `claude-sonnet-bogus`.
- [x] **The boundary test proves its negative case** — the production parser,
  resolver, and graph walker reject a controlled core-to-adapter edge without
  changing the working tree, while comments and ordinary strings remain
  ignored. *Test:* the checker runs against a disposable fixture root and the
  real production graph.
