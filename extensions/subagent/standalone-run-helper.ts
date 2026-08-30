/** Standalone one-Run composition used only by Dispatcher/Harness tests. */

import type { HarnessAdapter, HarnessRegistry } from "./harnesses/contract.ts";
import type { ParentModel, SubagentContext } from "./run.ts";
import {
  assertSubagentDepthAvailable,
  dispatchSubagentRun,
  getSubagentDepth,
  type StartedSubagent,
} from "./runner.ts";
import type { SubagentRuns } from "./runs.ts";
import { type AgentConfig, DEFAULT_HARNESS_NAME } from "./types.ts";

export interface RunSubagentOptions {
  config: AgentConfig;
  description: string;
  prompt: string;
  signal?: AbortSignal;
  parentModel?: ParentModel;
  projectTrusted?: boolean;
  cwd?: string;
  harnesses: HarnessRegistry;
  runs: SubagentRuns;
  now?: () => number;
}

async function closeAdapter(adapter: HarnessAdapter): Promise<void> {
  try {
    await adapter.close();
  } catch {
    // Test composition preserves the production rule that close cannot alter a Run.
  }
}

export function startSubagent({
  config,
  description,
  prompt,
  signal,
  parentModel,
  projectTrusted = false,
  cwd = process.cwd(),
  harnesses,
  runs,
  now = Date.now,
}: RunSubagentOptions): StartedSubagent {
  const currentDepth = getSubagentDepth();
  assertSubagentDepthAvailable(currentDepth);

  const harnessName = config.harness ?? DEFAULT_HARNESS_NAME;
  const selectedHarness = harnesses.get(harnessName);
  if (!selectedHarness) {
    throw new Error(`No harness registered for '${harnessName}'`);
  }

  const context: SubagentContext = {
    config,
    cwd,
    childDepth: currentDepth + 1,
    projectTrusted,
    ...(parentModel ? { parentModel } : {}),
  };
  const adapter = selectedHarness.prepare(context);
  let started: StartedSubagent;
  try {
    started = dispatchSubagentRun({
      subagentId: "subagent-unmanaged",
      agent: config.name,
      harness: selectedHarness.name,
      description,
      prompt,
      adapter,
      ...(signal ? { signal } : {}),
      runs,
      now,
    });
  } catch (error) {
    void closeAdapter(adapter);
    throw error;
  }
  return {
    id: started.id,
    settled: started.settled.finally(() => closeAdapter(adapter)),
  };
}
