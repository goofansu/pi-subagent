import { createClaudeHarness } from "./harnesses/claude/harness.ts";
import { createCodexHarness } from "./harnesses/codex/harness.ts";
import {
  createHarnessRegistry,
  type HarnessRegistry,
} from "./harnesses/contract.ts";
import { createPiHarness } from "./harnesses/pi/harness.ts";

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
