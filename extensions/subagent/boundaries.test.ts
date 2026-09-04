import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  listSourceFiles,
  readImportSpecifiers,
  readNamedImports,
  resolveRelativeSource,
  writeSourceFile,
} from "../../tools/import-specifiers.ts";

/**
 * The extension's import boundary: what may name what, enforced.
 *
 * Every rule below guards a property somebody can otherwise take away with one
 * `import` line. That is the test for whether a rule belongs here: not "is
 * this tidy" but "what breaks if this edge exists".
 *
 * M7 removed three rules with v1. The v1-import rule, the transitive v1 walk,
 * and the rule keeping Effect and v2 out of v1 all guarded the same thing — a
 * rewrite must not inherit the machinery it is replacing — and there is no v1
 * left to inherit from. Nothing that survived is about the migration; each
 * survivor is about the product.
 *
 * The **legacy profile field name** rule survives deliberately, and its job
 * changed. It used to keep v1's word out of v2; now it keeps the product's
 * vocabulary singular, which is why it is expressed as a scan of every file in
 * the tree whatever its extension rather than as an import check.
 * [ADR-0022](../../docs/adr/0022-v2-terminology-and-backend-field.md) reserves
 * the one compound that legitimately contains it. This file is the only place
 * in the tree that spells the legacy name, and it excludes itself from the
 * scan for exactly that reason.
 */

/**
 * The frontmatter field 1.x Profiles used to name `pi`, `claude`, or `codex`.
 *
 * The product understands only `backend`; a Profile still using this name
 * fails validation as an unrecognised field. See
 * `docs/v2/profile-backend-field-migration.md`.
 */
const LEGACY_BACKEND_FIELD = "harness";

/**
 * The one compound this tree is allowed to spell that contains the legacy name.
 *
 * ADR-0022 reserves `AgentHarness` for Pi's own native abstraction, so the
 * Pi adapter legitimately names that type. Removing the reserved
 * identifier before the scan keeps both rules true at once: the legacy profile
 * field name still appears nowhere, and the reserved name stays usable.
 */
const RESERVED_PI_ABSTRACTION = "AgentHarness";

const checkerFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(checkerFile), "..", "..");

/** How a violation names a file: repository-relative, so edges read as paths. */
function describe(file: string): string {
  return path.relative(repositoryRoot, file) || file;
}

export interface BoundaryGraph {
  /** Root of the extension tree. */
  readonly treeRoot: string;
  /** The extension entry point the transitive walk starts from. */
  readonly treeEntry: string;
  /** The plain-TypeScript domain module, which may import only itself. */
  readonly domainRoot: string;
  /** The backend contract module, which is Effect-typed but mechanism-free. */
  readonly contractRoot: string;
  /** The Pi adapter, where every Pi SDK session symbol is confined. */
  readonly piAdapterRoot: string;
  /** Test doubles and rigs for the Pi adapter, which may name its types. */
  readonly piTestingRoot: string;
  /** The Claude adapter, where the whole Claude SDK is confined. */
  readonly claudeAdapterRoot: string;
  /** Test doubles and rigs for the Claude adapter, which may name its types. */
  readonly claudeTestingRoot: string;
  /** The Codex adapter, where the App Server process and protocol are confined. */
  readonly codexAdapterRoot: string;
  /** Test doubles and rigs for the Codex adapter, which may name its types. */
  readonly codexTestingRoot: string;
  /** The Session runtime, where the supervisor and its services live. */
  readonly runtimeRoot: string;
  /**
   * The supervisor, which sequences lifecycles and holds no state of its own.
   *
   * The one file where a state holder would hide best: it is the module every
   * lifecycle change passes through, so a map added there looks local to
   * whatever was being changed. Naming it here makes "the supervisor is
   * stateless" a check rather than a review comment.
   */
  readonly supervisorFile: string;
  /** Pure prose and row formatting, which may name only the domain and Pi. */
  readonly presentationRoot: string;
  /** The `Subagents` façade, between presentation and the host. */
  readonly applicationRoot: string;
  /** The Pi host boundary: the one place that runs an Effect. */
  readonly hostRoot: string;
  /** The active widget, which observes and never delivers. */
  readonly widgetFile: string;
  /** The Session push sink, which owns notification delivery and landing. */
  readonly pushSinkFile: string;
  /**
   * The notification formatter, which depends on the domain notice alone.
   *
   * Narrower than the presentation rule above it: a presentation file may
   * name Pi's own packages for theming and width, and this one may not name
   * anything outside `domain/` and `presentation/`. That is what makes
   * "changing what a notice says touches no runtime module" checkable.
   */
  readonly notificationTextFile: string;
  /**
   * The delivery module and its test, which may not say what only the sink
   * knows.
   *
   * Two files rather than one, because the vocabulary a maintainer reads is as
   * much in the test's comments as in the module's: a test asserting that a
   * push "lands" would teach the wrong reading of `handedOff()` just as
   * effectively as a doc comment would.
   */
  readonly deliveryFiles: readonly string[];
  /** Test helpers, which are a test boundary and may run Effects. */
  readonly testingRoot: string;
  /** The checker itself, excluded from the legacy-name scan. */
  readonly checkerFile?: string;
}

const productionGraph: BoundaryGraph = {
  treeRoot: path.join(repositoryRoot, "extensions", "subagent"),
  treeEntry: path.join(repositoryRoot, "extensions", "subagent", "index.ts"),
  domainRoot: path.join(repositoryRoot, "extensions", "subagent", "domain"),
  contractRoot: path.join(repositoryRoot, "extensions", "subagent", "backend"),
  piAdapterRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "backend",
    "pi",
  ),
  piTestingRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "testing",
    "pi",
  ),
  claudeAdapterRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "backend",
    "claude",
  ),
  claudeTestingRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "testing",
    "claude",
  ),
  codexAdapterRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "backend",
    "codex",
  ),
  codexTestingRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "testing",
    "codex",
  ),
  runtimeRoot: path.join(repositoryRoot, "extensions", "subagent", "runtime"),
  supervisorFile: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "runtime",
    "supervisor.ts",
  ),
  presentationRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "presentation",
  ),
  applicationRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "application",
  ),
  hostRoot: path.join(repositoryRoot, "extensions", "subagent", "host"),
  widgetFile: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "host",
    "widget.ts",
  ),
  pushSinkFile: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "host",
    "push-sink.ts",
  ),
  notificationTextFile: path.join(
    repositoryRoot,
    "extensions",
    "subagent",
    "presentation",
    "notification-text.ts",
  ),
  deliveryFiles: [
    path.join(
      repositoryRoot,
      "extensions",
      "subagent",
      "runtime",
      "delivery.ts",
    ),
    path.join(
      repositoryRoot,
      "extensions",
      "subagent",
      "runtime",
      "delivery.test.ts",
    ),
  ],
  testingRoot: path.join(repositoryRoot, "extensions", "subagent", "testing"),
  checkerFile,
};

/** Every file under a tree, whatever its extension. */
function listTreeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...listTreeFiles(full));
      continue;
    }
    files.push(full);
  }
  return files.sort();
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/** The core package and every Effect ecosystem package. */
function isEffectPackage(specifier: string): boolean {
  return (
    specifier === "effect" ||
    specifier.startsWith("effect/") ||
    specifier === "@effect" ||
    specifier.startsWith("@effect/")
  );
}

/**
 * Provider SDKs, which no file may import outside its own adapter.
 *
 * Pi's own packages are deliberately not on this list: they are also the host
 * API this extension is written against, and the M0 entry point imports the
 * host types from them. Keeping them out of the neutral core is the job of the
 * domain and backend rules below, which admit no package specifier at all.
 *
 * M5 turned the blanket ban into a confinement, because one adapter now needs
 * one of these packages. The Claude SDK may be named inside
 * `backend/claude/` and nowhere else — not even by the adapter's own test
 * doubles, which take the SDK's types through the aliases the adapter
 * re-exports. That is stricter than the Pi rule has to be: Pi's package is
 * also the host API, so its rule is by binding, and Claude's package is a
 * provider and nothing else, so its rule is by specifier.
 */
const PROVIDER_SDK_PREFIXES = ["@anthropic-ai/", "@openai/"] as const;

