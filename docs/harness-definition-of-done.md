# Harness abstraction — definition of done

Acceptance criteria for the harness milestone (ADR-0007). Written for two
readers: the implementer, who needs to know what to test, and the code
reviewer, who needs to know what to check. Checked items are permanent
invariants, not one-time gates; every item below is checked only where
production behavior and regression evidence support it.

## Scope rule (read first)

"Pi" below means **pi as a harness**: the SDK vocabulary in
`@earendil-works/pi-ai` (`Message`, content parts, usage payloads) and the Pi
adapter module. It does **not** mean pi as the
host: `ExtensionAPI`, pi-tui components, `Theme`, and host event names are
how this extension exists at all and are allowed everywhere. A reviewer
checking items 1–3 is looking for wire/message types, not host-API imports.

"Claude" means everything from `@anthropic-ai/claude-agent-sdk`. "Codex" means
Codex App Server JSON-RPC events and invocation policy, all confined to
codex-owned modules (the harness, retained transport owner, and Attempt).

## The ten criteria

1. [x] **`runner.ts` imports no pi-harness or Claude types.**
   No Pi adapter import, no pi `provider/id` model building, no pi
   thinking-scale vocabulary — resolution lives in the harness.
    *Test:* the boundaries test parses real import specifiers and walks the
    dispatcher's transitive core-module graph; it contains neither
    `harnesses/pi` nor `@earendil-works/pi-ai` nor the claude SDK.
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
    *Test:* `harnesses/contract.test.ts` runs a fake through dispatcher, registry,
   delivery, presentation, and widget, including cancellation, without
   starting a Pi child or loading the Claude SDK. Its shared **Harness
   Conformance** battery also covers backend-crash executor resolution,
   cancellation normalization, usage folding, child-depth transport, configuration
   immutability, clean answerless termination, and failure after an answer. The
   battery has thirteen scenarios: backend-crash, abort-mid-run,
   terminal-answer-then-abort, usage-totals, child-depth, config-immutable,
   no-terminal-answer, post-answer-failure, terminal-transcript-healing,
   steering-single-consumed, steering-fifo-consumed,
   steering-intermediate-completion, and steering-admission-no-fact. The four
   steering scenarios are capability-aware: supported adapters prove serial
   FIFO consumption, provider-Result-transparent settlement, authoritative
   neutral user Facts, and no Fact at admission alone; unsupported adapters
   prove truthful rejection with zero provider-control work. Shared code never checks a
   harness name.
   That battery is part of the one-adapter cost,
   not a core change.
   *Review:* the fake implements only the public `Harness` contract; profile
   loading also asks a fake-owned validator to reject an unknown field.

6. [x] **The Codex adapter owns three modules, one registration, its own tests —
   and no dispatcher/lifecycle changes.**
    *Test:* `harnesses/codex/harness.test.ts` runs the real Codex adapter through the
   shared **Harness Conformance** battery (all thirteen scenarios; Claude alone
   visibly skips snapshot healing). Codex has no transcript snapshot, so its
   `terminal-transcript-healing` case asserts that multiple completed agent
   messages remain streamed facts and that the final completed agent message
   determines final output, without inventing a transcript replacement. JSON-RPC
   fixtures and protocol validation cover the adapter's remaining behavior. The
   retained transport owns process and JSON-RPC lifetime, while the Attempt owns
   current-Turn reduction and terminal meaning. The adapter cost is therefore
   its harness, retained transport, and Attempt modules, one harness registration,
   and its battery tests.

7. [x] **Pi wire `Message` objects never leave the pi harness.**
   Translation to facts happens inside the retained Pi SDK adapter, at the edge.
   *Test:* pi adapter tests drive SDK session events and terminal snapshots
   through the Harness interface and assert emitted *facts*, including tool
   calls, tool results, and confined in-band errors. The boundaries test
   directly assigns Pi wire ownership to the Pi harness, rejects Pi wire imports
   from Claude and other adapters, and rejects Claude SDK imports from the Pi
   side.
   *Review:* the translator is the only consumer of the wire shape.

