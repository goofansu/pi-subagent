import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { denySdkExternalIO } from "../../../../scripts/real-sdk-io-guard.ts";
import type { Backend } from "../../backend/contract.ts";
import { createPiBackend } from "../../backend/pi/index.ts";
import { realSdkFixture } from "../../backend/pi/real-sdk-fixture.ts";
import type { RunObservation } from "../../domain/index.ts";
import { createRuntimeCounters } from "../../runtime/counters.ts";
import {
  until,
  untilRunTerminal,
  withBackendSession,
} from "../backend-session.ts";
import { createFakeNotificationSink } from "../fake-sink.ts";
import { PI_RIG_PROFILE, piRigRequest } from "./pi-rig.ts";

for (const mode of ["continue", "cancel-second", "auth"] as const) {
  test(`locked SDK managed finalization: ${mode}`, {
    timeout: 15000,
  }, async (t) => {
    const ioGuard = denySdkExternalIO(t);
    let fixture: Awaited<ReturnType<typeof realSdkFixture>>;
    try {
      fixture = await realSdkFixture(t, mode);
    } catch (error) {
      ioGuard.restore();
      throw error;
    }
    // Registered after the fixture's fallback cleanup: guards remain active through disposal.
    t.after(ioGuard.restore);
    const observations: RunObservation[] = [];
    const handle = createPiBackend({
      sessionFactory: async () => ({ session: fixture.session }),
      sessionOptionsFactory: async () => ({}),
    });
    const backend: Backend = {
      ...handle.backend,
      open: (profile, context) =>
        handle.backend.open(profile, context).pipe(
          Effect.map((agent) => ({
            ...agent,
            execute: (input, io) =>
              agent.execute(input, {
                ...io,
                emit: (observation) =>
                  Effect.sync(() => {
                    observations.push(observation);
                  }).pipe(Effect.andThen(io.emit(observation))),
              }),
          })),
        ),
    };
    const counters = createRuntimeCounters();
    const outcome = await withBackendSession(
      {
        backend,
        profiles: { from: "list", profiles: [PI_RIG_PROFILE] },
        counters,
        sink: createFakeNotificationSink(),
      },
      (rig) =>
        Effect.gen(function* () {
          // Always release provider gates before Session finalizers, including assertion defects.
          yield* Effect.addFinalizer(() => Effect.sync(fixture.releaseAll));
          const started = yield* rig.supervisor.start(piRigRequest());
          assert.equal(started.outcome, "started");
          if (started.outcome !== "started")
            throw new Error("SDK failed to open");
          yield* until(
            "summarization auth",
            Effect.sync(() => fixture.authEntered.opened),
          );
          assert.equal(fixture.record().initialAuthChecks, 1);
          assert.equal(fixture.record().summarizationAuthCalls, 1);
          assert.equal(
            fixture.events.some((e) => e.type === "compaction_start"),
            false,
          );
          assert.ok(
            fixture.events.some(
              (e) =>
                e.type === "message_end" &&
                e.message.role === "assistant" &&
                e.message.stopReason === "length",
            ),
          );
          assert.equal(fixture.record().promptFinished, false);
          yield* until(
            "partial accounting delivered before cancellation",
            Effect.sync(() => observations.some((o) => o.kind === "usage")),
          );
          if (mode === "auth") {
            const cancelled = yield* rig.supervisor.cancel([started.runId]);
            assert.equal(cancelled[0]?.outcome, "admitted");
            yield* until(
              "native cleanup abort before releasing auth",
              Effect.sync(() => fixture.abortEntered.opened),
            );
            assert.equal(fixture.authRelease.opened, false);
            assert.equal(
              fixture.events.some((e) => e.type === "compaction_start"),
              false,
            );
            fixture.authRelease.release();
            fixture.summaryRelease.release();
          } else {
            fixture.authRelease.release();
            yield* until(
              "real summary stream",
              Effect.sync(() => fixture.summaryEntered.opened),
            );
            const control = yield* rig.supervisor.steer(started.runId, {
              type: "steer",
              text: "queued supervisor guidance",
            });
            assert.equal(control.outcome, "accepted");
            yield* until(
              "native steering queue",
              Effect.sync(() =>
                fixture.session
                  .getSteeringMessages()
                  .includes("queued supervisor guidance"),
              ),
            );
            fixture.summaryRelease.release();
            yield* until(
              "actual second execution",
              Effect.sync(() => fixture.secondEntered.opened),
            );
            assert.equal(
              fixture.events.filter((e) => e.type === "agent_start").length,
              2,
            );
            const failure = fixture.events.find(
              (e) => e.type === "compaction_end",
            );
            assert.ok(
              failure?.type === "compaction_end" &&
                !failure.aborted &&
                !failure.willRetry &&
                failure.reason === "overflow" &&
                failure.errorMessage?.includes(
                  "PRIVATE_SUMMARY_PROVIDER_DETAIL",
                ),
            );
            assert.match(
              fixture.requests.filter((r) => !r.summary)[1]?.context ?? "",
              /queued supervisor guidance/,
            );
            assert.equal(fixture.session.getSteeringMessages().length, 0);
            assert.equal(fixture.record().promptFinished, false);
            // FIFO observation barrier: guidance follows all compaction-failure observations.
            yield* until(
              "consumed guidance observation",
              Effect.sync(() =>
                observations.some(
                  (o) => o.kind === "message" && o.role === "user",
                ),
              ),
            );
            assert.deepEqual(
              observations.filter((o) => o.kind === "diagnostic"),
              [
                {
                  kind: "diagnostic",
                  diagnostic: {
                    category: "backend-failure",
                    message: "Pi recovery failed: [redacted]",
                  },
                },
              ],
              "failed required compaction is diagnosed before the second response",
            );
          }
          const atBoundary = observations.filter(
            (o) => o.kind === "ending" || o.kind === "reconciliation",
          );
          if (mode === "cancel-second") {
            const cancelled = yield* rig.supervisor.cancel([started.runId]);
            assert.equal(cancelled[0]?.outcome, "admitted");
          } else if (mode === "continue") {
            fixture.secondRelease.release();
          }
          yield* untilRunTerminal(rig.repository, started.runId);
          const stored = yield* rig.supervisor.result(started.runId);
          assert.equal(stored.outcome, "result");
          if (stored.outcome !== "result") throw new Error("missing Result");
          return { result: stored.result, atBoundary };
        }),
    );
    // Cleanup assertions precede deliberately RED desired outcomes.
    assert.equal(outcome.noLeaks, true);
    assert.equal(counters.counters().cleanupEscalations, 0);
    assert.deepEqual(handle.probe(), {
      openSessions: 0,
      liveSubscriptions: 0,
      pendingCleanups: 0,
    });
    assert.equal(fixture.record().disposed, 1);
    assert.equal(fixture.record().liveStreams, 0);
    assert.equal(fixture.record().promptFinished, true);
    assert.equal(fixture.session.isIdle, true);
    assert.equal(fixture.session.pendingMessageCount, 0);
    assert.deepEqual(fixture.faults, []);
    assert.deepEqual(ioGuard.attempts, []);
    if (mode === "continue") {
      assert.equal(fixture.record().toolCalls, 1);
      assert.equal(fixture.record().taskRequests, 3);
      assert.ok(
        fixture.events.some(
          (e) => e.type === "tool_execution_end" && !e.isError,
        ),
      );
      assert.ok(
        fixture.events.some(
          (e) =>
            e.type === "message_end" &&
            e.message.role === "assistant" &&
            e.message.stopReason === "stop",
        ),
      );
    }
    const { result, atBoundary } = outcome.value;
    t.diagnostic(
      JSON.stringify({
        mode,
        record: fixture.record(),
        events: fixture.events.map((e) => e.type),
        result,
        atBoundary,
        runtimeProbe: outcome.probeAfterClose,
        nativeProbe: handle.probe(),
        counters: counters.counters(),
      }),
    );
    const actual = {
      status: result.status,
      reason: result.cancellationReason,
      finalOutput: result.finalOutput,
      transcript: result.transcript.map((item) => ({
        role: item.role,
        text: item.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""),
      })),
      usage: result.usage.totals,
      turns: result.usage.turns,
      earlyTerminal: atBoundary.map((o) => o.kind),
      tools: result.tools.map((tool) => ({
        name: tool.name,
        status: tool.status,
        output: tool.outputSummary,
      })),
      recoveryDiagnostics: result.diagnostics.filter((d) =>
        d.message.includes("Pi recovery failed"),
      ),
      privateDetailLeaked: JSON.stringify(result).includes(
        "PRIVATE_SUMMARY_PROVIDER_DETAIL",
      ),
    };
    assert.deepEqual(actual, {
      status: mode === "continue" ? "completed" : "cancelled",
      reason: mode === "continue" ? undefined : "requested",
      finalOutput:
        mode === "continue" ? "later complete answer" : "original partial",
      transcript:
        mode === "continue"
          ? [
              { role: "assistant", text: "original partial" },
              { role: "user", text: "queued supervisor guidance" },
              { role: "assistant", text: "later tool work" },
              { role: "tool", text: "later tool result" },
              { role: "assistant", text: "later complete answer" },
            ]
          : mode === "cancel-second"
            ? [
                { role: "assistant", text: "original partial" },
                { role: "user", text: "queued supervisor guidance" },
              ]
            : [{ role: "assistant", text: "original partial" }],
      usage: {
        input: mode === "continue" ? 60 : 10,
        output: mode === "continue" ? 12 : 2,
        cacheRead: mode === "continue" ? 6 : 1,
        cacheWrite: 0,
        cost: mode === "continue" ? 0.06 : 0.01,
      },
      turns: mode === "continue" ? 3 : 1,
      earlyTerminal: [],
      tools:
        mode === "continue"
          ? [
              {
                name: "fixture_tool",
                status: "completed",
                output: "later tool result",
              },
            ]
          : [],
      recoveryDiagnostics:
        mode === "auth"
          ? []
          : [
              {
                category: "backend-failure",
                message: "Pi recovery failed: [redacted]",
              },
            ],
      privateDetailLeaked: false,
    });
  });
}