function isProviderSdk(specifier: string): boolean {
  return PROVIDER_SDK_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

/**
 * The one package specifier the Claude adapter may name.
 *
 * The exact specifier rather than the `@anthropic-ai/` prefix, because the
 * exemption is for *this* SDK and not for the scope it happens to live in. A
 * prefix would silently admit any future package published under the same
 * scope, which is the opposite of a confinement.
 */
const CLAUDE_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

function mayImportProviderSdk(
  specifier: string,
  file: string,
  graph: BoundaryGraph,
): boolean {
  return (
    specifier === CLAUDE_SDK_SPECIFIER &&
    isInside(file, graph.claudeAdapterRoot)
  );
}

/**
 * The one package a domain production file may name, and the one binding it
 * may take from it.
 *
 * ADR-0029 replaced "the domain imports nothing" with this. The old rule was a
 * proxy: it was easy to check, and that was the only thing it had going for
 * it. What the rule is actually for is that the fold stays testable with no
 * runtime, no provider SDK reaches the core, and no runtime machinery appears
 * in the domain — and a schema declaration breaks none of those. Admitting the
 * binding by name, rather than the specifier, is what keeps the other Effect
 * bindings out.
 */
const DOMAIN_PACKAGE = "effect";
const DOMAIN_PACKAGE_BINDING = "Schema";

/**
 * The only package specifiers a domain *test* may name.
 *
 * A domain test is still domain code and must not reach for a runtime or an
 * SDK, but it does need a test runner and an assertion library, and neither
 * can be a relative import.
 */
const DOMAIN_TEST_PACKAGES = new Set([
  "node:test",
  "node:assert",
  "node:assert/strict",
]);

function isTestFile(file: string): boolean {
  return file.endsWith(".test.ts");
}

/**
 * Runtime mechanism vocabulary that belongs at the host boundary and in tests.
 *
 * The domain has no runtime in it at all, the backend contract expresses
 * lifetime with `Scope` and cancellation with interruption, and the Session
 * runtime runs *inside* an Effect rather than starting one — so an adapter is
 * never handed a signal to poll, and none of the three modules runs an Effect.
 * `Effect.runPromise` belongs at the host boundary, which is where a Pi
 * callback crosses into Effect and nowhere else.
 *
 * Tests are exempt: a test has to run the Effect it is testing, and the
 * contract's own shape test names these very words as forbidden.
 */
const MECHANISM_VOCABULARY = [
  "AbortController",
  "AbortSignal",
  "Effect.runPromise",
  "ManagedRuntime",
] as const;

/**
 * The two words a provider adapter may name, and where.
 *
 * The list above is about the *core*: the contract expresses cancellation as
 * interruption, so no module of the neutral runtime is ever handed a signal to
 * poll. A provider whose only cancellation surface is an `AbortController` is
 * exactly the case an adapter exists to absorb — the Claude SDK takes one on
 * its options bag and offers nothing else — so the adapter constructs one,
 * owns it for the Run, and aborts it in a scope finalizer.
 *
 * Admitting the two words **by directory** rather than dropping them from the
 * list is what keeps the rule doing its job: the core still cannot name them,
 * and `Effect.runPromise` and `ManagedRuntime` stay forbidden in the adapter
 * too, because an adapter that started its own runtime would be an adapter
 * that had stopped living inside the caller's Effect.
 */
const PROVIDER_CANCELLATION_VOCABULARY = new Set([
  "AbortController",
  "AbortSignal",
]);

function mayNameMechanism(
  mechanism: string,
  file: string,
  graph: BoundaryGraph,
): boolean {
  return (
    PROVIDER_CANCELLATION_VOCABULARY.has(mechanism) &&
    isInside(file, graph.claudeAdapterRoot)
  );
}

/**
 * Where the host boundary is.
 *
 * M3 makes the exit-gate rule checkable rather than reviewable: the host
 * module is the one place a Pi callback crosses into Effect, so it is the one
 * place that may run one, hold a managed runtime, or touch an abort signal.
 * Everything else in the production tree — the domain, the contract, the
 * runtime, presentation, the façade, Profile discovery — runs *inside* an
 * Effect and is scanned for the vocabulary above.
 *
 * The test helpers are exempt for the same reason tests are: a rig is where a
 * `node:test` callback crosses into Effect, which makes it a test boundary
 * rather than production code that reached for a runtime.
 */
function isHostBoundaryFile(file: string, graph: BoundaryGraph): boolean {
  return (
    file === graph.treeEntry ||
    isInside(file, graph.hostRoot) ||
    isInside(file, graph.testingRoot)
  );
}

/** Pi's own packages: the host API and the TUI primitives it ships. */
function isHostPackage(specifier: string): boolean {
  return specifier.startsWith("@earendil-works/");
}

/**
 * The schema library this tree does not use.
 *
 * ADR-0029 adopted Effect Schema, and the M2 spike cleared the last thing
 * that was keeping `typebox` alive here: emitting a JSON Schema
 * document the Pi host accepts for a tool's `parameters`. The dependency
 * itself stays in the manifest until v1 is deleted at M7, because v1 uses it —
 * so the rule that keeps it out has to be a check rather than the
 * absence of a dependency.
 */
const SECOND_SCHEMA_LIBRARY = "typebox";

/**
 * The word only the Session push sink may say.
 *
 * *Handed off* means the host accepted the message; *landed* means
 * `message_start` carried it into the conversation. Delivery can observe the
 * first and cannot observe the second, so the delivery module saying "landed"
 * would be a module claiming knowledge it does not have — and the reader who
 * believed it would treat a successful push as a notice the model has read.
 * See docs/v2-simplify/notification-semantics.md §1.
 *
 * Inflections are covered because the confusion is in the concept and not in
 * the suffix: "the notice lands", "an unlanded push", and "on landing" all
 * assert the same thing the sink alone can assert.
 */
const LANDING_VOCABULARY = /\b(un)?land(ed|ing|ings|s)?\b/i;

/**
 * The second word only the Session push sink may say.
 *
 * *Consumed* means the parent retrieved this Run's Result with
 * `agent_result`, which the sink is told by the tool handler and delivery
 * cannot observe at all. It is fenced for the reason *landed* is, and against
 * the same one wrong conclusion by a second door: a `handedOff` set explained
 * by a comment about the model having consumed the notice is a set whose next
 * reader treats an accepted push as an answer the model has read.
 *
 * The sink's own vocabulary is not covered, and neither is the `agent_result`
 * handler's — both are host files, and both are where the word belongs.
 */
const CONSUMPTION_VOCABULARY = /\bconsum(e|ed|es|ing|ption)\b/i;

/**
 * The one thing the two vocabulary scans do not read: a link's target.
 *
 * `[the decision](../../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md)`
 * carries both banned words in a file path, and a rule that fired on it would
 * be a rule forbidding delivery to cite the ADR that governs it. The property
 * being given up is nothing: these rules are about the *reading* a maintainer
 * takes away, and a path fragment is not a reading — the link text beside it
 * still is, and is still scanned.
 */
function withoutLinkTargets(source: string): string {
  return source.replace(/\]\([^)]*\)/g, "]()");
}

/**
 * The state constructions the supervisor may not contain.
 *
 * Phase B moved admission, the Subagent records, and the waiter ledger out of
 * `runtime/supervisor.ts`, each into a module that owns the invariant its
 * state carries. What that leaves is orchestration, and the way it comes back
 * is gradually: one more map, one more flag, each reasonable beside the
 * operation that needed it, until a question about capacity has five places
 * to be answered again. The contributor rules name "maps, flags,
 * `Promise.race`, or `AbortController` turning up in generic runtime code" as
 * the early signal of the old architecture returning, and this makes the
 * first of those a failing test for the one file where it would hide best.
 *
 * A content scan rather than an import check, for the same reason the delivery
 * vocabulary rule is one: nothing is imported to construct a `Map`, and the
 * thing being prevented is a state holder appearing rather than a dependency
 * being added.
 *
 * The `stages` trace array is **not** covered and is the documented
 * exception. It is a test hook the conformance suite reads instead of the
 * deleted driver's log — an append-only list of stage names that no operation
 * reads and no decision depends on. A rule that covered every array would
 * have to cover that one, and would then be a rule about tidiness.
 */
const STATE_CONSTRUCTIONS = ["Ref.make", "new Map", "new Set"] as const;

/**
 * The only files that may name a backend or a fake.
 *
 * "Only the composition root names backends" is the rule that keeps the host
 * from reaching around the runtime: a host handler that could import a
 * `Backend` could open one, and then two things would own BackendAgent
 * lifetime. Naming the files here makes each addition a deliberate edit where
 * the rule is written.
 */
const COMPOSITION_ROOT_FILES = new Set([
  "runtime/composition.ts",
  "host/demo-backends.ts",
  "host/pi-backends.ts",
  "host/production-backends.ts",
]);

function isCompositionRoot(file: string, graph: BoundaryGraph): boolean {
  return COMPOSITION_ROOT_FILES.has(
    path.relative(graph.treeRoot, file).split(path.sep).join("/"),
  );
}

/**
 * Runtime primitives, which the domain may not name at all.
 *
 * ADR-0029 admits `Schema` into the domain because a schema declaration is a
 * plain value. The other Effect bindings are the runtime, and the named-import
 * rule above already keeps them out of the import list — this catches the same
 * thing spelled a different way, such as a type annotation reached through a
 * relative re-export or a comment promising a `Layer` that a later edit would
 * then feel free to add.
 *
 * Matched as capitalized identifiers, so the prose "a queue overflow" and the
 * domain's own `queue-overflow` diagnostic category are not violations. They
 * are domain words; `Queue` is a runtime type.
 */
const RUNTIME_PRIMITIVES = [
  "Fiber",
  "Scope",
  "Queue",
  "Deferred",
  "Layer",
  "SubscriptionRef",
  "SynchronizedRef",
] as const;

function namesIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(source);
}

/**
 * The runtime files allowed to import `Layer`.
 *
 * ADR-0023's rule is that no Subagent, BackendAgent, or Run is a Layer, and
 * the way that rule is broken is gradually: one more `Layer.effect` in one
 * more module, each reasonable on its own. Naming the files that may wire one
 * makes each addition a deliberate edit here, where the rule is written, and
 * keeps the composition of the Session runtime readable in one place.
 *
 * Everything on this list is session-long by construction: the six services,
 * the module that wires them, and nothing else.
 */
const LAYER_MODULES = new Set([
  "composition.ts",
  "repository.ts",
  "result-store.ts",
  "backend-catalog.ts",
  "profile-catalog.ts",
  "supervisor.ts",
  "delivery.ts",
]);

/**
 * Pi's own SDK, as opposed to Pi's host API.
 *
 * The distinction is the whole reason this list exists rather than a package
 * ban. `@earendil-works/pi-coding-agent` is *both*: it exports the extension
 * API this product is written against — `ExtensionAPI`, `getAgentDir`, the
 * theme — and the native session machinery the Pi adapter drives. The first is
 * the host and belongs everywhere; the second is a provider and belongs in one
 * directory.
 *
 * So the rule is by binding, not by specifier: naming any of these outside the
 * Pi adapter is a violation, and naming `ExtensionAPI` is not. The two sibling
 * packages are provider-only, so those are banned by specifier.
 */
const PI_SESSION_SYMBOLS = new Set([
  // The native session and how one is made.
  "AgentSession",
  "AgentSessionConfig",
  "AgentSessionEvent",
  "AgentSessionEventListener",
  "createAgentSession",
  "CreateAgentSessionOptions",
  // What a session is constructed from.
  "createBashToolDefinition",
  "DefaultResourceLoader",
  "LoadExtensionsResult",
  "ModelRuntime",
  "ResourceLoader",
  "SessionManager",
  "SettingsManager",
  // Pi's message and event vocabulary, from either sibling package.
  "Agent",
  "AgentEvent",
  "AgentMessage",
  "AgentState",
  "AgentTool",
  "AssistantMessage",
  "AssistantMessageEvent",
  "ThinkingLevel",
  "ToolResultMessage",
  "UserMessage",
]);

/**
 * The tests outside the adapter's own directories that may name it.
 *
 * Named one by one, the way the composition root is, rather than admitted as a
 * class. "Any test may import the adapter" would be a hole rather than an
 * exception: a presentation test that imported it would pass, and the next
 * person to need a Pi fact in presentation would find a precedent for it.
 *
 * Every entry is a host test that is *about* the adapter facts — the
 * inert-in-child guard, the probes the diagnostics command reports, and the
 * production set's own contents — and none has anywhere else to get them.
 */
const PI_ADAPTER_TEST_IMPORTERS = new Set([
  "host/inert-guard.test.ts",
  "host/diagnostics-command.test.ts",
  "host/production-backends.test.ts",
]);

/**
 * Who may reach into the Pi adapter.
 *
 * The composition root wires the backend set, and the adapter's own code, its
 * test doubles, and the named tests above may name its types. Nothing else: a
 * runtime, presentation, application, or host module that could import the
 * adapter would be a module that could open a native session, and then two
 * things would own the handle.
 */
function mayImportPiAdapter(file: string, graph: BoundaryGraph): boolean {
  return (
    isCompositionRoot(file, graph) ||
    isInside(file, graph.piAdapterRoot) ||
    isInside(file, graph.piTestingRoot) ||
    PI_ADAPTER_TEST_IMPORTERS.has(
      path.relative(graph.treeRoot, file).split(path.sep).join("/"),
    )
  );
}

