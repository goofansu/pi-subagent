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
 * The v2 import boundary.
 *
 * v2 is a rewrite, not a fork: it must not inherit v1 lifecycle machinery by
 * accident, v1 must stay free of Effect and of any dependency on v2, and the
 * legacy profile field name must never appear in the v2 tree. This file is the
 * only place in v2 that spells that legacy name, and it excludes itself from
 * the scan for exactly that reason.
 *
 * Later v2 import rules (adapter confinement) belong here too. M0 added the v1
 * and Effect edges; M1 added the rules that keep provider SDKs out of the tree
 * entirely; M2 replaces the domain's "no package specifiers at all" rule with
 * the named-import check ADR-0029 asks for, which is stricter because it
 * checks the properties the rule is *for* rather than a proxy for them.
 */

/**
 * The frontmatter field v1 profiles use to name `pi`, `claude`, or `codex`.
 * v2 understands only `backend`; a profile still using this name fails v2
 * validation as an unrecognized field. See
 * `docs/v2/profile-backend-field-migration.md`.
 */
const LEGACY_BACKEND_FIELD = "harness";

/**
 * The one compound v2 is allowed to spell that contains the legacy name.
 *
 * ADR-0022 reserves `AgentHarness` for Pi's own native abstraction, so the v2
 * Pi adapter will legitimately name that type. Removing the reserved
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

export interface V2BoundaryGraph {
  /** Root of the frozen v1 extension tree. */
  readonly v1Root: string;
  /** Root of the v2 extension tree. */
  readonly v2Root: string;
  /** The v2 extension entry point the transitive walk starts from. */
  readonly v2Entry: string;
  /** The plain-TypeScript domain module, which may import only itself. */
  readonly domainRoot: string;
  /** The backend contract module, which is Effect-typed but mechanism-free. */
  readonly contractRoot: string;
  /** The Pi adapter, where every Pi SDK session symbol is confined. */
  readonly piAdapterRoot: string;
  /** Test doubles and rigs for the Pi adapter, which may name its types. */
  readonly piTestingRoot: string;
  /** The Session runtime, where the supervisor and its services live. */
  readonly runtimeRoot: string;
  /** Pure prose and row formatting, which may name only the domain and Pi. */
  readonly presentationRoot: string;
  /** The `Subagents` façade, between presentation and the host. */
  readonly applicationRoot: string;
  /** The Pi host boundary: the one place that runs an Effect. */
  readonly hostRoot: string;
  /** Test helpers, which are a test boundary and may run Effects. */
  readonly testingRoot: string;
  /** The checker itself, excluded from the legacy-name scan. */
  readonly checkerFile?: string;
}

const productionGraph: V2BoundaryGraph = {
  v1Root: path.join(repositoryRoot, "extensions", "subagent"),
  v2Root: path.join(repositoryRoot, "extensions", "subagent-v2"),
  v2Entry: path.join(repositoryRoot, "extensions", "subagent-v2", "index.ts"),
  domainRoot: path.join(repositoryRoot, "extensions", "subagent-v2", "domain"),
  contractRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "backend",
  ),
  piAdapterRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "backend",
    "pi",
  ),
  piTestingRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "testing",
    "pi",
  ),
  runtimeRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "runtime",
  ),
  presentationRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "presentation",
  ),
  applicationRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "application",
  ),
  hostRoot: path.join(repositoryRoot, "extensions", "subagent-v2", "host"),
  testingRoot: path.join(
    repositoryRoot,
    "extensions",
    "subagent-v2",
    "testing",
  ),
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
 * Provider SDKs, which no v2 file may import before the adapter milestones.
 *
 * Pi's own packages are deliberately not on this list: they are also the host
 * API this extension is written against, and the M0 entry point imports the
 * host types from them. Keeping them out of the neutral core is the job of the
 * domain and backend rules below, which admit no package specifier at all.
 */
const PROVIDER_SDK_PREFIXES = ["@anthropic-ai/", "@openai/"] as const;

function isProviderSdk(specifier: string): boolean {
  return PROVIDER_SDK_PREFIXES.some((prefix) => specifier.startsWith(prefix));
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
function isHostBoundaryFile(file: string, graph: V2BoundaryGraph): boolean {
  return (
    file === graph.v2Entry ||
    isInside(file, graph.hostRoot) ||
    isInside(file, graph.testingRoot)
  );
}

/** Pi's own packages: the host API and the TUI primitives it ships. */
function isHostPackage(specifier: string): boolean {
  return specifier.startsWith("@earendil-works/");
}

/**
 * The schema library v2 does not use.
 *
 * ADR-0029 adopted Effect Schema for v2, and the M2 spike cleared the last
 * thing that was keeping `typebox` alive in v2: emitting a JSON Schema
 * document the Pi host accepts for a tool's `parameters`. The dependency
 * itself stays in the manifest until v1 is deleted at M7, because v1 uses it —
 * so the rule that keeps it out of v2 has to be a check rather than the
 * absence of a dependency.
 */
const SECOND_SCHEMA_LIBRARY = "typebox";

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
]);

