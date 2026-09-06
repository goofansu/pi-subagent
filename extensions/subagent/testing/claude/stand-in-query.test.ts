import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeFrame } from "../../backend/claude/index.ts";
import {
  claudeInputMessage,
  createClaudeInput,
} from "../../backend/claude/index.ts";
import type { RunId } from "../../domain/index.ts";
import {
  type ClaudeScript,
  createStandInClaudeQuery,
  OTHER_STAND_IN_IDENTITY,
  STAND_IN_IDENTITY,
  STAND_IN_MODEL,
} from "./stand-in-query.ts";

/**
 * The stand-in, tested as the thing it is.
 *
 * A test double nobody exercises is a second implementation with no tests, and
 * every conformance scenario for Claude rests on this one. So each frame kind
 * and each behaviour is driven here directly, without the adapter in the way:
 * if a script step stops producing what it says it produces, this file fails
 * rather than thirty scenarios failing mysteriously.
 */

/** Drive one script to exhaustion, collecting the frames it yielded. */
async function collect(
  script: ClaudeScript,
  push: readonly { readonly text: string; readonly priority?: "later" }[] = [],
): Promise<{
  readonly frames: readonly Record<string, unknown>[];
  readonly stand: ReturnType<typeof createStandInClaudeQuery>;
}> {
  const stand = createStandInClaudeQuery({ scripts: [script] });
  const input = createClaudeInput();
  const abort = new AbortController();
  const stream = stand.query({
    prompt: input,
    options: { abortController: abort },
  });
  input.push(claudeInputMessage("the brief", "prompt-uuid"));
  for (const [index, message] of push.entries()) {
    input.push(
      claudeInputMessage(
        message.text,
        `control-uuid-${index}`,
        message.priority,
      ),
    );
  }
  const frames: Record<string, unknown>[] = [];
  for await (const frame of stream) {
    frames.push(frame as unknown as Record<string, unknown>);
  }
  return { frames, stand };
}

test("the init frame carries the identity and the model", async () => {
  const { frames } = await collect([{ step: "init" }]);

  assert.deepEqual(frames.length, 1);
  assert.equal(frames[0].type, "system");
  assert.equal(frames[0].subtype, "init");
  assert.equal(frames[0].session_id, STAND_IN_IDENTITY);
  assert.equal(frames[0].model, STAND_IN_MODEL);
});

test("an assistant frame carries text, tool calls, and thinking", async () => {
  const { frames } = await collect([
    {
      step: "assistant",
      messageId: "msg_1",
      thinking: "private",
      text: "the answer",
      toolCalls: [{ name: "Read", callId: "toolu_1" }],
    },
  ]);
  const message = frames[0].message as Record<string, unknown>;

  assert.equal(frames[0].type, "assistant");
  assert.equal(message.id, "msg_1");
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "private" },
    { type: "text", text: "the answer" },
    { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
  ]);
  assert.equal(frames[0].parent_tool_use_id, null);
});

test("a sidechain assistant frame names its parent tool use or subagent", async () => {
  const { frames } = await collect([
    { step: "assistant", parentToolUseId: "toolu_1" },
    { step: "assistant", subagentType: "explore" },
  ]);

  assert.equal(frames[0].parent_tool_use_id, "toolu_1");
  assert.equal(frames[1].subagent_type, "explore");
});

test("a tool-result frame is a user frame carrying a tool_result block", async () => {
  const { frames } = await collect([
    { step: "tool-result", callId: "toolu_1", text: "40 lines" },
    {
      step: "tool-result",
      callId: "toolu_2",
      text: "no such file",
      isError: true,
    },
  ]);
  const first = (frames[0].message as { content: Record<string, unknown>[] })
    .content[0];
  const second = (frames[1].message as { content: Record<string, unknown>[] })
    .content[0];

  assert.equal(frames[0].type, "user");
  assert.deepEqual(first, {
    type: "tool_result",
    tool_use_id: "toolu_1",
    content: "40 lines",
  });
  assert.equal(second.is_error, true);
});