/**
 * The tests outside the Claude adapter's own directories that may name it.
 *
 * Named one by one, exactly as the Pi list is. Both entries are host tests
 * that are *about* the adapter — the two probes the diagnostics command
 * reports, and what the production set actually holds — and neither has
 * anywhere else to get them.
 */
const CLAUDE_ADAPTER_TEST_IMPORTERS = new Set([
  "host/diagnostics-command.test.ts",
  "host/production-backends.test.ts",
]);

/**
 * Who may reach into the Claude adapter.
 *
 * The same rule as Pi's, for the same reason: a runtime, presentation,
 * application, or host module that could import the adapter would be a module
 * that could start a Query, and then two things would own the Run's lifetime.
 */
function mayImportClaudeAdapter(file: string, graph: BoundaryGraph): boolean {
  return (
    isCompositionRoot(file, graph) ||
    isInside(file, graph.claudeAdapterRoot) ||
    isInside(file, graph.claudeTestingRoot) ||
    CLAUDE_ADAPTER_TEST_IMPORTERS.has(
      path.relative(graph.treeRoot, file).split(path.sep).join("/"),
    )
  );
}

/**
 * The tests outside the Codex adapter's own directories that may name it.
 *
 * Named one by one, exactly as the Pi and Claude lists are, and for the same
 * reason: "any test may import the adapter" would be a hole rather than an
 * exception. Both entries are host tests that are *about* the adapter — the
 * three probes the diagnostics command reports, and what the production set
 * actually holds — and neither has anywhere else to get them.
 */
const CODEX_ADAPTER_TEST_IMPORTERS = new Set([
  "host/diagnostics-command.test.ts",
  "host/production-backends.test.ts",
]);

/**
 * Who may reach into the Codex adapter.
 *
 * The same rule as Pi's and Claude's, for the same reason: a runtime,
 * presentation, application, or host module that could import the adapter
 * would be a module that could spawn an App Server, and then two things would
 * own a child process.
 */
function mayImportCodexAdapter(file: string, graph: BoundaryGraph): boolean {
  return (
    isCompositionRoot(file, graph) ||
    isInside(file, graph.codexAdapterRoot) ||
    isInside(file, graph.codexTestingRoot) ||
    CODEX_ADAPTER_TEST_IMPORTERS.has(
      path.relative(graph.treeRoot, file).split(path.sep).join("/"),
    )
  );
}

/**
 * The child-process package, which one directory may name.
 *
 * Confined by specifier rather than by binding, because — unlike Pi's package
 * — `node:child_process` is nothing but a process API. There is no host half
 * of it that belongs elsewhere, so the rule needs no exceptions: a module
 * outside the Codex adapter that could spawn a process would be a module that
 * could own one.
 */
const CHILD_PROCESS_PACKAGE = "node:child_process";

function isChildProcessPackage(specifier: string): boolean {
  return (
    specifier === CHILD_PROCESS_PACKAGE ||
    specifier.startsWith(`${CHILD_PROCESS_PACKAGE}/`)
  );
}

/**
 * The Codex vocabulary that stays inside the adapter, even from the
 * composition root.
 *
 * "Only the composition root may import the adapter" is not enough on its own
 * here. The composition root legitimately names `createCodexBackend` and the
 * adapter's probe, and if it could *also* name a transport, a JSON-RPC frame,
 * a notification, or a child process, then retained process state would have a
 * path into the module that wires the Session — which is exactly what the
 * roadmap's "retained process/thread state never enters generic repositories"
 * exit-gate item is about.
 *
 * So the confinement is by binding: these names may be imported inside
 * `backend/codex/` and by the adapter's own test doubles, which drive the real
 * wire, and nowhere else. What is deliberately *not* on the list is the small
 * public surface a backend set needs: the factory, the id, its options, the
 * probe, and the display name.
 */
const CODEX_CONFINED_SYMBOLS = new Set([
  // The transport, its frames, and the bounds it keeps.
  "CODEX_ESCALATION_MILLIS",
  "CODEX_MAX_LINE_LENGTH",
  "CODEX_METHOD_NOT_SUPPORTED",
  "CODEX_REQUEST_BUDGET_MILLIS",
  "CodexTransport",
  "CodexTransportOptions",
  "CodexTransportStart",
  "CodexFrame",
  "CodexRequestOutcome",
  "startCodexTransport",
  // The Subagent-scoped reader and its routing table.
  "CodexReader",
  "CodexRoute",
  "CodexRouter",
  "createCodexReader",
  "codexFrameTurnId",
  // The App Server protocol.
  "CodexItem",
  "CodexNotification",
  "CodexNotificationMethod",
  "CodexNotificationReading",
  "CodexParams",
  "CodexThreadParameters",
  "CodexTokenBreakdown",
  "CodexTurnStatus",
  "codexEchoedText",
  "decodeCodexItem",
  "initializeParams",
  "isCodexInitializeResult",
  "readCodexNotification",
  "readCodexThreadId",
  "readCodexTurnId",
  "threadStartParams",
  "turnInterruptParams",
  "turnStartParams",
  "turnSteerParams",
  // The child process.
  "CodexChildProcess",
  "CodexProcessExit",
  "CodexSignal",
  "CodexSpawn",
  "CodexSpawnRequest",
  "codexChildEnvironment",
  "codexSpawnRequest",
  "spawnCodexAppServer",
]);

function specifiersOf(file: string): string[] {
  return readImportSpecifiers(fs.readFileSync(file, "utf8"));
}

/**
 * Report every forbidden edge and every legacy-name occurrence in one pass.
 *
 * A graph parameter lets the regression tests below supply a disposable pair
 * of trees rather than mutating the working tree or faking the checker.
 */