function isCompositionRoot(file: string, graph: V2BoundaryGraph): boolean {
  return COMPOSITION_ROOT_FILES.has(
    path.relative(graph.v2Root, file).split(path.sep).join("/"),
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
 * Both entries are host tests that are *about* the Pi facts — the inert-in-
 * child guard and the adapter probe the diagnostics command reports — and
 * neither has anywhere else to get them.
 */
const PI_ADAPTER_TEST_IMPORTERS = new Set([
  "host/inert-guard.test.ts",
  "host/diagnostics-command.test.ts",
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
function mayImportPiAdapter(file: string, graph: V2BoundaryGraph): boolean {
  return (
    isCompositionRoot(file, graph) ||
    isInside(file, graph.piAdapterRoot) ||
    isInside(file, graph.piTestingRoot) ||
    PI_ADAPTER_TEST_IMPORTERS.has(
      path.relative(graph.v2Root, file).split(path.sep).join("/"),
    )
  );
}

function specifiersOf(file: string): string[] {
  return readImportSpecifiers(fs.readFileSync(file, "utf8"));
}

/**
 * Report every forbidden edge and every legacy-name occurrence in one pass.
 *
 * A graph parameter lets the regression tests below supply a disposable pair
 * of trees rather than mutating the working tree or faking the checker.
 */
export function findV2BoundaryViolations(
  graph: V2BoundaryGraph = productionGraph,
): string[] {
  const { v1Root, v2Root, v2Entry } = graph;
  const violations = new Set<string>();

  const recordV1Import = (importer: string, target: string): void => {
    violations.add(
      `${describe(importer)} imports forbidden v1 module ${describe(target)}`,
    );
  };

  // 1. The v2 runtime graph. Walking from the entry point catches a v1 module
  //    reached through a chain of modules outside both trees, which a flat
  //    per-file scan of v2 alone would miss.
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (!target) continue;
      if (isInside(target, v1Root)) {
        recordV1Import(file, target);
        continue;
      }
      visit(target);
    }
  };
  if (fs.existsSync(v2Entry)) visit(v2Entry);

  // 2. Every v2 TypeScript source, tests and all. A v2 test is not reachable
  //    from the entry point but is still v2 code, and still must not reach
  //    into v1.
  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (target && isInside(target, v1Root)) recordV1Import(file, target);
    }
  }

  // 3. Every file in the v2 tree, whatever its extension, for the legacy
  //    field name. "Nowhere in the v2 tree" has to mean a Markdown note or a
  //    JSON fixture too, not only the TypeScript the import rules care about.
  for (const file of listTreeFiles(v2Root)) {
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

  // 4. The domain module holds meaning, not machinery. A production domain
  //    file may name another domain file and, from `effect`, only the `Schema`
  //    binding — checked at the named-import level, so `Effect`, `Layer`, and
  //    the rest are violations of the same import. Every other package
  //    specifier is a violation by construction rather than by enumeration. A
  //    domain test may additionally name the test runner and the assertion
  //    library, and may share relative test helpers with the rest of v2.
  for (const file of listSourceFiles(graph.domainRoot, {
    includeTests: true,
  })) {
    const test = isTestFile(file);
    for (const edge of readNamedImports(fs.readFileSync(file, "utf8"))) {
      const target = resolveRelativeSource(file, edge.specifier);
      if (target) {
        // A test may share a relative helper with the rest of v2; a
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

  // 5. Runtime mechanism vocabulary stays out of the neutral core and out of
  //    the Session runtime, and the runtime primitives stay out of the domain
  //    specifically — the contract names `Scope` on purpose, because lifetime
  //    is what it is about.
  for (const file of listSourceFiles(v2Root, { includeTests: false })) {
    if (isHostBoundaryFile(file, graph)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const mechanism of MECHANISM_VOCABULARY) {
      if (!source.includes(mechanism)) continue;
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

  // 6. `Layer` is confined to the composition module and the service
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

  // 7. No v2 file reaches a provider SDK before the adapter milestones.
  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      if (isProviderSdk(specifier)) {
        violations.add(
          `${describe(file)} imports forbidden provider SDK ${specifier}`,
        );
      }
    }
  }

  // 8. The freeze runs in both directions: v1 gains neither Effect nor a
  //    dependency on the tree that is replacing it.
  for (const file of listSourceFiles(v1Root, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      if (isEffectPackage(specifier)) {
        violations.add(
          `${describe(file)} imports forbidden package ${specifier}`,
        );
        continue;
      }
      const target = resolveRelativeSource(file, specifier);
      if (target && isInside(target, v2Root)) {
        violations.add(
          `${describe(file)} imports forbidden v2 module ${describe(target)}`,
        );
      }
    }
  }

  // 9. Presentation is prose, and prose has no dependencies. A presentation
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

  // 10. The application module is the façade: it maps decoded input to
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

  // 11. The host does not reach around the runtime. Every backend a Session
  //     has is named by the composition root and handed to the runtime; a
  //     host handler that could import a `Backend` could open one, and then
  //     two things would own BackendAgent lifetime.
  for (const file of [
    ...listSourceFiles(graph.hostRoot, { includeTests: false }),
    ...(fs.existsSync(v2Entry) ? [v2Entry] : []),
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

  // 12. The runtime does not know the host exists. `CompletionDelivery`
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

  // 13. One schema library. v2 declares every schema with Effect Schema, and
  //     the dependency v1 still needs must not creep back in through a tool
  //     parameter document or a custom message payload.
  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      if (
        specifier === SECOND_SCHEMA_LIBRARY ||
        specifier.startsWith(`${SECOND_SCHEMA_LIBRARY}/`)
      ) {
        violations.add(
          `${describe(file)} imports ${specifier}, and v2 declares its schemas with Effect Schema alone`,
        );
      }
    }
  }

  // 14. Pi's SDK session vocabulary lives in the Pi adapter and nowhere else.
  //     Pi's *host* API is a different thing that happens to ship in the same
  //     package, so the rule is by binding rather than by package: naming
  //     `createAgentSession` outside the adapter is a violation and naming
  //     `ExtensionAPI` is not.
  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
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

  // 15. The adapter stays behind the contract in both directions. Only the
  //     composition root and the adapter's own tests may reach into it, and it
  //     may not reach the runtime, the host, presentation, or the façade —
  //     which is what keeps "a backend change is an adapter-local change" a
  //     checkable claim rather than a hope.
  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
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

  return [...violations].sort();
}

/** A disposable pair of trees laid out exactly like the real ones. */
function fixtureGraph(
  t: { after(fn: () => void): void },
  name: string,
): {
  graph: V2BoundaryGraph;
  write(relative: string, source: string): void;
} {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagent-v2-boundary-${name}-`)),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const graph: V2BoundaryGraph = {
    v1Root: path.join(fixtureRoot, "extensions", "subagent"),
    v2Root: path.join(fixtureRoot, "extensions", "subagent-v2"),
    v2Entry: path.join(fixtureRoot, "extensions", "subagent-v2", "index.ts"),
    domainRoot: path.join(fixtureRoot, "extensions", "subagent-v2", "domain"),
    contractRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent-v2",
      "backend",
    ),
    piAdapterRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent-v2",
      "backend",
      "pi",
    ),
    piTestingRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent-v2",
      "testing",
      "pi",
    ),
    runtimeRoot: path.join(fixtureRoot, "extensions", "subagent-v2", "runtime"),
    presentationRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent-v2",
      "presentation",
    ),
    applicationRoot: path.join(
      fixtureRoot,
      "extensions",
      "subagent-v2",
      "application",
    ),
    hostRoot: path.join(fixtureRoot, "extensions", "subagent-v2", "host"),
    testingRoot: path.join(fixtureRoot, "extensions", "subagent-v2", "testing"),
  };
  return {
    graph,
    write: (relative, source) => writeSourceFile(fixtureRoot, relative, source),
  };
}

test("a v2 module importing a v1 module is rejected, naming the edge", (t) => {
  const { graph, write } = fixtureGraph(t, "v2-to-v1");
  write("extensions/subagent-v2/index.ts", 'import "../subagent/runner.ts";\n');
  write("extensions/subagent/runner.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(graph.v2Entry)} imports forbidden v1 module ${describe(path.join(graph.v1Root, "runner.ts"))}`,
  ]);
});

test("a v1 module reached transitively from the v2 entry is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "v2-transitive");
  write("extensions/subagent-v2/index.ts", 'import "./supervisor.ts";\n');
  write(
    "extensions/subagent-v2/supervisor.ts",
    'import "../subagent/subagents.ts";\n',
  );
  write("extensions/subagent/subagents.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v2Root, "supervisor.ts"))} imports forbidden v1 module ${describe(path.join(graph.v1Root, "subagents.ts"))}`,
  ]);
});

