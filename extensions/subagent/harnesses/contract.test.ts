import assert from "node:assert/strict";
import { test } from "node:test";
import { type ControlAdmission, createControlGate } from "../control-source.ts";
import { createSubagentDelivery } from "../delivery.ts";
import { formatNotification } from "../presentation.ts";
import type {
  Fact,
  RunControl,
  RunEnding,
  RunReporter,
  SubagentContext,
  SubagentExecutor,
  SubagentRun,
  SubagentTask,
} from "../run.ts";
import { createSubagentRuns } from "../runs.ts";
import { startSubagent } from "../standalone-run-helper.ts";
import type { AgentConfig, SingleResult } from "../types.ts";
import { renderRunLines } from "../widget.ts";
import { createClaudeHarness } from "./claude/harness.ts";
import { createCodexHarness } from "./codex/harness.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "./conformance.ts";
import type {
  Harness,
  HarnessAdapter,
  HarnessResumeAdmission,
  HarnessRun,
} from "./contract.ts";
import {
  createHarnessRegistry,
  parseTools,
  shouldAppendSystemPrompt,
  validateCommonProfileFields,
} from "./contract.ts";
import { createPiHarness } from "./pi/harness.ts";

// These assertions are intentionally type-level: runtime key checks cannot
// stop a future optional send/steer/session member from widening the contract.
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;
type HarnessContractKeys = Assert<
  Equal<keyof Harness, "name" | "validate" | "prepare">
>;
type HarnessAdapterContractKeys = Assert<
  Equal<keyof HarnessAdapter, "model" | "prepareRun" | "admitResume" | "close">
>;
type HarnessResumeAdmissionContract = Assert<
  Equal<
    HarnessResumeAdmission,
    | { readonly outcome: "admitted"; readonly run: HarnessRun }
    | { readonly outcome: "unsupported" }
    | { readonly outcome: "conversation lost" }
  >
>;
type HarnessRunContractKeys = Assert<
  Equal<keyof HarnessRun, "execute" | "supportedControls">
>;
type SubagentContextContractKeys = Assert<
  Equal<
    keyof SubagentContext,
    "config" | "cwd" | "childDepth" | "projectTrusted" | "parentModel"
  >
>;
type SubagentTaskContractKeys = Assert<
  Equal<keyof SubagentTask, "description" | "prompt">
>;
type SubagentRunContractKeys = Assert<
  Equal<keyof SubagentRun, "report" | "signal" | "controls">
>;
type FactContractKeys = Assert<
  Equal<
    keyof Fact,
    "role" | "parts" | "usage" | "model" | "stopReason" | "errorMessage"
  >
>;
type RunEndingContract = Assert<
  Equal<
    RunEnding,
    | { ending: "answered" }
    | { ending: "failed"; errorMessage?: string }
    | { ending: "cancelled" }
  >
>;
type SingleResultContractKeys = Assert<
  Equal<
    keyof SingleResult,
    | "agent"
    | "subagentId"
    | "harness"
    | "description"
    | "lifecycle"
    | "startedAt"
    | "messages"
    | "stderr"
    | "usage"
    | "activity"
    | "liveActivity"
    | "model"
    | "stopReason"
    | "errorMessage"
  >
>;

// Keep the aliases above instantiated under noUnusedLocals configurations.
const contractKeyAssertions: [
  HarnessContractKeys,
  HarnessAdapterContractKeys,
  HarnessResumeAdmissionContract,
  HarnessRunContractKeys,
  SubagentContextContractKeys,
  SubagentTaskContractKeys,
  SubagentRunContractKeys,
  FactContractKeys,
  RunEndingContract,
  SingleResultContractKeys,
] = [true, true, true, true, true, true, true, true, true, true];

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const profile: AgentConfig = {
  name: "fake",
  description: "fake",
  harness: "fake",
  fields: {},
  systemPrompt: "work",
};

