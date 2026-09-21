import assert from "node:assert/strict";
import { test } from "node:test";
import { runId } from "../domain/index.ts";
import { emitText } from "../testing/fakes/script.ts";
import {
  hostRig,
  RIG_ONE_SHOT_PROFILE,
  RIG_POLICY,
  startedIds,
} from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";
const REMOVED_OUTPUT = "OUTPUT_THAT_WILL_NOT_BE_RETAINED";
const WAIT_RETURNED =
  "This wait has returned: every Run it covered is terminal, nothing outstanding.";
const NO_FINAL_OUTPUT_REMAINS = "No final output remains in the Result.";

async function inspectOnlyRun(rig: ReturnType<typeof hostRig>) {
  const closed = rig.host.command("subagent", "dashboard");
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  return { closed };
}

test("automatic delivery, Result tools, and inspection agree when all final output was removed", async (t) => {
  const rig = hostRig(t, {
    policy: {
      ...RIG_POLICY,
      projection: {
        ...RIG_POLICY.projection,
        maxTranscriptItems: 0,
        maxFinalOutputBytes: 0,
      },
    },
    resumableSteps: [
      [
        { step: "await-gate", gate: "answer" },
        emitText(REMOVED_OUTPUT),
        { step: "complete" },
      ],
    ],
    oneShotSteps: [
      [
        { step: "await-gate", gate: "wait-all-answer" },
        emitText(REMOVED_OUTPUT),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = startedIds(
    await rig.text("agent_start", {
      agent: "explore",
      description: "remove all final output",
      prompt: "produce deterministic output",
    }),
  );
  await rig.release("answer");
  await rig.settled(started.runId);
  await rig.pump();

  const sent = rig.host.sent();
  assert.equal(sent.length, 1, "the automatic path delivers before any read");
  const notice = sent[0]?.message.content;
  assert.equal(typeof notice, "string");
  if (typeof notice !== "string") return;
  assert.ok(
    notice.includes(
      "Final output was produced, but none remains in the Run record",
    ),
  );
  assert.doesNotMatch(notice, /No output was produced/);
  assert.doesNotMatch(notice, new RegExp(REMOVED_OUTPUT));

  const resultText = await rig.text("agent_result", { id: started.runId });
  const waitText = await rig.text("agent_wait", { ids: [started.runId] });
  // The card is byte-identical to the one `agent_result` returns; the
  // wait adds only its own closing sentence about the call.
  assert.equal(waitText, `${resultText}\n\n${WAIT_RETURNED}`);
  assert.ok(resultText.includes(NO_FINAL_OUTPUT_REMAINS));
  assert.doesNotMatch(resultText, /finished without output/);
  assert.doesNotMatch(resultText, new RegExp(REMOVED_OUTPUT));
  assert.equal(rig.installation.sink.status(runId(started.runId)), "resolved");
  assert.equal(
    await rig.text("agent_result", { id: started.runId }),
    resultText,
    "presentation does not mutate the stored Result",
  );

  const dashboard = await inspectOnlyRun(rig);
  const inspection = rig.host.customLines(160, 200).join("\n");
  assert.match(inspection, /status: +completed/);
  assert.ok(inspection.includes(NO_FINAL_OUTPUT_REMAINS));
  assert.doesNotMatch(inspection, /No final output was produced/);
  assert.doesNotMatch(inspection, new RegExp(REMOVED_OUTPUT));

  for (let index = 0; index < 3; index += 1) {
    rig.host.customKey(ESC);
    await rig.pump();
  }
  await dashboard.closed;

  const waited = startedIds(
    await rig.text("agent_start", {
      agent: RIG_ONE_SHOT_PROFILE,
      description: "wait for wholly removed output",
      prompt: "produce deterministic output",
    }),
  );
  const waitingForAll = rig.text("agent_wait_all", {});
  await rig.release("wait-all-answer");
  const waitAllText = await waitingForAll;
  assert.equal(
    waitAllText,
    `${await rig.text("agent_result", { id: waited.runId })}\n\n${WAIT_RETURNED}`,
    "agent_wait_all uses the same Result formatter",
  );
  await rig.pump();
  assert.equal(
    rig.host.sent().length,
    1,
    "a successful wait suppresses its automatic Notification",
  );
});