test("a v2 test file importing a v1 module is rejected even though the entry cannot reach it", (t) => {
  const { graph, write } = fixtureGraph(t, "v2-test-to-v1");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/supervisor.test.ts",
    'import "../subagent/runs.ts";\n',
  );
  write("extensions/subagent/runs.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v2Root, "supervisor.test.ts"))} imports forbidden v1 module ${describe(path.join(graph.v1Root, "runs.ts"))}`,
  ]);
});

test("a v1 module importing effect or an Effect ecosystem package is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "v1-to-effect");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent/runner.ts", 'import { Effect } from "effect";\n');
  write(
    "extensions/subagent/runs.ts",
    'import { TestClock } from "effect/testing";\n',
  );
  // The roadmap forbids the ecosystem packages too, not only the core one.
  write(
    "extensions/subagent/delivery.ts",
    'import { HttpClient } from "@effect/platform";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v1Root, "delivery.ts"))} imports forbidden package @effect/platform`,
    `${describe(path.join(graph.v1Root, "runner.ts"))} imports forbidden package effect`,
    `${describe(path.join(graph.v1Root, "runs.ts"))} imports forbidden package effect/testing`,
  ]);
});

test("the legacy field name is rejected in a v2 file of any kind, not only TypeScript", (t) => {
  const { graph, write } = fixtureGraph(t, "legacy-field-any-file");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/NOTES.md",
    `Set \`${LEGACY_BACKEND_FIELD}: claude\` in the profile.\n`,
  );
  write(
    "extensions/subagent-v2/fixtures/profile.json",
    `{ "${LEGACY_BACKEND_FIELD}": "codex" }\n`,
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v2Root, "NOTES.md"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
    `${describe(path.join(graph.v2Root, "fixtures", "profile.json"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
  ]);
});

test("a v1 module importing the v2 tree is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "v1-to-v2");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent/runner.ts", 'import "../subagent-v2/index.ts";\n');

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v1Root, "runner.ts"))} imports forbidden v2 module ${describe(graph.v2Entry)}`,
  ]);
});

