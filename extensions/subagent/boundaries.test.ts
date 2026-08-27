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
  "@earendil-works/pi-ai",
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

/** Walk a source root with the same production parser and resolver used below.
 * A root parameter lets the regression test supply a disposable graph without
 * writing a fake checker or mutating the working tree. */
export function findForbiddenImports(graphRoot: string = root): string[] {
  const sourceFiles = fs
    .readdirSync(graphRoot)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  // Adapter modules are identified by the production naming convention, not
  // a frozen inventory. pi-agent.ts predates the -harness.ts convention and
  // remains the explicit Pi adapter exception. The Codex App Server transport
  // is also adapter-owned, despite being a transport module rather than a
  // harness. The neutral process source remains core and is still walked for
  // forbidden imports.
  const isHarnessAdapter = (file: string): boolean => {
    const name = path.basename(file);
    return name.endsWith("-harness.ts") || name === "pi-agent.ts";
  };
  const isAdapter = (file: string): boolean =>
    isHarnessAdapter(file) || file === "codex-app-server.ts";
  const adapterPaths = new Set(
    sourceFiles.filter(isAdapter).map((file) => path.join(graphRoot, file)),
  );
  const adapterOwnership = (
    file: string,
  ): "claude" | "pi" | "codex" | "other" => {
    const name = path.basename(file);
    if (name === "claude-harness.ts") return "claude";
    if (name === "pi-harness.ts" || name === "pi-agent.ts") return "pi";
    if (name === "codex-harness.ts" || name === "codex-app-server.ts")
      return "codex";
    return "other";
  };
  const compositionRoot = path.join(graphRoot, "composition.ts");
  // Only direct adapter imports from the composition root are allowed. This
  // registration shape keeps composition the sole adapter edge.
  const allowedCompositionImports = new Set(
    fs.existsSync(compositionRoot)
      ? readImportSpecifiers(fs.readFileSync(compositionRoot, "utf8"))
          .map((specifier) => resolveSourceFile(compositionRoot, specifier))
          .filter((file): file is string => file !== undefined)
          .filter((file) => adapterPaths.has(file))
          .filter((file) => isHarnessAdapter(file))
      : [],
  );
  const coreFiles = sourceFiles
    .filter((file) => !adapterPaths.has(path.join(graphRoot, file)))
    .map((file) => path.join(graphRoot, file));
  const visited = new Set<string>();
  const violations: string[] = [];

  // Adapter modules are the only place backend wire types may appear. Check
  // ownership explicitly rather than treating every adapter as an opaque hole
  // in the graph: a crossed import must fail even when both adapters are
  // otherwise excluded from the core walk.
  for (const adapter of adapterPaths) {
    const owner = adapterOwnership(adapter);
    for (const specifier of readImportSpecifiers(
      fs.readFileSync(adapter, "utf8"),
    )) {
      const importsClaude =
        specifier === "@anthropic-ai/claude-agent-sdk" ||
        specifier.startsWith("@anthropic-ai/claude-agent-sdk/");
      const importsPi =
        specifier === "@earendil-works/pi-ai" ||
        specifier.startsWith("@earendil-works/pi-ai/");
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
        adapterOwnership(adapter) !== adapterOwnership(target)
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
    const text = "./pi-agent.ts";
    const name = "pi-agent";
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
  fs.writeFileSync(
    path.join(fixtureRoot, "runner.ts"),
    [
      "await import(`./codex-harness.ts`);",
      'module.require("./codex-harness.ts");',
      'module["require"]("./codex-harness.ts");',
    ].join("\n"),
  );
  fs.writeFileSync(path.join(fixtureRoot, "codex-harness.ts"), "export {};");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter codex-harness.ts",
    "runner.ts imports forbidden harness adapter codex-harness.ts",
    "runner.ts imports forbidden harness adapter codex-harness.ts",
  ]);
});

test("static CommonJS require edges are checked like imports", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-require-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "runner.ts"),
    'const adapter = require("./codex-harness.ts");\nvoid adapter;\n',
  );
  fs.writeFileSync(path.join(fixtureRoot, "codex-harness.ts"), "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter codex-harness.ts",
  ]);
});