const contractContext: SubagentContext = {
  config: profile,
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
  parentModel: { provider: "test", id: "parent" },
};

const contractTask: SubagentTask = {
  description: "contract run",
  prompt: "exercise the contract",
};

async function assertHarnessContract(
  harness: Harness,
  supportedControls: HarnessRun["supportedControls"],
): Promise<void> {
  assert.deepEqual(Object.keys(harness).sort(), [
    "name",
    "prepare",
    "validate",
  ]);
  const adapter = harness.prepare(contractContext);
  assert.equal(typeof adapter.close, "function");
  const prepared = adapter.prepareRun(contractTask);
  assert.equal(typeof prepared.execute, "function");
  assert.deepEqual(prepared.supportedControls, supportedControls);
  assert.deepEqual(Object.keys(prepared).sort(), [
    "execute",
    "supportedControls",
  ]);
  assert.deepEqual(Object.keys(adapter).sort(), [
    "admitResume",
    "close",
    "model",
    "prepareRun",
  ]);
  const admission = adapter.admitResume(contractTask);
  assert.equal("then" in admission, false, "Resume admission is synchronous");
  assert.equal(admission.outcome, "admitted");
  if (admission.outcome === "admitted") {
    assert.equal(typeof admission.run.execute, "function");
    assert.deepEqual(admission.run.supportedControls, supportedControls);
  }
  assert.equal("send" in adapter, false);
  assert.equal("steer" in adapter, false);
  assert.equal("session" in adapter, false);
  assert.equal("thread" in adapter, false);
  assert.equal("continuation" in adapter, false);
  assert.equal("capabilities" in adapter, false);
  await adapter.close();
  await adapter.close();
}