export function findBoundaryViolations(
  graph: BoundaryGraph = productionGraph,
): string[] {
  const { treeRoot, treeEntry } = graph;
  const violations = new Set<string>();

  // 1. The production graph, reachable from the entry point.
  //
  //    Walking from the entry rather than scanning files flat is what catches
  //    an edge reached through a chain of modules outside the tree, and it is
  //    also what makes "reachable from production" a thing the rules below can
  //    be about. The v1-import rules it used to carry went with v1: there is no
  //    frozen tree left to inherit machinery from, and a rule about a directory
  //    that does not exist is a rule that can never fail.
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      visit(target);
    }
  };
  if (fs.existsSync(treeEntry)) visit(treeEntry);

  // 2. Every file in the tree, whatever its extension, for the legacy field
  //    name. "Nowhere in the tree" has to mean a Markdown note or a JSON
  //    fixture too, not only the TypeScript the import rules care about — and
  //    the rule's job since M7 is keeping the product's vocabulary singular
  //    rather than keeping a deleted implementation's word out.
  for (const file of listTreeFiles(treeRoot)) {
    if (file === graph.checkerFile) continue;
    const source = fs
      .readFileSync(file, "utf8")
      .replaceAll(RESERVED_PI_ABSTRACTION, "");
    if (source.toLowerCase().includes(LEGACY_BACKEND_FIELD)) {
      violations.add(
        `${describe(file)} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
      );
    }
  }

  // 3. The domain module holds meaning, not machinery. A production domain
  //    file may name another domain file and, from `effect`, only the `Schema`
  //    binding — checked at the named-import level, so `Effect`, `Layer`, and
  //    the rest are violations of the same import. Every other package
  //    specifier is a violation by construction rather than by enumeration. A
  //    domain test may additionally name the test runner and the assertion
  //    library, and may share relative test helpers with the rest of the tree.
  for (const file of listSourceFiles(graph.domainRoot, {
    includeTests: true,
  })) {
    const test = isTestFile(file);
    for (const edge of readNamedImports(fs.readFileSync(file, "utf8"))) {
      const target = resolveRelativeSource(file, edge.specifier);
      if (target) {
        // A test may share a relative helper with the rest of the tree; a
        // production file may name only another domain file.
        if (!test && !isInside(target, graph.domainRoot)) {
          violations.add(
            `${describe(file)} imports ${edge.specifier} from outside the domain module`,
          );
        }
        continue;
      }
      if (test && DOMAIN_TEST_PACKAGES.has(edge.specifier)) continue;
      if (edge.specifier !== DOMAIN_PACKAGE) {
        violations.add(
          test
            ? `${describe(file)} imports package ${edge.specifier}, which a domain test may not name`
            : `${describe(file)} imports ${edge.specifier} from outside the domain module`,
        );
        continue;
      }
      // The one-binding rule holds for a test too: a domain test exercises the
      // declarations it is about, and reaching for the runtime to do it would
      // be the first step towards a domain that needs one.
      for (const name of edge.names) {
        if (name === DOMAIN_PACKAGE_BINDING) continue;
        violations.add(
          `${describe(file)} imports ${name} from ${edge.specifier}, and a domain file may name only ${DOMAIN_PACKAGE_BINDING}`,
        );
      }
    }
  }

  // 4. Runtime mechanism vocabulary stays out of the neutral core and out of
  //    the Session runtime, and the runtime primitives stay out of the domain
  //    specifically — the contract names `Scope` on purpose, because lifetime
  //    is what it is about.
  for (const file of listSourceFiles(treeRoot, { includeTests: false })) {
    if (isHostBoundaryFile(file, graph)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const mechanism of MECHANISM_VOCABULARY) {
      if (!source.includes(mechanism)) continue;
      if (mayNameMechanism(mechanism, file, graph)) continue;
      violations.add(
        `${describe(file)} contains runtime mechanism vocabulary ${mechanism}`,
      );
    }
  }
  for (const file of listSourceFiles(graph.domainRoot, {
    includeTests: false,
  })) {
    const source = fs.readFileSync(file, "utf8");
    for (const primitive of RUNTIME_PRIMITIVES) {
      if (!namesIdentifier(source, primitive)) continue;
      violations.add(
        `${describe(file)} names the runtime primitive ${primitive}`,
      );
    }
  }

  // 5. `Layer` is confined to the composition module and the service
  //    definitions it wires. A Layer per Subagent, BackendAgent, or Run is the
  //    thing ADR-0023 forbids, and a runtime file that cannot import `Layer`
  //    cannot make one by accident.
  for (const file of listSourceFiles(graph.runtimeRoot, {
    includeTests: false,
  })) {
    if (LAYER_MODULES.has(path.basename(file))) continue;
    for (const edge of readNamedImports(fs.readFileSync(file, "utf8"))) {
      if (resolveRelativeSource(file, edge.specifier)) continue;
      if (!isEffectPackage(edge.specifier)) continue;
      if (!edge.names.includes("Layer") && !edge.names.includes("*")) continue;
      violations.add(
        `${describe(file)} imports Layer, which only the composition module and the services it wires may name`,
      );
    }
  }

  // 6. A provider SDK is named inside its own adapter directory and nowhere
  //    else. The Claude adapter names the Claude SDK; every other file,
  //    tests and test doubles included, names none.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      if (!isProviderSdk(specifier)) continue;
      if (mayImportProviderSdk(specifier, file, graph)) continue;
      violations.add(
        `${describe(file)} imports forbidden provider SDK ${specifier}`,
      );
    }
  }

  // 7. Presentation is prose, and prose has no dependencies. A presentation
  //    file may name another presentation file, the domain, and Pi's own
  //    packages — which is where the row measuring and the theme come from —
  //    and nothing else. Not the runtime, not a backend, not a fake, not even
  //    `effect`: a presentation module that could reach the repository would
  //    be one edit away from folding state, and v1's dispatcher ended up
  //    owning presentation state for exactly that reason.
  for (const file of listSourceFiles(graph.presentationRoot, {
    includeTests: true,
  })) {
    const test = isTestFile(file);
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (target) {
        if (isInside(target, graph.presentationRoot)) continue;
        if (isInside(target, graph.domainRoot)) continue;
        // A presentation *test* may share a fixture with the rest of the lane,
        // exactly as a domain test may. The rule is about what a production
        // renderer can reach; a fixture module living inside `presentation/`
        // would be a hole in it rather than an exception to it, which is why
        // the shared fixtures live in the test tree.
        if (test && isInside(target, graph.testingRoot)) continue;
        violations.add(
          `${describe(file)} imports ${describe(target)}, and a presentation file may name only the domain and Pi`,
        );
        continue;
      }
      if (isHostPackage(specifier)) continue;
      if (test && specifier.startsWith("node:")) continue;
      violations.add(
        `${describe(file)} imports package ${specifier}, and a presentation file may name only the domain and Pi`,
      );
    }
  }

  // 8. The application module is the façade: it maps decoded input to
  //     supervisor requests and outcomes to prose. So it may name the domain,
  //     the runtime's services, presentation, and Effect — and no Pi package,
  //     because a façade that knew the host would be the host.
  for (const file of listSourceFiles(graph.applicationRoot, {
    includeTests: true,
  })) {
    const test = isTestFile(file);
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (target) {
        if (
          isInside(target, graph.applicationRoot) ||
          isInside(target, graph.domainRoot) ||
          isInside(target, graph.presentationRoot) ||
          isInside(target, graph.runtimeRoot)
        ) {
          continue;
        }
        if (test && isInside(target, graph.testingRoot)) continue;
        violations.add(
          `${describe(file)} imports ${describe(target)}, which the application module may not name`,
        );
        continue;
      }
      if (isEffectPackage(specifier)) continue;
      if (test && specifier.startsWith("node:")) continue;
      violations.add(
        `${describe(file)} imports package ${specifier}, which the application module may not name`,
      );
    }
  }

  // 9. The host does not reach around the runtime. Every backend a Session
  //     has is named by the composition root and handed to the runtime; a
  //     host handler that could import a `Backend` could open one, and then
  //     two things would own BackendAgent lifetime.
  for (const file of [
    ...listSourceFiles(graph.hostRoot, { includeTests: false }),
    ...(fs.existsSync(treeEntry) ? [treeEntry] : []),
  ]) {
    if (isCompositionRoot(file, graph)) continue;
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      if (
        isInside(target, graph.contractRoot) ||
        isInside(target, graph.testingRoot)
      ) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, which only the composition root may name`,
        );
      }
    }
  }

  // 10. The runtime does not know the host exists. `CompletionDelivery`
  //     reaches its Session through the `NotificationSink` interface and
  //     nothing else, which is what let M3 supply the real Session push
  //     without changing delivery — and a runtime file that could import the
  //     host or presentation would be one edit away from taking that back.
  for (const file of listSourceFiles(graph.runtimeRoot, {
    includeTests: false,
  })) {
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      if (
        isInside(target, graph.hostRoot) ||
        isInside(target, graph.presentationRoot) ||
        isInside(target, graph.applicationRoot) ||
        isInside(target, graph.testingRoot)
      ) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and the runtime does not know the host exists`,
        );
      }
    }
  }

  // 11. One schema library. Every schema is declared with Effect Schema, and
  //     the dependency v1 still needs must not creep back in through a tool
  //     parameter document or a custom message payload.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      if (
        specifier === SECOND_SCHEMA_LIBRARY ||
        specifier.startsWith(`${SECOND_SCHEMA_LIBRARY}/`)
      ) {
        violations.add(
          `${describe(file)} imports ${specifier}, and this tree declares its schemas with Effect Schema alone`,
        );
      }
    }
  }

  // 12. Pi's SDK session vocabulary lives in the Pi adapter and nowhere else.
  //     Pi's *host* API is a different thing that happens to ship in the same
  //     package, so the rule is by binding rather than by package: naming
  //     `createAgentSession` outside the adapter is a violation and naming
  //     `ExtensionAPI` is not.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (isInside(file, graph.piAdapterRoot)) continue;
    for (const edge of readNamedImports(fs.readFileSync(file, "utf8"))) {
      if (!isHostPackage(edge.specifier)) continue;
      for (const name of edge.names) {
        if (!PI_SESSION_SYMBOLS.has(name) && name !== "*") continue;
        violations.add(
          `${describe(file)} imports ${name} from ${edge.specifier}, and Pi session symbols stay inside the Pi adapter`,
        );
      }
    }
  }

  // 13. The adapter stays behind the contract in both directions. Only the
  //     composition root and the adapter's own tests may reach into it, and it
  //     may not reach the runtime, the host, presentation, or the façade —
  //     which is what keeps "a backend change is an adapter-local change" a
  //     checkable claim rather than a hope.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (mayImportPiAdapter(file, graph)) continue;
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (target && isInside(target, graph.piAdapterRoot)) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and only the composition root may name the Pi adapter`,
        );
      }
    }
  }
  for (const file of listSourceFiles(graph.piAdapterRoot, {
    includeTests: false,
  })) {
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      if (
        isInside(target, graph.runtimeRoot) ||
        isInside(target, graph.hostRoot) ||
        isInside(target, graph.presentationRoot) ||
        isInside(target, graph.applicationRoot) ||
        isInside(target, graph.testingRoot)
      ) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and the Pi adapter lives behind the backend contract`,
        );
      }
    }
  }

  // 14. The same two directions for the Claude adapter. The sibling edge —
  //     one adapter naming the other — needs no rule of its own: rule 15's
  //     importer list does not admit the Claude adapter, so a Claude module
  //     reaching for Pi is already rejected there, and the reverse is rejected
  //     by this rule's own list.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (mayImportClaudeAdapter(file, graph)) continue;
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (target && isInside(target, graph.claudeAdapterRoot)) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and only the composition root may name the Claude adapter`,
        );
      }
    }
  }
  for (const file of listSourceFiles(graph.claudeAdapterRoot, {
    includeTests: false,
  })) {
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      if (
        isInside(target, graph.runtimeRoot) ||
        isInside(target, graph.hostRoot) ||
        isInside(target, graph.presentationRoot) ||
        isInside(target, graph.applicationRoot) ||
        isInside(target, graph.testingRoot)
      ) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and the Claude adapter lives behind the backend contract`,
        );
      }
    }
  }

  // 15. The same two directions for the Codex adapter.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (mayImportCodexAdapter(file, graph)) continue;
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (target && isInside(target, graph.codexAdapterRoot)) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and only the composition root may name the Codex adapter`,
        );
      }
    }
  }
  for (const file of listSourceFiles(graph.codexAdapterRoot, {
    includeTests: false,
  })) {
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      if (
        isInside(target, graph.runtimeRoot) ||
        isInside(target, graph.hostRoot) ||
        isInside(target, graph.presentationRoot) ||
        isInside(target, graph.applicationRoot) ||
        isInside(target, graph.testingRoot)
      ) {
        violations.add(
          `${describe(file)} imports ${describe(target)}, and the Codex adapter lives behind the backend contract`,
        );
      }
    }
  }

  // 16. A child process is spawned in one directory and nowhere else.
  //     The Codex adapter owns one per Subagent; a second module able to spawn
  //     one would be a second owner of a process nothing else can kill.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (isInside(file, graph.codexAdapterRoot)) continue;
    for (const specifier of specifiersOf(file)) {
      if (!isChildProcessPackage(specifier)) continue;
      violations.add(
        `${describe(file)} imports ${specifier}, and only the Codex adapter may spawn a child process`,
      );
    }
  }

  // 17. The App Server's own vocabulary — the transport, the reader's routing
  //     table, the protocol shapes, and the child-process types — stays inside
  //     the adapter and its test doubles. The composition root may name the
  //     factory, the id, the options, and the probe, and nothing else: a
  //     composition module that could name a JSON-RPC frame would be one edit
  //     from putting retained process state somewhere generic.
  for (const file of listSourceFiles(treeRoot, { includeTests: true })) {
    if (
      isInside(file, graph.codexAdapterRoot) ||
      isInside(file, graph.codexTestingRoot)
    ) {
      continue;
    }
    for (const edge of readNamedImports(fs.readFileSync(file, "utf8"))) {
      const target = resolveRelativeSource(file, edge.specifier);
      if (!target || !isInside(target, graph.codexAdapterRoot)) continue;
      for (const name of edge.names) {
        if (!CODEX_CONFINED_SYMBOLS.has(name) && name !== "*") continue;
        violations.add(
          `${describe(file)} imports ${name} from ${describe(target)}, and Codex App Server vocabulary stays inside the Codex adapter`,
        );
      }
    }
  }

  // 18. The widget observes; it does not deliver. A settled Run's row lasts
  //     until its completion notice lands, which is the push sink's fact — so
  //     the widget is handed two functions for it and may not name the sink or
  //     delivery itself. A widget that could import either could push a
  //     notification, and then two things would decide what the model is told.
  if (fs.existsSync(graph.widgetFile)) {
    const forbidden = new Set([
      graph.pushSinkFile,
      path.join(graph.runtimeRoot, "delivery.ts"),
    ]);
    for (const specifier of specifiersOf(graph.widgetFile)) {
      const target = resolveRelativeSource(graph.widgetFile, specifier);
      if (!target || !forbidden.has(target)) continue;
      violations.add(
        `${describe(graph.widgetFile)} imports ${describe(target)}, and the widget reads landing facts rather than owning delivery`,
      );
    }
  }

  // 19. Delivery does not say "landed", and does not say "consumed" either. It
  //     knows pending, handed off, and exhausted; the Session push sink knows
  //     the rest. This is a scan for two words rather than an import check
  //     because the mistake it prevents is a mistake of reading: a `handedOff`
  //     set introduced by a comment about landing — or about the model having
  //     consumed the notice — is a set whose next reader treats an accepted
  //     push as a notice the model has read. *Consumed* is the second door to
  //     that same conclusion, which is why it is fenced beside the first. The
  //     push sink's own `hasLanded`, `landed`, `unlanded`, `subscribe`, and
  //     `consumed` are correct and are not covered.
  for (const file of graph.deliveryFiles) {
    if (!fs.existsSync(file)) continue;
    const source = withoutLinkTargets(fs.readFileSync(file, "utf8"));
    const landing = LANDING_VOCABULARY.exec(source);
    if (landing) {
      violations.add(
        `${describe(file)} says "${landing[0]}", and only the Session push sink may say whether a notice landed`,
      );
    }
    const consumption = CONSUMPTION_VOCABULARY.exec(source);
    if (consumption) {
      violations.add(
        `${describe(file)} says "${consumption[0]}", and only the Session push sink may say whether the model has read a Result`,
      );
    }
  }

  // 20. The notification formatter depends on the domain notice and nothing
  //     else. Presentation as a whole may name Pi's packages, because a
  //     widget row has to measure a width and pick a theme colour; the notice
  //     is prose a *model* reads, so it needs neither. Fencing it this
  //     narrowly is what makes the compatibility matrix's claim checkable: a
  //     change to what a notice says provably touches no runtime module,
  //     because the file that says it cannot reach one.
  if (fs.existsSync(graph.notificationTextFile)) {
    for (const specifier of specifiersOf(graph.notificationTextFile)) {
      const target = resolveRelativeSource(
        graph.notificationTextFile,
        specifier,
      );
      if (
        target &&
        (isInside(target, graph.domainRoot) ||
          isInside(target, graph.presentationRoot))
      ) {
        continue;
      }
      violations.add(
        `${describe(graph.notificationTextFile)} imports ${target ? describe(target) : specifier}, and notification text depends on the domain notice alone`,
      );
    }
  }

  // 21. The supervisor holds no state of its own. Admission, the Subagent
  //     records, and the waiter ledger each own the state whose invariant they
  //     carry, and what is left in the supervisor is the order the operations
  //     happen in. A reference, a map, or a set constructed there would be a
  //     fourth owner with no invariant and no test, and it would read as local
  //     to whichever operation added it. The `stages` trace array is the
  //     documented exception: it is a test hook nothing reads back.
  if (fs.existsSync(graph.supervisorFile)) {
    const source = fs.readFileSync(graph.supervisorFile, "utf8");
    for (const construction of STATE_CONSTRUCTIONS) {
      if (!source.includes(construction)) continue;
      violations.add(
        `${describe(graph.supervisorFile)} constructs ${construction}, and the supervisor holds no state of its own`,
      );
    }
  }

  return [...violations].sort();
}

