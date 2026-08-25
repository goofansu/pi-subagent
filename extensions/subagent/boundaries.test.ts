import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const adapterNames = new Set([
  "claude-harness.ts",
  "pi-agent.ts",
  "pi-harness.ts",
]);
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
      add(argument && ts.isStringLiteral(argument) ? argument : undefined);
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
  const adapterPaths = new Set(
    [...adapterNames].map((name) => path.join(graphRoot, name)),
  );
  const compositionRoot = path.join(graphRoot, "composition.ts");
  const allowedCompositionImports = new Set([
    path.join(graphRoot, "claude-harness.ts"),
    path.join(graphRoot, "pi-harness.ts"),
  ]);
  // Deriving this list keeps a newly added core module from silently escaping
  // the boundary check. Adapter implementations are the only production
  // modules excluded from the core graph; the composition root is allowed to
  // register those adapters and no other core module may import them.
  const coreFiles = fs
    .readdirSync(graphRoot)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !adapterNames.has(file),
    )
    .map((file) => path.join(graphRoot, file));
  const visited = new Set<string>();
  const violations: string[] = [];

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
    import type { Fact } from "./run.ts";
  `;
  assert.deepEqual(readImportSpecifiers(source), ["./run.ts"]);
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
