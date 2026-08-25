import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.dirname(new URL(import.meta.url).pathname);
const coreFiles = [
  "runner.ts",
  "run.ts",
  "types.ts",
  "runs.ts",
  "index.ts",
  "render.ts",
  "widget.ts",
  "presentation.ts",
  "messages.ts",
];

test("harness wire imports stop at their adapters", () => {
  const forbidden = [
    "@earendil-works/pi-ai",
    "@anthropic-ai/claude-agent-sdk",
    "./pi-agent.ts",
  ];
  for (const file of coreFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const module of forbidden) {
      assert.equal(
        source.includes(module),
        false,
        `${file} must not import or mention ${module}`,
      );
    }
  }

  const claude = fs.readFileSync(path.join(root, "claude-harness.ts"), "utf8");
  assert.match(claude, /claude-agent-sdk/);
});