test("adapter discovery follows the harness naming convention", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "composition.ts"),
    'import "./codex-harness.ts";\n',
  );
  fs.writeFileSync(path.join(fixtureRoot, "codex-harness.ts"), "export {};\n");
  fs.writeFileSync(
    path.join(fixtureRoot, "runner.ts"),
    'import "./codex-harness.ts";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter codex-harness.ts",
  ]);
});

test("the production graph checker catches a controlled forbidden adapter edge", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "runner.ts"),
    'import "./pi-agent.ts";\n',
  );
  fs.writeFileSync(path.join(fixtureRoot, "pi-agent.ts"), "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter pi-agent.ts",
  ]);
});

test("core-to-SDK package edges are forbidden too", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-sdk-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "runner.ts"),
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden package @anthropic-ai/claude-agent-sdk",
  ]);
});

test("each named adapter may import only its owned wire", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-owned-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "claude-harness.ts"),
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "pi-agent.ts"),
    'import "@earendil-works/pi-ai";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), []);
});

test("crossed Claude and Pi adapter wire imports are rejected", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-crossed-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "composition.ts"),
    'import "./claude-harness.ts"; import "./pi-harness.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "claude-harness.ts"),
    'import "@earendil-works/pi-ai";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "pi-harness.ts"),
    'import "@anthropic-ai/claude-agent-sdk";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "claude-harness.ts imports forbidden Pi wire package @earendil-works/pi-ai",
    "pi-harness.ts imports forbidden Claude SDK package @anthropic-ai/claude-agent-sdk",
  ]);
});

test("core cannot import the Codex App Server transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-core-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "runner.ts"),
    'import "./codex-app-server.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-app-server.ts"),
    "export {};\n",
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "runner.ts imports forbidden harness adapter codex-app-server.ts",
  ]);
});

test("a foreign Claude adapter cannot import the Codex transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-claude-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "claude-harness.ts"),
    'import "./codex-app-server.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-app-server.ts"),
    "export {};\n",
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "claude-harness.ts imports forbidden foreign adapter codex-app-server.ts",
  ]);
});

test("an unclassified adapter cannot import the Codex transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-other-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "mystery-harness.ts"),
    'import "./codex-app-server.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-app-server.ts"),
    "export {};\n",
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "mystery-harness.ts imports forbidden foreign adapter codex-app-server.ts",
  ]);
});

test("the Codex harness may import its Codex-owned transport", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-codex-transport-owned-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "composition.ts"),
    'import "./codex-harness.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-harness.ts"),
    'import "./codex-app-server.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-app-server.ts"),
    "export {};\n",
  );

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
  fs.writeFileSync(
    path.join(fixtureRoot, "composition.ts"),
    'import "./codex-app-server.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-app-server.ts"),
    "export {};\n",
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "composition.ts imports forbidden harness adapter codex-app-server.ts",
  ]);
});

test("an unclassified adapter cannot import either wire", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-other-adapter-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "codex-harness.ts"),
    'import "@earendil-works/pi-ai"; import "@anthropic-ai/claude-agent-sdk";\n',
  );

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "codex-harness.ts imports forbidden Pi wire package @earendil-works/pi-ai",
    "codex-harness.ts imports forbidden Claude SDK package @anthropic-ai/claude-agent-sdk",
  ]);
});

test("only the composition registration edge may import adapters", (t) => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-boundary-composition-"),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(fixtureRoot, "composition.ts"),
    'import "./pi-harness.ts";\n',
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "index.ts"),
    'import "./pi-harness.ts";\n',
  );
  fs.writeFileSync(path.join(fixtureRoot, "pi-harness.ts"), "export {};\n");

  assert.deepEqual(findForbiddenImports(fixtureRoot), [
    "index.ts imports forbidden harness adapter pi-harness.ts",
  ]);
});

test("harness wire imports stop at their adapters", () => {
  assert.deepEqual(findForbiddenImports(), []);
});
