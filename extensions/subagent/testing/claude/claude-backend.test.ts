import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  CLAUDE_ATTACHMENT_FAILED_MESSAGE,
  CLAUDE_CAPABILITIES,
  claudeProbeIsClear,
  RESULT_ERROR_CATEGORY,
  SDK_STDERR_CATEGORY,
} from "../../backend/claude/index.ts";
import type { RunId, RunResult } from "../../domain/index.ts";
import { DEFAULT_RUNTIME_POLICY } from "../../runtime/policy.ts";
import {
  claudeRigRequest,
  quiesce,
  until,
  untilPushed,
  untilQueried,
  untilTerminal,
  withClaudeSession,
} from "./claude-rig.ts";
import { STAND_IN_IDENTITY, STAND_IN_MODEL } from "./stand-in-query.ts";

/**
 * The Claude behaviours the shared suite cannot ask about.
 *
 * Everything provider-neutral is proven by the conformance suite; these are
 * the cells that are Claude's own. Most of them are the M0 spike's findings,
 * and they are named for what they prove rather than for the mechanism, so
 * that a later reader cannot mistake one for a duplicate of a shared scenario
 * and delete it. The spike found that a Claude BackendAgent has no
 * provider-side open; if `a BackendAgent that has never run holds no
 * conversation to resume` goes, nothing is left checking the one exception
 * ADR-0023 records.
 */

/** Narrow a start to the one outcome most tests are about. */
function startedRun(outcome: { readonly outcome: string }): {
  readonly runId: RunId;
  readonly subagentId: import("../../domain/index.ts").SubagentId;
} {
  if (outcome.outcome !== "started") {
    throw new Error(`expected a started Run, got '${outcome.outcome}'`);
  }
  return outcome as never;
}

/** The stored result of a settled Run, or a failure naming what came back. */
function resultOf(read: { readonly outcome: string }): RunResult {
  if (read.outcome !== "result") {
    throw new Error(`expected a stored result, got '${read.outcome}'`);
  }
  return (read as unknown as { readonly result: RunResult }).result;
}

const ANSWERED = [
  { step: "init" },
  { step: "assistant", messageId: "msg_1", text: "the answer" },
  { step: "result", text: "the answer" },
] as const;

/* ============================================================== */
/* Opening, and the identity that is not there yet                 */
/* ============================================================== */

test("Claude declares resume and steering, and no terminal transcript snapshot", () => {
  // The frames *were* the transcript and they have already been reported, so
  // there is no authoritative message list to read at the end of a Query.
  // Declaring false is what makes the suite's healing scenarios a visible skip
  // rather than something the adapter invents a snapshot to pass.
  assert.deepEqual(CLAUDE_CAPABILITIES, {
    resume: true,
    steer: true,
    terminalTranscriptSnapshot: false,
  });
});

test("an SDK that will not load is backend unavailable with no provider text", async () => {
  const { value } = await withClaudeSession({ openFails: true }, (rig) =>
    rig.supervisor.start(claudeRigRequest()),
  );

  assert.equal(value.outcome, "backend unavailable");
  if (value.outcome !== "backend unavailable") return;
  assert.equal(value.diagnostic.category, "backend-failure");
  assert.equal(value.diagnostic.message, "[redacted]");
  assert.doesNotMatch(value.diagnostic.message, /refused/);
});

test("an SDK loader that never returns is backend unavailable and leaves nothing open", async () => {
  const { value, probeAfterClose, nativeProbeAfterClose } =
    await withClaudeSession(
      {
        openHangs: true,
        policy: { ...DEFAULT_RUNTIME_POLICY, openBudgetMillis: 1 },
      },
      (rig) =>
        Effect.gen(function* () {
          const outcome = yield* rig.supervisor.start(claudeRigRequest());
          const rows = yield* rig.repository.list();
          return { outcome: outcome.outcome, rows: rows.length };
        }),
    );

  assert.equal(value.outcome, "backend unavailable");
  assert.equal(value.rows, 0);
  assert.equal(probeAfterClose.openBackendAgents, 0);
  assert.ok(claudeProbeIsClear(nativeProbeAfterClose));
});

test("opening loads the SDK and starts no Query, because there is nothing else to open", async () => {
  const { value } = await withClaudeSession({ scripts: [ANSWERED] }, (rig) =>
    Effect.gen(function* () {
      const started = startedRun(
        yield* rig.supervisor.start(claudeRigRequest()),
      );
      yield* untilQueried(rig);
      yield* untilTerminal(rig, started.runId);
      return { loads: rig.loads(), queries: rig.standIn.record().queries };
    }),
  );

  // One load per open, one Query per Run. The load is all `open` does.
  assert.equal(value.loads, 1);
  assert.equal(value.queries, 1);
});

