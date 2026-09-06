import assert from "node:assert/strict";
import { test } from "node:test";
import { runId } from "../domain/index.ts";
import { installSubagentV2 } from "../index.ts";
import { emitText } from "../testing/fakes/script.ts";
import {
  hostRig,
  RIG_ANSWER,
  RIG_ONE_SHOT_PROFILE,
  RIG_RESUMABLE_PROFILE,
  startedIds,
} from "../testing/host-rig.ts";
import { createStandInHost } from "../testing/stand-in-host.ts";
import { STRESS_POLICY } from "../testing/stress-policy.ts";
import { createDemoBackendSet } from "./demo-backends.ts";

/**
 * Every public operation, driven through the registered handler.
 *
 * These tests call the `execute` Pi would call, with the arguments Pi would
 * pass, and assert on the text a model would read. Nothing here reaches the
 * supervisor, the repository, or the store: if a rule is real it is visible at
 * the surface, and if it is not visible at the surface it is not a rule a user
 * or a model can rely on.
 */

/** Start a Session and start one Run on the named Profile. */
async function startedRun(
  rig: Awaited<ReturnType<typeof hostRig>>,
  agent = RIG_RESUMABLE_PROFILE,
): Promise<{ readonly subagentId: string; readonly runId: string }> {
  return startedIds(
    await rig.text("agent_start", {
      agent,
      description: "look around",
      prompt: "have a look",
    }),
  );
}

// ── agent_start ──────────────────────────────────────────────────────────────

test("agent_start returns a Subagent id and a first Run id a model can act on", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const text = await rig.text("agent_start", {
    agent: RIG_RESUMABLE_PROFILE,
    description: "look around",
    prompt: "have a look",
  });

  const ids = startedIds(text);
  assert.notEqual(ids.subagentId, ids.runId);
  assert.match(text, /^Started explore:/);
  assert.match(
    text,
    /for agent_wait, agent_result, agent_cancel, and agent_steer/,
  );
});

test("agent_start refuses an unknown agent and names the ones that exist", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  assert.equal(
    await rig.text("agent_start", {
      agent: "ghost",
      description: "d",
      prompt: "p",
    }),
    'Unknown agent: "ghost". Available: explore, once',
  );
});

test("agent_start inherits the Session's working directory, trust, and model", async (t) => {
  const rig = hostRig(t, {
    cwd: "/elsewhere",
    projectTrusted: true,
    model: { provider: "anthropic", id: "claude-opus-5" },
    thinkingLevel: "high",
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  // The facts reach the Subagent's context, which nothing at the surface
  // reports — so the proof is that a Run started under them completes, and
  // that the handler read the live context rather than a captured one.
  const started = await startedRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });

  assert.match(
    await rig.text("agent_result", { id: started.runId }),
    new RegExp(RIG_ANSWER),
  );
});

// ── agent_resume ─────────────────────────────────────────────────────────────

test("agent_resume starts a second Run on the same Subagent", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  await rig.text("agent_wait", { ids: [first.runId] });

  const text = await rig.text("agent_resume", {
    id: first.subagentId,
    description: "again",
    prompt: "once more",
  });

  assert.ok(
    text.startsWith(`Resumed subagent ${first.subagentId}:`),
    `resume named a different Subagent: ${text}`,
  );
  const resumedRunId = /run id (\S+)/.exec(text)?.[1];
  assert.notEqual(resumedRunId, first.runId);
});

test("agent_resume carries the resumed identity in its details for the renderer", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  await rig.text("agent_wait", { ids: [first.runId] });
  const result = await rig.call("agent_resume", {
    id: first.subagentId,
    description: "again",
    prompt: "once more",
  });

  assert.deepEqual(Object.keys(result.details as object).sort(), [
    "runId",
    "subagentId",
  ]);
});