/** A disposable pair of trees laid out exactly like the real ones. */
function fixtureGraph(
  t: { after(fn: () => void): void },
  name: string,
): {
  graph: BoundaryGraph;
  write(relative: string, source: string): void;
} {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagent-boundary-${name}-`)),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const graph: BoundaryGraph = {
    treeRoot: path.join(fixtureRoot, "extensions", "subagent"),
    treeEntry: path.join(fixtureRoot, "extensions", "subagent", "index.ts"),
    domainRoot: path.join(fixtureRoot, "extensions", "subagent", "domain"),
    contractRoot: path.join(fixtureRoot, "extensions", "subagent", "backend"),
    piAdapterRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "backend",
      "pi",
    ),
    piTestingRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "testing",
      "pi",
    ),
    claudeAdapterRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "backend",
      "claude",
    ),
    claudeTestingRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "testing",
      "claude",
    ),
    codexAdapterRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "backend",
      "codex",
    ),
    codexTestingRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "testing",
      "codex",
    ),
    runtimeRoot: path.join(fixtureRoot, "extensions", "subagent", "runtime"),
    supervisorFile: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "runtime",
      "supervisor.ts",
    ),
    presentationRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "presentation",
    ),
    applicationRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "application",
    ),
    hostRoot: path.join(fixtureRoot, "extensions", "subagent", "host"),
    widgetFile: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "host",
      "widget.ts",
    ),
    pushSinkFile: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "host",
      "push-sink.ts",
    ),
    notificationTextFile: path.join(
      fixtureRoot,
      "extensions",
      "subagent",
      "presentation",
      "notification-text.ts",
    ),
    deliveryFiles: [
      path.join(
        fixtureRoot,
        "extensions",
        "subagent",
        "runtime",
        "delivery.ts",
      ),
      path.join(
        fixtureRoot,
        "extensions",
        "subagent",
        "runtime",
        "delivery.test.ts",
      ),
    ],
    testingRoot: path.join(fixtureRoot, "extensions", "subagent", "testing"),
  };
  return {
    graph,
    write: (relative, source) => writeSourceFile(fixtureRoot, relative, source),
  };
}

test("the legacy field name is rejected in a file of any kind, not only TypeScript", (t) => {
  const { graph, write } = fixtureGraph(t, "legacy-field-any-file");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/NOTES.md",
    `Set \`${LEGACY_BACKEND_FIELD}: claude\` in the profile.\n`,
  );
  write(
    "extensions/subagent/fixtures/profile.json",
    `{ "${LEGACY_BACKEND_FIELD}": "codex" }\n`,
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.treeRoot, "NOTES.md"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
    `${describe(path.join(graph.treeRoot, "fixtures", "profile.json"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
  ]);
});

test("a source containing the legacy backend field name is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "legacy-field");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/profile.ts",
    `export const field = "${LEGACY_BACKEND_FIELD}";\n`,
  );
  write(
    "extensions/subagent/profile.test.ts",
    `/** The ${LEGACY_BACKEND_FIELD} field is gone. */\nexport {};\n`,
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.treeRoot, "profile.test.ts"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
    `${describe(path.join(graph.treeRoot, "profile.ts"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
  ]);
});

test("the reserved Pi abstraction name is allowed, the legacy field name is not", (t) => {
  const { graph, write } = fixtureGraph(t, "reserved-name");
  write("extensions/subagent/index.ts", "export {};\n");
  // ADR-0022 reserves this name for Pi's own native abstraction.
  write(
    "extensions/subagent/pi-adapter.ts",
    `import type { ${RESERVED_PI_ABSTRACTION} } from "@earendil-works/pi-coding-agent";\nexport type Held = ${RESERVED_PI_ABSTRACTION};\n`,
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/pi-adapter.ts",
    `export const field = "${LEGACY_BACKEND_FIELD}";\n`,
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.treeRoot, "pi-adapter.ts"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
  ]);
});

test("comments and string literals are not import edges", (t) => {
  // The false-positive half of the parser's contract. A checker that flagged a
  // path mentioned in a comment would be a checker people learned to ignore.
  const { graph, write } = fixtureGraph(t, "syntax-only");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/runtime/repository.ts", "export {};\n");
  write(
    "extensions/subagent/presentation/rows.ts",
    [
      '// import "../runtime/repository.ts";',
      'const forbidden = "../runtime/repository.ts";',
      "void forbidden;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);
});

test("dynamic and require edges are checked like static imports", (t) => {
  // The parser's own property, and it needs a rule to demonstrate against:
  // a forbidden edge written as `await import` or `module.require` is still a
  // forbidden edge, and one that was only checked when spelled `import … from`
  // would be one line away from being uncheckable. Presentation reaching the
  // runtime is the rule used here because it is the one where the temptation
  // is real — a renderer that wanted one more figure.
  const { graph, write } = fixtureGraph(t, "dynamic");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/runtime/repository.ts", "export {};\n");
  write(
    "extensions/subagent/presentation/rows.ts",
    [
      'await import("../runtime/repository.ts");',
      'module.require("../runtime/repository.ts");',
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.presentationRoot, "rows.ts"))} imports ${describe(path.join(graph.runtimeRoot, "repository.ts"))}, and a presentation file may name only the domain and Pi`,
  ]);
});

test("a domain module importing a package other than effect is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-purity");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/domain/ids.ts", 'import "node:crypto";\n');
  write(
    "extensions/subagent/domain/profile.ts",
    'import "@earendil-works/pi-coding-agent";\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} imports node:crypto from outside the domain module`,
    `${describe(path.join(graph.domainRoot, "profile.ts"))} imports @earendil-works/pi-coding-agent from outside the domain module`,
  ]);
});

test("a domain module may take Schema from effect and nothing else", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-named-imports");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/domain/ids.ts",
    'import { Schema } from "effect";\nexport const Id = Schema.String;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/domain/reduce.ts",
    'import { Effect, Schema } from "effect";\nvoid Effect;\nvoid Schema;\n',
  );
  write(
    "extensions/subagent/domain/result.ts",
    'import * as effect from "effect";\nvoid effect;\n',
  );
  write(
    "extensions/subagent/domain/usage.ts",
    'import Effect from "effect";\nvoid Effect;\n',
  );
  write(
    "extensions/subagent/domain/endings.ts",
    'const it = await import("effect");\nvoid it;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "endings.ts"))} imports * from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} imports Effect from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "result.ts"))} imports * from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "usage.ts"))} imports default from effect, and a domain file may name only Schema`,
  ]);
});

test("a renamed import is judged by the name the module exports", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-renamed-import");
  write("extensions/subagent/index.ts", "export {};\n");
  // Renaming `Layer` to `S` hides it from a reader and from a rule that looked
  // at local bindings. Both rules still fire, because both read the name the
  // module exports.
  write(
    "extensions/subagent/domain/ids.ts",
    'import { Layer as S } from "effect";\nvoid S;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} imports Layer from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "ids.ts"))} names the runtime primitive Layer`,
  ]);
});

test("a domain module naming a runtime primitive is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-runtime-primitives");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/domain/reduce.ts",
    "export type Sink = Queue<string>;\n",
  );
  write(
    "extensions/subagent/domain/result.ts",
    "/** Held for the life of the Run Scope. */\nexport {};\n",
  );
  write(
    "extensions/subagent/domain/ids.ts",
    "declare const layer: Layer;\ndeclare const fiber: Fiber;\nvoid layer;\nvoid fiber;\n",
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} names the runtime primitive Fiber`,
    `${describe(path.join(graph.domainRoot, "ids.ts"))} names the runtime primitive Layer`,
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} names the runtime primitive Queue`,
    `${describe(path.join(graph.domainRoot, "result.ts"))} names the runtime primitive Scope`,
  ]);
});

test("the domain's own vocabulary is not a runtime primitive", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-vocabulary");
  write("extensions/subagent/index.ts", "export {};\n");
  // The diagnostic category and the prose around it are domain words. Only
  // the capitalized runtime type is machinery.
  write(
    "extensions/subagent/domain/diagnostics.ts",
    [
      "/** A diagnostic the core authored — a late event, a queue overflow. */",
      'export const categories = ["queue-overflow", "late-event"] as const;',
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);
});

