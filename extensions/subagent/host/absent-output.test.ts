import assert from "node:assert/strict";
import { test } from "node:test";
import { runId } from "../domain/index.ts";
import { NO_FINAL_OUTPUT_REMAINS } from "../presentation/index.ts";
import { emitText } from "../testing/fakes/script.ts";
import { hostRig, RIG_POLICY, startedIds } from "../testing/host-rig.ts";

const ENTER = "\r";
const ESC = "\x1b";
const REMOVED_OUTPUT = "OUTPUT_THAT_WILL_NOT_BE_RETAINED";

async function inspectOnlyRun(rig: ReturnType<typeof hostRig>) {
  const closed = rig.host.command("subagent", "dashboard");
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  rig.host.customKey(ENTER);
  await rig.pump();
  return { closed };
}

test("Result tools and terminal inspection agree when all final output was removed", async (t) => {
  const rig = hostRig(t, {
    policy: {
      ...RIG_POLICY,
      projection: {
        ...RIG_POLICY.projection,
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
  const waitingForAll = rig.text("agent_wait_all", {});
  await rig.release("answer");
  const waitAllText = await waitingForAll;
  const resultText = await rig.text("agent_result", { id: started.runId });
  const waitText = await rig.text("agent_wait", { ids: [started.runId] });

  assert.equal(waitAllText, resultText);
  assert.equal(waitText, resultText);
  assert.match(resultText, /32 bytes of the final output were cut\./);
  assert.ok(resultText.includes(NO_FINAL_OUTPUT_REMAINS));
  assert.doesNotMatch(resultText, /finished without output/);
  assert.match(resultText, new RegExp(REMOVED_OUTPUT));
  assert.ok(
    resultText.indexOf(REMOVED_OUTPUT) <
      resultText.indexOf(NO_FINAL_OUTPUT_REMAINS),
    "retained Transcript stays evidence rather than becoming final output",
  );
  assert.equal(rig.installation.sink.status(runId(started.runId)), "resolved");
  assert.deepEqual(rig.host.sent(), []);
  assert.equal(
    await rig.text("agent_result", { id: started.runId }),
    resultText,
    "presentation does not mutate the stored Result",
  );

  const dashboard = await inspectOnlyRun(rig);
  const inspection = rig.host.customLines(160, 200).join("\n");
  assert.match(inspection, /status: +completed/);
  assert.match(inspection, /Final output/);
  assert.match(inspection, /32 bytes of the final output were cut\./);
  assert.ok(inspection.includes(NO_FINAL_OUTPUT_REMAINS));
  assert.doesNotMatch(inspection, /No final output was produced/);
  assert.match(inspection, new RegExp(REMOVED_OUTPUT));
  assert.ok(
    inspection.indexOf(NO_FINAL_OUTPUT_REMAINS) <
      inspection.indexOf(REMOVED_OUTPUT),
    "inspection keeps the removed-output explanation with Final output before Transcript",
  );

  for (let index = 0; index < 3; index += 1) {
    rig.host.customKey(ESC);
    await rig.pump();
  }
  await dashboard.closed;
});