8. [x] **Claude SDK message objects never leave the claude harness.**
   Same rule, same checks: SDK fixtures in, facts out; `SDKMessage` types
   confined to the Claude adapter, and the parsed graph directly rejects
   Claude SDK imports from the Pi or any other adapter.

9. [x] **`AbortSignal` is the only cancellation mechanism core exposes.**
   Core says *why* (cancel reason recorded in the registry, before abort
   fires); the harness owns *how* (SIGTERM/SIGKILL for pi, SDK abort for
   Claude, and `turn/interrupt` for Codex, escalating to process signals only
   when the server is unresponsive). Cancellation is normalized to the `cancelled` ending at the seam: backend
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
backend wire. Codex's App Server event stream has no transcript snapshot: its
final completed agent message remains an authoritative streamed fact without a
fabricated replacement. The composition module is the sole registration edge;
it is allowed to name the adapters. Tool registration and every other core edge
fail loudly in CI instead of silently in review. Static module forms are edges too;
comments and ordinary string literals are not.

## Milestone-agreed additions (from the design session, ADR-0007)

- [x] **Usage deltas** — input/output/cache counters, turns, and cost on a
  fact are additive deltas and the shared fold sums them. `contextTokens` is
  different: it is a latest-value gauge, so the fold replaces it with the
  newest reported context size rather than adding it. A harness that only
  knows totals reports one usage-bearing fact, and never reports the same
  run's usage both per-message and cumulatively. Turn deltas are nonnegative
  finite integers. Claude provisionally emits one turn per unique root
  assistant message id (treating a missing parent as root, deduplicating block
  events, excluding non-null sidechains, and counting aborted frames), then
  uses a valid terminal total only to raise the count. Missing message ids and
  malformed totals contribute zero; cancellation, backend failure, and lower
  terminal totals preserve provisional progress.
  Refusal-fallback retractions deliberately do not decrement additive Facts,
  accepting a bounded overcount so later catch-up remains synchronized.
  *Test:* the shared **Harness Conformance** battery's `usage-totals`
  scenario runs every real harness
  through the dispatcher and fold, asserting additive deltas; the Pi and fake
  rigs also prove latest-context replacement, while the Claude rig proves no
  double count between per-message usage and the terminal result.
- [x] **Every Run settles exactly once** — one new prompt produces one
  immutable terminal Result (ADR-0020). Harness preparation binds the fixed
  Subagent context and returns an adapter that can prepare independent Runs,
  atomically admit Resume, and close idempotently. Admission is synchronous,
  provider-I/O-free, and returns exactly an admitted prepared Run,
  unsupported, or Conversation loss. The Session
  manager retains it while the Subagent is idle and closes it at Session
  shutdown; the dispatcher owns only each Run execution. *Test:*
  `harnesses/contract.test.ts` has compile-time exact `keyof` assertions for
  `Harness`, `HarnessAdapter`, `HarnessResumeAdmission`, `HarnessRun`, `SubagentContext`,
  `SubagentTask`, `SubagentRun`, `Fact`, `RunEnding`, and `SingleResult`, plus
  runtime checks covering every adapter. Prepared Runs declare neutral Control
  capability, and executors receive only a fresh reporter, AbortSignal, and
  neutral synchronous Control source — never send/control methods or provider continuation
  handles. Pi, Claude, and healthy Codex adapters admit Resume. Pi retains one
  idle SDK session; Claude creates fresh, fully cleaned Queries; Codex retains
  one App Server and ephemeral root while every Run receives fresh Turn-scoped
  Attempt state. Adapter tests prove retained private semantic context,
  independent managed Runs, per-Run accounting, current-Run steering, honest
  Conversation loss, and deterministic cancellation and shutdown races.
- [x] **Managed resume conformance is part of the adapter cost** — the shared
  battery creates one stable Subagent and first Run, observes idle transition,
  admits at most one resumed Run, preserves independent immutable Results and
  notifications, limits each adapter to one disposable execution at a time,
  and closes the retained adapter once across repeated shutdown. Its fixture
  contract contains neutral admission outcomes and lifecycle observations only and
  never branches on Harness names or exposes continuation tokens. The
  controlled adapter and every production adapter prove retained semantic
  context, cancellation followed by resume, immutable and independently
  retrievable Results, independent notifications, per-Run transcript and usage
  isolation, at most one active execution, and idempotent close through the
  same domain outcomes. The battery repeats every
  adapter path 32 times without timing delays. *Test:*
  `npm run test:managed-conformance`.
