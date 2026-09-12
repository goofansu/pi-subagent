import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  emitActivity,
  emitText,
  emitToolCall,
  emitToolProgress,
} from "../testing/fakes/script.ts";
import {
  type HostRig,
  hostRig,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";
const screen = (rig: HostRig) =>
  stripVTControlCharacters(rig.host.customLines(160, 200).join("\n"));
async function start(rig: HostRig) {
  return startedIds(
    await rig.text("agent_start", {
      agent: "explore",
      description: "active Label",
      prompt: "task",
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

test("active inspection freezes content and activity ages until explicit refresh, then follows settlement", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        emitActivity("reading files"),
        emitText("first content"),
        { step: "await-gate", gate: "more" },
        emitActivity("writing report"),
        emitText("second content"),
        { step: "await-gate", gate: "finish" },
        emitText("authoritative answer"),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  const work = await start(rig);
  await rig.pump();
  await rig.advanceClock(2000);
  const dashboard = await inspect(rig);
  const first = screen(rig);
  assert.match(first, /active snapshot/);
  assert.match(first, /active Label/);
  assert.match(first, /status: +running/);
  assert.match(first, /first content/);
  assert.doesNotMatch(first, /Last activity:|Captured at:/);
  assert.match(first, /r refresh/);
  const requests = rig.host.customRenderRequests();
  await rig.release("more");
  await rig.pump();
  await rig.advanceClock(3000);
  assert.equal(rig.host.customRenderRequests(), requests);
  assert.equal(screen(rig), first);
  rig.host.customKey("R");
  await rig.pump();
  const second = screen(rig);
  assert.match(second, /second content/);
  assert.doesNotMatch(second, /Last activity:|Captured at:/);
  await rig.release("finish");
  await rig.settled(work.runId);
  await rig.pump();
  assert.equal(screen(rig), second);
  rig.host.customKey("r");
  await rig.pump();
  const terminal = screen(rig);
  assert.match(terminal, /terminal snapshot/);
  assert.match(terminal, /status: +completed/);
  assert.match(terminal, /authoritative answer/);
  assert.doesNotMatch(terminal, /r refresh/);
  await rig.advanceClock(2000);
  rig.host.customKey("R");
  await rig.pump();
  assert.equal(screen(rig), terminal);
  await close(rig, dashboard);
});

test("multiple active refreshes preserve line offset and clamp after shorter reconciliation", async (t) => {
  const rig = hostRig(t, {
    testClock: true,
    resumableSteps: [
      [
        ...Array.from({ length: 30 }, (_, i) =>
          emitText(`full retained item ${i}`),
        ),
        { step: "await-gate", gate: "more" },
        emitText("new tail"),
        { step: "await-gate", gate: "shorter" },
        {
          step: "emit",
          observation: {
            kind: "reconciliation",
            reconciliation: { transcript: [], finalOutput: "short output" },
          },
        },
        { step: "hang" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await start(rig);
  await rig.pump();
  const dashboard = await inspect(rig);
  const full = screen(rig);
  for (let i = 0; i < 30; i += 1)
    assert.ok(full.includes(`full retained item ${i}`));
  const draw = () => rig.host.customLines(160, 10);
  draw();
  rig.host.customKey("\x1b[C");
  let page = draw();
  assert.match(page.at(-2) ?? "", /5-8\//);
  for (const key of ["r", "R", "r"]) {
    await rig.advanceClock(1000);
    rig.host.customKey(key);
    // Drawing during the read must not reset the offset either.
    draw();
    await rig.pump();
    assert.deepEqual(draw(), page);
    assert.match(draw().at(-2) ?? "", /5-8\//);
    page = draw();
  }
  await rig.release("more");
  await rig.pump();
  assert.deepEqual(draw(), page);
  rig.host.customKey("R");
  await rig.pump();
  assert.match(draw().at(-2) ?? "", /5-8\//);
  let sawNewTail = false;
  for (let i = 0; i < 30; i += 1) {
    rig.host.customKey("\x1b[C");
    sawNewTail ||= draw().join("\n").includes("new tail");
  }
  const bottom = draw();
  assert.ok(sawNewTail, "new transcript tail is reachable by scrolling");
  await rig.release("shorter");
  await rig.pump();
  assert.deepEqual(draw(), bottom);
  rig.host.customKey("R");
  await rig.pump();
  const shorter = draw();
  assert.doesNotMatch(shorter.join("\n"), /full retained item|new tail/);
  const position = /(\d+)-(\d+)\/(\d+)/.exec(shorter.at(-2) ?? "");
  assert.ok(position);
  assert.equal(position[2], position[3], "clamped to new bottom");
  assert.match(screen(rig), /short output/);
  await close(rig, dashboard);
});

for (const truncated of [false, true])
  test(`active ${truncated ? "bounded mixed content" : "empty content"} is explicit and not a fake terminal Result`, async (t) => {
    const rig = hostRig(t, {
      policy: {
        ...RIG_POLICY,
        projection: {
          ...RIG_POLICY.projection,
          maxTranscriptItems: 10,
          maxFinalOutputBytes: 8,
        },
      },
      resumableSteps: [
        [
          ...(truncated
            ? [
                ...Array.from({ length: 12 }, (_, i) =>
                  emitText(`bounded item ${i}`),
                ),
                emitToolCall("read", "call-id"),
                emitToolProgress(
                  "call-id",
                  "running",
                  "full tool output\nsecond tool line",
                ),
                emitText("user text", "user"),
                emitText("tool text", "tool"),
                {
                  step: "emit" as const,
                  observation: {
                    kind: "usage" as const,
                    usage: { input: 12, output: 9, turns: 2 },
                  },
                },
                {
                  step: "emit" as const,
                  observation: {
                    kind: "model" as const,
                    model: "active-model",
                  },
                },
                {
                  step: "emit" as const,
                  observation: {
                    kind: "diagnostic" as const,
                    diagnostic: {
                      category: "other" as const,
                      message: "active diagnostic",
                    },
                  },
                },
                {
                  step: "emit" as const,
                  observation: {
                    kind: "link" as const,
                    link: {
                      kind: "url" as const,
                      label: "report",
                      target: "https://example.com/report",
                    },
                  },
                },
              ]
            : []),
          { step: "hang" },
        ],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    await start(rig);
    await rig.pump();
    const dashboard = await inspect(rig);
    const text = screen(rig);
    assert.match(text, /status: +running/);
    assert.doesNotMatch(text, /Result expired|Final output|settled:/);
    if (truncated) {
      for (const value of [
        "bounded item 5",
        "bounded item 11",
        "Tool call · read",
        "read — running",
        "full tool output",
        "second tool line",
        "user text",
        "tool text",
        "turns:              2",
        "input tokens:       12",
        "active-model",
        "active diagnostic",
        "https://example.com/report",
        "Dropped to stay within bounds:",
        "5 transcript items",
        "bytes of the final output",
      ])
        assert.ok(text.includes(value), `${value}\n${text}`);
      const orderedSections = [
        "Metadata",
        "Output so far",
        "Diagnostics",
        "Tools",
        "Links",
        "Transcript",
      ];
      for (let i = 1; i < orderedSections.length; i += 1)
        assert.ok(
          text.indexOf(orderedSections[i - 1] ?? "") <
            text.indexOf(orderedSections[i] ?? ""),
          orderedSections.join(" → "),
        );
      const outputHeading = text.indexOf("Output so far");
      const outputWarning = text.indexOf(
        "7 bytes of the final output were cut.",
      );
      assert.ok(outputHeading < outputWarning);
      assert.ok(outputWarning < text.indexOf("bounded", outputWarning));
      assert.doesNotMatch(text, /call-id/);
      assert.match(text, /User:/);
      assert.match(text, /Tool output:/);
    } else assert.match(text, /Active snapshot available but empty/);
    await close(rig, dashboard);
  });

for (const expire of [false, true])
  test(`refresh through cancellation cleanup reaches ${expire ? "expiry" : "stored terminal Result"}`, async (t) => {
    const rig = hostRig(t, {
      testClock: true,
      policy: { ...RIG_POLICY, maxResultBytes: 4096, resultStoreBytes: 4096 },
      resumableSteps: [
        [
          emitText("partial content"),
          { step: "gate-the-finalizer", gate: "cleanup" },
          { step: "hang" },
        ],
        [{ step: "complete" }],
      ],
    });
    await rig.host.sessionStart();
    t.after(() => rig.installation.handle.release());
    const work = await start(rig);
    await rig.pump();
    const dashboard = await inspect(rig);
    const running = screen(rig);
    await rig.text("agent_cancel", { ids: [work.runId] });
    await rig.pump();
    assert.equal(screen(rig), running);
    rig.host.customKey("R");
    await rig.pump();
    const finalizing = screen(rig);
    assert.match(finalizing, /active snapshot/);
    assert.match(finalizing, /status: +cancelling \(requested\)/);
    assert.match(finalizing, /partial content/);
    await rig.release("cleanup");
    await rig.settled(work.runId);
    await rig.pump();
    if (expire) {
      const other = startedIds(
        await rig.text("agent_start", {
          agent: "once",
          description: "evict",
          prompt: "evict",
        }),
      );
      await rig.settled(other.runId);
      await rig.pump();
    }
    assert.equal(screen(rig), finalizing);
    rig.host.customKey("R");
    await rig.pump();
    const terminal = screen(rig);
    assert.match(terminal, /status: +cancelled \(requested\)/);
    assert.match(
      terminal,
      expire ? /Result expired: output is gone/ : /partial content/,
    );
    assert.doesNotMatch(terminal, /r refresh/);
    rig.host.customKey(ESC);
    await rig.pump();
    assert.match(screen(rig), /Subagent dashboard · run history · explore/);
    assert.match(screen(rig), /active Label/);
    assert.match(screen(rig), /Cancelled/);
    rig.host.customKey(ESC);
    await rig.pump();
    assert.match(screen(rig), /› active Label +Cancelled/);
    rig.host.customKey(ESC);
    await dashboard.closed;
  });