test("production Harnesses expose the exact managed Run contract", async () => {
  assert.deepEqual(Object.keys(contractContext).sort(), [
    "childDepth",
    "config",
    "cwd",
    "parentModel",
    "projectTrusted",
  ]);
  assert.deepEqual(Object.keys(contractTask).sort(), ["description", "prompt"]);
  assert.equal("send" in contractTask, false);
  assert.equal("steer" in contractTask, false);
  assert.equal("session" in contractTask, false);
  assert.deepEqual(contractKeyAssertions, [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);

  await assertHarnessContract(createPiHarness(), ["steer"]);
  await assertHarnessContract(
    createClaudeHarness(async () => {
      throw new Error("execution is not part of this contract fixture");
    }),
    ["steer"],
  );
  await assertHarnessContract(createCodexHarness(), ["steer"]);
});

test("common profile accessors normalize tools and default appendSystemPrompt", () => {
  const config: AgentConfig = {
    ...profile,
    fields: { tools: " read, , grep ,, ", appendSystemPrompt: null },
  };

  assert.deepEqual(parseTools(config, "/agents/fake.md"), ["read", "grep"]);
  assert.deepEqual(
    parseTools({ ...config, fields: { tools: ", ," } }, "/agents/fake.md"),
    [],
  );
  assert.equal(
    parseTools({ ...config, fields: { tools: "" } }, "/agents/fake.md"),
    undefined,
  );
  assert.equal(shouldAppendSystemPrompt(config, "/agents/fake.md"), true);
  assert.equal(
    shouldAppendSystemPrompt(
      { ...config, fields: { appendSystemPrompt: false } },
      "/agents/fake.md",
    ),
    false,
  );
});

test("common profile validation owns the shared field list and model hook", () => {
  const diagnostics = validateCommonProfileFields(
    {
      ...profile,
      fields: { model: "sonnet", unsupported: true },
    },
    "/agents/fake.md",
    {
      displayName: "Fake",
      validateModel: (model) =>
        model === "sonnet" ? undefined : { reason: "bad model" },
    },
  );

  assert.deepEqual(diagnostics, [
    { reason: "Fake harness does not recognize field 'unsupported'" },
  ]);
});

test("one prepared adapter owns private state across independent Runs and closes idempotently", async () => {
  const releases: string[] = [];
  const adapters: HarnessAdapter[] = [];
  const statefulHarness: Harness = {
    name: "stateful",
    validate: () => [],
    prepare: () => {
      const conversation: string[] = [];
      let closed = false;
      const prepareRun: HarnessAdapter["prepareRun"] = (task) => ({
        supportedControls: [],
        execute: async (run) => {
          conversation.push(task.prompt);
          run.report.message({
            role: "assistant",
            parts: [{ type: "text", text: conversation.join(" -> ") }],
          });
          return { ending: "answered" };
        },
      });
      const adapter: HarnessAdapter = {
        model: undefined,
        prepareRun,
        admitResume: (task) => ({ outcome: "admitted", run: prepareRun(task) }),
        close: async () => {
          if (closed) return;
          closed = true;
          releases.push("released");
        },
      };
      adapters.push(adapter);
      return adapter;
    },
  };
  const context = {
    config: profile,
    cwd: "/work",
    childDepth: 1,
    projectTrusted: false,
  };
  const facts: Fact[] = [];
  const report: RunReporter = {
    message: (fact) => facts.push(fact),
    transcript: () => {},
    activity: () => {},
    stderr: () => {},
  };
  const execution: SubagentRun = {
    report,
    signal: new AbortController().signal,
    controls: createControlGate([]).controls,
  };

  const adapter = statefulHarness.prepare(context);
  await adapter
    .prepareRun({ description: "first", prompt: "remember alpha" })
    .execute(execution);
  const admission = adapter.admitResume({
    description: "second",
    prompt: "use beta",
  });
  assert.equal(admission.outcome, "admitted");
  if (admission.outcome !== "admitted") assert.fail("resume was rejected");
  await admission.run.execute({
    ...execution,
    signal: new AbortController().signal,
  });

  assert.deepEqual(
    facts.map((fact) => fact.parts[0]),
    [
      { type: "text", text: "remember alpha" },
      { type: "text", text: "remember alpha -> use beta" },
    ],
  );
  await adapter.close();
  await adapter.close();
  assert.deepEqual(releases, ["released"]);

  const neverExecuted = statefulHarness.prepare(context);
  await neverExecuted.close();
  await neverExecuted.close();
  assert.deepEqual(releases, ["released", "released"]);
  assert.equal(adapters.length, 2);
});

test("a registry without the default harness names the missing adapter", () => {
  const profileWithoutHarness = { ...profile };
  delete profileWithoutHarness.harness;

  assert.deepEqual(
    createHarnessRegistry([]).validate(
      profileWithoutHarness,
      "/agents/default.md",
    ),
    [{ reason: "unknown harness 'pi'" }],
  );
});

function fakeHarness(
  onRun: (signal: AbortSignal | undefined) => Promise<void>,
): Harness {
  return {
    name: "fake",
    validate: () => [],
    prepare: () => ({
      model: undefined,
      prepareRun: () => ({
        supportedControls: [],
        execute: async (run) => {
          await onRun(run.signal);
          return run.signal?.aborted
            ? { ending: "cancelled" }
            : { ending: "answered" };
        },
      }),
      admitResume: () => ({ outcome: "unsupported" }),
      close: async () => {},
    }),
  };
}

function fakeExecutorHarness(
  execute: SubagentExecutor,
  supportedControls: readonly RunControl["type"][] = [],
  onPrepare?: (childDepth: number) => void,
): Harness {
  return {
    name: "fake",
    validate: () => [],
    prepare: (context) => {
      onPrepare?.(context.childDepth);
      return {
        model: undefined,
        prepareRun: () => ({ execute, supportedControls }),
        admitResume: () => ({ outcome: "unsupported" }),
        close: async () => {},
      };
    },
  };
}

function cancellationGate(): {
  ready: Promise<void>;
  open: () => void;
} {
  let open = () => {};
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

function waitForAbort(
  signal: AbortSignal | undefined,
  ready: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) {
      ready();
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
    ready();
  });
}

