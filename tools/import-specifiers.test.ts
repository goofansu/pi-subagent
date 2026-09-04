import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  hasComputedImport,
  readImportSpecifiers,
  resolveRelativeSource,
} from "./import-specifiers.ts";

test("static imports, type-only imports, and re-exports are import edges", () => {
  const source = [
    'import runner from "./runner.ts";',
    'import type { Fact } from "./run.ts";',
    'export { createRuns } from "./runs.ts";',
    'export * from "./types.ts";',
    'import legacy = require("./legacy.ts");',
    "void runner;",
  ].join("\n");

  assert.deepEqual(readImportSpecifiers(source), [
    "./runner.ts",
    "./run.ts",
    "./runs.ts",
    "./types.ts",
    "./legacy.ts",
  ]);
});

test("dynamic import and require with a static string are import edges", () => {
  const source = [
    'await import("./a.ts");',
    "await import(`./b.ts`);",
    'require("./c.ts");',
    'module.require("./d.ts");',
    'module["require"]("./e.ts");',
  ].join("\n");

  assert.deepEqual(readImportSpecifiers(source), [
    "./a.ts",
    "./b.ts",
    "./c.ts",
    "./d.ts",
    "./e.ts",
  ]);
});

test("comments, string literals, and computed specifiers are not import edges", () => {
  const source = `
    // import "./commented.ts";
    /* import "./blocked.ts"; */
    const text = "./quoted.ts";
    const name = "runner";
    await import(\`./\${name}.ts\`);
    void text;
  `;

  assert.deepEqual(readImportSpecifiers(source), []);
});

test("relative specifiers resolve to files, extensionless paths, and directory indexes", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-specifier-resolve-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const importer = path.join(root, "importer.ts");
  fs.writeFileSync(importer, "export {};\n");
  fs.writeFileSync(path.join(root, "sibling.ts"), "export {};\n");
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "index.ts"), "export {};\n");

  assert.equal(
    resolveRelativeSource(importer, "./sibling.ts"),
    path.join(root, "sibling.ts"),
  );
  assert.equal(
    resolveRelativeSource(importer, "./sibling"),
    path.join(root, "sibling.ts"),
  );
  assert.equal(
    resolveRelativeSource(importer, "./nested"),
    path.join(root, "nested", "index.ts"),
  );
  assert.equal(resolveRelativeSource(importer, "./missing.ts"), undefined);
});

test("package specifiers resolve to nothing so callers match them by name", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-specifier-package-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const importer = path.join(root, "importer.ts");
  fs.writeFileSync(importer, "export {};\n");

  assert.equal(resolveRelativeSource(importer, "effect"), undefined);
  assert.equal(resolveRelativeSource(importer, "effect/testing"), undefined);
  assert.equal(resolveRelativeSource(importer, "node:fs"), undefined);
});

test("a computed dynamic import is reported, and a literal one is not", () => {
  // The specifier reader drops a computed edge, which is the only honest thing
  // it can do — the argument is an expression. This is how a caller finds out
  // that it dropped one.
  assert.equal(hasComputedImport('await import("./a.ts");'), false);
  assert.equal(hasComputedImport("await import(`./a.ts`);"), false);
  assert.equal(hasComputedImport('require("./a.ts");'), false);

  assert.equal(hasComputedImport("await import(where);"), true);
  // The fixture is source code, and the placeholder is the whole point: a
  // template with a substitution is precisely the computed specifier this
  // reports.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: see above
  assert.equal(hasComputedImport("await import(`./${name}.ts`);"), true);
  assert.equal(
    hasComputedImport('await import(new URL("./a.ts", x).href);'),
    true,
  );
  assert.equal(hasComputedImport("require(where);"), true);

  // Not an import at all, and not reported as one.
  assert.equal(hasComputedImport('const s = "await import(where)";'), false);
  assert.equal(hasComputedImport("// await import(where)"), false);
  assert.equal(hasComputedImport("importSomething(where);"), false);
});
