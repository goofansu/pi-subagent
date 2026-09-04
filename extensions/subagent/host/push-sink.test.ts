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
 * The completion hand-off, driven by the events that decide it.
 *
 * `CompletionDelivery` treats a successful push as done, and it is right to:
 * the Result was stored first. What is left over is whether the message
 * reached the conversation — and, since Phase C, whether the parent needs it
 * to. Both are decided by events the sink is told about rather than by
 * anything it can observe, so every test here says what the host did and
 * asserts on what the sink did next.
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

test("unbinding forgets every Run and sends nothing into the next Session", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.sink.consumed(runId("run-9"));

  bound.sink.unbind();
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();

  // All four sets go: the ids belong to a Session that has ended, and the
  // next Session's model started none of these Runs.
  assert.deepEqual(bound.sink.unlanded(), []);
  assert.deepEqual(bound.sink.landed(), []);
  assert.equal(bound.sink.status(NOTICE.runId), "pending");
  assert.equal(bound.sink.status(runId("run-9")), "pending");
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

test("a second aborted turn does not lose the same notice twice", async () => {
  // `lostAfterHandOff` is read against `rePushes` to see whether the two
  // agree, so a notice counted lost on every abort until the parent settles
  // would make a Session look like it was losing many more notices than it
  // re-pushed.
  const bound = rig();
  await bound.push(NOTICE);

  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.turnEnded({ signalAborted: true });

  assert.equal(bound.sink.counts().lostAfterHandOff, 1);

  bound.sink.agentSettled();
  assert.equal(bound.sink.counts().rePushes, 1);
});

// -- Consumption -------------------------------------------------------------

test("a push for a consumed Run is accepted and nothing is sent", async () => {
  const bound = rig();
  bound.sink.consumed(NOTICE.runId);

  // Delivery sees a hand-off, which is what happened: the host took
  // responsibility for the message, and taking responsibility included
  // deciding the parent does not need it.
  assert.equal(await bound.push(NOTICE), "pushed");
  assert.deepEqual(bound.sent(), []);
  assert.deepEqual(bound.sink.unlanded(), []);
  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
  assert.equal(bound.sink.counts().handOffsAccepted, 1);
  assert.equal(bound.sink.counts().handOffsRefused, 0);
});

test("a consumed notice lost to an interrupt is not pushed again", async () => {
  const bound = rig();
  await bound.push(NOTICE);

  // The parent read the Result while its notice was still queued, and then the
  // turn was aborted. Re-pushing would re-orient it toward work it has
  // finished with.
  bound.sink.consumed(NOTICE.runId);
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();

  assert.equal(bound.sent().length, 1);
  assert.equal(bound.sink.counts().rePushes, 0);
  // And the sink forgets it: Pi discarded the message, so nothing will land,
  // and a Run left unlanded would keep a widget row for a Result already read.
  assert.deepEqual(bound.sink.unlanded(), []);
  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
});

test("a consumed notice Pi already holds lands anyway, and is counted", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.sink.consumed(NOTICE.runId);

  bound.landed(bound.sent()[0]);

  // Not a gap: the extension API has no call that takes a queued message back.
  // The count is what Phase D's envelope is scheduled on.
  assert.deepEqual(bound.sink.landed(), [NOTICE.runId]);
  assert.equal(bound.sink.counts().landings, 1);
  assert.equal(bound.sink.counts().consumedBeforeLanding, 1);
});

test("consuming a Run whose notice already landed changes nothing", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.landed(bound.sent()[0]);

  bound.sink.consumed(NOTICE.runId);

  // The ordinary case — a notice lands, the model reads it, the model fetches
  // the Result — must not be counted as a notice that arrived too late.
  assert.equal(bound.sink.counts().consumedBeforeLanding, 0);
  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
});

// -- Exhaustion --------------------------------------------------------------

test("a Run delivery gave up on reads exhausted, and consuming it resolves it", async () => {
  const bound = rig();

  await Effect.runPromise(bound.sink.exhausted(NOTICE.runId));

  assert.equal(bound.sink.status(NOTICE.runId), "exhausted");
  assert.equal(bound.sink.counts().exhaustions, 1);

  // Retrieving the Result is the way out of a row that will never leave on its
  // own, so it has to resolve the hand-off.
  bound.sink.consumed(NOTICE.runId);
  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
});

test("exhausting a Run the parent has already read records nothing", async () => {
  const bound = rig();
  bound.sink.consumed(NOTICE.runId);

  await Effect.runPromise(bound.sink.exhausted(NOTICE.runId));

  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
  assert.equal(bound.sink.counts().exhaustions, 0);
});

test("a Run the sink has never heard of is pending, which is what a row wants", () => {
  const bound = rig();

  assert.equal(bound.sink.status(runId("run-never-seen")), "pending");
});

// -- Watching ----------------------------------------------------------------

test("a subscriber is told about a landing, a retrieval, and an exhaustion", async () => {
  const bound = rig();
  let told = 0;
  const stop = bound.sink.subscribe(() => {
    told += 1;
  });

  await bound.push(NOTICE);
  assert.equal(told, 0, "a push changes no status");

  bound.landed(bound.sent()[0]);
  bound.sink.consumed(runId("run-9"));
  await Effect.runPromise(bound.sink.exhausted(runId("run-8")));
  assert.equal(told, 3);

  stop();
  bound.sink.consumed(runId("run-7"));
  assert.equal(told, 3);
});

test("a throwing subscriber does not take the host event down with it", async () => {
  const bound = rig();
  let told = 0;
  bound.sink.subscribe(() => {
    throw new Error("a renderer blew up");
  });
  bound.sink.subscribe(() => {
    told += 1;
  });

  await bound.push(NOTICE);
  bound.landed(bound.sent()[0]);

  assert.equal(told, 1);
});

// -- Counts ------------------------------------------------------------------

test("every hand-off outcome is counted separately, and a bind starts them over", async () => {
  // A counter that cannot tell a refused hand-off from a lost one cannot say
  // which half of the pipeline is failing, which is the only question these
  // exist to answer.
  const bound = rig();
  const other = fixtureNotification({
    identity: { runId: runId("run-9") },
    ending: failedEnding("boom"),
  });

  await bound.push(NOTICE);
  await bound.push(other);
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();
  bound.landed(bound.sent()[2]);
  bound.sink.consumed(other.runId);
  await Effect.runPromise(bound.sink.exhausted(runId("run-8")));
  bound.sink.unbind();
  await bound.push(
    fixtureNotification({ identity: { runId: runId("run-7") } }),
  );

  assert.deepEqual(bound.sink.counts(), {
    pushesAttempted: 3,
    handOffsAccepted: 2,
    handOffsRefused: 1,
    lostAfterHandOff: 2,
    rePushes: 2,
    landings: 1,
    exhaustions: 1,
    consumedBeforeLanding: 0,
  });

  // The counts are one Session's, so the next Session's report is about the
  // next Session.
  bound.sink.bind(() => {});
  assert.deepEqual(bound.sink.counts(), {
    pushesAttempted: 0,
    handOffsAccepted: 0,
    handOffsRefused: 0,
    lostAfterHandOff: 0,
    rePushes: 0,
    landings: 0,
    exhaustions: 0,
    consumedBeforeLanding: 0,
  });
});