test("a v2 source containing the legacy backend field name is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "legacy-field");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/profile.ts",
    `export const field = "${LEGACY_BACKEND_FIELD}";\n`,
  );
  write(
    "extensions/subagent-v2/profile.test.ts",
    `/** The ${LEGACY_BACKEND_FIELD} field is gone in v2. */\nexport {};\n`,
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v2Root, "profile.test.ts"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
    `${describe(path.join(graph.v2Root, "profile.ts"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
  ]);
});

test("the reserved Pi abstraction name is allowed, the legacy field name is not", (t) => {
  const { graph, write } = fixtureGraph(t, "reserved-name");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  // ADR-0022 reserves this name for Pi's own native abstraction.
  write(
    "extensions/subagent-v2/pi-adapter.ts",
    `import type { ${RESERVED_PI_ABSTRACTION} } from "@earendil-works/pi-coding-agent";\nexport type Held = ${RESERVED_PI_ABSTRACTION};\n`,
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/pi-adapter.ts",
    `export const field = "${LEGACY_BACKEND_FIELD}";\n`,
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v2Root, "pi-adapter.ts"))} contains the legacy profile backend field name "${LEGACY_BACKEND_FIELD}"`,
  ]);
});

test("comments and string literals in v2 are not import edges", (t) => {
  const { graph, write } = fixtureGraph(t, "syntax-only");
  write(
    "extensions/subagent-v2/index.ts",
    [
      '// import "../subagent/runner.ts";',
      'const path = "../subagent/runner.ts";',
      "void path;",
    ].join("\n"),
  );
  write("extensions/subagent/runner.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), []);
});

test("dynamic and require edges out of v2 are checked like static imports", (t) => {
  const { graph, write } = fixtureGraph(t, "dynamic");
  write(
    "extensions/subagent-v2/index.ts",
    [
      'await import("../subagent/runner.ts");',
      'module.require("../subagent/runner.ts");',
    ].join("\n"),
  );
  write("extensions/subagent/runner.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(graph.v2Entry)} imports forbidden v1 module ${describe(path.join(graph.v1Root, "runner.ts"))}`,
  ]);
});

test("a domain module importing a package other than effect is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-purity");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/domain/ids.ts", 'import "node:crypto";\n');
  write(
    "extensions/subagent-v2/domain/profile.ts",
    'import "@earendil-works/pi-coding-agent";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} imports node:crypto from outside the domain module`,
    `${describe(path.join(graph.domainRoot, "profile.ts"))} imports @earendil-works/pi-coding-agent from outside the domain module`,
  ]);
});

test("a domain module may take Schema from effect and nothing else", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-named-imports");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/domain/ids.ts",
    'import { Schema } from "effect";\nexport const Id = Schema.String;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/domain/reduce.ts",
    'import { Effect, Schema } from "effect";\nvoid Effect;\nvoid Schema;\n',
  );
  write(
    "extensions/subagent-v2/domain/result.ts",
    'import * as effect from "effect";\nvoid effect;\n',
  );
  write(
    "extensions/subagent-v2/domain/usage.ts",
    'import Effect from "effect";\nvoid Effect;\n',
  );
  write(
    "extensions/subagent-v2/domain/endings.ts",
    'const it = await import("effect");\nvoid it;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "endings.ts"))} imports * from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} imports Effect from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "result.ts"))} imports * from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "usage.ts"))} imports default from effect, and a domain file may name only Schema`,
  ]);
});