test("a replay-flagged frame carries the flag, and an ordinary one does not", async () => {
  const { frames } = await collect([
    { step: "assistant", text: "replayed", replay: true },
    { step: "assistant", text: "live" },
  ]);

  assert.equal(frames[0].isReplay, true);
  assert.equal("isReplay" in frames[1], false);
});

test("a history frame is unflagged, which is why the pre-boundary drop is needed", async () => {
  const { frames } = await collect([
    { step: "history", role: "user", text: "an old question" },
    { step: "history", role: "assistant", text: "an old answer" },
  ]);

  assert.equal(frames[0].type, "user");
  assert.equal("isReplay" in frames[0], false);
  assert.equal(frames[1].type, "assistant");
  assert.equal("isReplay" in frames[1], false);
});

test("pushed inputs are recorded in order with their uuids and priorities", async () => {
  const { stand } = await collect(
    [
      { step: "await-input" },
      { step: "await-input" },
      { step: "result", text: "done" },
    ],
    [
      { text: "first guidance", priority: "later" },
      { text: "second guidance", priority: "later" },
    ],
  );
  const record = stand.record();

  assert.deepEqual(record.inputs, [
    { text: "the brief", uuid: "prompt-uuid" },
    { text: "first guidance", uuid: "control-uuid-0", priority: "later" },
    { text: "second guidance", uuid: "control-uuid-1", priority: "later" },
  ]);
  assert.deepEqual(record.controls, ["first guidance", "second guidance"]);
});

test("an echo carries the awaited input's own uuid, which is what confirms it", async () => {
  const { frames } = await collect(
    [{ step: "await-input", echo: true }, { step: "result" }],
    [{ text: "some guidance", priority: "later" }],
  );

  assert.equal(frames[0].type, "user");
  assert.equal(frames[0].uuid, "control-uuid-0");
});

test("a later echo-input step acknowledges the input awaited earlier", async () => {
  const { frames } = await collect(
    [{ step: "await-input" }, { step: "echo-input" }, { step: "result" }],
    [{ text: "some guidance", priority: "later" }],
  );
  const echo = frames.find((frame) => frame.type === "user");

  assert.equal(echo?.uuid, "control-uuid-0");
});

test("two pushed Controls at once are visible as a concurrency of two", async () => {
  const { stand } = await collect(
    [{ step: "await-input" }, { step: "await-input" }, { step: "result" }],
    [
      { text: "first", priority: "later" },
      { text: "second", priority: "later" },
    ],
  );

  // Nothing acknowledged either, so both counted at once. A serial adapter
  // never reaches this, which is exactly what the conformance rig asserts.
  assert.equal(stand.record().maxConcurrentControls, 2);
});

test("the result frame reports per-model usage, turns, and its correlation", async () => {
  const { frames } = await collect([
    {
      step: "result",
      text: "the answer",
      numTurns: 3,
      cost: 0.25,
      models: {
        [STAND_IN_MODEL]: { input: 100, output: 40, window: 200_000 },
        "claude-haiku-4-5": { input: 20 },
      },
    },
  ]);
  const usage = frames[0].modelUsage as Record<string, Record<string, unknown>>;

  assert.equal(frames[0].type, "result");
  assert.equal(frames[0].num_turns, 3);
  assert.equal(frames[0].total_cost_usd, 0.25);
  assert.equal(frames[0].user_message_uuid, "prompt-uuid");
  assert.equal(usage[STAND_IN_MODEL].inputTokens, 100);
  assert.equal(usage["claude-haiku-4-5"].inputTokens, 20);
});

test("a result can be an error, can omit its correlation, and can name an input nobody owns", async () => {
  const { frames } = await collect([
    { step: "result", isError: true },
    { step: "result", correlate: "none" },
    { step: "result", correlate: "unowned" },
  ]);

  assert.equal(frames[0].is_error, true);
  assert.equal("user_message_uuid" in frames[1], false);
  assert.notEqual(frames[2].user_message_uuid, "prompt-uuid");
});

