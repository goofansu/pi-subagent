/**
 * Neutral repository tooling for import-boundary checks.
 *
 * Both extension trees enforce import rules with a test that walks a source
 * graph, so the syntax-based specifier reader lives here rather than inside
 * either tree: the v2 boundary test must not import a v1 test file to get it,
 * and the v1 boundary test must not import anything from v2.
 *
 * Reading specifiers from syntax rather than from a regular expression is the
 * whole point. Comments and ordinary string literals that happen to look like
 * module paths are not import edges, and a dynamic `import()` or `require()`
 * with a static string argument is.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Read module specifiers from syntax, not arbitrary strings or comments. */
export function readImportSpecifiers(source: string): string[] {
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

/**
 * Resolve a relative specifier to the source file it names, or `undefined` for
 * a bare package specifier or a path with no file behind it. Package
 * specifiers are the caller's business: a boundary rule about `effect` or a
 * provider SDK reads the raw specifier instead.
 */
export function resolveRelativeSource(
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

/**
 * Every TypeScript source under a tree, in stable order.
 *
 * `includeTests` is the only thing the two boundary checks disagree about: the
 * v1 rules are about the production graph, while the v2 rules also apply to
 * tests, which are v2 code and must not reach into v1 either.
 */
export function listSourceFiles(
  dir: string,
  { includeTests }: { includeTests: boolean },
): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...listSourceFiles(full, { includeTests }));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (!includeTests && entry.name.endsWith(".test.ts")) continue;
    files.push(full);
  }
  return files.sort();
}

/** Write one fixture source, creating the directories it needs. */
export function writeSourceFile(
  rootDir: string,
  relative: string,
  source: string,
): void {
  const dest = path.join(rootDir, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, source);
}
