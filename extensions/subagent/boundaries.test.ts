import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const forbiddenPackages = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]);
const piSessionSymbols = new Set([
  "AgentSession",
  "AgentSessionEvent",
  "CreateAgentSessionOptions",
  "LoadExtensionsResult",
  "ModelRuntime",
  "SessionManager",
  "SettingsManager",
  "DefaultResourceLoader",
  "createAgentSession",
  "createBashToolDefinition",
  "withFileMutationQueue",
]);

/** Read module specifiers from syntax, not arbitrary strings or comments. */
function readImportSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "boundary-fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const add = (node: ts.StringLiteralLike | undefined): void => {
    if (node) specifiers.push(node.text);
  };
  const staticString = (
    node: ts.Node | undefined,
  ): node is ts.StringLiteralLike =>
    Boolean(
      node &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)),
    );
  const isRequireCallee = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && node.text === "require") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "require") ||
    (ts.isElementAccessExpression(node) &&
      staticString(node.argumentExpression) &&
      node.argumentExpression.text === "require");

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier
          : undefined,
      );
    } else if (ts.isExportDeclaration(node)) {
      add(
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier
          : undefined,
      );
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      add(
        ts.isExternalModuleReference(reference) &&
          ts.isStringLiteral(reference.expression)
          ? reference.expression
          : undefined,
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      add(argument && staticString(argument) ? argument : undefined);
    } else if (ts.isCallExpression(node) && isRequireCallee(node.expression)) {
      const [argument] = node.arguments;
      add(argument && staticString(argument) ? argument : undefined);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

/** Find Pi Conversation/session symbols even when imports are type-only or aliased. */
function readPiSessionSymbolImports(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "boundary-fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const isPiCodingAgent = (node: ts.Expression | undefined): boolean =>
    Boolean(
      node &&
        ts.isStringLiteralLike(node) &&
        (node.text === "@earendil-works/pi-coding-agent" ||
          node.text.startsWith("@earendil-works/pi-coding-agent/")),
    );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isPiCodingAgent(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) found.push("*");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) found.push("*");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (piSessionSymbols.has(imported)) found.push(imported);
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      isPiCodingAgent(node.moduleSpecifier)
    ) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        found.push("*");
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (piSessionSymbols.has(imported)) found.push(imported);
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isPiCodingAgent(node.moduleReference.expression)
    ) {
      found.push("*");
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      isPiCodingAgent(node.arguments[0])
    ) {
      found.push("*");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function resolveSourceFile(
  importer: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function describe(file: string, graphRoot: string): string {
  return path.relative(graphRoot, file) || file;
}

function listProductionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...listProductionSources(full));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

type AdapterOwner = "claude" | "pi" | "codex" | "other";

/** Backend ownership is the `harnesses/<name>/` directory, not a filename. */
function adapterOwnership(
  file: string,
  graphRoot: string,
): AdapterOwner | undefined {
  const parts = path.relative(graphRoot, file).split(path.sep);
  if (parts[0] !== "harnesses" || parts.length < 3) return undefined;
  if (parts[1] === "pi") return "pi";
  if (parts[1] === "claude") return "claude";
  if (parts[1] === "codex") return "codex";
  return "other";
}

/** Composition may register only `harnesses/<name>/harness.ts`. */
function isHarnessAdapter(file: string, graphRoot: string): boolean {
  const parts = path.relative(graphRoot, file).split(path.sep);
  return (
    parts[0] === "harnesses" && parts.length === 3 && parts[2] === "harness.ts"
  );
}

function writeSource(rootDir: string, relative: string, source: string): void {
  const dest = path.join(rootDir, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, source);
}

/**
 * Walk a source root with the same production parser and resolver used below.
 * A root parameter lets the regression test supply a disposable graph without
 * writing a fake checker or mutating the working tree.
 *
 * Allowed directions:
 * - core may import `harnesses/contract.ts` and `harnesses/conformance.ts`
 * - adapters may import core and the shared contract
 * - composition may import `harnesses/<name>/harness.ts` only
 * - adapters must not import a foreign backend directory or another backend's wire
 */
export function findForbiddenImports(graphRoot: string = root): string[] {
  const sourceFiles = listProductionSources(graphRoot);
  const adapterPaths = new Set(
    sourceFiles.filter(
      (file) => adapterOwnership(file, graphRoot) !== undefined,
    ),
  );
  const compositionRoot = path.join(graphRoot, "composition.ts");
  // Only direct adapter imports from the composition root are allowed. This
  // registration shape keeps composition the sole adapter edge.
  const allowedCompositionImports = new Set(
    fs.existsSync(compositionRoot)
      ? readImportSpecifiers(fs.readFileSync(compositionRoot, "utf8"))
          .map((specifier) => resolveSourceFile(compositionRoot, specifier))
          .filter((file): file is string => file !== undefined)
          .filter((file) => adapterPaths.has(file))
          .filter((file) => isHarnessAdapter(file, graphRoot))
      : [],
  );
  const coreFiles = sourceFiles.filter((file) => !adapterPaths.has(file));
  const visited = new Set<string>();
  const violations: string[] = [];

  // Adapter modules are the only place backend wire types may appear. Check
  // ownership explicitly rather than treating every adapter as an opaque hole
  // in the graph: a crossed import must fail even when both adapters are
  // otherwise excluded from the core walk.
  for (const adapter of adapterPaths) {
    const owner = adapterOwnership(adapter, graphRoot);
    for (const specifier of readImportSpecifiers(
      fs.readFileSync(adapter, "utf8"),
    )) {
      const importsClaude =
        specifier === "@anthropic-ai/claude-agent-sdk" ||
        specifier.startsWith("@anthropic-ai/claude-agent-sdk/");
      const importsPi =
        specifier === "@earendil-works/pi-ai" ||
        specifier.startsWith("@earendil-works/pi-ai/") ||
        specifier === "@earendil-works/pi-agent-core" ||
        specifier.startsWith("@earendil-works/pi-agent-core/") ||
        specifier === "@earendil-works/pi-coding-agent" ||
        specifier.startsWith("@earendil-works/pi-coding-agent/");
      const forbidden =
        (importsClaude && owner !== "claude") || (importsPi && owner !== "pi");
      if (forbidden) {
        const wire = importsClaude ? "Claude SDK" : "Pi wire";
        violations.push(
          `${describe(adapter, graphRoot)} imports forbidden ${wire} package ${specifier}`,
        );
        continue;
      }

      const target = resolveSourceFile(adapter, specifier);
      if (
        target &&
        adapterPaths.has(target) &&
        adapterOwnership(adapter, graphRoot) !==
          adapterOwnership(target, graphRoot)
      ) {
        violations.push(
          `${describe(adapter, graphRoot)} imports forbidden foreign adapter ${describe(target, graphRoot)}`,
        );
      }
    }
  }

  const visit = (file: string): void => {
    if (visited.has(file) || adapterPaths.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");

    for (const symbol of readPiSessionSymbolImports(source)) {
      violations.push(
        `${describe(file, graphRoot)} imports forbidden Pi SDK symbol ${symbol}`,
      );
    }

    for (const specifier of readImportSpecifiers(source)) {
      const forbiddenPackage = [...forbiddenPackages].find(
        (packageName) =>
          specifier === packageName || specifier.startsWith(`${packageName}/`),
      );
      if (forbiddenPackage) {
        violations.push(
          `${describe(file, graphRoot)} imports forbidden package ${specifier}`,
        );
        continue;
      }

      const target = resolveSourceFile(file, specifier);
      if (!target) continue;
      if (adapterPaths.has(target)) {
        if (file === compositionRoot && allowedCompositionImports.has(target)) {
          continue;
        }
        violations.push(
          `${describe(file, graphRoot)} imports forbidden harness adapter ${describe(target, graphRoot)}`,
        );
        continue;
      }
      visit(target);
    }
  };

  for (const file of coreFiles) visit(file);
  return violations;
}

test("comments and string literals are not import edges", () => {
  const source = `
    // import "@anthropic-ai/claude-agent-sdk";
    const text = "./harnesses/pi/agent.ts";
    const name = "agent";
    import(\`./\${name}.ts\`);
    import type { Fact } from "./run.ts";
  `;
  assert.deepEqual(readImportSpecifiers(source), ["./run.ts"]);
});

test("no-substitution imports and static property requires are checked", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-static-forms-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "runner.ts",
    [
      "await import(`./harnesses/codex/harness.ts`);",
      'module.require("./harnesses/codex/harness.ts");',
      'module["require"]("./harnesses/codex/harness.ts");',
    ].join("\n"),
  );
  writeSource(fixtureRoot, "harnesses/codex/harness.ts", "export {};");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter harnesses/codex/harness.ts",
    "runner.ts imports forbidden harness adapter harnesses/codex/harness.ts",
    "runner.ts imports forbidden harness adapter harnesses/codex/harness.ts",
  ]);
});