test("each Query applies the Subagent's fixed Trust posture to Claude setting sources", async () => {
  const { value } = await withClaudeSession(
    { scripts: [ANSWERED, ANSWERED] },
    (rig) =>
      Effect.gen(function* () {
        const trusted = startedRun(
          yield* rig.supervisor.start(
            claudeRigRequest({ projectTrusted: true }),
          ),
        );
        yield* untilTerminal(rig, trusted.runId);

        const untrusted = startedRun(
          yield* rig.supervisor.start(
            claudeRigRequest({ projectTrusted: false }),
          ),
        );
        yield* untilTerminal(rig, untrusted.runId);

        return rig.standIn.record().options;
      }),
  );

  assert.equal("settingSources" in value[0], false);
  assert.deepEqual(value[1]?.settingSources, ["user"]);
  assert.equal("strictMcpConfig" in value[0], false);
  assert.equal("strictMcpConfig" in value[1], false);
  assert.equal(value[0]?.permissionMode, "bypassPermissions");
  assert.equal(value[1]?.permissionMode, "bypassPermissions");
});

test("a BackendAgent that has never run holds no conversation to resume", async () => {
  // ADR-0023's first exception, end to end: the SDK has no open call, so the
  // identity comes into existence only as a side effect of the first Run.
  // Until then there is nothing to resume, and saying so costs no quota.
  const { value } = await withClaudeSession(
    { scripts: [[{ step: "hang" }], ANSWERED] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "and again",
        });
        return {
          resumed: resumed.outcome,
          // A second Query was never started, because admission refused
          // before the backend was asked anything.
          queries: rig.standIn.record().queries,
        };
      }),
  );

  assert.equal(value.resumed, "conversation lost");
  assert.equal(value.queries, 1);
});

test("the first Run's identity frame is what makes a later Run resumable", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        ANSWERED,
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_2", text: "the second answer" },
          { step: "result", text: "the second answer" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const resumed = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "and again",
          }),
        );
        yield* untilTerminal(rig, resumed.runId);
        return {
          resumed: resumed.runId,
          resumes: rig.standIn.record().resumes,
          second: resultOf(yield* rig.supervisor.result(resumed.runId)),
        };
      }),
  );

  // The first Query attached to nothing; the second carried the identity the
  // first acquired, and it never crossed the seam to get there.
  assert.deepEqual(value.resumes, [undefined, STAND_IN_IDENTITY]);
  assert.equal(value.second.finalOutput, "the second answer");
});

test("closing drops the identity, and it stays dropped", async () => {
  const { value, nativeProbeAfterClose, tallyAfterClose } =
    await withClaudeSession({ scripts: [ANSWERED] }, (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const beforeClose = rig.probe().retainedIdentities;
        // Shutdown closes the Subagent; the Session Scope closes it again on
        // the way out, which is the second call.
        yield* rig.supervisor.shutdown();
        const resumed = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "again",
          prompt: "and again",
        });
        return {
          beforeClose,
          afterClose: rig.probe().retainedIdentities,
          resumed: resumed.outcome,
        };
      }),
    );

  assert.equal(value.beforeClose, 1);
  assert.equal(value.afterClose, 0);
  assert.equal(value.resumed, "shutting down");
  // Two close calls, one effective close. There is no SDK call to make twice.
  assert.equal(tallyAfterClose.closes, 1);
  assert.equal(tallyAfterClose.opens, 1);
  assert.ok(claudeProbeIsClear(nativeProbeAfterClose));
});

test("closing twice aborts the live Query once", async () => {
  // `AbortController.abort()` is idempotent, and so is the adapter's close —
  // but they are separate guards and only one of them is the adapter's. A
  // second close that ran its listeners again would abort a controller the
  // execution's own finalizer is also about to abort, and the stand-in counts
  // what the SDK would actually see.
  //
  // The record is read through a thunk rather than returned as a value,
  // because shutdown forgets the Run's identity at the Session boundary — so
  // there is no terminal row to wait for, and what matters is what the
  // stand-in saw by the time the Session Scope had closed.
  const { value, nativeProbeAfterClose, tallyAfterClose } =
    await withClaudeSession(
      { scripts: [[{ step: "init" }, { step: "hang" }]] },
      (rig) =>
        Effect.gen(function* () {
          startedRun(yield* rig.supervisor.start(claudeRigRequest()));
          yield* untilQueried(rig);
          // Shutdown closes the Subagent while its Run is live; the Session
          // Scope closes it again on the way out.
          yield* rig.supervisor.shutdown();
          yield* quiesce();
          return () => rig.standIn.record();
        }),
    );

  assert.equal(value().aborts, 1);
  assert.equal(value().closes, 1);
  assert.equal(tallyAfterClose.opens, 1);
  assert.equal(tallyAfterClose.closes, 1);
  assert.ok(claudeProbeIsClear(nativeProbeAfterClose));
});