- [x] **Managed Resume rejects known Conversation loss without a Run** — the
  shared battery exercises admitted, unsupported, and Conversation-loss
  outcomes through controlled neutral adapters. Rejections consume no Run id,
  start no execution, emit no Notification, and leave prior Results immutable.
  The public Codex/fake-App-Server test additionally proves idle process loss
  yields actionable harness-neutral prose, no replacement request or spawn,
  and no provider identity.
- [x] **Depth binds every harness** — Claude children have their
  agent-spawning tools disallowed, and every executor copies
  `context.childDepth` into its child's environment so a Bash-launched
  grandchild pi cannot restart at depth zero. *Test:* the shared **Harness
  Conformance** battery's `child-depth` scenario runs every real harness and
  observes the child depth; adapter policy tests assert Claude disallows
  `Agent` and `Task`, while the adapter rigs assert `PI_SUBAGENT_DEPTH` and
  preserved `process.env` inheritance. The dispatcher depth guard remains
  separately tested.
- [x] **Trust posture is harness policy** — the request carries
  `projectTrusted`; the Claude and Codex harnesses bypass unconditionally in
  this version (deliberate parity, ADR-0009), with the forwarded value
  reserved for a future shared posture. *Test:* Claude adapter tests assert
  bypass regardless of the forwarded value; Codex App Server handshake tests
  assert the fixed approval and sandbox policy. *Review:* the sharp edge is documented, not
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
  scenario covers the final completed agent message's authority and explicitly
  retains streamed facts rather than pretending a snapshot exists; Claude is
  the only visible skip.
  Adapter and dispatcher fold tests cover the error paths, authoritative-baseline
  replacement, stale-model removal, and baseline preservation.
- [x] **Empty terminal accounting reaches presentation** — a successful Claude
  result with no text remains a fact, including usage, turns, cost, and stop
  reason. Model provenance comes from the SDK init message, an assistant fact,
  or the harness-resolved baseline; `modelUsage` is accounting only because
  even its sole entry can be an auxiliary model. Undeclared terminal model
  metadata is tolerated for wire compatibility but is not required.
  *Test:* the pinned widget fixture retains nonzero usage accounting and turns,
  the unpinned integration retains streamed provenance and accounting, and single-entry,
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
- [x] **Codex protocol fidelity is schema-derived** — every App Server
  notification shape the transport consumes is derived from the installed
  codex's generated protocol schema (`codex app-server generate-json-schema`,
  verified against codex-cli 0.150.1 plus a live stdio smoke run), never from
  hand-authored fixtures alone. The parser requires only schema-required
  fields: the notification envelope is `method` + `params` (the live server's
  undeclared `emittedAtMs` stamp is ignored, not required), optional fields
  are normalized to their schema defaults, and unknown item variants inside a
  completed turn are skipped so the authoritative `turn/completed` settlement
  survives protocol growth. The drift invariant: an unknown notification
  method is safely ignored, and an unrecognized server-to-client request is
  refused with a JSON-RPC method-not-found error — neither can fail the run,
  because the protocol carries many more notification variants than this
  adapter consumes. The request and notification unions are vendored in
  `docs/codex-protocol/`; the no-quota check also inspects generated ephemeral
  `thread/start`, pathless Thread response, Turn identity, stored-thread
  inspection, and consumed notification shapes. When the codex CLI moves,
  re-verify via the `codex-upgrade` skill
  (`.agents/skills/codex-upgrade/SKILL.md`), which diffs the regenerated schema
  and runs both authenticated Codex smokes. *Test:* the App Server transport tests
  forward schema-minimum notifications — no envelope timestamp, sparse
  optional fields, a turn carrying an unknown item type — and drop unknown
  notification methods while refusing unsupported server requests.