test("static CommonJS require edges are checked like imports", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-require-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "runner.ts",
    'const adapter = require("./harnesses/codex/harness.ts");\nvoid adapter;\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/harness.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter harnesses/codex/harness.ts",
  ]);
});

test("adapter discovery follows the harnesses directory", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "composition.ts",
    'import "./harnesses/codex/harness.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/harness.ts", "export {};\n");
  writeSource(
    fixtureRoot,
    "runner.ts",
    'import "./harnesses/codex/harness.ts";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter harnesses/codex/harness.ts",
  ]);
});

test("a root file named like an adapter is still core", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-root-name-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(fixtureRoot, "runner.ts", 'import "./codex-harness.ts";\n');
  writeSource(fixtureRoot, "codex-harness.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), []);
});

test("the production graph checker catches a controlled forbidden adapter edge", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(fixtureRoot, "runner.ts", 'import "./harnesses/pi/agent.ts";\n');
  writeSource(fixtureRoot, "harnesses/pi/agent.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter harnesses/pi/agent.ts",
  ]);
});

test("core-to-SDK package edges are forbidden too", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-sdk-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "runner.ts",
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden package @anthropic-ai/claude-agent-sdk",
  ]);
});

test("Pi SDK session types and symbols are confined to the Pi adapter", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-pi-sdk-symbols-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "runner.ts",
    [
      'import type { AgentSession as Session } from "@earendil-works/pi-coding-agent";',
      'export { createAgentSession as makeSession } from "@earendil-works/pi-coding-agent";',
      'import * as piSdk from "@earendil-works/pi-coding-agent";',
    ].join("\n"),
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden Pi SDK symbol AgentSession",
    "runner.ts imports forbidden Pi SDK symbol createAgentSession",
    "runner.ts imports forbidden Pi SDK symbol *",
  ]);
});

