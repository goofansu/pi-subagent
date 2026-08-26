import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeHarness } from "./claude-harness.ts";
import { createCodexHarness } from "./codex-harness.ts";
import type { Harness, HarnessRun } from "./harness.ts";
import { runOneShot, streamSource } from "./one-shot.ts";
import { createPiHarness } from "./pi-harness.ts";
import type { Fact, RunReporter, SubagentTask } from "./run.ts";
import type { AgentConfig } from "./types.ts";

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
type HarnessRunContractKeys = Assert<
  Equal<keyof HarnessRun, "execute" | "model">
>;
type SubagentTaskContractKeys = Assert<
  Equal<
    keyof SubagentTask,
    | "config"
    | "description"
    | "prompt"
    | "cwd"
    | "childDepth"
    | "projectTrusted"
  >
>;

// Keep the aliases above instantiated under noUnusedLocals configurations.
const contractKeyAssertions: [
  HarnessContractKeys,
  HarnessRunContractKeys,
  SubagentTaskContractKeys,
] = [true, true, true];

const config: AgentConfig = {
  name: "worker",
  description: "worker",
  fields: {},
  systemPrompt: "Work.",
};

const task: SubagentTask = {
  config,
  description: "one shot",
  prompt: "do one thing",
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

function assertOneShotContract(harness: Harness): void {
  assert.deepEqual(Object.keys(harness).sort(), [
    "name",
    "prepare",
    "validate",
  ]);
  const prepared = harness.prepare(task);
  assert.equal(typeof prepared.execute, "function");
  assert.equal("send" in harness, false);
  assert.equal("steer" in harness, false);
  assert.equal("session" in harness, false);
}

test("one-shot is an invariant of the public harness/task contract for both adapters", () => {
  assert.deepEqual(Object.keys(task).sort(), [
    "childDepth",
    "config",
    "cwd",
    "description",
    "projectTrusted",
    "prompt",
  ]);
  assert.equal("send" in task, false);
  assert.equal("steer" in task, false);
  assert.equal("session" in task, false);

  assert.deepEqual(contractKeyAssertions, [true, true, true]);
  assertOneShotContract(createPiHarness());
  assertOneShotContract(
    createClaudeHarness(async () => {
      throw new Error("execution is not part of this contract fixture");
    }),
  );
  assertOneShotContract(createCodexHarness());
});

test("runOneShot applies its ending precedence and message rules", async () => {
  const controller = new AbortController();
  const reported: string[] = [];
  const report: RunReporter = {
    message: (fact) => {
      reported.push(`fact:${fact.parts.length}`);
      if (fact.parts.length === 1) controller.abort();
    },
    transcript: (facts) => reported.push(`transcript:${facts.length}`),
    stderr: (chunk) => reported.push(`stderr:${chunk}`),
  };
  const answered = await runOneShot({
    source: async (sink) => {
      sink.event({ answer: true });
      return { status: "failed", errorMessage: "late failure" };
    },
    translate: () => ({
      facts: [{ role: "assistant", parts: [{ type: "text", text: "answer" }] }],
      terminal: true,
    }),
    report,
    signal: controller.signal,
    missingAnswerMessage: "missing",
  });
  assert.deepEqual(answered, { ending: "answered" });
  assert.deepEqual(reported, ["fact:1"]);
});

test("runOneShot exposes only truthful terminal acknowledgements", async () => {
  const controller = new AbortController();
  const acknowledgements: unknown[] = [];
  let settledSink: { event: (event: string) => unknown } | undefined;
  const result = await runOneShot({
    source: async (sink) => {
      settledSink = sink;
      acknowledgements.push(sink.event("ignored"));
      acknowledgements.push(sink.event("progress"));
      acknowledgements.push(sink.event("terminal"));
      controller.abort();
      acknowledgements.push(sink.event("terminal"));
      return { status: "clean" } as const;
    },
    translate: (event) =>
      event === "ignored" ? undefined : { terminal: event === "terminal" },
    report: { message: () => {}, transcript: () => {}, stderr: () => {} },
    signal: controller.signal,
    missingAnswerMessage: "missing",
  });
  acknowledgements.push(settledSink?.event("terminal"));

  assert.deepEqual(result, { ending: "answered" });
  assert.deepEqual(acknowledgements, [
    undefined,
    false,
    true,
    false,
    undefined,
  ]);
});

test("runOneShot distinguishes cancellation, source errors, and missing answers", async () => {
  const makeReport = (): RunReporter => ({
    message: () => {},
    transcript: () => {},
    stderr: () => {},
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await runOneShot({
      source: async () => ({ status: "clean" }),
      translate: () => undefined,
      report: makeReport(),
      signal: controller.signal,
      missingAnswerMessage: "missing",
    }),
    { ending: "cancelled" },
  );
  assert.deepEqual(
    await runOneShot({
      source: async () => {
        throw new Error("source broke");
      },
      translate: () => undefined,
      report: makeReport(),
      missingAnswerMessage: "missing",
    }),
    { ending: "failed", errorMessage: "source broke" },
  );
  assert.deepEqual(
    await runOneShot({
      source: async () => ({ status: "clean" }),
      translate: () => undefined,
      report: makeReport(),
      missingAnswerMessage: "missing",
    }),
    { ending: "failed", errorMessage: "missing" },
  );
});

test("runOneShot rejects translator bugs but resolves source failures", async () => {
  const report: RunReporter = {
    message: () => {},
    transcript: () => {},
    stderr: () => {},
  };
  assert.deepEqual(
    await runOneShot({
      source: async () => {
        throw new Error("source failure");
      },
      translate: () => undefined,
      report,
      missingAnswerMessage: "missing",
    }),
    { ending: "failed", errorMessage: "source failure" },
  );

  const translatorError = new Error("translator bug");
  await assert.rejects(
    runOneShot({
      source: async (sink) => {
        sink.event("wire event");
        return { status: "clean" };
      },
      translate: () => {
        throw translatorError;
      },
      report,
      missingAnswerMessage: "missing",
    }),
    (error) => error === translatorError,
  );
});

test("runOneShot preserves failed conclusion messages, including an absent one", async () => {
  const report: RunReporter = {
    message: () => {},
    transcript: () => {},
    stderr: () => {},
  };
  assert.deepEqual(
    await runOneShot({
      source: async () => ({ status: "failed", errorMessage: "exit detail" }),
      translate: () => undefined,
      report,
      missingAnswerMessage: "missing",
    }),
    { ending: "failed", errorMessage: "exit detail" },
  );
  assert.deepEqual(
    await runOneShot({
      source: async () => ({ status: "failed" }),
      translate: () => undefined,
      report,
      missingAnswerMessage: "missing",
    }),
    { ending: "failed" },
  );
});

test("runOneShot absorbs a source throw after abort as cancelled", async () => {
  const controller = new AbortController();
  const source = async (
    _sink: {
      event: (event: string) => void;
      stderr: (chunk: string) => void;
    },
    signal: AbortSignal,
  ) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw new Error("transport stopped");
  };
  const promise = runOneShot({
    source,
    translate: () => undefined,
    report: { message: () => {}, transcript: () => {}, stderr: () => {} },
    signal: controller.signal,
    missingAnswerMessage: "missing",
  });
  controller.abort();
  assert.deepEqual(await promise, { ending: "cancelled" });
});

test("runOneShot forwards facts, transcripts, and stderr after abort until source settlement", async () => {
  const controller = new AbortController();
  const forwarded: string[] = [];
  const source = async (sink: {
    event: (event: string) => void;
    stderr: (chunk: string) => void;
  }) => {
    sink.event("before");
    controller.abort();
    sink.event("after");
    sink.stderr("after abort");
    return { status: "clean" } as const;
  };
  const result = await runOneShot({
    source,
    translate: (event) => ({
      facts: [{ role: "assistant", parts: [{ type: "text", text: event }] }],
      transcript: event === "after" ? [] : undefined,
      terminal: true,
    }),
    report: {
      message: (fact) => forwarded.push(`fact:${fact.parts[0]?.type}`),
      transcript: () => forwarded.push("transcript"),
      stderr: (chunk) => forwarded.push(`stderr:${chunk}`),
    },
    signal: controller.signal,
    missingAnswerMessage: "missing",
  });

  assert.deepEqual(result, { ending: "answered" });
  assert.deepEqual(forwarded, [
    "fact:text",
    "fact:text",
    "transcript",
    "stderr:after abort",
  ]);
});

test("runOneShot does not latch a terminal answer first witnessed after abort", async () => {
  const controller = new AbortController();
  const result = await runOneShot({
    source: async (sink) => {
      controller.abort();
      sink.event("late answer");
      return { status: "clean" };
    },
    translate: () => ({ terminal: true }),
    report: { message: () => {}, transcript: () => {}, stderr: () => {} },
    signal: controller.signal,
    missingAnswerMessage: "missing",
  });
  assert.deepEqual(result, { ending: "cancelled" });
});

test("runOneShot gives witnessed errors precedence and forwards facts, transcripts, and stderr in order", async () => {
  const order: string[] = [];
  const fact = (text: string): Fact => ({
    role: "assistant",
    parts: [{ type: "text", text }],
  });
  const result = await runOneShot({
    source: async (sink) => {
      sink.stderr("diagnostic");
      sink.event("first");
      sink.event("second");
      return { status: "failed", errorMessage: "conclusion" };
    },
    translate: (event) =>
      event === "first"
        ? { facts: [fact("one")], errorMessage: "first error" }
        : {
            facts: [fact("two")],
            transcript: [fact("healed")],
            errorMessage: "last error",
          },
    report: {
      message: () => order.push("fact"),
      transcript: () => order.push("transcript"),
      stderr: () => order.push("stderr"),
    },
    missingAnswerMessage: "missing",
  });
  assert.deepEqual(result, { ending: "failed", errorMessage: "last error" });
  assert.deepEqual(order, ["stderr", "fact", "fact", "transcript"]);
});

test("runOneShot discards sink calls after source settlement", async () => {
  let sinkAfterSource:
    | { event: (event: string) => void; stderr: (chunk: string) => void }
    | undefined;
  let reports = 0;
  const result = await runOneShot({
    source: async (sink) => {
      sinkAfterSource = sink;
      return { status: "clean" };
    },
    translate: () => ({ facts: [{ role: "assistant", parts: [] }] }),
    report: {
      message: () => {
        reports++;
      },
      transcript: () => {
        reports++;
      },
      stderr: () => {
        reports++;
      },
    },
    missingAnswerMessage: "missing",
  });
  sinkAfterSource?.event("late");
  sinkAfterSource?.stderr("late");
  assert.deepEqual(result, { ending: "failed", errorMessage: "missing" });
  assert.equal(reports, 0);
});

test("runOneShot composes streamSource's pre-start race without starting work", async () => {
  let opened = 0;
  let stopped = 0;
  let release = () => {};
  const source = streamSource(async (signal) => {
    if (signal.aborted) return undefined;
    opened++;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      events: (async function* () {
        await done;
        yield* [];
      })(),
      stop: () => {
        stopped++;
        release();
      },
    };
  });
  const preStart = new AbortController();
  const preStartPromise = runOneShot({
    source,
    translate: () => ({ terminal: true }),
    report: { message: () => {}, transcript: () => {}, stderr: () => {} },
    signal: preStart.signal,
    missingAnswerMessage: "missing",
  });
  preStart.abort();
  assert.deepEqual(await preStartPromise, { ending: "cancelled" });
  assert.equal(opened, 0);

  const controller = new AbortController();
  const pending = runOneShot({
    source,
    translate: () => undefined,
    report: { message: () => {}, transcript: () => {}, stderr: () => {} },
    signal: controller.signal,
    missingAnswerMessage: "missing",
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending, { ending: "cancelled" });
  assert.equal(opened, 1);
  assert.equal(stopped, 1);
});
