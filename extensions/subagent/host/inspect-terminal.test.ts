import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { RunRepository } from "../runtime/repository.ts";
import {
  emitText,
  emitToolCall,
  emitToolProgress,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  type HostRig,
  hostRig,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";
const screen = (rig: HostRig) => rig.host.customLines(160, 200).join("\n");

async function start(rig: HostRig, description = "inspected Label") {
  return startedIds(
    await rig.text("agent_start", {
      agent: "explore",
      description,
      prompt: "not separately retained admission prompt",
    }),
  );
}
async function inspect(rig: HostRig) {
  const closed = rig.host.command("subagent", "dashboard");
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  return { closed };
}
async function close(rig: HostRig, dashboard: { closed: Promise<void> }) {
  for (let i = 0; i < 3; i += 1) {
    rig.host.customKey(ESC);
    await rig.pump();
  }
  await dashboard.closed;
}

test("terminal inspection shows every retained transcript item and returns to the selected Run", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        ...Array.from({ length: 10 }, (_, i) => emitText(`retained item ${i}`)),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig);
  await rig.settled(work.runId);
  await rig.pump();
  const dashboard = await inspect(rig);
  const text = screen(rig);
  assert.match(text, /Subagent dashboard · run inspection/);
  assert.match(text, /Captured at:/);
  assert.ok(text.includes(work.runId));
  assert.ok(text.includes(work.subagentId));
  assert.match(text, /Label: inspected Label/);
  for (let i = 0; i < 10; i += 1)
    assert.ok(text.includes(`retained item ${i}`));
  assert.doesNotMatch(
    text,
    /Recent transcript|not separately retained admission prompt/,
  );
  rig.host.customKey(ESC);
  await rig.pump();
  assert.match(screen(rig), /Subagent dashboard · run history/);
  assert.match(screen(rig), /Subagent dashboard · run history · explore/);
  rig.host.customKey(ENTER);
  await rig.pump();
  assert.match(screen(rig), /Subagent dashboard · run inspection/);
  await close(rig, dashboard);
});

test("inspection includes mixed transcript parts, every tool, normalized usage, errors, diagnostics and links", async (t) => {
  const steps: FakeStep[] = [
    {
      step: "emit",
      observation: {
        kind: "message",
        role: "assistant",
        model: "transcript-model",
        parts: [
          { kind: "text", text: "mixed text" },
          { kind: "tool_call", name: "mixed-call", callId: "mixed-id" },
          { kind: "text", text: "text after mixed call" },
        ],
      },
    },
    ...Array.from({ length: 9 }, (_, i) => [
      emitToolCall(`tool-${i}`, `call-${i}`),
      emitToolProgress(
        `call-${i}`,
        "completed",
        `tool output ${i}\nsecond line ${i}`,
      ),
    ]).flat(),
    emitText("normalized user text", "user"),
    emitText("normalized tool text", "tool"),
    {
      step: "emit",
      observation: {
        kind: "usage",
        usage: {
          input: 123,
          output: 45,
          cacheRead: 6,
          cacheWrite: 7,
          cost: 0.125,
          turns: 3,
        },
      },
    },
    {
      step: "emit",
      observation: { kind: "context", context: { tokens: 181, window: 1000 } },
    },
    { step: "emit", observation: { kind: "model", model: "primary-model" } },
    {
      step: "emit",
      observation: {
        kind: "diagnostic",
        diagnostic: { category: "other", message: "captured diagnostic" },
      },
    },
    {
      step: "emit",
      observation: {
        kind: "link",
        link: {
          kind: "url",
          label: "report",
          target: "https://example.com/report",
        },
      },
    },
    emitText("final answer\nlast answer line"),
    {
      step: "fail",
      message: "failure explanation for Call ID: retained-error-id",
    },
  ];
  const rig = hostRig(t, { resumableSteps: [steps] });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig);
  await rig.settled(work.runId);
  await rig.pump();
  const dashboard = await inspect(rig);
  const text = screen(rig);
  for (const expected of [
    "mixed text",
    "Tool call · mixed-call",
    "text after mixed call",
    "Reported model: transcript-model",
    "Model: primary-model",
    "normalized user text",
    "normalized tool text",
    "input: 123",
    "output: 45",
    "cacheRead: 6",
    "cacheWrite: 7",
    "cost: 0.125",
    "Turns: 3",
    "Context tokens: 181 / 1000",
    "captured diagnostic",
    "https://example.com/report",
    "final answer",
    "last answer line",
    "failure explanation for Call ID: retained-error-id",
    "Run status: failed",
    "Assistant:",
    "User:",
    "Tool output:",
  ])
    assert.ok(text.includes(expected), `${expected}\n${text}`);
  for (let i = 0; i < 9; i += 1)
    for (const expected of [
      `tool-${i} — completed`,
      `tool output ${i}`,
      `second line ${i}`,
    ])
      assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /mixed-id|call-[0-8]/);
  assert.equal(text.split("Assistant:").length - 1, 3);
  await close(rig, dashboard);
});