test("the one-shot backend proves resume unsupported at the surface", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig, RIG_ONE_SHOT_PROFILE);
  await rig.text("agent_wait", { ids: [started.runId] });

  assert.equal(
    await rig.text("agent_resume", {
      id: started.subagentId,
      description: "again",
      prompt: "once more",
    }),
    `Cannot resume subagent ${started.subagentId}: its backend does not ` +
      "support resume. No Run or provider work was started. Start a new " +
      "Subagent to continue this work.",
  );
});

test("agent_resume tells an unknown Subagent from a Run id", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);

  // A Run id is a well-formed identifier that names no Subagent, which is the
  // mistake the sentence is written for.
  assert.match(
    await rig.text("agent_resume", {
      id: started.runId,
      description: "d",
      prompt: "p",
    }),
    /unknown Subagent\. Use a Subagent id returned by agent_start/,
  );
});

test("agent_resume refuses a Subagent that is already running", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(async () => {
    await rig.release("hold");
    await rig.installation.handle.release();
  });

  const started = await startedRun(rig);

  assert.match(
    await rig.text("agent_resume", {
      id: started.subagentId,
      description: "d",
      prompt: "p",
    }),
    /it already has an active Run\. The request was not queued/,
  );
});

// ── agent_steer ──────────────────────────────────────────────────────────────

test("agent_steer accepts a message and says acceptance is local admission only", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [{ step: "await-control", confirm: true }, { step: "complete" }],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);

  assert.equal(
    await rig.text("agent_steer", { id: started.runId, message: "go left" }),
    `Steering accepted for run ${started.runId}. The complete message was ` +
      "synchronously admitted to this Run's local bounded mailbox, and that " +
      "is all acceptance means: it does not mean the backend dequeued it, a " +
      "provider accepted it, or a model consumed it. Do not resend this " +
      "steering message in a retry loop.",
  );
});

test("the one-shot backend proves unsupported steering at the surface", async (t) => {
  const rig = hostRig(t, {
    oneShotSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(async () => {
    await rig.release("hold");
    await rig.installation.handle.release();
  });

  const started = await startedRun(rig, RIG_ONE_SHOT_PROFILE);

  assert.match(
    await rig.text("agent_steer", { id: started.runId, message: "go left" }),
    /its backend declared no steering Control/,
  );
});

test("agent_steer rejects empty guidance before it looks the Run up", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);

  assert.match(
    await rig.text("agent_steer", { id: started.runId, message: "   " }),
    /invalid message — a Control must be non-empty text/,
  );
});

test("agent_steer names a terminal Run's status rather than calling it unknown", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });

  assert.match(
    await rig.text("agent_steer", { id: started.runId, message: "go left" }),
    /it is already completed\. Use agent_result with that Run id/,
  );
});

// ── agent_cancel ─────────────────────────────────────────────────────────────

test("agent_cancel reports request admission, not terminal cancellation", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);

  assert.equal(
    await rig.text("agent_cancel", { ids: [started.runId] }),
    `Cancellation requested: ${started.runId}. Each Run stops when its ` +
      "execution and cleanup finish, or settles cancelled once its cleanup " +
      "outlives the cleanup budget; it keeps whatever output it produced and " +
      "still sends its own notification.",
  );
});

test("a repeated agent_cancel is idempotent and the first request stands", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  await rig.text("agent_cancel", { ids: [started.runId] });

  assert.match(
    await rig.text("agent_cancel", { ids: [started.runId] }),
    /Already cancelling: .*The first request stands/s,
  );
});

test("agent_cancel tells a finished Run from an id that never existed", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });

  const text = await rig.text("agent_cancel", {
    ids: [started.runId, "run-never"],
  });

  assert.match(
    text,
    new RegExp(
      `Already finished, result kept: ${started.runId} \\(completed\\)\\.`,
    ),
  );
  assert.match(text, /Unknown run ids: run-never\./);
});

test("an id named twice in agent_cancel produces one observation", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });
  const text = await rig.text("agent_cancel", {
    ids: [started.runId, started.runId],
  });

  assert.equal(text.match(new RegExp(started.runId, "g"))?.length, 1);
});

