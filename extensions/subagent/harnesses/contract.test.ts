import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentDelivery } from "../delivery.ts";
import { formatNotification } from "../presentation.ts";
import type { RunControl, SubagentExecutor } from "../run.ts";
import { startSubagent } from "../runner.ts";
import { createSubagentRuns } from "../runs.ts";
import type { AgentConfig } from "../types.ts";
import { renderRunLines } from "../widget.ts";
import {
  type HarnessConformanceFixture,
  type HarnessConformanceRig,
  type HarnessConformanceScenario,
  runHarnessConformance,
} from "./conformance.ts";
import type { Harness } from "./contract.ts";
import {
  createHarnessRegistry,
  parseTools,
  shouldAppendSystemPrompt,
  validateCommonProfileFields,
} from "./contract.ts";

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
      supportedControls: [],
      execute: async (run) => {
        await onRun(run.signal);
        return run.signal?.aborted
          ? { ending: "cancelled" }
          : { ending: "answered" };
      },
    }),
  };
}

function fakeExecutorHarness(
  execute: SubagentExecutor,
  supportedControls: readonly RunControl["type"][] = [],
): Harness {
  return {
    name: "fake",
    validate: () => [],
    prepare: () => ({ execute, supportedControls }),
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
        harness: fakeExecutorHarness(execute, steering ? ["steer"] : []),
        expected,
        ...(readyForCancellation ? { readyForCancellation } : {}),
        ...(steering ? { steering } : {}),
        depthProbe: () => childDepth,
      });

      switch (scenario) {
        case "backend-crash":
          return base(
            async (run) => {
              childDepth = run.task.childDepth;
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
              childDepth = run.task.childDepth;
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
              childDepth = run.task.childDepth;
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
              childDepth = run.task.childDepth;
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
            async (run) => {
              childDepth = run.task.childDepth;
              return { ending: "answered" };
            },
            { phase: "completed", childDepth: 1 },
          );
        case "config-immutable":
          return base(
            async (run) => {
              childDepth = run.task.childDepth;
              return { ending: "answered" };
            },
            { phase: "completed" },
          );
        case "no-terminal-answer":
          return base(
            async (run) => {
              childDepth = run.task.childDepth;
              return { ending: "failed", errorMessage: "fake missing answer" };
            },
            { phase: "failed", errorMessage: "fake missing answer" },
          );
        case "post-answer-failure":
          return base(
            async (run) => {
              childDepth = run.task.childDepth;
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
              childDepth = run.task.childDepth;
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
        case "steering-fifo-consumed": {
          const offeredTexts =
            scenario === "steering-single-consumed"
              ? ["first guidance"]
              : ["first guidance", "second guidance"];
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
          return base(
            async (run) => {
              openReady();
              const controls = run.controls[Symbol.asyncIterator]();
              for (const expectedText of offeredTexts) {
                const next = await controls.next();
                assert.equal(next.done, false);
                assert.equal(next.value?.type, "steer");
                assert.equal(next.value?.text, expectedText);
                providerControlStarts++;
                activeProviderControls++;
                maxConcurrentProviderControls = Math.max(
                  maxConcurrentProviderControls,
                  activeProviderControls,
                );
                receivedTexts.push(next.value.text);
                if (providerControlStarts === 1)
                  await firstProviderControlResponse;
                run.report.message({
                  role: "user",
                  parts: [
                    { type: "text", text: `confirmed: ${next.value.text}` },
                  ],
                });
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
              userFactTexts: offeredTexts.map((text) => `confirmed: ${text}`),
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
            },
          );
        }
      }
    },
  };
}

runHarnessConformance(conformanceRig());

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
  delivery.register(started.id, profile.name, started.settled);
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

test("a Codex-like harness compiles and runs through the unchanged one-shot core", async () => {
  const codex: Harness = {
    name: "codex",
    validate: () => [],
    prepare: () => ({
      supportedControls: [],
      execute: async (run) => {
        run.report.message({
          role: "assistant",
          parts: [{ type: "text", text: "codex fixture" }],
        });
        return { ending: "answered" };
      },
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