test("a domain module importing a file outside the domain is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-reaches-out");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/backend/contract.ts", "export {};\n");
  write(
    "extensions/subagent/domain/reduce.ts",
    'import "../backend/contract.ts";\nimport "./ids.ts";\n',
  );
  write("extensions/subagent/domain/ids.ts", "export {};\n");

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} imports ../backend/contract.ts from outside the domain module`,
  ]);
});

test("a domain test may name the test runner but not a runtime", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-test-packages");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/testing/type-level.ts", "export {};\n");
  write(
    "extensions/subagent/domain/reduce.test.ts",
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import "../testing/type-level.ts";',
      "void assert;",
      "void test;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  // A domain test may exercise the declarations it is about, so `Schema` is
  // admitted on the same one-binding terms as a production file.
  write(
    "extensions/subagent/domain/schemas.test.ts",
    'import { Schema } from "effect";\nvoid Schema;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/domain/reduce.test.ts",
    'import { Effect } from "effect";\nimport "node:fs";\nvoid Effect;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "reduce.test.ts"))} imports Effect from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "reduce.test.ts"))} imports package node:fs, which a domain test may not name`,
  ]);
});

test("a runtime module outside the composition may not import Layer", (t) => {
  const { graph, write } = fixtureGraph(t, "layer-confinement");
  write("extensions/subagent/index.ts", "export {};\n");
  // The composition module and the services it wires may name it.
  write(
    "extensions/subagent/runtime/composition.ts",
    'import { Layer } from "effect";\nvoid Layer;\n',
  );
  write(
    "extensions/subagent/runtime/repository.ts",
    'import { Effect, Layer } from "effect";\nvoid Effect;\nvoid Layer;\n',
  );
  // A Run is not a service, so the module that owns one may not.
  write(
    "extensions/subagent/runtime/run-scope.ts",
    'import { Effect, Layer } from "effect";\nvoid Effect;\nvoid Layer;\n',
  );
  write(
    "extensions/subagent/runtime/mailbox.ts",
    'import * as effect from "effect";\nvoid effect;\n',
  );
  // Naming other Effect bindings is fine: only `Layer` is confined.
  write(
    "extensions/subagent/runtime/arbitration.ts",
    'import { Effect, Queue } from "effect";\nvoid Effect;\nvoid Queue;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "mailbox.ts"))} imports Layer, which only the composition module and the services it wires may name`,
    `${describe(path.join(graph.runtimeRoot, "run-scope.ts"))} imports Layer, which only the composition module and the services it wires may name`,
  ]);
});

test("any file importing a provider SDK is rejected, tests included", (t) => {
  const { graph, write } = fixtureGraph(t, "provider-sdk");
  write(
    "extensions/subagent/index.ts",
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );
  write(
    "extensions/subagent/backend/fake.test.ts",
    'import "@openai/some-sdk";\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.treeRoot, "backend", "fake.test.ts"))} imports forbidden provider SDK @openai/some-sdk`,
    `${describe(graph.treeEntry)} imports forbidden provider SDK @anthropic-ai/claude-agent-sdk`,
  ]);
});

test("mechanism vocabulary in the domain or the contract is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "mechanism-vocabulary");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/domain/reduce.ts",
    "export const cancel = new AbortController();\n",
  );
  write(
    "extensions/subagent/backend/contract.ts",
    "/** The adapter never sees an AbortSignal. */\nexport {};\n",
  );
  write(
    "extensions/subagent/backend/fake.ts",
    'import { Effect } from "effect";\nawait Effect.runPromise(Effect.void);\n',
  );

  assert.deepEqual(
    findBoundaryViolations(graph),
    [
      `${describe(path.join(graph.contractRoot, "contract.ts"))} contains runtime mechanism vocabulary AbortSignal`,
      `${describe(path.join(graph.contractRoot, "fake.ts"))} contains runtime mechanism vocabulary Effect.runPromise`,
      `${describe(path.join(graph.domainRoot, "reduce.ts"))} contains runtime mechanism vocabulary AbortController`,
    ].sort(),
  );
});

test("a runtime module running an Effect or polling a signal is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "runtime-mechanism");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/runtime/supervisor.ts",
    'import { Effect } from "effect";\nawait Effect.runPromise(Effect.void);\n',
  );
  write(
    "extensions/subagent/runtime/run-scope.ts",
    "export const stop = new AbortController();\n",
  );
  write(
    "extensions/subagent/runtime/mailbox.ts",
    "/** Never handed an AbortSignal. */\nexport {};\n",
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "mailbox.ts"))} contains runtime mechanism vocabulary AbortSignal`,
    `${describe(path.join(graph.runtimeRoot, "run-scope.ts"))} contains runtime mechanism vocabulary AbortController`,
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} contains runtime mechanism vocabulary Effect.runPromise`,
  ]);
});

test("a test may name mechanism vocabulary, because a test has to run things", (t) => {
  const { graph, write } = fixtureGraph(t, "mechanism-vocabulary-tests");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/backend/contract.test.ts",
    [
      'import { Effect } from "effect";',
      'const forbidden = ["AbortController", "AbortSignal"];',
      "await Effect.runPromise(Effect.void);",
      "void forbidden;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);
});

test("a presentation file importing the runtime, a backend, or a fake is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "presentation-edges");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/domain/index.ts", "export {};\n");
  write("extensions/subagent/runtime/repository.ts", "export {};\n");
  write("extensions/subagent/backend/contract.ts", "export {};\n");
  write("extensions/subagent/testing/fakes/backend.ts", "export {};\n");
  // Prose over the domain, painted with Pi's own primitives: allowed.
  write(
    "extensions/subagent/presentation/status.ts",
    [
      'import type {} from "../domain/index.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "void truncateToWidth;",
    ].join("\n"),
  );
  // A test may name the runner, the assertion library, and a shared fixture.
  write("extensions/subagent/testing/presentation-fixtures.ts", "export {};\n");
  write(
    "extensions/subagent/presentation/status.test.ts",
    [
      'import assert from "node:assert/strict";',
      'import "../testing/presentation-fixtures.ts";',
      "void assert;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  // A production presentation file may not, which is the half of the rule the
  // fixture exemption must not widen.
  write(
    "extensions/subagent/presentation/status.ts",
    [
      'import type {} from "../domain/index.ts";',
      'import "../testing/presentation-fixtures.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "void truncateToWidth;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.presentationRoot, "status.ts"))} imports ${describe(path.join(graph.testingRoot, "presentation-fixtures.ts"))}, and a presentation file may name only the domain and Pi`,
  ]);

  // Restore the good production file for the rejections below.
  write(
    "extensions/subagent/presentation/status.ts",
    [
      'import type {} from "../domain/index.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "void truncateToWidth;",
    ].join("\n"),
  );

  write(
    "extensions/subagent/presentation/rows.ts",
    'import "../runtime/repository.ts";\n',
  );
  write(
    "extensions/subagent/presentation/card.ts",
    'import "../backend/contract.ts";\nimport "../testing/fakes/backend.ts";\n',
  );
  // Not even Effect: presentation runs nothing.
  write(
    "extensions/subagent/presentation/prose.ts",
    'import { Effect } from "effect";\nvoid Effect;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.presentationRoot, "card.ts"))} imports ${describe(path.join(graph.contractRoot, "contract.ts"))}, and a presentation file may name only the domain and Pi`,
    `${describe(path.join(graph.presentationRoot, "card.ts"))} imports ${describe(path.join(graph.testingRoot, "fakes", "backend.ts"))}, and a presentation file may name only the domain and Pi`,
    `${describe(path.join(graph.presentationRoot, "prose.ts"))} imports package effect, and a presentation file may name only the domain and Pi`,
    `${describe(path.join(graph.presentationRoot, "rows.ts"))} imports ${describe(path.join(graph.runtimeRoot, "repository.ts"))}, and a presentation file may name only the domain and Pi`,
  ]);
});

test("an application file importing the host, a backend, or a Pi package is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "application-edges");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/domain/index.ts", "export {};\n");
  write("extensions/subagent/presentation/index.ts", "export {};\n");
  write("extensions/subagent/runtime/supervisor.ts", "export {};\n");
  write("extensions/subagent/backend/contract.ts", "export {};\n");
  write("extensions/subagent/host/tools.ts", "export {};\n");
  // The four edges the façade is allowed: domain, runtime, presentation, Effect.
  write(
    "extensions/subagent/application/subagents.ts",
    [
      'import { Effect } from "effect";',
      'import "../domain/index.ts";',
      'import "../presentation/index.ts";',
      'import "../runtime/supervisor.ts";',
      "void Effect;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/application/subagents.ts",
    [
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      'import "../backend/contract.ts";',
      'import "../host/tools.ts";',
      "export type Api = ExtensionAPI;",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} imports ${describe(path.join(graph.contractRoot, "contract.ts"))}, which the application module may not name`,
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} imports ${describe(path.join(graph.hostRoot, "tools.ts"))}, which the application module may not name`,
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} imports package @earendil-works/pi-coding-agent, which the application module may not name`,
  ]);
});

test("a host file importing a backend or a fake is rejected unless it is the composition root", (t) => {
  const { graph, write } = fixtureGraph(t, "host-composition-root");
  write("extensions/subagent/index.ts", 'import "./host/session.ts";\n');
  write("extensions/subagent/backend/contract.ts", "export {};\n");
  write("extensions/subagent/testing/fakes/backend.ts", "export {};\n");
  write("extensions/subagent/host/session.ts", "export {};\n");
  // The composition root supplies the demo backend set, so it names both.
  write(
    "extensions/subagent/host/demo-backends.ts",
    'import "../backend/contract.ts";\nimport "../testing/fakes/backend.ts";\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/host/session.ts",
    'import "../backend/contract.ts";\n',
  );
  write(
    "extensions/subagent/index.ts",
    'import "../subagent/host/session.ts";\nimport "./testing/fakes/backend.ts";\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "session.ts"))} imports ${describe(path.join(graph.contractRoot, "contract.ts"))}, which only the composition root may name`,
    `${describe(graph.treeEntry)} imports ${describe(path.join(graph.testingRoot, "fakes", "backend.ts"))}, which only the composition root may name`,
  ]);
});