// ── agent_wait ───────────────────────────────────────────────────────────────

test("agent_wait delivers each terminal Run's full result, as agent_result would", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  const second = await startedRun(rig, RIG_ONE_SHOT_PROFILE);

  const text = await rig.text("agent_wait", {
    ids: [first.runId, second.runId],
  });

  // Two cards, one per Run, each the same text `agent_result` returns for it.
  assert.equal(
    text,
    [
      await rig.text("agent_result", { id: first.runId }),
      await rig.text("agent_result", { id: second.runId }),
    ].join("\n\n"),
  );
  assert.match(
    text,
    new RegExp(
      `^explore \\(subagent ${first.subagentId}\\), run ${first.runId}:`,
    ),
  );
  assert.match(
    text,
    new RegExp(
      `\nonce \\(subagent ${second.subagentId}\\), run ${second.runId}:`,
    ),
  );
  assert.equal(text.match(new RegExp(RIG_ANSWER, "g"))?.length, 4);
});

test("agent_wait says why a cancelled Run was cancelled", async (t) => {
  // v1 reported `cancelled (requested)` and `cancelled (shutdown)`, and the
  // difference is not decoration: at shutdown every Run is cancelled without
  // anyone asking, and a model told plain "cancelled" would conclude its own
  // cancel had taken effect.
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  await rig.text("agent_cancel", { ids: [started.runId] });

  const text = await rig.text("agent_wait", { ids: [started.runId] });
  assert.match(text, /look around · pi · cancelled after /);
  assert.match(
    text,
    /^The Run was cancelled before producing output \(requested\)\.$/m,
  );
});

test("agent_wait reports an unknown id rather than blocking on it", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  assert.equal(
    await rig.text("agent_wait", { ids: ["run-never"] }),
    "Unknown run ids: run-never.",
  );
});

test("agent_wait is repeatable, and the Result stays readable afterwards", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  const first = await rig.text("agent_wait", { ids: [started.runId] });
  const second = await rig.text("agent_wait", { ids: [started.runId] });

  // Reading is not taking: the wait observed the stored Result, and so does
  // every later reader.
  assert.equal(first, second);
  assert.match(
    await rig.text("agent_result", { id: started.runId }),
    new RegExp(RIG_ANSWER),
  );
});