test("a renamed import is judged by the name the module exports", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-renamed-import");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  // Renaming `Layer` to `S` hides it from a reader and from a rule that looked
  // at local bindings. Both rules still fire, because both read the name the
  // module exports.
  write(
    "extensions/subagent-v2/domain/ids.ts",
    'import { Layer as S } from "effect";\nvoid S;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} imports Layer from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "ids.ts"))} names the runtime primitive Layer`,
  ]);
});

test("a domain module naming a runtime primitive is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-runtime-primitives");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/domain/reduce.ts",
    "export type Sink = Queue<string>;\n",
  );
  write(
    "extensions/subagent-v2/domain/result.ts",
    "/** Held for the life of the Run Scope. */\nexport {};\n",
  );
  write(
    "extensions/subagent-v2/domain/ids.ts",
    "declare const layer: Layer;\ndeclare const fiber: Fiber;\nvoid layer;\nvoid fiber;\n",
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} names the runtime primitive Fiber`,
    `${describe(path.join(graph.domainRoot, "ids.ts"))} names the runtime primitive Layer`,
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} names the runtime primitive Queue`,
    `${describe(path.join(graph.domainRoot, "result.ts"))} names the runtime primitive Scope`,
  ]);
});

test("the domain's own vocabulary is not a runtime primitive", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-vocabulary");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  // The diagnostic category and the prose around it are domain words. Only
  // the capitalized runtime type is machinery.
  write(
    "extensions/subagent-v2/domain/diagnostics.ts",
    [
      "/** A diagnostic the core authored — a late event, a queue overflow. */",
      'export const categories = ["queue-overflow", "late-event"] as const;',
      "",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);
});

test("a domain module importing a v2 file outside the domain is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-reaches-out");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/backend/contract.ts", "export {};\n");
  write(
    "extensions/subagent-v2/domain/reduce.ts",
    'import "../backend/contract.ts";\nimport "./ids.ts";\n',
  );
  write("extensions/subagent-v2/domain/ids.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} imports ../backend/contract.ts from outside the domain module`,
  ]);
});

test("a domain test may name the test runner but not a runtime", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-test-packages");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/testing/type-level.ts", "export {};\n");
  write(
    "extensions/subagent-v2/domain/reduce.test.ts",
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import "../testing/type-level.ts";',
      "void assert;",
      "void test;",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  // A domain test may exercise the declarations it is about, so `Schema` is
  // admitted on the same one-binding terms as a production file.
  write(
    "extensions/subagent-v2/domain/schemas.test.ts",
    'import { Schema } from "effect";\nvoid Schema;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/domain/reduce.test.ts",
    'import { Effect } from "effect";\nimport "node:fs";\nvoid Effect;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "reduce.test.ts"))} imports Effect from effect, and a domain file may name only Schema`,
    `${describe(path.join(graph.domainRoot, "reduce.test.ts"))} imports package node:fs, which a domain test may not name`,
  ]);
});

test("a runtime module outside the composition may not import Layer", (t) => {
  const { graph, write } = fixtureGraph(t, "layer-confinement");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  // The composition module and the services it wires may name it.
  write(
    "extensions/subagent-v2/runtime/composition.ts",
    'import { Layer } from "effect";\nvoid Layer;\n',
  );
  write(
    "extensions/subagent-v2/runtime/repository.ts",
    'import { Effect, Layer } from "effect";\nvoid Effect;\nvoid Layer;\n',
  );
  // A Run is not a service, so the module that owns one may not.
  write(
    "extensions/subagent-v2/runtime/run-scope.ts",
    'import { Effect, Layer } from "effect";\nvoid Effect;\nvoid Layer;\n',
  );
  write(
    "extensions/subagent-v2/runtime/mailbox.ts",
    'import * as effect from "effect";\nvoid effect;\n',
  );
  // Naming other Effect bindings is fine: only `Layer` is confined.
  write(
    "extensions/subagent-v2/runtime/arbitration.ts",
    'import { Effect, Queue } from "effect";\nvoid Effect;\nvoid Queue;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "mailbox.ts"))} imports Layer, which only the composition module and the services it wires may name`,
    `${describe(path.join(graph.runtimeRoot, "run-scope.ts"))} imports Layer, which only the composition module and the services it wires may name`,
  ]);
});

test("any v2 file importing a provider SDK is rejected, tests included", (t) => {
  const { graph, write } = fixtureGraph(t, "provider-sdk");
  write(
    "extensions/subagent-v2/index.ts",
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );
  write(
    "extensions/subagent-v2/backend/fake.test.ts",
    'import "@openai/some-sdk";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.v2Root, "backend", "fake.test.ts"))} imports forbidden provider SDK @openai/some-sdk`,
    `${describe(graph.v2Entry)} imports forbidden provider SDK @anthropic-ai/claude-agent-sdk`,
  ]);
});