function conformanceRig(): HarnessConformanceRig {
  return {
    name: "fake",
    build(
      scenario: HarnessConformanceScenario,
    ): HarnessConformanceFixture | undefined {
      let childDepth: number | undefined;
      const base = (
        execute: SubagentExecutor,
        expected: HarnessConformanceFixture["expected"],
        readyForCancellation?: Promise<void>,
        steering?: HarnessConformanceFixture["steering"],
      ): HarnessConformanceFixture => ({
        harness: fakeExecutorHarness(
          execute,
          steering ? ["steer"] : [],
          (depth) => {
            childDepth = depth;
          },
        ),
        expected,
        ...(readyForCancellation ? { readyForCancellation } : {}),
        ...(steering ? { steering } : {}),
        depthProbe: () => childDepth,
      });

      switch (scenario) {
        case "backend-crash":
          return base(
            async () => {
              return {
                ending: "failed",
                errorMessage: "fake backend crashed",
              };
            },
            {
              phase: "failed",
              errorMessage: "fake backend crashed",
            },
          );
        case "abort-mid-run": {
          const gate = cancellationGate();
          return base(
            async (run) => {
              await waitForAbort(run.signal, gate.open);
              return { ending: "cancelled" };
            },
            { phase: "cancelled", cancellationReason: "requested" },
            gate.ready,
          );
        }
        case "terminal-answer-then-abort": {
          const gate = cancellationGate();
          return base(
            async (run) => {
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text: "terminal answer" }],
                stopReason: "stop",
                usage: { turns: 1 },
              });
              await waitForAbort(run.signal, gate.open);
              return { ending: "answered" };
            },
            {
              phase: "completed",
              finalOutput: "terminal answer",
              stopReason: "stop",
              errorMessage: undefined,
            },
            gate.ready,
          );
        }
        case "usage-totals":
          return base(
            async (run) => {
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text: "first turn" }],
                usage: {
                  input: 7,
                  output: 3,
                  cacheRead: 2,
                  cacheWrite: 1,
                  cost: 0.2,
                  contextTokens: 10,
                  turns: 1,
                },
              });
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text: "second turn" }],
                usage: {
                  input: 5,
                  output: 4,
                  cacheRead: 1,
                  cacheWrite: 2,
                  cost: 0.3,
                  contextTokens: 20,
                  turns: 1,
                },
              });
              return { ending: "answered" };
            },
            {
              phase: "completed",
              usage: {
                input: 12,
                output: 7,
                cacheRead: 3,
                cacheWrite: 3,
                cost: 0.5,
                contextTokens: 20,
                turns: 2,
              },
            },
          );
        case "child-depth":
          return base(
            async () => {
              return { ending: "answered" };
            },
            { phase: "completed", childDepth: 1 },
          );
        case "config-immutable":
          return base(
            async () => {
              return { ending: "answered" };
            },
            { phase: "completed" },
          );
        case "no-terminal-answer":
          return base(
            async () => {
              return { ending: "failed", errorMessage: "fake missing answer" };
            },
            { phase: "failed", errorMessage: "fake missing answer" },
          );
        case "post-answer-failure":
          return base(
            async (run) => {
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text: "answer" }],
              });
              return { ending: "answered" };
            },
            {
              phase: "completed",
              finalOutput: "answer",
              errorMessage: undefined,
            },
          );
        case "terminal-transcript-healing":
          return base(
            async (run) => {
              run.report.message({
                role: "assistant",
                parts: [],
                stopReason: "error",
                errorMessage: "stale streamed error",
              });
              run.report.transcript([
                {
                  role: "assistant",
                  parts: [{ type: "text", text: "healed terminal answer" }],
                  stopReason: "stop",
                },
              ]);
              return { ending: "answered" };
            },
            {
              phase: "completed",
              finalOutput: "healed terminal answer",
              stopReason: "stop",
              errorMessage: undefined,
            },
          );
        case "steering-single-consumed":
        case "steering-fifo-consumed":
        case "steering-intermediate-completion":
        case "steering-admission-no-fact": {
          const offeredTexts =
            scenario === "steering-fifo-consumed"
              ? ["first guidance", "second guidance"]
              : ["first guidance"];
          const receivedTexts: string[] = [];
          let activeProviderControls = 0;
          let providerControlStarts = 0;
          let maxConcurrentProviderControls = 0;
          let openReady = () => {};
          const ready = new Promise<void>((resolve) => {
            openReady = resolve;
          });
          let releaseFirstProviderControl = () => {};
          const firstProviderControlResponse = new Promise<void>((resolve) => {
            releaseFirstProviderControl = resolve;
          });
          let openIntermediate = () => {};
          const intermediateCheckpoint = new Promise<void>((resolve) => {
            openIntermediate = resolve;
          });
          return base(
            async (run) => {
              openReady();
              const admissions: ControlAdmission[] = [];
              let resolveAdmission:
                | ((admission: ControlAdmission | undefined) => void)
                | undefined;
              run.controls.subscribe(
                (admission) => {
                  const resolve = resolveAdmission;
                  if (resolve) {
                    resolveAdmission = undefined;
                    resolve(admission);
                  } else {
                    admissions.push(admission);
                  }
                },
                () => {
                  const resolve = resolveAdmission;
                  resolveAdmission = undefined;
                  resolve?.(undefined);
                },
              );
              for (const expectedText of offeredTexts) {
                const admission =
                  admissions.shift() ??
                  (await new Promise<ControlAdmission | undefined>(
                    (resolve) => {
                      resolveAdmission = resolve;
                    },
                  ));
                assert.ok(admission);
                admission.acknowledge();
                assert.equal(admission.control.type, "steer");
                assert.equal(admission.control.text, expectedText);
                providerControlStarts++;
                activeProviderControls++;
                maxConcurrentProviderControls = Math.max(
                  maxConcurrentProviderControls,
                  activeProviderControls,
                );
                receivedTexts.push(admission.control.text);
                if (
                  providerControlStarts === 1 &&
                  scenario === "steering-intermediate-completion"
                ) {
                  run.report.message({
                    role: "assistant",
                    parts: [
                      { type: "text", text: "intermediate provider answer" },
                    ],
                    usage: { turns: 1 },
                  });
                  openIntermediate();
                }
                if (providerControlStarts === 1)
                  await firstProviderControlResponse;
                if (scenario !== "steering-admission-no-fact") {
                  run.report.message({
                    role: "user",
                    parts: [
                      {
                        type: "text",
                        text: `confirmed: ${admission.control.text}`,
                      },
                    ],
                  });
                }
                activeProviderControls--;
              }
              run.report.message({
                role: "assistant",
                parts: [{ type: "text", text: "controlled answer" }],
              });
              return { ending: "answered" };
            },
            {
              phase: "completed",
              finalOutput: "controlled answer",
              userFactTexts:
                scenario === "steering-admission-no-fact"
                  ? []
                  : offeredTexts.map((text) => `confirmed: ${text}`),
            },
            undefined,
            {
              ready,
              offeredTexts,
              expectedOutcome: "accepted",
              release: releaseFirstProviderControl,
              receivedTexts: () => receivedTexts,
              providerControlStarts: () => providerControlStarts,
              maxConcurrentProviderControls: () =>
                maxConcurrentProviderControls,
              ...(scenario === "steering-intermediate-completion"
                ? { intermediateCheckpoint }
                : {}),
            },
          );
        }
      }
    },
  };
}