test("a result can claim a different identity, which is how a mismatch is scripted", async () => {
  const { frames } = await collect([
    { step: "init" },
    { step: "result", identity: OTHER_STAND_IN_IDENTITY },
  ]);

  assert.equal(frames[0].session_id, STAND_IN_IDENTITY);
  assert.equal(frames[1].session_id, OTHER_STAND_IN_IDENTITY);
});

test("several result frames in one Query are several turns", async () => {
  const { frames } = await collect([
    { step: "result", numTurns: 1 },
    { step: "result", numTurns: 2 },
  ]);

  assert.deepEqual(
    frames.map((frame) => frame.num_turns),
    [1, 2],
  );
});

test("the stderr step reaches the callback the options carried", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "stderr", text: "a provider warning" }]],
  });
  const written: string[] = [];
  const stream = stand.query({
    prompt: createClaudeInput(),
    options: { stderr: (data) => written.push(data) },
  });
  for await (const _frame of stream) {
    // The script yields nothing; the point is the side effect.
  }

  assert.deepEqual(written, ["a provider warning"]);
});

test("a script that throws mid-stream rejects the iteration", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "assistant", text: "partial" }, { step: "throw" }]],
  });
  const stream = stand.query({ prompt: createClaudeInput() });
  const frames: ClaudeFrame[] = [];

  await assert.rejects(async () => {
    for await (const frame of stream) frames.push(frame);
  });
  assert.equal(frames.length, 1);
  assert.equal(stand.record().liveQueries, 0);
});

test("throw-on-start means no Query is ever returned", () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "throw-on-start" }]],
  });

  assert.throws(() => stand.query({ prompt: createClaudeInput() }));
  // Nothing was started, so nothing is live and nothing is counted.
  assert.equal(stand.record().queries, 0);
  assert.equal(stand.record().liveQueries, 0);
});

test("a hanging Query stops when it is aborted, having produced what it had", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "init" }, { step: "hang" }]],
  });
  const abort = new AbortController();
  const stream = stand.query({
    prompt: createClaudeInput(),
    options: { abortController: abort },
  });
  const frames: ClaudeFrame[] = [];
  const iterating = (async () => {
    for await (const frame of stream) {
      frames.push(frame);
      abort.abort();
    }
  })();

  await iterating;

  assert.equal(frames.length, 1);
  assert.equal(stand.record().aborts, 1);
  assert.equal(stand.record().liveQueries, 0);
});

test("an ignore-abort frame wait stays pending after the abort signal fires", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "init" }, { step: "ignore-abort" }]],
  });
  const abort = new AbortController();
  const stream = stand.query({
    prompt: createClaudeInput(),
    options: { abortController: abort },
  });
  const frames = stream[Symbol.asyncIterator]();

  assert.equal((await frames.next()).done, false);
  const pending = frames.next();
  abort.abort();
  const marker = Symbol("still pending");
  assert.equal(await Promise.race([pending, Promise.resolve(marker)]), marker);
  assert.equal(stand.record().aborts, 1);

  // Closing is synchronous bookkeeping even though the provider's frame wait
  // remains pending, matching the surface the adapter has to interrupt past.
  stream.close();
  assert.equal(stand.record().liveQueries, 0);
});

test("a Query aborted before it is iterated produces no frames at all", async () => {
  // The spike's shape: an abort 50 ms in gave no frames, not even the init
  // frame, so no conversation identity was ever seen for that Run.
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "init" }, { step: "assistant", text: "never" }]],
  });
  const abort = new AbortController();
  abort.abort();
  const stream = stand.query({
    prompt: createClaudeInput(),
    options: { abortController: abort },
  });
  const frames: ClaudeFrame[] = [];
  for await (const frame of stream) frames.push(frame);

  assert.deepEqual(frames, []);
  assert.equal(stand.record().aborts, 1);
});