test("mechanism vocabulary in the domain or the contract is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "mechanism-vocabulary");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/domain/reduce.ts",
    "export const cancel = new AbortController();\n",
  );
  write(
    "extensions/subagent-v2/backend/contract.ts",
    "/** The adapter never sees an AbortSignal. */\nexport {};\n",
  );
  write(
    "extensions/subagent-v2/backend/fake.ts",
    'import { Effect } from "effect";\nawait Effect.runPromise(Effect.void);\n',
  );

  assert.deepEqual(
    findV2BoundaryViolations(graph),
    [
      `${describe(path.join(graph.contractRoot, "contract.ts"))} contains runtime mechanism vocabulary AbortSignal`,
      `${describe(path.join(graph.contractRoot, "fake.ts"))} contains runtime mechanism vocabulary Effect.runPromise`,
      `${describe(path.join(graph.domainRoot, "reduce.ts"))} contains runtime mechanism vocabulary AbortController`,
    ].sort(),
  );
});

test("a runtime module running an Effect or polling a signal is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "runtime-mechanism");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/runtime/supervisor.ts",
    'import { Effect } from "effect";\nawait Effect.runPromise(Effect.void);\n',
  );
  write(
    "extensions/subagent-v2/runtime/run-scope.ts",
    "export const stop = new AbortController();\n",
  );
  write(
    "extensions/subagent-v2/runtime/mailbox.ts",
    "/** Never handed an AbortSignal. */\nexport {};\n",
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "mailbox.ts"))} contains runtime mechanism vocabulary AbortSignal`,
    `${describe(path.join(graph.runtimeRoot, "run-scope.ts"))} contains runtime mechanism vocabulary AbortController`,
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} contains runtime mechanism vocabulary Effect.runPromise`,
  ]);
});

test("a test may name mechanism vocabulary, because a test has to run things", (t) => {
  const { graph, write } = fixtureGraph(t, "mechanism-vocabulary-tests");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/backend/contract.test.ts",
    [
      'import { Effect } from "effect";',
      'const forbidden = ["AbortController", "AbortSignal"];',
      "await Effect.runPromise(Effect.void);",
      "void forbidden;",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);
});

test("a presentation file importing the runtime, a backend, or a fake is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "presentation-edges");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/domain/index.ts", "export {};\n");
  write("extensions/subagent-v2/runtime/repository.ts", "export {};\n");
  write("extensions/subagent-v2/backend/contract.ts", "export {};\n");
  write("extensions/subagent-v2/testing/fakes/backend.ts", "export {};\n");
  // Prose over the domain, painted with Pi's own primitives: allowed.
  write(
    "extensions/subagent-v2/presentation/status.ts",
    [
      'import type {} from "../domain/index.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "void truncateToWidth;",
    ].join("\n"),
  );
  // A test may name the runner, the assertion library, and a shared fixture.
  write(
    "extensions/subagent-v2/testing/presentation-fixtures.ts",
    "export {};\n",
  );
  write(
    "extensions/subagent-v2/presentation/status.test.ts",
    [
      'import assert from "node:assert/strict";',
      'import "../testing/presentation-fixtures.ts";',
      "void assert;",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  // A production presentation file may not, which is the half of the rule the
  // fixture exemption must not widen.
  write(
    "extensions/subagent-v2/presentation/status.ts",
    [
      'import type {} from "../domain/index.ts";',
      'import "../testing/presentation-fixtures.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "void truncateToWidth;",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.presentationRoot, "status.ts"))} imports ${describe(path.join(graph.testingRoot, "presentation-fixtures.ts"))}, and a presentation file may name only the domain and Pi`,
  ]);

  // Restore the good production file for the rejections below.
  write(
    "extensions/subagent-v2/presentation/status.ts",
    [
      'import type {} from "../domain/index.ts";',
      'import { truncateToWidth } from "@earendil-works/pi-tui";',
      "void truncateToWidth;",
    ].join("\n"),
  );

  write(
    "extensions/subagent-v2/presentation/rows.ts",
    'import "../runtime/repository.ts";\n',
  );
  write(
    "extensions/subagent-v2/presentation/card.ts",
    'import "../backend/contract.ts";\nimport "../testing/fakes/backend.ts";\n',
  );
  // Not even Effect: presentation runs nothing.
  write(
    "extensions/subagent-v2/presentation/prose.ts",
    'import { Effect } from "effect";\nvoid Effect;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.presentationRoot, "card.ts"))} imports ${describe(path.join(graph.contractRoot, "contract.ts"))}, and a presentation file may name only the domain and Pi`,
    `${describe(path.join(graph.presentationRoot, "card.ts"))} imports ${describe(path.join(graph.testingRoot, "fakes", "backend.ts"))}, and a presentation file may name only the domain and Pi`,
    `${describe(path.join(graph.presentationRoot, "prose.ts"))} imports package effect, and a presentation file may name only the domain and Pi`,
    `${describe(path.join(graph.presentationRoot, "rows.ts"))} imports ${describe(path.join(graph.runtimeRoot, "repository.ts"))}, and a presentation file may name only the domain and Pi`,
  ]);
});

