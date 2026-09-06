import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option } from "effect";
import {
  createPiBackend,
  PI_CAPABILITIES,
  piProbeIsClear,
} from "../../backend/pi/index.ts";
import { DEFAULT_BACKEND_ID } from "../../domain/index.ts";
import { DEFAULT_RUNTIME_POLICY } from "../../runtime/policy.ts";
import {
  piRigRequest,
  until,
  untilPrompted,
  untilSteered,
  untilTerminal,
  withPiSession,
} from "./pi-rig.ts";

/**
 * The Pi behaviours the shared suite cannot ask about.
 *
 * Everything provider-neutral is proven by the conformance suite; these are
 * the cells that are Pi's own. Four of them are the M0 spike's findings, and
 * they are named for what they prove rather than for the mechanism, so that a
 * later reader cannot mistake one for a duplicate of a shared scenario and
 * delete it. The spike found that a disposed Pi session still accepts a
 * prompt; if that test goes, nothing is left checking the adapter's own guard.
 */

/** Narrow a start to the one outcome most tests are about. */
function startedRun(outcome: { readonly outcome: string }): {
  readonly runId: import("../../domain/index.ts").RunId;
  readonly subagentId: import("../../domain/index.ts").SubagentId;
} {
  if (outcome.outcome !== "started") {
    throw new Error(`expected a started Run, got '${outcome.outcome}'`);
  }
  return outcome as never;
}

test("a disposed Pi session is refused by the adapter, not by the SDK", async () => {
  // The spike's finding: `prompt()` after `dispose()` does not throw. So the
  // adapter's own closed flag is the only thing standing between a closed
  // Subagent and work starting on a session that no longer exists.
  const { value } = await withPiSession(
    { scripts: [[{ step: "assistant", text: "first" }, { step: "terminal" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilTerminal(rig, started.runId);
        yield* rig.supervisor.shutdown();

        // The Subagent is closed, so a resume is refused before any native
        // call is made — and the stand-in, which would have accepted one,
        // records that none arrived.
        const promptsBeforeResume = rig.standIn.record().prompts;
        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "and again",
        });
        return {
          resumed: resumed.outcome,
          promptsBeforeResume,
          promptsAfter: rig.standIn.record().prompts,
          disposed: rig.standIn.record().disposed,
        };
      }),
  );

  assert.equal(value.resumed, "shutting down");
  assert.equal(value.promptsAfter, value.promptsBeforeResume);
  assert.equal(value.disposed, 1);
});

test("closing twice emits one child shutdown and disposes once", async () => {
  const { value, nativeProbeAfterClose } = await withPiSession(
    { scripts: [[{ step: "assistant", text: "done" }, { step: "terminal" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilTerminal(rig, started.runId);
        // Shutdown closes the Subagent; closing the Session Scope closes it
        // again on the way out.
        yield* rig.supervisor.shutdown();
        return rig.standIn.record();
      }),
  );

  assert.equal(value.disposed, 1);
  assert.equal(value.shutdownEmits, 1);
  assert.ok(
    piProbeIsClear(nativeProbeAfterClose),
    `the adapter is still holding something: ${JSON.stringify(nativeProbeAfterClose)}`,
  );
});

test("admitResume answers from the adapter's own state, with no native call", async () => {
  const { value } = await withPiSession(
    {
      scripts: [
        [{ step: "assistant", text: "first" }, { step: "terminal" }],
        [{ step: "assistant", text: "second" }, { step: "terminal" }],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilTerminal(rig, started.runId);
        const before = rig.standIn.record();
        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "and again",
        });
        const second = startedRun(resumed);
        const afterAdmission = rig.standIn.record();
        yield* untilTerminal(rig, second.runId);
        const result = yield* rig.supervisor.result(second.runId);
        return {
          admittedWithNoExtraCall:
            afterAdmission.aborts === before.aborts &&
            afterAdmission.queueClears === before.queueClears,
          resumedOutcome: resumed.outcome,
          output: result.outcome === "result" ? result.result.finalOutput : "",
        };
      }),
  );

  assert.ok(value.admittedWithNoExtraCall);
  assert.equal(value.resumedOutcome, "started");
  assert.equal(value.output, "second");
});