test("closing a Query is observable and ends the iteration", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "await-gate", gate: "never" }]],
  });
  const stream = stand.query({ prompt: createClaudeInput() });
  const iterating = (async () => {
    for await (const _frame of stream) {
      // Nothing is yielded; the gate is what the script is waiting on.
    }
  })();
  stream.close();

  await iterating;

  assert.equal(stand.record().closes, 1);
  assert.equal(stand.record().liveQueries, 0);
  assert.equal(stand.record().closedQueries, 1);
});

test("the live counts fall to zero once the input closes and the Query ends", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "result", text: "done" }]],
  });
  const input = createClaudeInput();
  const stream = stand.query({ prompt: input });
  input.push(claudeInputMessage("the brief", "prompt-uuid"));
  for await (const _frame of stream) {
    // Drain.
  }
  input.close();
  // One turn of the microtask queue for the background input reader to notice.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(stand.record().liveQueries, 0);
  assert.equal(stand.record().openInputs, 0);
});

test("each Query takes the next script, and its options are recorded", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [
      [{ step: "result", text: "first" }],
      [{ step: "result", text: "second" }],
    ],
  });
  const texts: unknown[] = [];
  for (const resume of [undefined, STAND_IN_IDENTITY]) {
    const input = createClaudeInput();
    const stream = stand.query({
      prompt: input,
      options: resume === undefined ? {} : { resume },
    });
    input.push(claudeInputMessage("the brief", "prompt-uuid"));
    for await (const frame of stream) {
      texts.push((frame as unknown as Record<string, unknown>).result);
    }
  }

  assert.deepEqual(texts, ["first", "second"]);
  assert.deepEqual(stand.record().resumes, [undefined, STAND_IN_IDENTITY]);
  assert.equal(stand.record().queries, 2);
});

test("a gate a script waits on is opened by the test, not by a timer", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [
      [
        { step: "await-gate", gate: "answer" },
        { step: "result", text: "at last" },
      ],
    ],
  });
  const input = createClaudeInput();
  const stream = stand.query({ prompt: input });
  input.push(claudeInputMessage("the brief", "prompt-uuid"));
  const frames: Record<string, unknown>[] = [];
  const iterating = (async () => {
    for await (const frame of stream) {
      frames.push(frame as unknown as Record<string, unknown>);
    }
  })();

  assert.equal(frames.length, 0, "the gate held the script");
  stand.gate("answer").release();
  await iterating;

  assert.equal(frames[0]?.result, "at last");
});

test("a Control is grouped by the Run whose execution pushed it", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "await-input" }, { step: "result" }]],
  });
  const input = createClaudeInput();
  const runId = "run-1" as RunId;
  stand.beginRun(runId);
  const stream = stand.query({ prompt: input });
  input.push(claudeInputMessage("the brief", "prompt-uuid"));
  input.push(claudeInputMessage("some guidance", "control-uuid", "later"));
  for await (const _frame of stream) {
    // Drain.
  }
  stand.endRun();

  assert.deepEqual(stand.record().controlsByRun.get(runId), ["some guidance"]);
});

test("abandoning the input stream closes it, which is how a push can be refused", async () => {
  const stand = createStandInClaudeQuery({
    scripts: [[{ step: "abandon-input" }, { step: "hang" }]],
  });
  const input = createClaudeInput();
  const stream = stand.query({ prompt: input });
  const iterating = (async () => {
    for await (const _frame of stream) {
      // The script yields nothing; abandoning the input is the point.
    }
  })();

  // One turn for the abandon to reach the client-owned stream.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(input.isClosed(), true);
  assert.equal(
    input.push(claudeInputMessage("refused guidance", "control-uuid", "later")),
    false,
  );
  stream.close();
  await iterating;
});