runHarnessConformance(conformanceRig());

function unsupportedConformanceRig(): HarnessConformanceRig {
  return {
    name: "controlled-unsupported",
    build(scenario) {
      if (!scenario.startsWith("steering-"))
        return conformanceRig().build(scenario);
      let openReady = () => {};
      const ready = new Promise<void>((resolve) => {
        openReady = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let executorStarts = 0;
      const providerControlStarts = 0;
      return {
        harness: fakeExecutorHarness(async (run) => {
          executorStarts++;
          openReady();
          await released;
          run.report.message({
            role: "assistant",
            parts: [{ type: "text", text: "unsupported fixture answer" }],
          });
          return { ending: "answered" };
        }),
        expected: {
          phase: "completed",
          finalOutput: "unsupported fixture answer",
          userFactTexts: [],
        },
        steering: {
          ready,
          offeredTexts:
            scenario === "steering-fifo-consumed"
              ? ["first guidance", "second guidance"]
              : ["first guidance"],
          expectedOutcome: "unsupported",
          release: () => {
            assert.equal(executorStarts, 1, "the unsupported Run must execute");
            assert.equal(providerControlStarts, 0);
            release();
          },
          receivedTexts: () => [],
          providerControlStarts: () => providerControlStarts,
          maxConcurrentProviderControls: () => 0,
          ...(scenario === "steering-intermediate-completion"
            ? { intermediateCheckpoint: ready }
            : {}),
        },
        depthProbe: () => undefined,
      };
    },
  };
}

runHarnessConformance(unsupportedConformanceRig());

test("a fake harness reaches dispatcher, registry, delivery, presentation, and widget", async () => {
  const runs = createSubagentRuns();
  const pushed: string[] = [];
  const delivery = createSubagentDelivery({
    runs,
    push: (notification) => pushed.push(notification.text),
  });
  const harness = fakeHarness(async (signal) => {
    assert.equal(signal?.aborted, false);
  });
  const started = startSubagent({
    config: profile,
    description: "core seam",
    prompt: "go",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  delivery.register(
    started.id,
    profile.name,
    started.settled,
    "subagent-unmanaged",
  );
  const result = await started.settled;
  await delivery.wait([started.id]);

  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.harness, "fake");
  assert.equal(runs.list()[0]?.status, "completed");
  assert.equal(runs.list()[0]?.harness, "fake");
  assert.match(pushed[0] ?? "", /completed/);
  assert.match(formatNotification(started.id, result), /completed/);
  assert.match(
    renderRunLines(runs.list(), plainTheme, 120).join("\\n"),
    /completed/,
  );
  assert.equal(delivery.result(started.id)?.status, "completed");
});

test("a fake harness runs the core seam without a backend dependency", async () => {
  const runs = createSubagentRuns();
  const harness = fakeHarness(async (signal) => {
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const started = startSubagent({
    config: profile,
    description: "test",
    prompt: "go",
    harnesses: createHarnessRegistry([harness]),
    runs,
  });
  runs.cancel([started.id], "requested");
  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "cancelled");
  if (result.lifecycle.phase === "cancelled") {
    assert.equal(result.lifecycle.reason, "requested");
  }
});

test("a Codex-like harness compiles and runs through the unchanged core", async () => {
  const codex: Harness = {
    name: "codex",
    validate: () => [],
    prepare: () => ({
      model: undefined,
      prepareRun: () => ({
        supportedControls: [],
        execute: async (run) => {
          run.report.message({
            role: "assistant",
            parts: [{ type: "text", text: "codex fixture" }],
          });
          return { ending: "answered" };
        },
      }),
      admitResume: () => ({ outcome: "unsupported" }),
      close: async () => {},
    }),
  };
  const started = startSubagent({
    config: { ...profile, harness: "codex" },
    description: "codex fixture",
    prompt: "go",
    harnesses: createHarnessRegistry([codex]),
    runs: createSubagentRuns(),
  });

  const result = await started.settled;
  assert.equal(result.lifecycle.phase, "completed");
  assert.equal(result.messages[0]?.parts[0]?.type, "text");
});