test("bridge overflow fails the Run and stops native work", async () => {
  const burst = Array.from({ length: 4098 }, (_, index) => ({
    step: "user" as const,
    text: `event ${index}`,
  }));
  const { value, nativeProbeAfterClose } = await withPiSession(
    { scripts: [[...burst, { step: "hang" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        const stoppedPromptly = Option.isSome(
          yield* Effect.timeoutOption(
            until(
              "overflow to stop native work",
              Effect.sync(() => rig.standIn.record().aborts > 0),
            ),
            500,
          ),
        );
        if (!stoppedPromptly) {
          yield* rig.supervisor.cancel([started.runId]);
        }
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return {
          stoppedPromptly,
          status: result.outcome === "result" ? result.result.status : "",
          categories:
            result.outcome === "result"
              ? result.result.diagnostics.map(
                  (diagnostic) => diagnostic.category,
                )
              : [],
          aborts: rig.standIn.record().aborts,
        };
      }),
  );

  assert.ok(
    value.stoppedPromptly,
    "overflow did not stop native work promptly",
  );
  assert.equal(value.status, "failed");
  assert.ok(value.categories.includes("queue-overflow"));
  assert.ok(value.aborts >= 1, "overflow did not abort the native session");
  assert.ok(piProbeIsClear(nativeProbeAfterClose));
});

test("a stalled native steer does not delay a cancel", async () => {
  // Nothing ever consumes the steer, so the consumer is parked inside the
  // native call when the cancel arrives. Cancellation must not wait for it.
  const { value, probeAfterClose, nativeProbeAfterClose } = await withPiSession(
    { scripts: [[{ step: "assistant", text: "under way" }, { step: "hang" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilPrompted(rig);
        yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "guidance nothing will take",
        });
        yield* untilSteered(rig);
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return {
          status: result.outcome === "result" ? result.result.status : "",
          output: result.outcome === "result" ? result.result.finalOutput : "",
          aborts: rig.standIn.record().aborts,
        };
      }),
  );

  assert.equal(value.status, "cancelled");
  assert.equal(value.output, "under way");
  assert.ok(value.aborts >= 1, "the session was never aborted");
  assert.ok(piProbeIsClear(nativeProbeAfterClose));
  assert.deepEqual(probeAfterClose.openBackendAgents, 0);
});

test("a cancelled Run leaves the session resumable on the same conversation", async () => {
  const { value } = await withPiSession(
    {
      scripts: [
        [{ step: "assistant", text: "interrupted" }, { step: "hang" }],
        [{ step: "assistant", text: "after the cancel" }, { step: "terminal" }],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilPrompted(rig);
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);

        const resumed = startedRun(
          yield* rig.supervisor.resume({
            subagentId: started.subagentId,
            description: "carry on",
            prompt: "carry on",
          }),
        );
        yield* untilTerminal(rig, resumed.runId);
        const result = yield* rig.supervisor.result(resumed.runId);
        return {
          output: result.outcome === "result" ? result.result.finalOutput : "",
          status: result.outcome === "result" ? result.result.status : "",
          // One session for both Runs: resume is another prompt on the handle.
          opens: rig.opens(),
          prompts: rig.standIn.record().prompts,
        };
      }),
  );

  assert.equal(value.status, "completed");
  assert.equal(value.output, "after the cancel");
  assert.equal(value.opens, 1);
  assert.equal(value.prompts, 2);
});

test("a terminal answer observed before the abort settles answered", async () => {
  const { value } = await withPiSession(
    {
      scripts: [
        [
          { step: "assistant", text: "the answer" },
          { step: "terminal" },
          { step: "hang" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilPrompted(rig);
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return result.outcome === "result"
          ? { status: result.result.status, output: result.result.finalOutput }
          : { status: result.outcome, output: "" };
      }),
  );

  assert.equal(value.status, "completed");
  assert.equal(value.output, "the answer");
});

test("a model the Session's catalogue does not hold is a rejection, not a Run", async (t) => {
  const { value, probeAfterClose } = await withPiSession(
    {
      cleanup: t,
      profileFiles: {
        "explore.md": [
          "---",
          "description: The explore specialist",
          "model: openai-codex/gpt-9-imaginary",
          "---",
          "Explore.",
        ].join("\n"),
      },
      models: [
        { provider: "openai-codex", id: "gpt-5.4-mini" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const outcome = yield* rig.supervisor.start(piRigRequest());
        const rows = yield* rig.repository.list();
        return {
          outcome,
          rows: rows.length,
          notifications: rig.sink.received().length,
          opens: rig.opens(),
        };
      }),
  );

  // Rejected at admission: an invalid Profile never reaches `open`, so no
  // native session is built, no Run is published, and nothing notifies.
  assert.equal(value.outcome.outcome, "invalid profile");
  const diagnostics =
    value.outcome.outcome === "invalid profile"
      ? value.outcome.diagnostics
      : [];
  assert.equal(diagnostics.length, 1);
  assert.match(
    diagnostics[0].reason,
    /model 'openai-codex\/gpt-9-imaginary' was not found in Pi's model catalogue/,
  );
  // The diagnostic names what the catalogue does hold, bounded.
  assert.match(diagnostics[0].reason, /openai-codex\/gpt-5\.4-mini/);
  assert.equal(value.rows, 0);
  assert.equal(value.notifications, 0);
  assert.equal(value.opens, 0);
  assert.equal(probeAfterClose.openBackendAgents, 0);
});

test("a session factory that never returns is backend unavailable and leaves nothing open", async () => {
  const { value, probeAfterClose, nativeProbeAfterClose } = await withPiSession(
    {
      openHangs: true,
      policy: { ...DEFAULT_RUNTIME_POLICY, openBudgetMillis: 1 },
    },
    (rig) =>
      Effect.gen(function* () {
        const outcome = yield* rig.supervisor.start(piRigRequest());
        const rows = yield* rig.repository.list();
        return { outcome: outcome.outcome, rows: rows.length };
      }),
  );

  assert.equal(value.outcome, "backend unavailable");
  assert.equal(value.rows, 0);
  assert.equal(probeAfterClose.openBackendAgents, 0);
  assert.ok(piProbeIsClear(nativeProbeAfterClose));
});

test("a failed open carries a redacted diagnostic and no provider text", async () => {
  const { value } = await withPiSession({ openFails: true }, (rig) =>
    Effect.gen(function* () {
      const outcome = yield* rig.supervisor.start(piRigRequest());
      return outcome;
    }),
  );

  assert.equal(value.outcome, "backend unavailable");
  if (value.outcome !== "backend unavailable") return;
  assert.equal(value.diagnostic.category, "backend-failure");
  assert.equal(value.diagnostic.message, "[redacted]");
  assert.doesNotMatch(value.diagnostic.message, /refused/);
});

test("a Control admitted to one Run is delivered only to that Run", async () => {
  const { value } = await withPiSession(
    {
      scripts: [
        [
          { step: "assistant", text: "first" },
          { step: "await-steer", confirm: true },
          { step: "assistant", text: "steered" },
          { step: "terminal" },
        ],
        [{ step: "assistant", text: "second" }, { step: "terminal" }],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilPrompted(rig);
        yield* rig.supervisor.steer(first.runId, {
          type: "steer",
          text: "only for the first Run",
        });
        yield* untilTerminal(rig, first.runId);

        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "and again",
          }),
        );
        yield* untilTerminal(rig, second.runId);
        const record = rig.standIn.record();
        return {
          firstRunSteers: record.steersByRun.get(first.runId) ?? [],
          secondRunSteers: record.steersByRun.get(second.runId) ?? [],
        };
      }),
  );

  assert.deepEqual(value.firstRunSteers, ["only for the first Run"]);
  assert.deepEqual(value.secondRunSteers, []);
});

test("a native steer that rejects is a control diagnostic and no user message", async () => {
  const { value } = await withPiSession(
    {
      scripts: [
        [
          { step: "assistant", text: "under way" },
          { step: "await-steer", confirm: false, reject: true },
          { step: "assistant", text: "the answer" },
          { step: "terminal" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilPrompted(rig);
        const admitted = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "guidance the session refuses",
        });
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return {
          admitted: admitted.outcome,
          diagnostics:
            result.outcome === "result" ? result.result.diagnostics : [],
          transcript:
            result.outcome === "result"
              ? result.result.transcript.map((item) =>
                  item.parts
                    .map((part) => (part.kind === "text" ? part.text : ""))
                    .join(""),
                )
              : [],
        };
      }),
  );

  // Admission was honest; only the delivery failed, and only a bounded
  // adapter diagnostic says so.
  assert.equal(value.admitted, "accepted");
  assert.deepEqual(
    value.diagnostics.map((diagnostic) => diagnostic.category),
    ["control"],
  );
  assert.match(value.diagnostics[0].message, /\[redacted\]$/);
  // No user message was fabricated for guidance the provider never confirmed.
  assert.deepEqual(value.transcript, ["under way", "the answer"]);
});

test("a steer the session never takes does not stop the Run from settling", async () => {
  // The consumer is parked inside a native call the session will never
  // consume, and the prompt finishes anyway. v1 would have waited for the
  // delivery; ADR-0025 says waiting indefinitely is not a settlement policy,
  // so the Run settles and reports that the guidance did not arrive.
  const { value } = await withPiSession(
    {
      scripts: [
        [
          { step: "await-gate", gate: "finish" },
          { step: "assistant", text: "the answer" },
          { step: "terminal" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilPrompted(rig);
        yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "guidance the session never takes",
        });
        // Wait until the consumer is actually inside the native call, so the
        // Run finishing is the thing under test rather than a race with it.
        yield* untilSteered(rig);
        rig.standIn.gate("finish").release();
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return result.outcome === "result"
          ? {
              status: result.result.status,
              output: result.result.finalOutput,
              categories: result.result.diagnostics.map(
                (diagnostic) => diagnostic.category,
              ),
            }
          : { status: result.outcome, output: "", categories: [] };
      }),
  );

  assert.equal(value.status, "completed");
  assert.equal(value.output, "the answer");
  assert.deepEqual(value.categories, ["control"]);
});

test("a Run that ends with no terminal event fails with a fixed message", async () => {
  const { value } = await withPiSession(
    { scripts: [[{ step: "assistant", text: "something" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(yield* rig.supervisor.start(piRigRequest()));
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return result.outcome === "result"
          ? {
              status: result.result.status,
              message: result.result.errorMessage ?? "",
              output: result.result.finalOutput,
            }
          : { status: result.outcome, message: "", output: "" };
      }),
  );

  assert.equal(value.status, "failed");
  assert.match(value.message, /without a terminal event/);
  // Whatever it managed to say is still retained.
  assert.equal(value.output, "something");
});

test("a Profile with no backend field runs on Pi, which declares all three capabilities", () => {
  const handle = createPiBackend();

  // The default backend id is Pi's, which is what makes a v1 Profile that only
  // renamed the field run unchanged.
  assert.equal(handle.backend.id, DEFAULT_BACKEND_ID);
  assert.deepEqual(PI_CAPABILITIES, {
    resume: true,
    steer: true,
    terminalTranscriptSnapshot: true,
  });
});