test("agent_wait tells the host the parent has each delivered Result, so no notice follows", async (t) => {
  // Each fake numbers its scripts per BackendAgent, so two concurrent Runs
  // that settle on cue come from the two backends, one gate each. Both settle
  // *during* the wait, which is the ordering the hold exists for.
  const rig = hostRig(t, {
    resumableSteps: [
      [
        { step: "await-gate", gate: "a" },
        emitText(RIG_ANSWER),
        { step: "complete" },
      ],
    ],
    oneShotSteps: [
      [
        { step: "await-gate", gate: "b" },
        emitText(RIG_ANSWER),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  const second = await startedRun(rig, RIG_ONE_SHOT_PROFILE);

  const waiting = rig.text("agent_wait", {
    ids: [first.runId, second.runId],
  });
  await rig.release("a");
  await rig.release("b");
  await waiting;
  await rig.pump();

  // Both hand-offs resolved by the wait, and neither notice reached Pi: the
  // wait delivered the answer, so a notice pointing at it would have been the
  // duplicate. Delivery's push and the waiter's wake-up are forked at the same
  // instant, so which arrives first is not fixed — a push during the wait is
  // held and then dropped, a push after it finds the Run consumed — and both
  // are accepted hand-offs that send nothing.
  assert.equal(rig.installation.sink.status(runId(first.runId)), "resolved");
  assert.equal(rig.installation.sink.status(runId(second.runId)), "resolved");
  assert.deepEqual(rig.host.sent(), []);
  assert.deepEqual(rig.installation.sink.unlanded(), []);
  const counts = rig.installation.sink.counts();
  assert.equal(counts.pushesAttempted, 2);
  assert.equal(counts.handOffsAccepted, 2);
  assert.equal(counts.handOffsRefused, 0);
});

test("a wait that gave up leaves the notice to arrive on its own", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        { step: "await-gate", gate: "hold" },
        emitText(RIG_ANSWER),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  const controller = new AbortController();
  const waiting = rig.text(
    "agent_wait",
    { ids: [started.runId] },
    { signal: controller.signal },
  );
  controller.abort();
  await waiting;

  // No Result was delivered, so nothing was consumed and nothing is held.
  await rig.release("hold");
  await rig.settled(started.runId);
  await rig.pump();

  assert.equal(rig.installation.sink.status(runId(started.runId)), "pending");
  assert.equal(rig.host.sent().length, 1);
  assert.deepEqual(rig.installation.sink.unlanded(), [started.runId]);
});

test("aborting the turn ends only the wait: the Run settles and its result stands", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        { step: "await-gate", gate: "hold" },
        emitText(RIG_ANSWER),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  const controller = new AbortController();
  const waiting = rig.text(
    "agent_wait",
    { ids: [started.runId] },
    { signal: controller.signal },
  );
  controller.abort();

  assert.equal(
    await waiting,
    `Still running: ${started.runId}. The wait gave up, not the Runs: each ` +
      "keeps going and notifies on its own, so do not immediately wait on " +
      "the same ids again.",
  );

  // The Run was left to settle, which is the half of the rule that matters.
  await rig.release("hold");
  await rig.text("agent_wait", { ids: [started.runId] });
  assert.match(
    await rig.text("agent_result", { id: started.runId }),
    new RegExp(RIG_ANSWER),
  );
});

test("agent_wait carries the delivered Runs and the still-running count in its details", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  const result = await rig.call("agent_wait", { ids: [started.runId] });

  assert.deepEqual(result.details, {
    runs: [{ runId: started.runId, agent: "explore", status: "completed" }],
    stillRunning: 0,
  });
});

// ── agent_wait_all ───────────────────────────────────────────────────────────

test("agent_wait_all delivers every active Run's result and consumes each", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        { step: "await-gate", gate: "a" },
        emitText("first answer"),
        { step: "complete" },
      ],
    ],
    oneShotSteps: [
      [
        { step: "await-gate", gate: "b" },
        emitText("second answer"),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  const second = await startedRun(rig, RIG_ONE_SHOT_PROFILE);
  const waiting = rig.call("agent_wait_all", {});
  await rig.release("a");
  await rig.release("b");
  const result = await waiting;
  await rig.pump();

  const text = result.content.map((part) => part.text ?? "").join("");
  assert.match(text, /first answer/);
  assert.match(text, /second answer/);
  assert.deepEqual(result.details, {
    runs: [
      { runId: first.runId, agent: "explore", status: "completed" },
      { runId: second.runId, agent: "once", status: "completed" },
    ],
    stillRunning: 0,
  });
  assert.equal(rig.installation.sink.status(runId(first.runId)), "resolved");
  assert.equal(rig.installation.sink.status(runId(second.runId)), "resolved");
  assert.deepEqual(rig.host.sent(), []);
});

test("agent_wait_all covers only the Runs that were active when it was called", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  // Finished before the call, and its notice was already handed to Pi: it
  // is announced there, not repeated here.
  const earlier = await startedRun(rig);
  await rig.settled(earlier.runId);
  await rig.pump();
  assert.equal(rig.host.sent().length, 1);

  const result = await rig.call("agent_wait_all", {});
  const text = result.content.map((part) => part.text ?? "").join("");

  assert.equal(
    text,
    "No Runs are active in this Session. Every Run started here has already " +
      "finished and is announced by its own completion notice; use " +
      "agent_result with a Run id to re-read one.",
  );
  assert.deepEqual(result.details, { runs: [], stillRunning: 0 });
  assert.equal(rig.installation.sink.status(runId(earlier.runId)), "pending");
});