test("a foreign adapter cannot import Pi SDK session construction", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-foreign-pi-sdk-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "harnesses/claude/harness.ts",
    'import { createAgentSession } from "@earendil-works/pi-coding-agent";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "harnesses/claude/harness.ts imports forbidden Pi wire package @earendil-works/pi-coding-agent",
  ]);
});

test("each named adapter may import only its owned wire", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-owned-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "harnesses/claude/harness.ts",
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );
  writeSource(
    fixtureRoot,
    "harnesses/pi/agent.ts",
    'import "@earendil-works/pi-ai";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), []);
});

test("crossed Claude and Pi adapter wire imports are rejected", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-crossed-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "composition.ts",
    'import "./harnesses/claude/harness.ts"; import "./harnesses/pi/harness.ts";\n',
  );
  writeSource(
    fixtureRoot,
    "harnesses/claude/harness.ts",
    'import "@earendil-works/pi-ai";\n',
  );
  writeSource(
    fixtureRoot,
    "harnesses/pi/harness.ts",
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "harnesses/claude/harness.ts imports forbidden Pi wire package @earendil-works/pi-ai",
    "harnesses/pi/harness.ts imports forbidden Claude SDK package @anthropic-ai/claude-agent-sdk",
  ]);
});

test("core cannot import the Codex App Server transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-core-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "runner.ts",
    'import "./harnesses/codex/app-server.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/app-server.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter harnesses/codex/app-server.ts",
  ]);
});

test("a foreign Claude adapter cannot import the Codex transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-claude-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "harnesses/claude/harness.ts",
    'import "../codex/app-server.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/app-server.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "harnesses/claude/harness.ts imports forbidden foreign adapter harnesses/codex/app-server.ts",
  ]);
});

test("an unclassified adapter cannot import the Codex transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-other-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "harnesses/mystery/harness.ts",
    'import "../codex/app-server.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/app-server.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "harnesses/mystery/harness.ts imports forbidden foreign adapter harnesses/codex/app-server.ts",
  ]);
});

test("the Codex harness may import its Codex-owned transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-owned-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "composition.ts",
    'import "./harnesses/codex/harness.ts";\n',
  );
  writeSource(
    fixtureRoot,
    "harnesses/codex/harness.ts",
    'import "./app-server.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/app-server.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), []);
});

test("composition cannot register the Codex transport directly", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "pi-subagent-boundary-codex-transport-registration-",
    ),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "composition.ts",
    'import "./harnesses/codex/app-server.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/codex/app-server.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "composition.ts imports forbidden harness adapter harnesses/codex/app-server.ts",
  ]);
});

test("an unclassified adapter cannot import either wire", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-other-adapter-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "harnesses/mystery/harness.ts",
    'import "@earendil-works/pi-ai"; import "@anthropic-ai/claude-agent-sdk";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "harnesses/mystery/harness.ts imports forbidden Pi wire package @earendil-works/pi-ai",
    "harnesses/mystery/harness.ts imports forbidden Claude SDK package @anthropic-ai/claude-agent-sdk",
  ]);
});

test("only the composition registration edge may import adapters", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-composition-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "composition.ts",
    'import "./harnesses/pi/harness.ts";\n',
  );
  writeSource(fixtureRoot, "index.ts", 'import "./harnesses/pi/harness.ts";\n');
  writeSource(fixtureRoot, "harnesses/pi/harness.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "index.ts imports forbidden harness adapter harnesses/pi/harness.ts",
  ]);
});

test("core may import the shared harness contract", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-contract-core-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(fixtureRoot, "runner.ts", 'import "./harnesses/contract.ts";\n');
  writeSource(fixtureRoot, "harnesses/contract.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), []);
});

test("the shared harness contract cannot import adapters", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-contract-adapter-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "harnesses/contract.ts",
    'import "./pi/harness.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/pi/harness.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "harnesses/contract.ts imports forbidden harness adapter harnesses/pi/harness.ts",
  ]);
});

test("adapters may import the shared harness contract", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-adapter-contract-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  writeSource(
    fixtureRoot,
    "composition.ts",
    'import "./harnesses/pi/harness.ts";\n',
  );
  writeSource(
    fixtureRoot,
    "harnesses/pi/harness.ts",
    'import "../contract.ts";\n',
  );
  writeSource(fixtureRoot, "harnesses/contract.ts", "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), []);
});

test("harness wire imports stop at their adapters", () => {
  assert.deepEqual(findForbiddenImports(), []);
});
