import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { cancelledEnding, failedEnding, runId } from "../domain/index.ts";
import { fixtureNotification } from "../testing/presentation-fixtures.ts";
import type {
  buildNotificationMessage,
  NotificationMessage,
} from "./notification-message.ts";
import { createSessionPushSink, type SessionPushSink } from "./push-sink.ts";

/**
 * Landing, driven by the four host events that decide it.
 *
 * `CompletionDelivery` treats a successful push as done, and it is right to:
 * the Result was stored first. What is left over is whether the message
 * reached the conversation, and that is decided by events the sink is told
 * about rather than by anything it can observe. So every test here says what
 * the host did and asserts on what the sink did next.
 */

interface Rig {
  readonly sink: SessionPushSink;
  readonly sent: () => readonly NotificationMessage[];
  readonly push: (
    notice: Parameters<typeof buildNotificationMessage>[0],
  ) => Promise<"pushed" | "refused">;
  /** Report a message starting, as `message_start` would. */
  readonly landed: (message: NotificationMessage) => void;
}

function rig(options: { readonly bind?: boolean } = {}): Rig {
  const sink = createSessionPushSink();
  const sent: NotificationMessage[] = [];
  if (options.bind !== false) sink.bind((message) => void sent.push(message));
  return {
    sink,
    sent: () => [...sent],
    push: (notice) =>
      Effect.runPromise(
        Effect.match(sink.push(notice), {
          onSuccess: () => "pushed" as const,
          onFailure: () => "refused" as const,
        }),
      ),
    landed: (message) =>
      sink.messageStarted({
        role: "custom",
        customType: message.customType,
        content: message.content,
        details: message.details,
      }),
  };
}

const NOTICE = fixtureNotification({ finalOutput: "done" });

// -- Push --------------------------------------------------------------------

test("a push hands the built message over and records the notice unlanded", async () => {
  const sent: { message: NotificationMessage; options?: unknown }[] = [];
  const sink = createSessionPushSink();
  sink.bind((message) => void sent.push({ message }));

  await Effect.runPromise(sink.push(NOTICE));

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].message.content.startsWith('Subagent "look around"'),
    true,
  );
  assert.deepEqual(sink.unlanded(), [NOTICE.runId]);
  assert.deepEqual(sink.landed(), []);
});

test("a push with no Session bound is refused and nothing is queued", async () => {
  const bound = rig({ bind: false });

  assert.equal(await bound.push(NOTICE), "refused");
  assert.deepEqual(bound.sent(), []);
  assert.deepEqual(bound.sink.unlanded(), []);
});

test("a Session that throws on send is dropped rather than retried into", async () => {
  const sink = createSessionPushSink();
  sink.bind(() => {
    throw new Error("this Session is stale");
  });

  assert.equal(
    await Effect.runPromise(
      Effect.match(sink.push(NOTICE), {
        onSuccess: () => "pushed" as const,
        onFailure: () => "refused" as const,
      }),
    ),
    "refused",
  );
  assert.deepEqual(sink.unlanded(), []);
});

// -- Landing -----------------------------------------------------------------

test("a message-start carrying the notice marks it landed and forgets it", async () => {
  const bound = rig();
  await bound.push(NOTICE);

  bound.landed(bound.sent()[0]);

  assert.deepEqual(bound.sink.unlanded(), []);
  assert.deepEqual(bound.sink.landed(), [NOTICE.runId]);
});

test("a landed notice is never pushed again, however the agent settles", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.landed(bound.sent()[0]);

  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();

  assert.equal(bound.sent().length, 1);
});

test("a message that is not ours changes nothing", async () => {
  const bound = rig();
  await bound.push(NOTICE);

  bound.sink.messageStarted({ role: "assistant", content: "hello" });
  bound.sink.messageStarted(undefined);

  assert.deepEqual(bound.sink.unlanded(), [NOTICE.runId]);
});

// -- Loss and re-push --------------------------------------------------------

test("an aborted turn end followed by agent-settled re-pushes each unlanded notice exactly once", async () => {
  const bound = rig();
  const other = fixtureNotification({
    identity: { runId: runId("run-9") },
    ending: failedEnding("boom"),
  });
  await bound.push(NOTICE);
  await bound.push(other);

  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();

  assert.deepEqual(
    bound.sent().map((message) => message.details.runId),
    [NOTICE.runId, other.runId, NOTICE.runId, other.runId],
  );

  // Settling again re-pushes nothing: the lost mark was cleared by the
  // re-push, so a second settle has nothing to act on.
  bound.sink.agentSettled();
  assert.equal(bound.sent().length, 4);
});

test("a turn aborted through its signal loses notices exactly as a stop reason does", async () => {
  const bound = rig();
  await bound.push(NOTICE);

  bound.sink.turnEnded({ signalAborted: true });
  bound.sink.agentSettled();

  assert.equal(bound.sent().length, 2);
});

test("a turn that ended normally loses nothing", async () => {
  const bound = rig();
  await bound.push(NOTICE);

  bound.sink.turnEnded({ stopReason: "stop" });
  bound.sink.agentSettled();

  assert.equal(bound.sent().length, 1);
  assert.deepEqual(bound.sink.unlanded(), [NOTICE.runId]);
});

test("a re-pushed notice that lands is forgotten and lands exactly once", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();

  bound.landed(bound.sent()[1]);

  assert.deepEqual(bound.sink.landed(), [NOTICE.runId]);
  assert.deepEqual(bound.sink.unlanded(), []);
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();
  assert.equal(bound.sent().length, 2);
});

test("a notice that lands synchronously inside the push is not re-pushed later", async () => {
  // Pi may report a message starting inside `sendMessage`, so the sink records
  // the notice before it hands it over. A sink that recorded it afterwards
  // would mark a landed notice unlanded.
  const sink = createSessionPushSink();
  const sent: NotificationMessage[] = [];
  sink.bind((message) => {
    sent.push(message);
    sink.messageStarted({
      role: "custom",
      customType: message.customType,
      content: message.content,
      details: message.details,
    });
  });

  await Effect.runPromise(sink.push(NOTICE));
  sink.turnEnded({ stopReason: "aborted" });
  sink.agentSettled();

  assert.equal(sent.length, 1);
  assert.deepEqual(sink.landed(), [NOTICE.runId]);
});

// -- Unbinding ---------------------------------------------------------------

test("unbinding drops unlanded notices and sends nothing into the next Session", async () => {
  const bound = rig();
  await bound.push(NOTICE);

  bound.sink.unbind();
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();

  assert.deepEqual(bound.sink.unlanded(), []);
  assert.equal(bound.sent().length, 1);

  // A new Session binds and receives only what it asked for.
  const next: NotificationMessage[] = [];
  bound.sink.bind((message) => void next.push(message));
  bound.sink.agentSettled();
  assert.deepEqual(next, []);
});

test("a push after unbinding is refused rather than queued", async () => {
  const bound = rig();
  bound.sink.unbind();

  assert.equal(
    await bound.push(
      fixtureNotification({ ending: cancelledEnding("shutdown") }),
    ),
    "refused",
  );
});