test("agent_wait_all honours its timeout and reports what is still running", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(async () => {
    await rig.release("hold");
    await rig.installation.handle.release();
  });

  const started = await startedRun(rig);

  const text = await rig.text("agent_wait_all", { timeoutSeconds: 0.01 });

  assert.equal(
    text,
    `Still running: ${started.runId}. The wait gave up, not the Runs: each ` +
      "keeps going and notifies on its own, so do not immediately wait on " +
      "the same ids again.",
  );
});

test("agent_wait_all in flight at shutdown answers not-ready and the next Session still holds notices", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [
      [
        { step: "await-gate", gate: "finish" },
        emitText(RIG_ANSWER),
        { step: "complete" },
      ],
    ],
  });
  await rig.host.sessionStart();

  await startedRun(rig);
  const interruptedWait = rig.text("agent_wait_all", {});
  await rig.pump();
  await rig.host.sessionShutdown();

  assert.equal(
    await interruptedWait,
    "Cannot run agent_wait_all: this Session has no subagent runtime, so " +
      "nothing was started. That happens only while a Session is starting or " +
      "shutting down; try again once it is ready.",
  );

  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());
  await startedRun(rig);
  const nextWait = rig.text("agent_wait_all", {});
  await rig.pump();
  await rig.release("finish");

  assert.match(await nextWait, new RegExp(RIG_ANSWER));
  await rig.pump();
  assert.deepEqual(rig.host.sent(), []);
});

test("agent_wait_all rejects an id argument, because it takes none", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  assert.match(
    await rig.text("agent_wait_all", { ids: ["run-1"] }),
    /^Cannot run agent_wait_all: its arguments were not usable\./,
  );
});

// ── agent_result ─────────────────────────────────────────────────────────────

test("agent_result returns the full stored output with its Run identity", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });

  // The expanded body: identity, how it went and what it spent, the recent
  // transcript, and then the answer.
  assert.equal(
    await rig.text("agent_result", { id: started.runId }),
    [
      `explore (subagent ${started.subagentId}), run ${started.runId}:`,
      `look around · pi · completed in 0.0s`,
      `12 in / 8 out · 1 turn`,
      "",
      "Recent transcript:",
      `  assistant: ${RIG_ANSWER}`,
      "",
      RIG_ANSWER,
    ].join("\n"),
  );
});

test("agent_result on a live Run says it has not finished, distinctly from unknown", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);

  assert.match(
    await rig.text("agent_result", { id: started.runId }),
    /has not finished yet, so it has no result/,
  );
  assert.match(
    await rig.text("agent_result", { id: "run-never" }),
    /^No run with id run-never\./,
  );
});

test("agent_result tells the host the parent has the Result", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);
  const id = runId(started.runId);

  // Settled without a wait, so the notice is Pi's and the hand-off is open
  // until something resolves it.
  await rig.settled(started.runId);
  await rig.pump();
  assert.equal(rig.installation.sink.status(id), "pending");

  await rig.text("agent_result", { id: started.runId });

  assert.equal(rig.installation.sink.status(id), "resolved");
});