/* ============================================================== */
/* Attachment loss after a resumed Query                           */
/* ============================================================== */

test("a resumed Query that dies mid-stream marks the conversation lost", async () => {
  // Loss has to be monotonic across *every* way an attachment can fail, not
  // only the two that reach the identity check. A Subagent whose next Run
  // resumed an identity this one could not reach would be a Run answering
  // from a conversation nobody knows the state of.
  const { value } = await withClaudeSession(
    {
      scripts: [
        ANSWERED,
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_2", text: "a partial answer" },
          { step: "throw" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        const resumed = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "and again",
          }),
        );
        yield* untilTerminal(rig, resumed.runId);
        const failed = resultOf(yield* rig.supervisor.result(resumed.runId));
        const again = yield* rig.supervisor.resume({
          subagentId: first.subagentId,
          description: "once more",
          prompt: "once more",
        });
        return {
          failed,
          again: again.outcome,
          retained: rig.probe().retainedIdentities,
        };
      }),
  );

  assert.equal(value.failed.status, "failed");
  assert.equal(value.failed.errorMessage, CLAUDE_ATTACHMENT_FAILED_MESSAGE);
  // What it did observe before the transport died is kept.
  assert.equal(value.failed.finalOutput, "a partial answer");
  assert.equal(value.again, "conversation lost");
  assert.equal(value.retained, 0);
});

/* ============================================================== */
/* Steering delivery and per-Run Query routing                     */
/* ============================================================== */

test("only one Control is provider-visible at a time", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "under way" },
          { step: "await-input", echo: true },
          { step: "await-input", echo: true },
          { step: "await-input", echo: true },
          { step: "assistant", messageId: "msg_2", text: "the answer" },
          { step: "result", text: "the answer", correlate: "awaited" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        for (const text of ["first", "second", "third"]) {
          yield* rig.supervisor.steer(started.runId, { type: "steer", text });
        }
        yield* untilTerminal(rig, started.runId);
        return {
          record: rig.standIn.record(),
          result: resultOf(yield* rig.supervisor.result(started.runId)),
        };
      }),
  );

  assert.deepEqual(value.record.controls, ["first", "second", "third"]);
  assert.deepEqual(
    value.record.inputs.slice(1).map((input) => input.priority),
    ["later", "later", "later"],
  );
  // The delivery-side assertion the Pi gate could not make: the adapter waits
  // for the provider's acknowledgement before pushing the next one.
  assert.equal(value.record.maxConcurrentControls, 1);
  assert.deepEqual(
    value.result.transcript
      .filter((item) => item.role === "user")
      .map((item) =>
        item.parts
          .filter((part) => part.kind === "text")
          .map((part) => (part.kind === "text" ? part.text : ""))
          .join(""),
      ),
    ["first", "second", "third"],
  );
});

test("a Control admitted to one Run is pushed only into that Run's Query", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "the first answer" },
          { step: "await-input" },
          { step: "result", text: "the first answer", correlate: "prompt" },
          { step: "hang" },
        ],
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_2", text: "the second answer" },
          { step: "result", text: "the second answer" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        yield* rig.supervisor.steer(first.runId, {
          type: "steer",
          text: "only for the first Run",
        });
        yield* untilPushed(rig);
        yield* rig.supervisor.cancel([first.runId]);
        yield* untilTerminal(rig, first.runId);
        yield* quiesce();
        const second = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "and again",
          }),
        );
        yield* untilTerminal(rig, second.runId);
        return { second: second.runId, record: rig.standIn.record() };
      }),
  );

  assert.deepEqual(value.record.controls, ["only for the first Run"]);
  assert.deepEqual(value.record.controlsByRun.get(value.second) ?? [], []);
});

/* ============================================================== */
/* Endings                                                         */
/* ============================================================== */