test("an application file importing the host, a backend, or a Pi package is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "application-edges");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/domain/index.ts", "export {};\n");
  write("extensions/subagent-v2/presentation/index.ts", "export {};\n");
  write("extensions/subagent-v2/runtime/supervisor.ts", "export {};\n");
  write("extensions/subagent-v2/backend/contract.ts", "export {};\n");
  write("extensions/subagent-v2/host/tools.ts", "export {};\n");
  // The four edges the façade is allowed: domain, runtime, presentation, Effect.
  write(
    "extensions/subagent-v2/application/subagents.ts",
    [
      'import { Effect } from "effect";',
      'import "../domain/index.ts";',
      'import "../presentation/index.ts";',
      'import "../runtime/supervisor.ts";',
      "void Effect;",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/application/subagents.ts",
    [
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      'import "../backend/contract.ts";',
      'import "../host/tools.ts";',
      "export type Api = ExtensionAPI;",
    ].join("\n"),
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} imports ${describe(path.join(graph.contractRoot, "contract.ts"))}, which the application module may not name`,
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} imports ${describe(path.join(graph.hostRoot, "tools.ts"))}, which the application module may not name`,
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} imports package @earendil-works/pi-coding-agent, which the application module may not name`,
  ]);
});

test("a host file importing a backend or a fake is rejected unless it is the composition root", (t) => {
  const { graph, write } = fixtureGraph(t, "host-composition-root");
  write("extensions/subagent-v2/index.ts", 'import "./host/session.ts";\n');
  write("extensions/subagent-v2/backend/contract.ts", "export {};\n");
  write("extensions/subagent-v2/testing/fakes/backend.ts", "export {};\n");
  write("extensions/subagent-v2/host/session.ts", "export {};\n");
  // The composition root supplies the demo backend set, so it names both.
  write(
    "extensions/subagent-v2/host/demo-backends.ts",
    'import "../backend/contract.ts";\nimport "../testing/fakes/backend.ts";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/host/session.ts",
    'import "../backend/contract.ts";\n',
  );
  write(
    "extensions/subagent-v2/index.ts",
    'import "../subagent-v2/host/session.ts";\nimport "./testing/fakes/backend.ts";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "session.ts"))} imports ${describe(path.join(graph.contractRoot, "contract.ts"))}, which only the composition root may name`,
    `${describe(graph.v2Entry)} imports ${describe(path.join(graph.testingRoot, "fakes", "backend.ts"))}, which only the composition root may name`,
  ]);
});

test("a managed runtime or a signal outside the host module is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "host-boundary-vocabulary");
  // The host module is where a Pi callback crosses into Effect, so it is the
  // one place these words belong.
  write(
    "extensions/subagent-v2/index.ts",
    'import "./host/session.ts";\nimport "./application/subagents.ts";\n',
  );
  write(
    "extensions/subagent-v2/host/session.ts",
    [
      'import { Effect, ManagedRuntime } from "effect";',
      "export const stop = new AbortController();",
      "void ManagedRuntime;",
      "await Effect.runPromise(Effect.void);",
    ].join("\n"),
  );
  write("extensions/subagent-v2/application/subagents.ts", "export {};\n");

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/application/subagents.ts",
    [
      'import { Effect, ManagedRuntime } from "effect";',
      "void ManagedRuntime;",
      "await Effect.runPromise(Effect.void);",
    ].join("\n"),
  );
  write(
    "extensions/subagent-v2/presentation/rows.ts",
    "/** Never handed an AbortSignal. */\nexport {};\n",
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} contains runtime mechanism vocabulary Effect.runPromise`,
    `${describe(path.join(graph.applicationRoot, "subagents.ts"))} contains runtime mechanism vocabulary ManagedRuntime`,
    `${describe(path.join(graph.presentationRoot, "rows.ts"))} contains runtime mechanism vocabulary AbortSignal`,
  ]);
});

test("a runtime module importing the host, presentation, or the façade is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "runtime-knows-no-host");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/host/push-sink.ts", "export {};\n");
  write("extensions/subagent-v2/presentation/index.ts", "export {};\n");
  write("extensions/subagent-v2/application/subagents.ts", "export {};\n");
  write("extensions/subagent-v2/domain/index.ts", "export {};\n");
  // The runtime reaching its own domain is the whole design.
  write(
    "extensions/subagent-v2/runtime/delivery.ts",
    'import "../domain/index.ts";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), []);

  write(
    "extensions/subagent-v2/runtime/delivery.ts",
    'import "../host/push-sink.ts";\nimport "../presentation/index.ts";\n',
  );
  write(
    "extensions/subagent-v2/runtime/supervisor.ts",
    'import "../application/subagents.ts";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "delivery.ts"))} imports ${describe(path.join(graph.hostRoot, "push-sink.ts"))}, and the runtime does not know the host exists`,
    `${describe(path.join(graph.runtimeRoot, "delivery.ts"))} imports ${describe(path.join(graph.presentationRoot, "index.ts"))}, and the runtime does not know the host exists`,
    `${describe(path.join(graph.runtimeRoot, "supervisor.ts"))} imports ${describe(path.join(graph.applicationRoot, "subagents.ts"))}, and the runtime does not know the host exists`,
  ]);
});

