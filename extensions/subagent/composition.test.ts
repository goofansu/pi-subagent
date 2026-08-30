import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultHarnessRegistry } from "./composition.ts";
import { createHarnessRegistry } from "./harnesses/contract.ts";
import { createPiHarness } from "./harnesses/pi/harness.ts";

test("default composition truthfully enables only production Codex resume", async () => {
  const registry = createDefaultHarnessRegistry();

  assert.ok(registry.get("pi"));
  assert.ok(registry.get("claude"));
  const codex = registry.get("codex");
  assert.ok(codex);
  assert.equal(registry.get("unknown"), undefined);

  const adapter = codex.prepare({
    config: {
      name: "codex",
      description: "codex",
      harness: "codex",
      fields: {},
      systemPrompt: "work",
    },
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  });
  assert.deepEqual(adapter.capabilities, { resume: true });
  await adapter.close();

  for (const name of ["pi", "claude"] as const) {
    const harness = registry.get(name);
    assert.ok(harness);
    const unsupported = harness.prepare({
      config: {
        name,
        description: name,
        harness: name,
        fields: {},
        systemPrompt: "work",
      },
      cwd: "/work",
      childDepth: 1,
      projectTrusted: false,
    });
    assert.deepEqual(unsupported.capabilities, { resume: false });
    await unsupported.close();
  }
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