test("a Run cancelled before any frame settles cancelled with nothing at all", async () => {
  // The spike's Query-loss shape: an abort early enough produced no frames,
  // not even the init frame, so no identity was ever seen for that Run.
  const { value, nativeProbeAfterClose } = await withClaudeSession(
    { scripts: [[{ step: "hang" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        const resumed = yield* rig.supervisor.resume({
          subagentId: started.subagentId,
          description: "again",
          prompt: "and again",
        });
        return {
          result: resultOf(yield* rig.supervisor.result(started.runId)),
          resumed: resumed.outcome,
          retained: rig.probe().retainedIdentities,
          decisions: rig.decisions(),
        };
      }),
  );

  assert.equal(value.result.status, "cancelled");
  assert.equal(value.result.cancellationReason, "requested");
  assert.deepEqual(value.result.transcript, []);
  assert.equal(value.result.finalOutput, "");
  assert.equal(value.result.usage.turns, 0);
  assert.deepEqual(value.decisions, []);
  // And the BackendAgent is still unopened, so the Subagent is honestly
  // non-resumable rather than broken.
  assert.equal(value.retained, 0);
  assert.equal(value.resumed, "conversation lost");
  assert.ok(claudeProbeIsClear(nativeProbeAfterClose));
});

test("cancelling an unfinished guided Turn remains cancelled and keeps both Turns' output", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "the first answer" },
          // Guidance is already provider-visible when the prompt-correlated
          // success arrives, so this is a Turn boundary rather than Run
          // settlement.
          { step: "await-input" },
          { step: "result", text: "the first answer", correlate: "prompt" },
          { step: "echo-input" },
          {
            step: "assistant",
            messageId: "msg_2",
            text: "the guided partial answer",
          },
          { step: "hang" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        const steered = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "also inspect cancellation",
        });
        yield* untilPushed(rig);
        yield* until(
          "the guided Turn's partial assistant output to be observable",
          Effect.map(rig.supervisor.inspectRun(started.runId), (inspection) =>
            inspection.outcome === "active"
              ? inspection.content.finalOutput === "the guided partial answer"
              : false,
          ),
        );
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        return {
          steered: steered.outcome,
          result: resultOf(yield* rig.supervisor.result(started.runId)),
        };
      }),
  );

  assert.equal(value.steered, "accepted");
  assert.equal(value.result.status, "cancelled");
  assert.equal(value.result.cancellationReason, "requested");
  assert.equal(value.result.finalOutput, "the guided partial answer");
  assert.deepEqual(
    value.result.transcript.map((item) => ({
      role: item.role,
      text: item.parts
        .filter((part) => part.kind === "text")
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join(""),
    })),
    [
      { role: "assistant", text: "the first answer" },
      { role: "user", text: "also inspect cancellation" },
      { role: "assistant", text: "the guided partial answer" },
    ],
  );
});

test("a Query-end decision after a guided Turn boundary survives a later cancel", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "the answer" },
          { step: "await-input" },
          { step: "result", text: "the answer", correlate: "prompt" },
          { step: "await-gate", gate: "end-query" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        yield* until(
          "the assistant output before guidance is pushed",
          Effect.map(rig.supervisor.inspectRun(started.runId), (inspection) =>
            inspection.outcome === "active"
              ? inspection.content.finalOutput === "the answer"
              : false,
          ),
        );
        const steered = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "inspect the boundary",
        });
        yield* untilPushed(rig);
        yield* until(
          "the prompt-correlated result to become a Turn boundary",
          Effect.map(rig.supervisor.inspectRun(started.runId), (inspection) =>
            inspection.outcome === "active"
              ? inspection.usage.turns === 1
              : false,
          ),
        );
        const decisionsAtBoundary = rig.decisions().length;

        // Exhausting the script ends the Query without a second result frame.
        rig.standIn.gate("end-query").release();
        yield* until(
          "Query end to record the answered decision",
          Effect.sync(() => rig.decisions().length === 1),
        );
        const decisions = rig.decisions();
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        return {
          steered: steered.outcome,
          decisionsAtBoundary,
          decisions,
          result: resultOf(yield* rig.supervisor.result(started.runId)),
        };
      }),
  );

  assert.equal(value.steered, "accepted");
  assert.equal(value.decisionsAtBoundary, 0);
  assert.deepEqual(value.decisions, [
    {
      ending: { ending: "answered" },
      reconciliation: {
        turns: 1,
        model: STAND_IN_MODEL,
        finalOutput: "the answer",
      },
    },
  ]);
  assert.equal(value.result.status, "completed");
  assert.equal(value.result.finalOutput, "the answer");
  assert.deepEqual(
    value.result.transcript.map((item) => item.role),
    ["assistant"],
  );
});