test("the second schema library is rejected anywhere in v2, tests included", (t) => {
  const { graph, write } = fixtureGraph(t, "second-schema-library");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/host/tool-schemas.ts",
    'import { Type } from "typebox";\nvoid Type;\n',
  );
  write(
    "extensions/subagent-v2/host/tool-schemas.test.ts",
    'import { Value } from "typebox/value";\nvoid Value;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "tool-schemas.test.ts"))} imports typebox/value, and v2 declares its schemas with Effect Schema alone`,
    `${describe(path.join(graph.hostRoot, "tool-schemas.ts"))} imports typebox, and v2 declares its schemas with Effect Schema alone`,
  ]);
});

test("a Pi session symbol outside the adapter is rejected, its host API is not", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-symbols");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/host/widget.ts",
    'import { createAgentSession } from "@earendil-works/pi-coding-agent";\n' +
      "export const made = createAgentSession;\n",
  );
  write(
    "extensions/subagent-v2/host/tools.ts",
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n' +
      "export type Api = ExtensionAPI;\n",
  );
  write(
    "extensions/subagent-v2/backend/pi/agent.ts",
    'import { createAgentSession } from "@earendil-works/pi-coding-agent";\n' +
      "export const open = createAgentSession;\n",
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.hostRoot, "widget.ts"))} imports createAgentSession from @earendil-works/pi-coding-agent, and Pi session symbols stay inside the Pi adapter`,
  ]);
});

test("a Pi message type outside the adapter is rejected", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-message-type");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/runtime/run-scope.ts",
    'import type { AgentMessage } from "@earendil-works/pi-agent-core";\n' +
      "export type Message = AgentMessage;\n",
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "run-scope.ts"))} imports AgentMessage from @earendil-works/pi-agent-core, and Pi session symbols stay inside the Pi adapter`,
  ]);
});

test("only the composition root may import the Pi adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-adapter-importers");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/backend/pi/index.ts", "export const pi = 1;\n");
  // Allowed: the composition root wires the set.
  write(
    "extensions/subagent-v2/host/pi-backends.ts",
    'import { pi } from "../backend/pi/index.ts";\nexport const set = pi;\n',
  );
  // Allowed: the adapter's own test doubles.
  write(
    "extensions/subagent-v2/testing/pi/stand-in-session.ts",
    'import { pi } from "../../backend/pi/index.ts";\nexport const held = pi;\n',
  );
  // Rejected: the runtime reaching around the contract.
  write(
    "extensions/subagent-v2/runtime/repository.ts",
    'import { pi } from "../backend/pi/index.ts";\nexport const held = pi;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.runtimeRoot, "repository.ts"))} imports ${describe(
      path.join(graph.piAdapterRoot, "index.ts"),
    )}, and only the composition root may name the Pi adapter`,
  ]);
});

test("being a test is not on its own permission to import the Pi adapter", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-adapter-test-importers");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/backend/pi/index.ts", "export const pi = 1;\n");
  // A test *about* the adapter, in a module that has no business knowing it
  // exists. The rule names the two host tests that may; this is not one.
  write(
    "extensions/subagent-v2/presentation/rows.test.ts",
    'import { pi } from "../backend/pi/index.ts";\nexport const row = pi;\n',
  );

  const violations = findV2BoundaryViolations(graph);

  assert.ok(
    violations.some((violation) =>
      violation.endsWith("only the composition root may name the Pi adapter"),
    ),
    `a presentation test reached the adapter unchallenged: ${JSON.stringify(violations)}`,
  );
});

test("the Pi adapter may not import the runtime, the host, or presentation", (t) => {
  const { graph, write } = fixtureGraph(t, "pi-adapter-reach");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write(
    "extensions/subagent-v2/runtime/policy.ts",
    "export const bound = 1;\n",
  );
  write(
    "extensions/subagent-v2/backend/pi/agent.ts",
    'import { bound } from "../../runtime/policy.ts";\nexport const used = bound;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.piAdapterRoot, "agent.ts"))} imports ${describe(
      path.join(graph.runtimeRoot, "policy.ts"),
    )}, and the Pi adapter lives behind the backend contract`,
  ]);
});

test("the real v1 and v2 trees hold the boundary", () => {
  assert.deepEqual(findV2BoundaryViolations(), []);
});
