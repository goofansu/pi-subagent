import assert from "node:assert/strict";
import { test } from "node:test";
import type { PiSessionEvent } from "../../backend/pi/index.ts";
import { runId } from "../../domain/index.ts";
import {
  createGate,
  createStandInPiSession,
  type PiScript,
} from "./stand-in-session.ts";

/**
 * The stand-in, tested on its own.
 *
 * A test double is code, and one whose scripts nobody exercises is a double
 * that can drift into agreeing with the adapter rather than with Pi. Every
 * script step has a test here, alongside the three places a politer double
 * would be wrong: a disposed session still accepts a prompt, an abort releases
 * hanging work, and idle guidance is queued for the next prompt.
 */

/** Collect every event one prompt emits. */
function recorder(): {
  readonly listen: (event: PiSessionEvent) => void;
  readonly events: () => readonly Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    listen: (event) => events.push(event as unknown as Record<string, unknown>),
    events: () => [...events],
  };
}

function drive(script: PiScript) {
  const standIn = createStandInPiSession({ scripts: [script] });
  const events = recorder();
  const unsubscribe = standIn.session.subscribe(events.listen);
  return { standIn, events, unsubscribe };
}

test("a prompt echoes the brief back as the Run's first user message", async () => {
  const { standIn, events } = drive([]);

  await standIn.session.prompt("have a look");

  assert.deepEqual(events.events(), [
    {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "have a look" }],
        timestamp: 2,
      },
    },
  ]);
});

test("an assistant step emits a message with its usage, model, and tool calls", async () => {
  const { standIn, events } = drive([
    {
      step: "assistant",
      text: "the answer",
      usage: { input: 40, output: 10, totalTokens: 250, cost: 0.5 },
      model: { provider: "openai-codex", id: "gpt-5.4-mini" },
      toolCalls: [{ name: "read_file", callId: "c1" }],
    },
  ]);

  await standIn.session.prompt("go");

  const [, message] = events.events();
  assert.deepEqual(message.message, {
    role: "assistant",
    content: [
      { type: "text", text: "the answer" },
      { type: "toolCall", name: "read_file", id: "c1" },
    ],
    timestamp: 3,
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    usage: {
      input: 40,
      output: 10,
      totalTokens: 250,
      cost: { total: 0.5 },
    },
  });
});

test("a user step and a tool-result step emit their own roles", async () => {
  const { standIn, events } = drive([
    { step: "user", text: "keep going" },
    { step: "tool-result", text: "40 lines" },
  ]);

  await standIn.session.prompt("go");

  assert.deepEqual(
    events.events().map((event) => (event.message as { role: string }).role),
    ["user", "user", "toolResult"],
  );
});

test("the tool execution steps emit the frames the adapter joins by call id", async () => {
  const { standIn, events } = drive([
    { step: "tool-start", callId: "c1", name: "read_file" },
    {
      step: "tool-end",
      callId: "c1",
      name: "read_file",
      result: "40 lines",
      isError: false,
    },
  ]);

  await standIn.session.prompt("go");

  assert.deepEqual(events.events().slice(1), [
    {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read_file",
      args: {},
    },
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read_file",
      result: "40 lines",
      isError: false,
    },
  ]);
});

test("restating usage rewrites the retained message without re-emitting it", async () => {
  const { standIn, events } = drive([
    { step: "assistant", text: "drifted", usage: { input: 40 } },
    { step: "restate-usage", usage: { input: 50 } },
    { step: "terminal" },
  ]);

  await standIn.session.prompt("go");

  const emitted = events.events()[1].message as { usage: { input: number } };
  const terminal = events.events().at(-1) as {
    messages: readonly { usage?: { input: number } }[];
  };
  // What was streamed said forty; what the terminal frame carries says fifty,
  // which is the drift a terminal snapshot exists to heal.
  assert.equal(emitted.usage.input, 50);
  assert.equal(terminal.messages[1]?.usage?.input, 50);
});

