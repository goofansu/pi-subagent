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

test("a lost notice stays deferred while Pi reports pending messages", async () => {
  const sink = createSessionPushSink();
  const sent: NotificationMessage[] = [];
  sink.bind(
    (message) => void sent.push(message),
    () => true,
  );
  await Effect.runPromise(sink.push(NOTICE));

  sink.turnEnded({ stopReason: "aborted" });
  sink.agentSettled();

  assert.equal(sent.length, 1);
  assert.equal(sink.counts().rePushes, 0);

  sink.turnEnded({ stopReason: "stop" });

  assert.equal(sent.length, 2);
  assert.equal(sink.counts().rePushes, 1);
});

test("a lost notice is re-pushed at settle when Pi has no pending messages", async () => {
  const sink = createSessionPushSink();
  const sent: NotificationMessage[] = [];
  sink.bind(
    (message) => void sent.push(message),
    () => false,
  );
  await Effect.runPromise(sink.push(NOTICE));

  sink.turnEnded({ stopReason: "aborted" });
  sink.agentSettled();

  assert.equal(sent.length, 2);
  assert.equal(sink.counts().rePushes, 1);
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

test("a notice consumed after it was lost is forgotten at settlement", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.sink.turnEnded({ stopReason: "aborted" });

  bound.sink.consumed(NOTICE.runId);
  bound.sink.agentSettled();
  bound.sink.turnEnded({ stopReason: "aborted" });

  assert.deepEqual(bound.sink.unlanded(), []);
  assert.equal(bound.sink.counts().lostAfterHandOff, 1);
  assert.equal(bound.sink.counts().rePushes, 0);
  assert.equal(bound.sent().length, 1);
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

test("a consumed notice that survives an aborted turn still lands and is counted", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.sink.consumed(NOTICE.runId);
  bound.sink.turnEnded({ stopReason: "aborted" });

  bound.landed(bound.sent()[0]);

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

// -- Terminal delivery reports -----------------------------------------------

test("an unannounceable Run is terminal, counted once, and announced", async () => {
  const bound = rig();
  let told = 0;
  bound.sink.subscribe(() => {
    told += 1;
  });

  await Effect.runPromise(bound.sink.unannounceable(NOTICE.runId));
  await Effect.runPromise(bound.sink.unannounceable(NOTICE.runId));

  assert.equal(bound.sink.status(NOTICE.runId), "unannounceable");
  assert.equal(bound.sink.counts().unannounceable, 1);
  assert.equal(told, 1);

  // There is no Result for retrieval to resolve and no notice to hand over.
  bound.sink.consumed(NOTICE.runId);
  assert.equal(await bound.push(NOTICE), "pushed");
  assert.equal(bound.sink.status(NOTICE.runId), "unannounceable");
  assert.deepEqual(bound.sent(), []);
  assert.equal(bound.sink.counts().handOffsAccepted, 1);
});

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

test("a subscriber is told about a landing, a retrieval, and terminal delivery reports", async () => {
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
  await Effect.runPromise(bound.sink.unannounceable(runId("run-7")));
  assert.equal(told, 4);

  stop();
  bound.sink.consumed(runId("run-6"));
  assert.equal(told, 4);
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
  await Effect.runPromise(bound.sink.unannounceable(runId("run-6")));
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
    unannounceable: 1,
    consumedBeforeLanding: 0,
    heldForWait: 0,
    answeredByWait: 0,
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
    unannounceable: 0,
    consumedBeforeLanding: 0,
    heldForWait: 0,
    answeredByWait: 0,
  });
});

// -- Holding for a wait --------------------------------------------------------

test("a push for a held Run is accepted and kept, not handed to Pi", async () => {
  const bound = rig();
  const release = bound.sink.hold([NOTICE.runId]);

  assert.equal(await bound.push(NOTICE), "pushed");

  // Delivery saw a hand-off and the notice is nowhere Pi can see it: not
  // sent, not unlanded, and the row it belongs to is still pending.
  assert.deepEqual(bound.sent(), []);
  assert.deepEqual(bound.sink.unlanded(), []);
  assert.equal(bound.sink.status(NOTICE.runId), "pending");
  assert.equal(bound.sink.counts().heldForWait, 1);
  assert.equal(bound.sink.counts().handOffsAccepted, 1);
  release();
});

test("a held notice whose Result the wait delivered is dropped at release", async () => {
  const bound = rig();
  const release = bound.sink.hold([NOTICE.runId]);
  await bound.push(NOTICE);

  // What the wait handler does when the wait returns: consume, then release.
  bound.sink.consumed(NOTICE.runId);
  release();

  assert.deepEqual(bound.sent(), []);
  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
  assert.equal(bound.sink.counts().answeredByWait, 1);
  // Nothing left for a later abort to lose or a later settle to re-push.
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.agentSettled();
  assert.deepEqual(bound.sent(), []);
});

test("a held notice whose wait gave up is handed over at release, exactly as at settle", async () => {
  const bound = rig();
  const release = bound.sink.hold([NOTICE.runId]);
  await bound.push(NOTICE);

  // The wait timed out or was aborted: no Result was delivered.
  release();

  assert.equal(bound.sent().length, 1);
  assert.deepEqual(bound.sink.unlanded(), [NOTICE.runId]);
  assert.equal(bound.sink.counts().answeredByWait, 0);
  bound.landed(bound.sent()[0]);
  assert.equal(bound.sink.status(NOTICE.runId), "resolved");
});

test('a hold covers only the Runs it names, and "all" covers every Run', async () => {
  const bound = rig();
  const other = fixtureNotification({ identity: { runId: runId("run-9") } });

  const release = bound.sink.hold([NOTICE.runId]);
  await bound.push(other);
  assert.equal(
    bound.sent().length,
    1,
    "an unheld Run's notice went straight through",
  );
  release();

  const releaseAll = bound.sink.hold("all");
  await bound.push(NOTICE);
  assert.equal(bound.sent().length, 1, 'every Run is held under "all"');
  bound.sink.consumed(NOTICE.runId);
  releaseAll();
  assert.equal(bound.sent().length, 1);
  assert.equal(bound.sink.counts().answeredByWait, 1);
});

test("overlapping holds keep a notice until the last one releases, and a release is idempotent", async () => {
  const bound = rig();
  const first = bound.sink.hold([NOTICE.runId]);
  const second = bound.sink.hold([NOTICE.runId]);
  await bound.push(NOTICE);

  first();
  first();
  assert.deepEqual(bound.sent(), [], "the second wait still covers the Run");

  second();
  assert.equal(bound.sent().length, 1);
});

test("unbinding forgets every hold and every held notice", async () => {
  const bound = rig();
  bound.sink.hold([NOTICE.runId]);
  await bound.push(NOTICE);

  bound.sink.unbind();
  bound.sink.bind(() => {
    throw new Error("nothing should be sent into the next Session");
  });

  // The next Session's model did not start this Run, so the notice is gone
  // rather than released into it — and a fresh push for the id is not held.
  assert.equal(bound.sink.counts().heldForWait, 0);
});

test("an all hold released after unbinding cannot weaken the next Session's all hold", async () => {
  const bound = rig();
  const staleRelease = bound.sink.hold("all");

  bound.sink.unbind();
  staleRelease();
  bound.sink.bind(() => {
    throw new Error("the fresh hold should keep the notice in the sink");
  });
  bound.sink.hold("all");

  assert.equal(await bound.push(NOTICE), "pushed");
  assert.deepEqual(bound.sent(), []);
  assert.equal(bound.sink.counts().heldForWait, 1);
});

test("a wait holds a lost notice when the agent settles", async () => {
  const bound = rig();
  await bound.push(NOTICE);
  bound.sink.turnEnded({ stopReason: "aborted" });
  bound.sink.hold([NOTICE.runId]);

  bound.sink.agentSettled();

  assert.equal(bound.sent().length, 1);
  assert.equal(bound.sink.counts().heldForWait, 1);
  assert.equal(bound.sink.counts().rePushes, 0);
  assert.deepEqual(bound.sink.unlanded(), []);
});

test("a stale scoped release is a no-op on the current Session's live hold", async () => {
  const bound = rig();
  const staleRelease = bound.sink.hold([NOTICE.runId]);

  bound.sink.unbind();
  bound.sink.bind(() => {
    throw new Error("the current hold should keep the notice in the sink");
  });
  bound.sink.hold([NOTICE.runId]);
  staleRelease();

  assert.equal(await bound.push(NOTICE), "pushed");
  assert.deepEqual(bound.sent(), []);
  assert.equal(bound.sink.counts().heldForWait, 1);
});