test("the widget importing the push sink or delivery is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "widget-delivery");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  write(
    "extensions/subagent/host/push-sink.ts",
    "export const createSessionPushSink = () => ({});\n",
  );
  write("extensions/subagent/runtime/delivery.ts", "export const d = 1;\n");
  write(
    "extensions/subagent/host/widget.ts",
    [
      'import { createSessionPushSink } from "./push-sink.ts";',
      'import { d } from "../runtime/delivery.ts";',
      "export const widget = [createSessionPushSink, d];",
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "widget.ts"))} imports ${describe(path.join(graph.hostRoot, "push-sink.ts"))}, and the widget reads landing facts rather than owning delivery`,
    `${describe(path.join(graph.hostRoot, "widget.ts"))} imports ${describe(path.join(graph.runtimeRoot, "delivery.ts"))}, and the widget reads landing facts rather than owning delivery`,
  ]);
});

test("the notification formatter naming anything but the domain and presentation is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "notification-text-imports");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  write("extensions/subagent/domain/notification.ts", "export const n = 1;\n");
  write("extensions/subagent/presentation/status.ts", "export const s = 1;\n");
  write("extensions/subagent/runtime/repository.ts", "export const r = 1;\n");
  write(
    "extensions/subagent/presentation/notification-text.ts",
    [
      // The two it may name.
      'import { n } from "../domain/notification.ts";',
      'import { s } from "./status.ts";',
      // A runtime module, and a Pi package the rest of presentation may name.
      'import { r } from "../runtime/repository.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "export const text = [n, s, r, truncateToWidth];",
      "",
    ].join("\n"),
  );

  const formatter = describe(
    path.join(graph.presentationRoot, "notification-text.ts"),
  );
  const repository = describe(path.join(graph.runtimeRoot, "repository.ts"));
  assert.deepEqual(findBoundaryViolations(graph), [
    `${formatter} imports ${repository}, and a presentation file may name only the domain and Pi`,
    `${formatter} imports ${repository}, and notification text depends on the domain notice alone`,
    `${formatter} imports @earendil-works/pi-tui, and notification text depends on the domain notice alone`,
  ]);
});

test('the delivery module saying "landed" is rejected, and the push sink saying it is not', (t) => {
  const { graph, write } = fixtureGraph(t, "delivery-landing-vocabulary");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  // The sink is the one owner of the word, so its whole landing API is
  // written out here: a rule that fired on this file would be a rule that
  // took the vocabulary away from the component that has it.
  write(
    "extensions/subagent/host/push-sink.ts",
    [
      "export const hasLanded = () => false;",
      "export const landed = () => [];",
      "export const unlanded = () => [];",
      "export const onLanding = () => () => {};",
      "",
    ].join("\n"),
  );
  write(
    "extensions/subagent/runtime/delivery.ts",
    [
      "/** Ids that actually landed. */",
      "export const handedOff = () => [];",
      "",
    ].join("\n"),
  );
  write(
    "extensions/subagent/runtime/delivery.test.ts",
    [
      "// A push that is accepted lands, eventually.",
      "export const check = 1;",
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "delivery.test.ts"))} says "lands", and only the Session push sink may say whether a notice landed`,
    `${describe(path.join(graph.runtimeRoot, "delivery.ts"))} says "landed", and only the Session push sink may say whether a notice landed`,
  ]);
});

test('the delivery module saying "consumed" is rejected, and the push sink saying it is not', (t) => {
  const { graph, write } = fixtureGraph(t, "delivery-consumption-vocabulary");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  // The sink is the one owner of this word too, so its whole consumption API
  // is written out here: a rule that fired on this file would take the
  // vocabulary away from the component that has it.
  write(
    "extensions/subagent/host/push-sink.ts",
    [
      "/** The parent consumed this Run's Result. */",
      "export const consumed = () => {};",
      "export const consumedBeforeLanding = 0;",
      "",
    ].join("\n"),
  );
  write(
    "extensions/subagent/runtime/delivery.ts",
    [
      "// A push the model has consumed is not pushed again.",
      "export const handedOff = () => [];",
      "",
    ].join("\n"),
  );
  write(
    "extensions/subagent/runtime/delivery.test.ts",
    ["export const consumption = 1;", ""].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "delivery.test.ts"))} says "consumption", and only the Session push sink may say whether the model has read a Result`,
    `${describe(path.join(graph.runtimeRoot, "delivery.ts"))} says "consumed", and only the Session push sink may say whether the model has read a Result`,
  ]);
});

test("delivery may cite the ADR whose filename carries both banned words", (t) => {
  // The one exemption, and it is a narrow one: the link *target* is not read.
  // The link text is, which is what keeps the exemption from being a hole.
  const { graph, write } = fixtureGraph(t, "delivery-adr-citation");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  write(
    "extensions/subagent/runtime/delivery.ts",
    [
      "/**",
      " * [The decision](../../docs/adr/0035-completion-hand-off-resolves-on-landing-or-consumption.md).",
      " */",
      "export const handedOff = () => [];",
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);
});

test("delivery's own three states are not landing vocabulary", (t) => {
  const { graph, write } = fixtureGraph(t, "delivery-handoff-vocabulary");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  write(
    "extensions/subagent/runtime/delivery.ts",
    [
      "/** pending, handed off, exhausted — and nothing finer. */",
      "export const handedOff = () => [];",
      "export const exhausted = () => [];",
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);
});

test("a managed runtime or a signal outside the host module is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "host-boundary-vocabulary");
  // The host module is where a Pi callback crosses into Effect, so it is the
  // one place these words belong.
  write(
    "extensions/subagent/index.ts",
    'import "./host/session.ts";\nimport "./application/subagents.ts";\n',
  );
  write(
    "extensions/subagent/host/session.ts",
    [
      'import { Effect, ManagedRuntime } from "effect";',
      "export const stop = new AbortController();",
      "void ManagedRuntime;",
      "await Effect.runPromise(Effect.void);",
    ].join("\n"),
  );
  write("extensions/subagent/application/subagents.ts", "export {};\n");

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/application/subagents.ts",
    [
      'import { Effect, ManagedRuntime } from "effect";',
      "void ManagedRuntime;",
      "await Effect.runPromise(Effect.void);",
    ].join("\n"),
  );
  write(
    "extensions/subagent/presentation/rows.ts",
    "/** Never handed an AbortSignal. */\nexport {};\n",
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} contains runtime mechanism vocabulary Effect.runPromise`,
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} contains runtime mechanism vocabulary ManagedRuntime`,
    `${describe(path.join(graph.presentationRoot, "rows.ts"))} contains runtime mechanism vocabulary AbortSignal`,
  ]);
});

test("a runtime module importing the host, presentation, or the façade is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "runtime-knows-no-host");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/host/push-sink.ts", "export {};\n");
  write("extensions/subagent/presentation/index.ts", "export {};\n");
  write("extensions/subagent/application/subagents.ts", "export {};\n");
  write("extensions/subagent/domain/index.ts", "export {};\n");
  // The runtime reaching its own domain is the whole design.
  write(
    "extensions/subagent/runtime/delivery.ts",
    'import "../domain/index.ts";\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), []);

  write(
    "extensions/subagent/runtime/delivery.ts",
    'import "../host/push-sink.ts";\nimport "../presentation/index.ts";\n',
  );
  write(
    "extensions/subagent/runtime/supervisor.ts",
    'import "../application/subagents.ts";\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "delivery.ts"))} imports ${describe(path.join(graph.hostRoot, "push-sink.ts"))}, and the runtime does not know the host exists`,
    `${describe(path.join(graph.runtimeRoot, "delivery.ts"))} imports ${describe(path.join(graph.presentationRoot, "index.ts"))}, and the runtime does not know the host exists`,
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} imports ${describe(path.join(graph.applicationRoot, "subagents.ts"))}, and the runtime does not know the host exists`,
  ]);
});

test("the second schema library is rejected anywhere in the tree, tests included", (t) => {
  const { graph, write } = fixtureGraph(t, "second-schema-library");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/host/tool-schemas.ts",
    'import { Type } from "typebox";\nvoid Type;\n',
  );
  write(
    "extensions/subagent/host/tool-schemas.test.ts",
    'import { Value } from "typebox/value";\nvoid Value;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "tool-schemas.test.ts"))} imports typebox/value, and this tree declares its schemas with Effect Schema alone`,
    `${describe(path.join(graph.hostRoot, "tool-schemas.ts"))} imports typebox, and this tree declares its schemas with Effect Schema alone`,
  ]);
});

test("a Pi session symbol outside the adapter is rejected, its host API is not", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-symbols");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/host/widget.ts",
    'import { createAgentSession } from "@earendil-works/pi-coding-agent";\n' +
      "export const made = createAgentSession;\n",
  );
  write(
    "extensions/subagent/host/tools.ts",
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n' +
      "export type Api = ExtensionAPI;\n",
  );
  write(
    "extensions/subagent/backend/pi/agent.ts",
    'import { createAgentSession } from "@earendil-works/pi-coding-agent";\n' +
      "export const open = createAgentSession;\n",
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "widget.ts"))} imports createAgentSession from @earendil-works/pi-coding-agent, and Pi session symbols stay inside the Pi adapter`,
  ]);
});

test("a Pi message type outside the adapter is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-message-type");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/runtime/run-scope.ts",
    'import type { AgentMessage } from "@earendil-works/pi-agent-core";\n' +
      "export type Message = AgentMessage;\n",
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "run-scope.ts"))} imports AgentMessage from @earendil-works/pi-agent-core, and Pi session symbols stay inside the Pi adapter`,
  ]);
});

test("only the composition root may import the Pi adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-adapter-importers");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/backend/pi/index.ts", "export const pi = 1;\n");
  // Allowed: the composition root wires the set.
  write(
    "extensions/subagent/host/pi-backends.ts",
    'import { pi } from "../backend/pi/index.ts";\nexport const set = pi;\n',
  );
  // Allowed: the adapter's own test doubles.
  write(
    "extensions/subagent/testing/pi/stand-in-session.ts",
    'import { pi } from "../../backend/pi/index.ts";\nexport const held = pi;\n',
  );
  // Rejected: the runtime reaching around the contract.
  write(
    "extensions/subagent/runtime/repository.ts",
    'import { pi } from "../backend/pi/index.ts";\nexport const held = pi;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "repository.ts"))} imports ${describe(
      path.join(graph.piAdapterRoot, "index.ts"),
    )}, and only the composition root may name the Pi adapter`,
  ]);
});

test("being a test is not on its own permission to import the Pi adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-adapter-test-importers");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/backend/pi/index.ts", "export const pi = 1;\n");
  // A test *about* the adapter, in a module that has no business knowing it
  // exists. The rule names the two host tests that may; this is not one.
  write(
    "extensions/subagent/presentation/rows.test.ts",
    'import { pi } from "../backend/pi/index.ts";\nexport const row = pi;\n',
  );

  const violations = findBoundaryViolations(graph);

  assert.ok(
    violations.some((violation) =>
      violation.endsWith("only the composition root may name the Pi adapter"),
    ),
    `a presentation test reached the adapter unchallenged: ${JSON.stringify(violations)}`,
  );
});

test("the Pi adapter may not import the runtime, the host, or presentation", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-adapter-reach");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/runtime/policy.ts", "export const bound = 1;\n");
  write(
    "extensions/subagent/backend/pi/agent.ts",
    'import { bound } from "../../runtime/policy.ts";\nexport const used = bound;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.piAdapterRoot, "agent.ts"))} imports ${describe(
      path.join(graph.runtimeRoot, "policy.ts"),
    )}, and the Pi adapter lives behind the backend contract`,
  ]);
});