test("a successful result already observed survives a later cancel", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "the answer" },
          { step: "stderr", text: "provider-authored detail" },
          { step: "result", text: "the answer" },
          { step: "hang" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        yield* until(
          "the completed Turn to record its decision",
          Effect.sync(() => rig.decisions().length === 1),
        );
        const decisions = rig.decisions();
        yield* rig.supervisor.cancel([started.runId]);
        yield* untilTerminal(rig, started.runId);
        return {
          decisions,
          result: resultOf(yield* rig.supervisor.result(started.runId)),
        };
      }),
  );

  assert.deepEqual(value.decisions, [
    {
      ending: { ending: "answered" },
      reconciliation: {
        turns: 1,
        model: STAND_IN_MODEL,
        finalOutput: "the answer",
      },
    },
  ]);
  assert.equal(value.result.status, "completed");
  assert.equal(value.result.finalOutput, "the answer");
  assert.deepEqual(
    value.result.diagnostics.map((diagnostic) => diagnostic.message),
    [`${SDK_STDERR_CATEGORY}: [redacted]`],
  );
});

test("SDK stderr written by final Query.close is not lost", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [[{ step: "init" }, { step: "result", isError: true }]],
      stderrOnQueryClose: true,
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        return resultOf(yield* rig.supervisor.result(started.runId));
      }),
  );

  assert.equal(value.status, "failed");
  assert.deepEqual(
    value.diagnostics.map((diagnostic) => diagnostic.message),
    [
      `${RESULT_ERROR_CATEGORY}: [redacted]`,
      `${SDK_STDERR_CATEGORY}: [redacted]`,
    ],
  );
});

/* ============================================================== */
/* Usage and the model                                             */
/* ============================================================== */

test("every model the Query ran is charged, including one the Profile never asked for", async () => {
  // The spike's second finding: a single-model Run's `modelUsage` carried two
  // models, the requested one and the one the SDK reached for internally.
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "the answer" },
          {
            step: "result",
            text: "the answer",
            cost: 0.02,
            models: {
              [STAND_IN_MODEL]: {
                input: 900,
                output: 120,
                cacheRead: 935,
                cacheWrite: 65,
                window: 200_000,
              },
              "claude-haiku-4-5": { input: 40, output: 12 },
            },
          },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        return resultOf(yield* rig.supervisor.result(started.runId));
      }),
  );

  assert.equal(value.usage.totals.input, 940);
  assert.equal(value.usage.totals.output, 132);
  assert.equal(value.usage.totals.cacheRead, 935);
  assert.equal(value.usage.totals.cacheWrite, 65);
  assert.equal(value.usage.totals.cost, 0.02);
  // The gauge is the primary model's alone: occupancy is not additive, and
  // the auxiliary model's window is not this conversation's.
  assert.deepEqual(value.usage.context, { tokens: 1_900, window: 200_000 });
  assert.equal(value.model, STAND_IN_MODEL);
});

test("a Run that fails before answering still names the model it ran", async () => {
  const { value } = await withClaudeSession(
    { scripts: [[{ step: "init", model: "claude-opus-4-7" }]] },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        return resultOf(yield* rig.supervisor.result(started.runId));
      }),
  );

  assert.equal(value.status, "failed");
  assert.equal(value.model, "claude-opus-4-7");
});

test("a successful result repairs multi-block output without duplicating the streamed transcript", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "first block\n\n" },
          { step: "assistant", messageId: "msg_1", text: "second block" },
          { step: "result", text: "first block\n\nsecond block" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        return resultOf(yield* rig.supervisor.result(started.runId));
      }),
  );

  assert.equal(value.finalOutput, "first block\n\nsecond block");
  assert.equal(value.usage.turns, 1);
  assert.deepEqual(
    value.transcript
      .filter((item) => item.role === "assistant")
      .map((item) => item.parts),
    [
      [{ kind: "text", text: "first block\n\n" }],
      [{ kind: "text", text: "second block" }],
    ],
  );
});

