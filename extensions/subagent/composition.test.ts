import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultHarnessRegistry } from "./composition.ts";
import { createHarnessRegistry } from "./harness.ts";
import { createPiHarness } from "./pi-harness.ts";

test("default composition registers the pi, claude, and codex harnesses", () => {
  const registry = createDefaultHarnessRegistry();

  assert.ok(registry.get("pi"));
  assert.ok(registry.get("claude"));
  assert.ok(registry.get("codex"));
  assert.equal(registry.get("unknown"), undefined);
});

test("Pi-only composition keeps the core registry executable without Claude", () => {
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