for (const truncated of [false, true])
  test(`available ${truncated ? "truncated" : "empty"} Result is not expired or unknown`, async (t) => {
    const rig = hostRig(t, {
      policy: {
        ...RIG_POLICY,
        projection: {
          ...RIG_POLICY.projection,
          maxTranscriptItems: 8,
          maxFinalOutputBytes: 8,
        },
      },
      resumableSteps: [
        [
          ...(truncated
            ? Array.from({ length: 10 }, (_, i) =>
                emitText(`bounded text ${i}`),
              )
            : []),
          { step: "complete" },
        ],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig);
    await rig.settled(work.runId);
    await rig.pump();
    const dashboard = await inspect(rig);
    const text = screen(rig);
    assert.doesNotMatch(
      text,
      /Result expired|Unknown\/unavailable|Result unavailable/,
    );
    if (truncated) {
      assert.match(text, /Truncation:/);
      assert.match(text, /Dropped to stay within bounds: 2 transcript items/);
      assert.match(text, /bytes of the final output/);
      for (let i = 2; i < 10; i += 1)
        assert.ok(text.includes(`bounded text ${i}`));
    } else assert.match(text, /Result available but empty/);
    await close(rig, dashboard);
  });

for (const reason of ["requested", "timeout"] as const)
  test(`terminal inspection captures ${reason} Cancellation reason and settled duration`, async (t) => {
    const rig = hostRig(t, {
      testClock: true,
      policy: {
        ...RIG_POLICY,
        ...(reason === "timeout" ? { defaultRunTimeoutMillis: 2000 } : {}),
      },
      resumableSteps: [[emitText("partial answer"), { step: "hang" }]],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig);
    await rig.pump();
    await rig.advanceClock(2000);
    if (reason === "requested")
      await rig.text("agent_cancel", { ids: [work.runId] });
    await rig.settled(work.runId);
    await rig.pump();
    const dashboard = await inspect(rig);
    const text = screen(rig);
    assert.ok(text.includes(`Run status: cancelled (${reason})`));
    assert.match(text, /Started at: 1970-01-01T00:00:00.000Z/);
    assert.match(text, /Settled at: 1970-01-01T00:00:02.000Z/);
    assert.match(text, /Duration: 2.0s/);
    assert.match(text, /partial answer/);
    await rig.advanceClock(5000);
    assert.equal(screen(rig), text);
    await close(rig, dashboard);
  });

test("capture and capture time survive eviction; reopening observes current expiry and retains metadata", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    policy: { ...RIG_POLICY, maxResultBytes: 4096, resultStoreBytes: 4096 },
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig);
  await rig.settled(work.runId);
  await rig.pump();
  const dashboard = await inspect(rig);
  const captured = screen(rig);
  assert.match(captured, /the rig answered/);
  assert.match(captured, /Captured at: 1970-01-01T00:00:00.000Z/);
  await rig.advanceClock(2000);
  const other = await start(rig, "evicts old output");
  await rig.settled(other.runId);
  await rig.pump();
  for (const key of ["r", "R", ENTER, "c", "s"]) rig.host.customKey(key);
  assert.equal(screen(rig), captured);
  rig.host.customKey(ESC);
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  const reopened = screen(rig);
  assert.match(reopened, /Result expired: output is gone/);
  assert.match(reopened, /Captured at: 1970-01-01T00:00:02.000Z/);
  assert.match(reopened, /Label: inspected Label/);
  assert.match(reopened, /Run status: completed/);
  assert.match(reopened, /Turns: 1/);
  assert.doesNotMatch(reopened, /the rig answered|available but empty/);
  assert.ok(reopened.includes(work.runId));
  await close(rig, dashboard);
});

for (const outcome of ["unreadable", "unknown"] as const)
  test(`host inspection explains ${outcome} instead of empty output`, async (t) => {
    const rig = hostRig(
      t,
      outcome === "unreadable"
        ? { resultEncoder: () => ({ malformed: true }) }
        : {},
    );
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig);
    await rig.settled(work.runId);
    await rig.pump();
    const closed = rig.host.command("subagent", "dashboard");
    await rig.pump();
    rig.host.customKey(ENTER);
    await rig.pump();
    // Fault setup only: published history normally survives until shutdown, which
    // closes the UI. Forget the index behind an already displayed history to
    // exercise the query's unknown response through the registered host command.
    if (outcome === "unknown")
      await rig.installation.handle.run(
        Effect.flatMap(RunRepository, (repository) => repository.forget()),
        undefined,
      );
    rig.host.customKey(ENTER);
    await rig.pump();
    assert.match(
      screen(rig),
      outcome === "unknown"
        ? /Unknown\/unavailable run/
        : /stored result is missing or unreadable/,
    );
    assert.doesNotMatch(screen(rig), /available but empty/);
    await close(rig, { closed });
  });