test("the Claude SDK is rejected outside the Claude adapter, and admitted inside it", (t) => {
  const { graph, write } = fixtureGraph(t, "claude-sdk-confinement");
  write("extensions/subagent/index.ts", "export {};\n");
  // Allowed: the adapter is the one place the SDK is named.
  write(
    "extensions/subagent/backend/claude/query.ts",
    'import type { Options } from "@anthropic-ai/claude-agent-sdk";\nexport type Held = Options;\n',
  );
  // Rejected: a test double reaching for the SDK rather than the adapter's own
  // re-exported aliases.
  write(
    "extensions/subagent/testing/claude/stand-in-query.ts",
    'import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";\nexport type Frame = SDKMessage;\n',
  );
  // Rejected: the runtime, which has never heard of a provider.
  write(
    "extensions/subagent/runtime/repository.ts",
    'import { query } from "@anthropic-ai/claude-agent-sdk";\nexport const held = query;\n',
  );
  // Rejected even in the adapter: the exemption is for *this* SDK, not for
  // the scope it happens to live in.
  write(
    "extensions/subagent/backend/claude/other.ts",
    'import Anthropic from "@anthropic-ai/sdk";\nexport const held = Anthropic;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(
      path.join(graph.claudeAdapterRoot, "other.ts"),
    )} imports forbidden provider SDK @anthropic-ai/sdk`,
    `${describe(
      path.join(graph.runtimeRoot, "repository.ts"),
    )} imports forbidden provider SDK @anthropic-ai/claude-agent-sdk`,
    `${describe(
      path.join(graph.claudeTestingRoot, "stand-in-query.ts"),
    )} imports forbidden provider SDK @anthropic-ai/claude-agent-sdk`,
  ]);
});

test("only the composition root may import the Claude adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "claude-adapter-importers");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/backend/claude/index.ts",
    "export const claude = 1;\n",
  );
  // Allowed: the composition root wires the set.
  write(
    "extensions/subagent/host/production-backends.ts",
    'import { claude } from "../backend/claude/index.ts";\nexport const set = claude;\n',
  );
  // Allowed: the adapter's own test doubles.
  write(
    "extensions/subagent/testing/claude/stand-in-query.ts",
    'import { claude } from "../../backend/claude/index.ts";\nexport const held = claude;\n',
  );
  // Rejected: the façade reaching around the contract.
  write(
    "extensions/subagent/application/subagents.ts",
    'import { claude } from "../backend/claude/index.ts";\nexport const held = claude;\n',
  );

  const violations = findBoundaryViolations(graph);

  assert.ok(
    violations.includes(
      `${describe(
        path.join(graph.applicationRoot, "subagents.ts"),
      )} imports ${describe(
        path.join(graph.claudeAdapterRoot, "index.ts"),
      )}, and only the composition root may name the Claude adapter`,
    ),
    `the façade reached the adapter unchallenged: ${JSON.stringify(violations)}`,
  );
});

test("the two adapters are siblings and neither may name the other", (t) => {
  const { graph, write } = fixtureGraph(t, "claude-adapter-reach");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/backend/pi/depth.ts", "export const key = 1;\n");
  write("extensions/subagent/runtime/policy.ts", "export const bound = 1;\n");
  write(
    "extensions/subagent/backend/claude/options.ts",
    'import { key } from "../pi/depth.ts";\nexport const used = key;\n',
  );
  write(
    "extensions/subagent/backend/claude/agent.ts",
    'import { bound } from "../../runtime/policy.ts";\nexport const used = bound;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.claudeAdapterRoot, "agent.ts"))} imports ${describe(
      path.join(graph.runtimeRoot, "policy.ts"),
    )}, and the Claude adapter lives behind the backend contract`,
    // The sibling edge is caught by the Pi rule, whose importer list does not
    // admit the Claude adapter. One rule, one violation, either direction.
    `${describe(path.join(graph.claudeAdapterRoot, "options.ts"))} imports ${describe(
      path.join(graph.piAdapterRoot, "depth.ts"),
    )}, and only the composition root may name the Pi adapter`,
  ]);
});

test("the provider's cancellation primitive is admitted in the Claude adapter and nowhere else", (t) => {
  const { graph, write } = fixtureGraph(t, "claude-abort-controller");
  write("extensions/subagent/index.ts", "export {};\n");
  // Allowed: the SDK takes an AbortController and offers nothing else, so the
  // adapter owns one per Run.
  write(
    "extensions/subagent/backend/claude/execution.ts",
    "export const abort = new AbortController();\n",
  );
  // Rejected even in the adapter: an adapter that started its own runtime
  // would have stopped living inside the caller's Effect.
  write(
    "extensions/subagent/backend/claude/agent.ts",
    "export const run = () => Effect.runPromise;\n",
  );
  // Rejected: the runtime is handed interruption, never a signal to poll.
  write(
    "extensions/subagent/runtime/repository.ts",
    "export const held = (signal: AbortSignal) => signal;\n",
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(
      path.join(graph.claudeAdapterRoot, "agent.ts"),
    )} contains runtime mechanism vocabulary Effect.runPromise`,
    `${describe(
      path.join(graph.runtimeRoot, "repository.ts"),
    )} contains runtime mechanism vocabulary AbortSignal`,
  ]);
});

test("only the composition root may import the Codex adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "codex-adapter-importers");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/backend/codex/index.ts",
    "export const codex = 1;\n",
  );
  // Allowed: the composition root wires the set.
  write(
    "extensions/subagent/host/production-backends.ts",
    'import { codex } from "../backend/codex/index.ts";\nexport const set = codex;\n',
  );
  // Allowed: the adapter's own test doubles, which drive the real wire.
  write(
    "extensions/subagent/testing/codex/stand-in-app-server.ts",
    'import { codex } from "../../backend/codex/index.ts";\nexport const held = codex;\n',
  );
  // Rejected: the runtime reaching around the contract.
  write(
    "extensions/subagent/runtime/supervisor.ts",
    'import { codex } from "../backend/codex/index.ts";\nexport const held = codex;\n',
  );

  const violations = findBoundaryViolations(graph);

  assert.ok(
    violations.includes(
      `${describe(
        path.join(graph.runtimeRoot, "supervisor.ts"),
      )} imports ${describe(
        path.join(graph.codexAdapterRoot, "index.ts"),
      )}, and only the composition root may name the Codex adapter`,
    ),
    `the runtime reached the adapter unchallenged: ${JSON.stringify(violations)}`,
  );
});

test("the Codex adapter may not import the runtime, the host, or presentation", (t) => {
  const { graph, write } = fixtureGraph(t, "codex-adapter-reach");
  write("extensions/subagent/index.ts", "export {};\n");
  write("extensions/subagent/runtime/policy.ts", "export const bound = 1;\n");
  write(
    "extensions/subagent/backend/codex/agent.ts",
    'import { bound } from "../../runtime/policy.ts";\nexport const used = bound;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.codexAdapterRoot, "agent.ts"))} imports ${describe(
      path.join(graph.runtimeRoot, "policy.ts"),
    )}, and the Codex adapter lives behind the backend contract`,
  ]);
});

test("a child process is spawned in the Codex adapter and nowhere else", (t) => {
  const { graph, write } = fixtureGraph(t, "codex-child-process");
  write("extensions/subagent/index.ts", "export {};\n");
  // Allowed: the one directory that owns an App Server.
  write(
    "extensions/subagent/backend/codex/process.ts",
    'import { spawn } from "node:child_process";\nexport const held = spawn;\n',
  );
  // Rejected: the host growing a second process owner.
  write(
    "extensions/subagent/host/session.ts",
    'import { spawn } from "node:child_process";\nexport const held = spawn;\n',
  );
  // Rejected: a test double is not permission to spawn one either.
  write(
    "extensions/subagent/testing/codex/stand-in-app-server.ts",
    'import { spawn } from "node:child_process";\nexport const held = spawn;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(
      path.join(graph.hostRoot, "session.ts"),
    )} imports node:child_process, and only the Codex adapter may spawn a child process`,
    `${describe(
      path.join(graph.codexTestingRoot, "stand-in-app-server.ts"),
    )} imports node:child_process, and only the Codex adapter may spawn a child process`,
  ]);
});

test("App Server protocol and transport vocabulary stays inside the Codex adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "codex-protocol-confinement");
  write("extensions/subagent/index.ts", "export {};\n");
  write(
    "extensions/subagent/backend/codex/index.ts",
    "export const createCodexBackend = 1;\nexport const CodexTransport = 2;\nexport const turnStartParams = 3;\n",
  );
  // Allowed: the composition root names the factory and nothing else.
  write(
    "extensions/subagent/host/production-backends.ts",
    'import { createCodexBackend } from "../backend/codex/index.ts";\nexport const set = createCodexBackend;\n',
  );
  // Allowed: the adapter's own test doubles speak the wire.
  write(
    "extensions/subagent/testing/codex/stand-in-app-server.ts",
    'import { turnStartParams } from "../../backend/codex/index.ts";\nexport const held = turnStartParams;\n',
  );
  // Rejected: the composition root reaching for the transport itself.
  write(
    "extensions/subagent/runtime/composition.ts",
    'import { CodexTransport } from "../backend/codex/index.ts";\nexport const held = CodexTransport;\n',
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(
      path.join(graph.runtimeRoot, "composition.ts"),
    )} imports CodexTransport from ${describe(
      path.join(graph.codexAdapterRoot, "index.ts"),
    )}, and Codex App Server vocabulary stays inside the Codex adapter`,
  ]);
});

test("a supervisor constructing a reference, a map, or a set is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "stateless-supervisor");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  write(
    "extensions/subagent/runtime/supervisor.ts",
    [
      'import { Ref } from "effect";',
      "export const admission = Ref.make({ activeRuns: 0 });",
      "export const subagents = new Map();",
      "export const running = new Set();",
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} constructs Ref.make, and the supervisor holds no state of its own`,
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} constructs new Map, and the supervisor holds no state of its own`,
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} constructs new Set, and the supervisor holds no state of its own`,
  ]);
});

test("the supervisor's trace array is the documented exception, and another runtime module may hold state", (t) => {
  const { graph, write } = fixtureGraph(t, "stateless-supervisor-exception");
  write("extensions/subagent/index.ts", "export const entry = 1;\n");
  write(
    "extensions/subagent/runtime/supervisor.ts",
    [
      "/** Hooks the conformance suite reads instead of the deleted driver's log. */",
      "export const stages: string[] = [];",
      "export const trace = (stage: string) => stages.push(stage);",
      "",
    ].join("\n"),
  );
  // The rule is about one file, because the point is not that state is bad —
  // it is that the state each module owns should be owned by the module whose
  // invariant it carries, and those modules are where the maps belong.
  write(
    "extensions/subagent/runtime/admission.ts",
    [
      'import { Ref } from "effect";',
      "export const state = Ref.make({ running: new Set() });",
      "",
    ].join("\n"),
  );

  assert.deepEqual(findBoundaryViolations(graph), []);
});

test("the real tree holds every rule", () => {
  assert.deepEqual(findBoundaryViolations(), []);
});
