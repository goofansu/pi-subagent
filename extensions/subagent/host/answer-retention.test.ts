import assert from "node:assert/strict";
import { test } from "node:test";
import { runId } from "../domain/index.ts";
import {
  emitText,
  emitToolCall,
  emitToolProgress,
  type FakeStep,
} from "../testing/fakes/script.ts";
import {
  hostRig,
  RIG_ONE_SHOT_PROFILE,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";

function bulkyRun(answer: string, gate?: string): readonly FakeStep[] {
  return [
    ...(gate === undefined ? [] : [{ step: "await-gate", gate } as const]),
    ...Array.from({ length: 12 }, (_, index) => [
      emitText(`supporting transcript ${index}: ${"t".repeat(300)}`),
      emitToolCall(`evidence-${index}`, `call-${index}`),
      emitToolProgress(
        `call-${index}`,
        "completed",
        `supporting tool output ${index}: ${"s".repeat(700)}`,
      ),
    ]).flat(),
    emitText(answer),
    { step: "complete" },
  ];
}

async function start(
  rig: ReturnType<typeof hostRig>,
  agent = "explore",
): Promise<{ readonly subagentId: string; readonly runId: string }> {
  return startedIds(
    await rig.text("agent_start", {
      agent,
      description: `retain ${agent} answer`,
      prompt: "produce bulky deterministic evidence and then answer",
    }),
  );
}

async function resume(
  rig: ReturnType<typeof hostRig>,
  subagent: string,
): Promise<{ readonly subagentId: string; readonly runId: string }> {
  const outcome = await rig.text("agent_resume", {
    id: subagent,
    description: "retain resumed answer",
    prompt: "produce more bulky deterministic evidence and then answer",
  });
  const runId = /run id (\S+)/.exec(outcome)?.[1];
  if (runId === undefined)
    throw new Error(`no Run id in resume outcome:\n${outcome}`);
  return { subagentId: subagent, runId };
}

async function inspectFirstRun(rig: ReturnType<typeof hostRig>) {
  const closed = rig.host.command("subagent", "dashboard");
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  return { closed };
}

test("an automatic Notification identifies retained final output as a bounded prefix", async (t) => {
  const rig = hostRig(t, {
    policy: {
      ...RIG_POLICY,
      projection: {
        ...RIG_POLICY.projection,
        maxFinalOutputBytes: 10,
      },
    },
    resumableSteps: [
      [emitText("0123456789ANSWER-REMOVED"), { step: "complete" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await start(rig);
  await rig.settled(started.runId);
  await rig.pump();

  const notice = rig.host.sent()[0]?.message.content;
  assert.equal(typeof notice, "string");
  if (typeof notice !== "string") return;
  assert.ok(notice.includes("This is the retained output prefix;"));
  assert.doesNotMatch(notice, /ANSWER-REMOVED/);

  const result = await rig.text("agent_result", { id: started.runId });
  assert.ok(result.includes("bytes of the final output were cut."));
});

test("the host preserves a short answer across Result, waits, Notification, and inspection", async (t) => {
  const resultAnswer = "UNIQUE answer returned by agent_result";
  const waitAnswer = "UNIQUE answer returned by agent_wait";
  const waitAllAnswer = "UNIQUE answer returned by agent_wait_all";
  const waitAllOtherAnswer = "UNIQUE second answer returned by agent_wait_all";
  const rig = hostRig(t, {
    policy: {
      ...RIG_POLICY,
      maxResultBytes: 1_800,
    },
    resumableSteps: [
      bulkyRun(resultAnswer),
      bulkyRun(waitAnswer, "wait"),
      bulkyRun(waitAllAnswer, "wait-all-a"),
    ],
    oneShotSteps: [bulkyRun(waitAllOtherAnswer, "wait-all-b")],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const direct = await start(rig);
  await rig.settled(direct.runId);
  await rig.pump();

  const sentBeforeResult = rig.host.sent();
  assert.equal(sentBeforeResult.length, 1);
  const notice = sentBeforeResult[0]?.message.content;
  assert.equal(typeof notice, "string");
  if (typeof notice !== "string") return;
  assert.ok(
    notice.includes("This is the complete output; nothing further to fetch."),
  );

  const directText = await rig.text("agent_result", { id: direct.runId });
  assert.ok(directText.includes(resultAnswer));
  assert.equal(
    await rig.text("agent_result", { id: direct.runId }),
    directText,
    "the stored Result remains retrievable and immutable after Notification",
  );
  await rig.pump();
  assert.equal(rig.installation.sink.status(runId(direct.runId)), "resolved");
  assert.equal(
    rig.host.sent().length,
    1,
    "retrieving the Result after Notification sends no duplicate notice",
  );

  const dashboard = await inspectFirstRun(rig);
  const inspection = rig.host.customLines(160, 200).join("\n");
  assert.ok(inspection.includes(resultAnswer));
  for (let index = 0; index < 3; index += 1) {
    rig.host.customKey(ESC);
    await rig.pump();
  }
  await dashboard.closed;

  const waitedRun = await resume(rig, direct.subagentId);
  const waiting = rig.text("agent_wait", { ids: [waitedRun.runId] });
  await rig.release("wait");
  assert.match(await waiting, new RegExp(waitAnswer));

  const waitAllFirst = await resume(rig, direct.subagentId);
  const waitAllSecond = await start(rig, RIG_ONE_SHOT_PROFILE);
  const waitingForAll = rig.text("agent_wait_all", {});
  await rig.release("wait-all-a");
  await rig.release("wait-all-b");
  const allText = await waitingForAll;
  assert.match(allText, new RegExp(waitAllAnswer));
  assert.match(allText, new RegExp(waitAllOtherAnswer));
  assert.match(allText, new RegExp(waitAllFirst.runId));
  assert.match(allText, new RegExp(waitAllSecond.runId));
});