test("a rejected agent_result tells the host nothing", async (t) => {
  const rig = hostRig(t, {
    resumableSteps: [[{ step: "await-gate", gate: "hold" }]],
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = await startedRun(rig);

  // `not yet terminal` and an unknown id both answer with text alone, which is
  // the shape the handler recognises success by. Neither is a Result the
  // parent now has.
  await rig.text("agent_result", { id: started.runId });
  await rig.text("agent_result", { id: "run-never" });

  assert.equal(rig.installation.sink.status(runId(started.runId)), "pending");
  assert.equal(rig.installation.sink.status(runId("run-never")), "pending");
});

test("a Result the store evicted tells the host nothing either", async (t) => {
  // `ResultExpired` is a rejection like any other: the output is gone, so the
  // parent has nothing, and a notice that lands afterwards is stale but
  // harmless. The store budget here holds two results, so the first Run's
  // output is evicted well before it is asked for.
  const rig = hostRig(t, {
    policy: {
      ...STRESS_POLICY,
      deliveryRetryBudget: { attempts: 1, delayMillis: 0 },
    },
  });
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  await rig.settled(first.runId);
  await rig.pump();
  for (let index = 0; index < 6; index += 1) {
    const next = await startedRun(rig);
    await rig.settled(next.runId);
    await rig.pump();
  }

  assert.match(
    await rig.text("agent_result", { id: first.runId }),
    /its output was evicted/,
  );
  assert.equal(rig.installation.sink.status(runId(first.runId)), "pending");
});

// ── The teardown race ────────────────────────────────────────────────────────

test("a tool call with no live runtime returns a sentence and throws nothing", async (t) => {
  const host = createStandInHost();
  installSubagentV2(host.pi, {
    agentDir: hostRig(t).agentsDir,
    backendSet: createDemoBackendSet,
  });

  // No `session_start`: the tools are registered because registration is
  // per-process, and there is no runtime behind them.
  for (const [name, params] of [
    ["agent_start", { agent: "explore", description: "d", prompt: "p" }],
    ["agent_resume", { id: "subagent-1", description: "d", prompt: "p" }],
    ["agent_wait", { ids: ["run-1"] }],
    ["agent_wait_all", {}],
    ["agent_result", { id: "run-1" }],
    ["agent_cancel", { ids: ["run-1"] }],
    ["agent_steer", { id: "run-1", message: "go" }],
  ] as const) {
    const result = await host.call(name, params);
    const text = result.content.map((part) => part.text ?? "").join("");
    assert.equal(
      text,
      `Cannot run ${name}: this Session has no subagent runtime, so nothing ` +
        "was started. That happens only while a Session is starting or " +
        "shutting down; try again once it is ready.",
    );
  }
});

test("a tool call after shutdown returns the not-ready sentence", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  const started = await startedRun(rig);
  await rig.text("agent_wait", { ids: [started.runId] });
  await rig.host.sessionShutdown();

  assert.match(
    await rig.text("agent_start", {
      agent: RIG_RESUMABLE_PROFILE,
      description: "d",
      prompt: "p",
    }),
    /this Session has no subagent runtime/,
  );
});

test("agent_start refuses an empty description, and spends no identifier doing it", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  // Whitespace counts as empty, because the label is bounded to one line
  // first: a description of a newline and a tab bounds away to nothing, and a
  // Run labelled "" reaches the notice header, the collapsed line and the
  // widget row as a pair of empty quotes.
  for (const description of ["", "   ", "\n\t "]) {
    assert.equal(
      await rig.text("agent_start", {
        agent: RIG_RESUMABLE_PROFILE,
        description,
        prompt: "have a look",
      }),
      "Cannot start explore: its description is empty. No Run was started and " +
        "no id was handed out. Send a one-line description of the task: it is " +
        "the label this Run is shown under everywhere.",
    );
  }

  // Three refusals, and the next start is still this Session's first Run and
  // first Subagent. Nothing was admitted and no identifier was spent.
  const ids = await startedRun(rig);
  assert.match(ids.runId, /-1$/);
  assert.match(ids.subagentId, /-1$/);
});

test("agent_resume refuses an empty description, and the Subagent stays resumable", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const first = await startedRun(rig);
  await rig.text("agent_wait", { ids: [first.runId] });

  assert.equal(
    await rig.text("agent_resume", {
      id: first.subagentId,
      description: "  ",
      prompt: "carry on",
    }),
    `Cannot resume subagent ${first.subagentId}: its description is empty. No ` +
      "Run was started and nothing was queued. Send a one-line description of " +
      "this Run: it is the label this Run is shown under everywhere.",
  );

  // The refusal claimed no active Run on the Subagent, so the real resume
  // still works — which is the "nothing was reserved" half of the rejection.
  const resumed = await rig.text("agent_resume", {
    id: first.subagentId,
    description: "narrower question",
    prompt: "carry on",
  });
  assert.match(resumed, /^Resumed subagent /);
});