- [x] **The boundary test proves its negative case** — the production parser,
  resolver, and graph walker reject controlled core-to-adapter and crossed
  adapter-wire edges without changing the working tree. Static imports,
  no-substitution dynamic imports, and property-access requires are covered;
  comments and ordinary strings remain ignored. *Test:* the checker runs
  against disposable fixture roots and the real production graph.
- [x] **Steering has one release gate** — capability-aware Harness Conformance
  runs for the controlled harness and all production adapters; Codex dispatcher
  and transport fixtures repeat the synchronous Control/cancellation ingress law
  for first and resumed Attempts at least 32 times with explicit barriers and no
  timing delays: accepted-Control-before-cancellation writes `turn/steer` before
  `turn/interrupt`, and cancellation-first returns `not steerable` with no later
  `turn/steer`; late steering-response races remain covered separately and are
  not substitutes for admission-order proofs; provider-accepted steering stays
  correlated through cancellation until settlement and reports its later
  provider-confirmed user item exactly once; generated schemas are
  byte-compared with the pinned installed CLI; and the authenticated live smoke
  admits uniquely marked guidance, observes its correlated neutral user Fact,
  retrieves a Result reflecting it, proves interruption, prints
  `CODEX_STEERING_LIVE_SMOKE_PASS`, and cleans up on every exit path. Run
  `npm run check` for the local quality gates and `npm run release:check` for
  the quota-spending final gate.
- [ ] **Codex resume has one release gate** — pending authenticated smoke and
  recorded Desktop-coexistence evidence for the pinned release. The installed
  pinned CLI's generated request and notification unions are byte-checked,
  while generated response shapes are structurally checked for ephemeral
  pathlessness and Turn identity; per-Run and managed conformance are green;
  deterministic public and transport races repeat; and the authenticated
  resume smoke starts one Subagent, retains one App Server while idle, runs two
  Turns on one ephemeral pathless root without marker replay or
  `thread/resume`, rejects list/read from a second App Server, retrieves both
  immutable Results, observes both notifications, confines provider identity,
  proves process-tree cleanup, and prints `CODEX_RESUME_LIVE_SMOKE_PASS`. The
  existing steering/interruption smoke and recorded Desktop-coexistence
  procedure remain separate required proofs. `npm run
  codex:retained-release:check` is the no-quota closing gate and intentionally
  fails while either record is absent. Check this item only after both live
  records exist; deterministic coverage alone does not complete this release
  gate.
- [x] **Pi managed steering and resume have one release gate** — production
  uses a retained, in-process, memory-only `AgentSession` with normal resource
  loading, headless binding, project trust, self-filtering, orchestration-tool
  denial, per-spawn depth, FIFO native steering, current-Run snapshots, queue
  clearing on cancellation, and bounded idempotent shutdown. Focused SDK seam
  tests cover construction and fault cleanup; per-Run and 32-repeat managed
  conformance are green. `npm run pi:steering-smoke` and
  `npm run pi:resume-smoke` are authenticated gates and print
  `PI_STEERING_LIVE_SMOKE_PASS` and `PI_RESUME_LIVE_SMOKE_PASS`.
- [x] **Claude managed steering and resume have one release gate** — one
  ordered streaming-input engine keeps a public Run active across provider
  Result checkpoints, serializes correlated Controls, differences cumulative
  accounting, rejects lost continuation without fallback, and fully closes
  every disposable Query before idle. Focused Query seam tests cover replay,
  correlation, identity failure, cancellation, and accounting; per-Run and
  32-repeat managed conformance are green. `npm run claude:steering-smoke` and
  `npm run claude:resume-smoke` are authenticated gates and print
  `CLAUDE_STEERING_LIVE_SMOKE_PASS` and `CLAUDE_RESUME_LIVE_SMOKE_PASS`.
- [x] **Phase 3 release means all three providers** — `npm run check` is the
  local gate. `npm run release:check` additionally runs the separate Codex,
  Pi, and Claude authenticated steering and resume commands. Provider failures,
  five-minute timeouts, forced cancellation probes, `SIGINT`/`SIGTERM`, and
  normal completion all converge on manager shutdown and provider cleanup.
