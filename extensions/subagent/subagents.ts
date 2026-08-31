/**
 * Session-scoped Subagent ownership.
 *
 * A Subagent is the stable identity above its sequential Runs. This manager is the
 * sole owner of its Profile association, prepared Harness adapter, lifecycle,
 * and active-Run relationship. The Dispatcher still owns every Run record and
 * terminal transition.
 */

import type { HarnessAdapter, HarnessRegistry } from "./harnesses/contract.ts";
import type { ParentModel, SubagentContext } from "./run.ts";
import {
  assertSubagentDepthAvailable,
  dispatchSubagentRun,
  getSubagentDepth,
} from "./runner.ts";
import type { SubagentRuns } from "./runs.ts";
import {
  type AgentConfig,
  DEFAULT_HARNESS_NAME,
  type SingleResult,
} from "./types.ts";

export type SubagentState =
  | { phase: "running"; activeRunId: string }
  | { phase: "idle" }
  | { phase: "closed" };

interface ManagedSubagent {
  readonly id: string;
  readonly agent: string;
  readonly config: AgentConfig;
  readonly harness: string;
  readonly adapter: HarnessAdapter;
  admittingRun: boolean;
  state: SubagentState;
}

export interface StartManagedSubagentOptions {
  config: AgentConfig;
  description: string;
  prompt: string;
  parentModel?: ParentModel;
  projectTrusted?: boolean;
  cwd?: string;
  now?: () => number;
}

export interface StartedManagedSubagent {
  /** Stable Session-scoped identity retained after the first Run settles. */
  readonly subagentId: string;
  /** Identity of the first Run. */
  readonly runId: string;
  readonly settled: Promise<SingleResult>;
}

export interface ResumeManagedSubagentOptions {
  subagentId: string;
  description: string;
  prompt: string;
}

export type ResumeManagedSubagentOutcome =
  | {
      outcome: "started";
      runId: string;
      agent: string;
      settled: Promise<SingleResult>;
    }
  | {
      outcome:
        | "unknown subagent"
        | "already running"
        | "unsupported"
        | "conversation lost";
    };

export interface SubagentManager {
  /** Atomically create one running Subagent and its first active Run. */
  start(options: StartManagedSubagentOptions): StartedManagedSubagent;
  /** Atomically claim an idle Subagent and immediately start its next Run. */
  resume(options: ResumeManagedSubagentOptions): ResumeManagedSubagentOutcome;
  /** Close all Subagents after synchronously closing admission to the Session. */
  shutdown(): Promise<void>;
}

export interface SubagentManagerOptions {
  harnesses: HarnessRegistry;
  runs: SubagentRuns;
  /** Injected only for deterministic identity tests. */
  generateSubagentId?: () => string;
  /** Shared Run clock; individual manager calls may override it in tests. */
  now?: () => number;
}

function localSubagentId(): string {
  return `subagent-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

async function closeAdapter(adapter: HarnessAdapter): Promise<void> {
  try {
    await adapter.close();
  } catch {
    // Closing is cleanup. It cannot reopen a closed Subagent or alter a Run.
  }
}

export function createSubagentManager({
  harnesses,
  runs,
  generateSubagentId = localSubagentId,
  now = Date.now,
}: SubagentManagerOptions): SubagentManager {
  const subagents = new Map<string, ManagedSubagent>();
  const issuedIds = new Set<string>();

  const nextSubagentId = (): string => {
    let id = generateSubagentId();
    while (issuedIds.has(id)) id = generateSubagentId();
    issuedIds.add(id);
    return id;
  };

  const observeSettlement = (
    record: ManagedSubagent,
    runId: string,
    settled: Promise<SingleResult>,
  ): void => {
    const becomeIdle = (): void => {
      if (
        record.state.phase === "running" &&
        record.state.activeRunId === runId
      ) {
        record.state = { phase: "idle" };
      }
    };
    void settled.then(becomeIdle, becomeIdle);
  };

  return {
    start({
      config,
      description,
      prompt,
      parentModel,
      projectTrusted = false,
      cwd = process.cwd(),
      now: runNow = now,
    }) {
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
      const subagentId = nextSubagentId();
      let started: ReturnType<typeof dispatchSubagentRun>;
      try {
        started = dispatchSubagentRun({
          subagentId,
          agent: config.name,
          harness: selectedHarness.name,
          description,
          prompt,
          adapter,
          runs,
          now: runNow,
        });
      } catch (error) {
        void closeAdapter(adapter);
        throw error;
      }

      const record: ManagedSubagent = {
        id: subagentId,
        agent: config.name,
        config,
        harness: selectedHarness.name,
        adapter,
        admittingRun: false,
        state: { phase: "running", activeRunId: started.id },
      };
      subagents.set(subagentId, record);
      observeSettlement(record, started.id, started.settled);

      return {
        subagentId,
        runId: started.id,
        settled: started.settled,
      };
    },

    resume({ subagentId, description, prompt }) {
      const record = subagents.get(subagentId);
      if (!record || record.state.phase === "closed") {
        return { outcome: "unknown subagent" };
      }
      if (record.state.phase === "running" || record.admittingRun) {
        return { outcome: "already running" };
      }
      // This synchronous claim is the linearization point for concurrent
      // resume calls. No queue exists: every loser returns before adapter
      // admission or provider work.
      record.admittingRun = true;
      let started: ReturnType<typeof dispatchSubagentRun>;
      try {
        const task = { description, prompt };
        const admission = record.adapter.admitResume(task);
        if (admission.outcome !== "admitted") {
          record.admittingRun = false;
          return { outcome: admission.outcome };
        }
        started = dispatchSubagentRun({
          subagentId: record.id,
          agent: record.agent,
          harness: record.harness,
          description,
          prompt,
          adapter: record.adapter,
          preparedRun: admission.run,
          runs,
          now,
        });
      } catch (error) {
        record.admittingRun = false;
        throw error;
      }
      record.admittingRun = false;
      record.state = { phase: "running", activeRunId: started.id };
      observeSettlement(record, started.id, started.settled);
      return {
        outcome: "started",
        runId: started.id,
        agent: record.agent,
        settled: started.settled,
      };
    },

    shutdown() {
      const closing = [...subagents.values()];
      const activeRunIds = closing.flatMap((subagent) =>
        subagent.state.phase === "running" ? [subagent.state.activeRunId] : [],
      );
      // Closed is the linearization point: cancellation or settlement below
      // can no longer move any record back to idle.
      for (const subagent of closing) subagent.state = { phase: "closed" };
      runs.cancel(activeRunIds, "shutdown");

      subagents.clear();
      issuedIds.clear();
      return Promise.all(
        closing.map((subagent) => closeAdapter(subagent.adapter)),
      ).then(() => undefined);
    },
  };
}