test("a terminal step carries the whole message list and says whether it retries", async () => {
  const { standIn, events } = drive([
    { step: "assistant", text: "not final" },
    { step: "terminal", willRetry: true },
    { step: "assistant", text: "final" },
    { step: "terminal" },
  ]);

  await standIn.session.prompt("go");

  const terminals = events
    .events()
    .filter((event) => event.type === "agent_end");
  assert.deepEqual(
    terminals.map((event) => event.willRetry),
    [true, false],
  );
  assert.equal((terminals[1].messages as readonly unknown[]).length, 3);
});

test("a reject step makes the prompt reject", async () => {
  const { standIn } = drive([{ step: "reject", message: "no" }]);

  await assert.rejects(standIn.session.prompt("go"), /no/);
  // And the session is idle again afterwards.
  assert.equal(standIn.session.isIdle, true);
});

test("a gate step waits until the test opens it", async () => {
  const gate = createGate();
  const standIn = createStandInPiSession({
    scripts: [[{ step: "await-gate", gate: "hold" }]],
    gates: { hold: gate },
  });

  let finished = false;
  const prompting = standIn.session.prompt("go").then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);

  gate.release();
  await prompting;
  assert.equal(finished, true);
});

test("a hang step ends when the session is aborted, and leaves it idle", async () => {
  const { standIn } = drive([{ step: "hang" }]);

  const prompting = standIn.session.prompt("go");
  await Promise.resolve();
  assert.equal(standIn.session.isIdle, false);

  await standIn.session.abort();
  await prompting;

  // Aborting a real session ends the prompt and leaves it resumable.
  assert.equal(standIn.session.isIdle, true);
  assert.equal(standIn.record().aborts, 1);
});

test("an ignore-abort step keeps hanging, which is what a stuck session does", async () => {
  const { standIn } = drive([{ step: "ignore-abort" }]);

  let finished = false;
  void standIn.session.prompt("go").then(() => {
    finished = true;
  });
  await Promise.resolve();
  await standIn.session.abort();
  await Promise.resolve();

  assert.equal(finished, false);
  assert.equal(standIn.session.isIdle, false);
});

test("a speak-on-abort step says one more thing while the session is torn down", async () => {
  const { standIn, events } = drive([
    { step: "speak-on-abort", text: "a frame nobody asked for" },
    { step: "hang" },
  ]);

  const prompting = standIn.session.prompt("go");
  await Promise.resolve();
  await standIn.session.abort();
  await prompting;

  assert.deepEqual(events.events().at(-1)?.message, {
    role: "assistant",
    content: [{ type: "text", text: "a frame nobody asked for" }],
    timestamp: 3,
  });
});

test("a steer waits for the script to consume it, and a confirmed one is echoed", async () => {
  const { standIn, events } = drive([
    { step: "await-steer", confirm: true },
    { step: "terminal" },
  ]);

  const prompting = standIn.session.prompt("go");
  let steered = false;
  const steering = standIn.session.steer("guidance").then(() => {
    steered = true;
  });
  await prompting;
  await steering;

  assert.equal(steered, true);
  assert.deepEqual(standIn.record().steers, ["guidance"]);
  assert.deepEqual(events.events()[1].message, {
    role: "user",
    content: [{ type: "text", text: "guidance" }],
    timestamp: 3,
  });
});

test("an unconfirmed steer is consumed silently", async () => {
  const { standIn, events } = drive([
    { step: "await-steer", confirm: false },
    { step: "terminal" },
  ]);

  const prompting = standIn.session.prompt("go");
  await standIn.session.steer("guidance");
  await prompting;

  assert.deepEqual(standIn.record().steers, ["guidance"]);
  assert.equal(
    events
      .events()
      .some(
        (event) => event.type === "message_end" && event !== events.events()[0],
      ),
    false,
  );
});

test("a rejected steer is how an adapter learns delivery did not happen", async () => {
  const { standIn } = drive([
    { step: "await-steer", confirm: false, reject: true },
    { step: "terminal" },
  ]);

  const prompting = standIn.session.prompt("go");
  await assert.rejects(standIn.session.steer("guidance"), /refused a steer/);
  await prompting;
});

