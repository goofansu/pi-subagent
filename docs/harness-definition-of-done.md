# Harness abstraction — definition of done

Acceptance criteria for the harness milestone (ADR-0007). Written for two
readers: the implementer, who needs to know what to test, and the code
reviewer, who needs to know what to check. Once achieved, items 1–3 and 7–10
are permanent invariants, not one-time gates.

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
   *Test:* a boundaries test asserts the dispatcher's module graph contains
   neither `pi-agent` nor `@earendil-works/pi-ai` nor the claude SDK.
   *Review:* the executor arrives via the harness resolved from the profile;
   any `if (harness === ...)` branch in the dispatcher is a defect.

2. [x] **Run state imports no pi-harness or Claude types.**
   `run.ts`, `types.ts`, and `runs.ts` speak only the domain Fact type;
   `SingleResult.messages` is facts, and usage extraction reads typed domain
   units, never a widened cast of a wire payload.
   *Test:* same boundaries test covers these files; fold/usage tests are
   written against fact builders.
   *Review:* no `as Message`, no hand-narrowing of wire content parts, in
   source or in tests.

3. [x] **Tool registration and rendering import no pi-harness or Claude types.**
   `index.ts`, `render.ts`, `widget.ts`, `presentation.ts`, `messages.ts`
   consume facts and `RunView` only. (Host API and pi-tui are allowed —
   see the scope rule.)
   *Test:* boundaries test; presentation/notification tests use fact
   builders.
   *Review:* `getFinalOutput`/`deriveActivity` narrow domain fact parts,
   not wire shapes.

4. [x] **Removing the claude harness does not change core code.**
   Deleting the adapter module and its one registration line at the
   composition root is the whole removal.
   *Test:* the core suite passes with only the pi harness registered.
   *Review:* the claude harness is referenced from exactly one production
   site — its registration.

5. [x] **Adding a fake harness requires no core changes.**
   *Test:* the core suite (dispatcher, registry, delivery, presentation,
   widget) runs against a fake harness with neither a pi binary nor the
   claude SDK present.
   *Review:* the fake implements only the public `Harness` contract — if it
   needs a core patch or a test-only hook in core, the seam leaked.

6. [x] **A codex harness would cost one adapter, one registration, its own
   tests — and no dispatcher/lifecycle changes.**
   *Test:* not directly testable; item 5's fake harness is the standing
   proxy.
   *Review:* thought experiment on every core diff — "would codex need to
   edit this file?" If yes, push the change behind the harness contract.

7. [x] **Pi wire `Message` objects never leave the pi harness.**
   Translation to facts happens inside the pi executor module, at the edge.
   *Test:* pi adapter tests feed NDJSON fixtures and assert emitted *facts*;
   boundaries test forbids `@earendil-works/pi-ai` message imports outside
   the pi harness module.
   *Review:* the translator is the only consumer of the wire shape.

8. [x] **Claude SDK message objects never leave the claude harness.**
   Same rule, same checks: SDK fixtures in, facts out; `SDKMessage` types
   confined to the adapter module.

9. [x] **`AbortSignal` is the only cancellation mechanism core exposes.**
   Core says *why* (cancel reason recorded in the registry, before abort
   fires); the harness owns *how* (SIGTERM/SIGKILL for pi, SDK abort for
   claude) and reports `stopReason: "aborted"`, which the seam normalizes to
   *cancelled* — abort never appears above the seam (see Cancel in
   CONTEXT.md).
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

Criteria 1–3, 7, and 8 should share one mechanical **boundaries test**: read
each core source file's import specifiers and assert the forbidden modules
(`@earendil-works/pi-ai` message exports, the pi harness module, the claude
SDK) are absent — so the invariant fails loudly in CI instead of silently in
review.

## Milestone-agreed additions (from the design session, ADR-0007)

- **Usage deltas** — usage on a fact is a delta; the shared fold sums; a
  harness never reports the same run's usage both per-message and
  cumulatively. *Test:* fold accumulation on fact fixtures; claude adapter
  test asserts no double count between per-message usage and the terminal
  result.
- **One-shot binds every harness** — one prompt in, one terminal answer out
  (ADR-0003 is a property of Run). *Review:* no send/steer surface on any
  harness contract.
- **Depth binds every harness** — claude children have their agent-spawning
  tool disallowed. *Test:* claude adapter test asserts the disallowed-tools
  option is set.
- **Trust posture is harness policy** — the request carries `projectTrusted`;
  the claude harness bypasses permissions unconditionally in this version.
  *Test:* claude adapter test asserts bypass regardless of the forwarded
  value. *Review:* the sharp edge is documented, not hidden.