test("the terminal bundle carries turns and the model, and never a transcript", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "one" },
          { step: "assistant", messageId: "msg_2", text: "two" },
          { step: "result", text: "two", numTurns: 5 },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        return resultOf(yield* rig.supervisor.result(started.runId));
      }),
  );

  // The transcript is what was streamed, unhealed: two assistant items.
  assert.deepEqual(
    value.transcript.map((item) => item.role),
    ["assistant", "assistant"],
  );
  // The provider's own total raised the count past the two root messages.
  assert.equal(value.usage.turns, 5);
  assert.equal(value.model, STAND_IN_MODEL);
});

test("a tool call and its result read as one tool entry", async () => {
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          {
            step: "assistant",
            messageId: "msg_1",
            text: "reading it",
            toolCalls: [{ name: "Read", callId: "toolu_1" }],
          },
          { step: "tool-result", callId: "toolu_1", text: "40 lines" },
          { step: "assistant", messageId: "msg_2", text: "the answer" },
          { step: "result", text: "the answer" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, started.runId);
        return resultOf(yield* rig.supervisor.result(started.runId));
      }),
  );

  assert.deepEqual(value.tools, [
    {
      callId: "toolu_1",
      name: "Read",
      status: "completed",
      outputSummary: "40 lines",
    },
  ]);
  assert.deepEqual(
    value.transcript.map((item) => item.role),
    ["assistant", "tool", "assistant"],
  );
});

test("guidance the input stream will not take is a control diagnostic and nothing else", async () => {
  // A Query whose subprocess has stopped reading its input still has a Run
  // attached to it. Admission already told the caller the Control was
  // accepted, which was true; only the delivery failed, and a transcript that
  // claimed the model had seen it would be the one lie this seam must not
  // tell.
  const { value } = await withClaudeSession(
    {
      scripts: [
        [
          { step: "init" },
          { step: "assistant", messageId: "msg_1", text: "under way" },
          { step: "abandon-input" },
          { step: "await-gate", gate: "steered" },
          { step: "assistant", messageId: "msg_2", text: "the answer" },
          { step: "result", text: "the answer", correlate: "none" },
        ],
      ],
    },
    (rig) =>
      Effect.gen(function* () {
        const started = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilQueried(rig);
        yield* until(
          "the Query to stop reading its input",
          Effect.sync(() => rig.standIn.record().openInputs === 0),
        );
        const steered = yield* rig.supervisor.steer(started.runId, {
          type: "steer",
          text: "guidance that cannot be delivered",
        });
        // The refusal is not a published row, so there is nothing to poll
        // for: the Control has to be taken by the steering consumer before the
        // script is allowed to finish. Yielding is what lets that fiber run,
        // and the diagnostic assertion below is what fails if it did not.
        yield* quiesce();
        rig.standIn.gate("steered").release();
        yield* untilTerminal(rig, started.runId);
        return {
          steered: steered.outcome,
          result: resultOf(yield* rig.supervisor.result(started.runId)),
          controls: rig.standIn.record().controls,
        };
      }),
  );

  assert.equal(value.steered, "accepted");
  // Nothing reached the provider, and the transcript claims nothing.
  assert.deepEqual(value.controls, []);
  assert.deepEqual(
    value.result.transcript.filter((item) => item.role === "user"),
    [],
  );
  assert.deepEqual(
    value.result.diagnostics.map((diagnostic) => diagnostic.category),
    ["control"],
  );
  assert.equal(value.result.status, "completed");
});

test("nothing is left iterating or open once a Run has settled", async () => {
  const { value, nativeProbeAfterClose } = await withClaudeSession(
    { scripts: [ANSWERED, ANSWERED] },
    (rig) =>
      Effect.gen(function* () {
        const first = startedRun(
          yield* rig.supervisor.start(claudeRigRequest()),
        );
        yield* untilTerminal(rig, first.runId);
        yield* quiesce();
        const afterFirst = { ...rig.probe() };
        const resumed = startedRun(
          yield* rig.supervisor.resume({
            subagentId: first.subagentId,
            description: "again",
            prompt: "and again",
          }),
        );
        yield* untilTerminal(rig, resumed.runId);
        yield* quiesce();
        return { afterFirst, standIn: rig.standIn.record() };
      }),
  );

  // The identity is retained between Runs; the Query and its input are not.
  assert.equal(value.afterFirst.liveQueries, 0);
  assert.equal(value.afterFirst.openInputs, 0);
  assert.equal(value.afterFirst.retainedIdentities, 1);
  assert.equal(value.standIn.liveQueries, 0);
  assert.equal(value.standIn.openInputs, 0);
  assert.equal(value.standIn.queries, 2);
  assert.ok(claudeProbeIsClear(nativeProbeAfterClose));
});
