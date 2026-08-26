import { createClaudeHarness } from "./claude-harness.ts";
import { createCodexHarness } from "./codex-harness.ts";
import { createHarnessRegistry, type HarnessRegistry } from "./harness.ts";
import { createPiHarness } from "./pi-harness.ts";

/**
 * The only production edge that composes concrete backends. Core feature and
 * tool registration receives the resulting public registry and never names an
 * adapter.
 */
export function createDefaultHarnessRegistry(): HarnessRegistry {
  return createHarnessRegistry([
    createPiHarness(),
    createClaudeHarness(),
    createCodexHarness(),
  ]);
}