test("steers are grouped by the Run they were delivered during", async () => {
  const { standIn } = drive([
    { step: "await-steer", confirm: false },
    { step: "terminal" },
  ]);
  const first = runId("run-1");

  standIn.beginRun(first);
  const prompting = standIn.session.prompt("go");
  await standIn.session.steer("for the first Run");
  await prompting;
  standIn.endRun();
  // A steer that arrives with no Run in flight belongs to none.
  await Promise.resolve();

  assert.deepEqual(standIn.record().steersByRun.get(first), [
    "for the first Run",
  ]);
});

test("subscriptions are counted live and released on unsubscribe", () => {
  const { standIn, unsubscribe } = drive([]);

  assert.equal(standIn.record().liveSubscriptions, 1);
  assert.equal(standIn.record().subscriptions, 1);

  unsubscribe();

  assert.equal(standIn.record().liveSubscriptions, 0);
  assert.equal(standIn.record().subscriptions, 1);
});

test("a disposed session still accepts a prompt, exactly as the SDK does", async () => {
  const { standIn } = drive([{ step: "assistant", text: "after disposal" }]);

  standIn.session.dispose();
  await standIn.session.prompt("go");

  // The spike's finding, reproduced deliberately: if the double refused here,
  // the adapter's own closed flag would never be what a test proves.
  assert.equal(standIn.record().disposed, 1);
  assert.equal(standIn.record().promptsAfterDispose, 1);
});

test("binding extensions and the shutdown emit are recorded", async () => {
  const { standIn } = drive([]);

  await standIn.session.bindExtensions({ mode: "print" } as never);
  await standIn.session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });

  assert.equal(standIn.record().binds, 1);
  assert.equal(standIn.record().shutdownEmits, 1);
});

test("a steer delivered while idle is surfaced on the next prompt", async () => {
  const standIn = createStandInPiSession({ scripts: [[], []] });
  const events = recorder();
  standIn.session.subscribe(events.listen);

  await standIn.session.prompt("first");
  await standIn.session.steer("guidance delivered too late");
  await standIn.session.prompt("second");

  const userTexts = events
    .events()
    .map((event) => event.message as { role?: string; content?: unknown })
    .filter((message) => message?.role === "user")
    .map(
      (message) =>
        (message.content as readonly { readonly text: string }[])[0].text,
    );
  assert.deepEqual(userTexts, [
    "first",
    "second",
    "guidance delivered too late",
  ]);
});

test("clearing the queue returns pending idle steers and removes them", async () => {
  const { standIn } = drive([]);

  await standIn.session.steer("guidance delivered too late");
  assert.deepEqual(standIn.session.clearQueue(), {
    steering: ["guidance delivered too late"],
    followUp: [],
  });
  assert.equal(standIn.record().queueClears, 1);
});

test("waiting for idle resolves once the prompt in flight has finished", async () => {
  const { standIn } = drive([{ step: "hang" }]);

  const prompting = standIn.session.prompt("go");
  let idle = false;
  const waiting = standIn.session.waitForIdle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false);

  await standIn.session.abort();
  await prompting;
  await waiting;

  assert.equal(idle, true);
});

test("each prompt consumes the next script, and a prompt past the end does nothing", async () => {
  const standIn = createStandInPiSession({
    scripts: [
      [{ step: "assistant", text: "first" }],
      [{ step: "assistant", text: "second" }],
    ],
  });
  const events = recorder();
  standIn.session.subscribe(events.listen);

  await standIn.session.prompt("one");
  await standIn.session.prompt("two");
  await standIn.session.prompt("three");

  const assistantTexts = events
    .events()
    .map((event) => event.message as { role?: string; content?: unknown })
    .filter((message) => message?.role === "assistant")
    .map(
      (message) =>
        (message.content as readonly { readonly text: string }[])[0].text,
    );
  assert.deepEqual(assistantTexts, ["first", "second"]);
  assert.equal(standIn.record().prompts, 3);
});
