import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarnessRegistry } from "./harness.ts";
import { createPiHarness } from "./pi-harness.ts";

test("the core registry remains usable with only Pi registered", () => {
  const registry = createHarnessRegistry([createPiHarness()]);
  assert.ok(registry.get("pi"));
  assert.equal(registry.get("claude"), undefined);
  assert.deepEqual(
    registry.validate(
      {
        name: "pi-only",
        description: "pi-only",
        harness: "pi",
        fields: {},
        systemPrompt: "work",
      },
      "/agents/pi-only.md",
      { models: [] },
    ),
    [],
  );
});
