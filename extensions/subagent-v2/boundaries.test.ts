import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  listSourceFiles,
  readImportSpecifiers,
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
 * and Effect edges; M1 adds the rules that keep the domain module plain
 * TypeScript and keep provider SDKs out of the tree entirely.
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
  /** The checker itself, excluded from the legacy-name scan. */
  readonly checkerFile?: string;
}

const productionGraph: V2BoundaryGraph = {
  v1Root: path.join(repositoryRoot, "extensions", "subagent"),
  v2Root: path.join(repositoryRoot, "extensions", "subagent-v2"),
  v2Entry: path.join(repositoryRoot, "extensions", "subagent-v2", "index.ts"),
  domainRoot: path.join(repositoryRoot, "extensions", "subagent-v2", "domain"),
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

  // 4. The domain module is plain TypeScript. A production domain file may
  //    name only another domain file, which rules out `effect`, every SDK, and
  //    every `node:` module by construction rather than by enumeration. A
  //    domain test may additionally name the test runner and the assertion
  //    library, and may share relative test helpers with the rest of v2.
  for (const file of listSourceFiles(graph.domainRoot, {
    includeTests: true,
  })) {
    for (const specifier of specifiersOf(file)) {
      const target = resolveRelativeSource(file, specifier);
      if (isTestFile(file)) {
        if (!target && !DOMAIN_TEST_PACKAGES.has(specifier)) {
          violations.add(
            `${describe(file)} imports package ${specifier}, which a domain test may not name`,
          );
        }
        continue;
      }
      if (!target || !isInside(target, graph.domainRoot)) {
        violations.add(
          `${describe(file)} imports ${specifier} from outside the domain module`,
        );
      }
    }
  }

  // 5. No v2 file reaches a provider SDK before the adapter milestones.
  for (const file of listSourceFiles(v2Root, { includeTests: true })) {
    for (const specifier of specifiersOf(file)) {
      if (isProviderSdk(specifier)) {
        violations.add(
          `${describe(file)} imports forbidden provider SDK ${specifier}`,
        );
      }
    }
  }

  // 6. The freeze runs in both directions: v1 gains neither Effect nor a
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

test("a domain module importing a package is rejected, whatever the package", (t) => {
  const { graph, write } = fixtureGraph(t, "domain-purity");
  write("extensions/subagent-v2/index.ts", "export {};\n");
  write("extensions/subagent-v2/domain/reduce.ts", 'import "effect";\n');
  write("extensions/subagent-v2/domain/ids.ts", 'import "node:crypto";\n');
  write(
    "extensions/subagent-v2/domain/profile.ts",
    'import "@earendil-works/pi-coding-agent";\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "ids.ts"))} imports node:crypto from outside the domain module`,
    `${describe(path.join(graph.domainRoot, "profile.ts"))} imports @earendil-works/pi-coding-agent from outside the domain module`,
    `${describe(path.join(graph.domainRoot, "reduce.ts"))} imports effect from outside the domain module`,
  ]);
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

  write(
    "extensions/subagent-v2/domain/reduce.test.ts",
    'import { Effect } from "effect";\nimport "node:fs";\nvoid Effect;\n',
  );

  assert.deepEqual(findV2BoundaryViolations(graph), [
    `${describe(path.join(graph.domainRoot, "reduce.test.ts"))} imports package effect, which a domain test may not name`,
    `${describe(path.join(graph.domainRoot, "reduce.test.ts"))} imports package node:fs, which a domain test may not name`,
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

test("the real v1 and v2 trees hold the boundary", () => {
  assert.deepEqual(findV2BoundaryViolations(), []);
});
