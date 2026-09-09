/** Private stand-in driver. Only public supervisor Results and backend observations are read. */
import assert from "node:assert/strict";
import { Effect } from "effect";
import { piProbeIsClear } from "../../backend/pi/index.ts";
import {
  piRigRequest,
  quiesce,
  until,
  untilSteered,
  untilTerminal,
  withPiSession,
} from "./pi-rig.ts";
import type { PiScript } from "./stand-in-session.ts";

export interface BoundaryScenario {
  readonly name: string;
  readonly script: PiScript;
  readonly cancel?: boolean;
  readonly steer?: "queued" | "in-flight";
  readonly status: "completed" | "failed" | "cancelled";
  readonly second?: boolean;
  readonly consumed?: boolean;
  readonly recoveryFailure?: boolean;
  readonly providerFailure?: boolean;
  readonly recoveredWithoutAnswer?: boolean;
}

export const firstPartial: PiScript = [
  {
    step: "assistant",
    text: "first evidence",
    stopReason: "length",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 100,
      cost: 0.25,
    },
    toolCalls: [{ name: "read", callId: "first-tool" }],
  },
  { step: "tool-start", name: "read", callId: "first-tool" },
  {
    step: "tool-end",
    name: "read",
    callId: "first-tool",
    result: "first tool evidence",
  },
  { step: "tool-result", text: "first tool evidence" },
  { step: "terminal", messages: "current-execution" },
];
export const recoveryStart: PiScript = [
  { step: "compaction-start", reason: "overflow", retainedMessages: "remove" },
];
export const recoveryFailure: PiScript = [
  {
    step: "compaction-end",
    reason: "overflow",
    aborted: false,
    willRetry: false,
    errorMessage: "provider secret acct_1234",
  },
];
export const recoverySuccess = (willRetry: boolean): PiScript => [
  {
    step: "compaction-end",
    reason: "overflow",
    aborted: false,
    willRetry,
    result: { summary: "summary is not an answer" },
  },
];
export const boundary: PiScript = [{ step: "await-gate", gate: "boundary" }];
export const secondExecution = (complete: boolean): PiScript => [
  { step: "agent-start" },
  {
    step: "assistant",
    text: "second evidence",
    stopReason: complete ? "stop" : "length",
    usage: {
      input: 20,
      output: 3,
      cacheRead: 5,
      cacheWrite: 6,
      totalTokens: 250,
      cost: 0.5,
    },
    toolCalls: [{ name: "read", callId: "second-tool" }],
  },
  { step: "tool-start", name: "read", callId: "second-tool" },
  {
    step: "tool-end",
    name: "read",
    callId: "second-tool",
    result: "second tool evidence",
  },
  { step: "tool-result", text: "second tool evidence" },
  ...(complete
    ? [{ step: "terminal", messages: "current-execution" } as const]
    : []),
];

const firstComplete: PiScript = firstPartial.map((step) =>
  step.step === "assistant" ? { ...step, stopReason: "stop" } : step,
);
const firstFailure: PiScript = firstPartial.map((step) =>
  step.step === "assistant"
    ? {
        ...step,
        stopReason: "error",
        errorMessage: "provider secret acct_1234",
      }
    : step,
);
const admit: PiScript = [{ step: "await-gate", gate: "admit" }];
const consume: PiScript = [{ step: "await-steer", confirm: true }];

export const boundaryScenarios: readonly BoundaryScenario[] = [
  {
    name: "complete answer normal native finish",
    script: [...firstComplete, ...boundary],
    status: "completed",
  },
  {
    name: "complete answer cancelled during maintenance",
    script: [...firstComplete, ...recoveryStart, ...boundary],
    cancel: true,
    status: "completed",
  },
  {
    name: "complete answer maintenance fails",
    script: [
      ...firstComplete,
      ...recoveryStart,
      ...recoveryFailure,
      ...boundary,
    ],
    status: "completed",
  },
  {
    name: "incomplete cancelled during recovery",
    script: [...firstPartial, ...recoveryStart, ...boundary],
    cancel: true,
    status: "cancelled",
  },
  ...([true, false] as const).map(
    (willRetry): BoundaryScenario => ({
      name: `successful recovery willRetry=${willRetry} cancelled before continuation`,
      script: [
        ...firstPartial,
        ...recoveryStart,
        ...(willRetry ? [] : admit),
        ...recoverySuccess(willRetry),
        ...boundary,
      ],
      ...(willRetry ? {} : { steer: "queued" as const }),
      cancel: true,
      status: "cancelled",
    }),
  ),
  {
    name: "required recovery failure native finish",
    script: [
      ...firstPartial,
      ...recoveryStart,
      ...recoveryFailure,
      ...boundary,
    ],
    recoveryFailure: true,
    status: "failed",
  },
  {
    name: "required recovery failure queued continuation answers",
    script: [
      ...firstPartial,
      ...recoveryStart,
      ...admit,
      ...recoveryFailure,
      ...boundary,
      ...consume,
      ...secondExecution(true),
    ],
    steer: "queued",
    consumed: true,
    recoveryFailure: true,
    second: true,
    status: "completed",
  },
  {
    name: "required recovery failure cancelled while prompt open",
    script: [
      ...firstPartial,
      ...recoveryStart,
      ...recoveryFailure,
      ...boundary,
    ],
    recoveryFailure: true,
    cancel: true,
    status: "cancelled",
  },
  {
    name: "required recovery failure later execution cancelled",
    script: [
      ...firstPartial,
      ...recoveryStart,
      ...admit,
      ...recoveryFailure,
      ...consume,
      ...secondExecution(false),
      ...boundary,
    ],
    steer: "queued",
    consumed: true,
    recoveryFailure: true,
    second: true,
    cancel: true,
    status: "cancelled",
  },
  ...([true, false] as const).map(
    (willRetry): BoundaryScenario => ({
      name: `successful recovery willRetry=${willRetry} native finish without answer`,
      recoveredWithoutAnswer: true,
      script: [
        ...firstPartial,
        ...recoveryStart,
        ...recoverySuccess(willRetry),
        ...boundary,
      ],
      status: "failed",
    }),
  ),
  {
    name: "automatic willRetry=true recovery answers",
    script: [
      ...firstPartial,
      ...recoveryStart,
      ...recoverySuccess(true),
      ...secondExecution(true),
      ...boundary,
    ],
    second: true,
    status: "completed",
  },
  {
    name: "successful willRetry=false recovery queued continuation answers",
    script: [
      ...firstPartial,
      ...recoveryStart,
      ...admit,
      ...recoverySuccess(false),
      ...consume,
      ...secondExecution(true),
      ...boundary,
    ],
    steer: "queued",
    consumed: true,
    second: true,
    status: "completed",
  },
  {
    name: "earlier provider failure queued continuation answers",
    script: [
      ...firstFailure,
      ...admit,
      ...consume,
      ...secondExecution(true),
      ...boundary,
    ],
    steer: "queued",
    consumed: true,
    providerFailure: true,
    second: true,
    status: "completed",
  },
  {
    name: "earlier provider failure later execution cancelled",
    script: [
      ...firstFailure,
      ...admit,
      ...consume,
      ...secondExecution(false),
      ...boundary,
    ],
    steer: "queued",
    consumed: true,
    providerFailure: true,
    second: true,
    cancel: true,
    status: "cancelled",
  },
  {
    name: "provider failure cancelled while prompt open",
    script: [...firstFailure, ...boundary],
    providerFailure: true,
    cancel: true,
    status: "cancelled",
  },
  {
    name: "earlier complete answer later execution cancelled",
    script: [
      ...firstComplete,
      ...admit,
      ...consume,
      ...secondExecution(false),
      ...boundary,
    ],
    steer: "queued",
    consumed: true,
    second: true,
    cancel: true,
    status: "cancelled",
  },
  {
    name: "complete answer native task input pending at interruption",
    script: [...firstComplete, ...recoveryStart, ...admit, ...boundary],
    steer: "queued",
    cancel: true,
    status: "cancelled",
  },
  {
    name: "complete answer native steering delivery in flight at interruption",
    script: [...firstComplete, ...recoveryStart, ...admit, ...boundary],
    steer: "in-flight",
    cancel: true,
    status: "cancelled",
  },
];

export async function reproduceBoundary(scenario: BoundaryScenario) {
  const outcome = await withPiSession(
    {
      scripts: [
        [
          ...(scenario.cancel
            ? [
                {
                  step: "speak-on-abort",
                  text: "cleanup-only evidence",
                } as const,
              ]
            : []),
          ...scenario.script,
        ],
      ],
      ...(scenario.steer === "queued"
        ? { steerDelivery: "queued" as const }
        : {}),
    },
    (rig) =>
      Effect.gen(function* () {
        const started = yield* rig.supervisor.start(piRigRequest());
        assert.equal(started.outcome, "started");
        if (started.outcome !== "started") throw new Error("start refused");
        let admission: string | undefined;
        if (scenario.steer) {
          yield* until(
            "steering admission gate",
            Effect.sync(() =>
              rig.standIn.record().reachedGates.includes("admit"),
            ),
          );
          admission = (yield* rig.supervisor.steer(started.runId, {
            type: "steer",
            text: "queued guidance",
          })).outcome;
          yield* untilSteered(rig);
          rig.standIn.gate("admit").release();
        }
        yield* until(
          "semantic boundary gate",
          Effect.sync(() =>
            rig.standIn.record().reachedGates.includes("boundary"),
          ),
        );
        // Drain runnable fibers, never advance wall time or release native work.
        yield* quiesce();
        const before = {
          terminalObservations: rig.observations.filter(
            (o) => o.kind === "ending" || o.kind === "reconciliation",
          ),
          diagnostics: rig.observations.filter((o) => o.kind === "diagnostic"),
          nativeIdle: rig.standIn.session.isIdle,
          pending: rig.standIn.session.pendingMessageCount,
          deliveries: rig.standIn.record().concurrentSteers,
          compactionStarts: rig.standIn.record().compactionStarts,
        };
        if (scenario.cancel) yield* rig.supervisor.cancel([started.runId]);
        else rig.standIn.gate("boundary").release();
        yield* untilTerminal(rig, started.runId);
        const result = yield* rig.supervisor.result(started.runId);
        return {
          result,
          before,
          admission,
          record: rig.standIn.record(),
          counters: rig.supervisor.counters(),
          observations: [...rig.observations],
        };
      }),
  );
  assert.equal(outcome.noLeaks, true);
  assert.ok(Object.values(outcome.probeAfterClose).every((n) => n === 0));
  assert.ok(piProbeIsClear(outcome.nativeProbeAfterClose));
  return outcome.value;
}

export function assertBoundary(
  scenario: BoundaryScenario,
  value: Awaited<ReturnType<typeof reproduceBoundary>>,
) {
  assert.equal(value.result.outcome, "result");
  if (value.result.outcome !== "result") return;
  const result = value.result.result;
  const actual = {
    status: result.status,
    cancellationReason: result.cancellationReason,
    errorMessage: result.errorMessage,
    output: result.finalOutput,
    transcript: result.transcript.map((item) => [
      item.role,
      item.parts.map((p) => (p.kind === "text" ? p.text : p.name)).join(" "),
    ]),
    tools: result.tools,
    totals: result.usage.totals,
    turns: result.usage.turns,
    context: result.usage.context,
    prematureTerminal: value.before.terminalObservations,
    lateObservations: value.counters.lateObservations,
    cleanupEscalations: value.counters.cleanupEscalations,
    ...(scenario.status === "cancelled"
      ? {
          interruptionEndings: value.observations.filter(
            (o) => o.kind === "ending",
          ),
        }
      : {}),
  };
  const expected = {
    status: scenario.status,
    cancellationReason:
      scenario.status === "cancelled" ? "requested" : undefined,
    errorMessage:
      scenario.status === "failed"
        ? scenario.recoveryFailure
          ? "Pi recovery failed: [redacted]"
          : "Pi did not complete its message: [redacted]"
        : undefined,
    output: scenario.second ? "second evidence" : "first evidence",
    transcript: [
      ["assistant", "first evidence read"],
      ["tool", "first tool evidence"],
      ...(scenario.consumed ? [["user", "queued guidance"]] : []),
      ...(scenario.second
        ? [
            ["assistant", "second evidence read"],
            ["tool", "second tool evidence"],
          ]
        : []),
    ],
    tools: [
      {
        name: "read",
        callId: "first-tool",
        status: "completed",
        outputSummary: "first tool evidence",
      },
      ...(scenario.second
        ? [
            {
              name: "read",
              callId: "second-tool",
              status: "completed",
              outputSummary: "second tool evidence",
            },
          ]
        : []),
    ],
    totals: scenario.second
      ? { input: 30, output: 5, cacheRead: 8, cacheWrite: 10, cost: 0.75 }
      : { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25 },
    turns: scenario.second ? 2 : 1,
    context: { tokens: scenario.second ? 250 : 100 },
    prematureTerminal: [],
    lateObservations: 0,
    cleanupEscalations: 0,
    ...(scenario.status === "cancelled" ? { interruptionEndings: [] } : {}),
  };
  assert.equal(value.before.nativeIdle, false);
  if (scenario.steer) assert.equal(value.admission, "accepted");
  if (scenario.steer === "queued" && !scenario.consumed)
    assert.equal(value.before.pending, 1);
  if (scenario.steer === "queued") assert.equal(value.before.deliveries, 0);
  if (scenario.steer === "in-flight") {
    assert.equal(value.before.pending, 0);
    assert.equal(value.before.deliveries, 1);
  }
  // Cancellation discards undelivered admissions; it does not invent a
  // rejected/abandoned delivery diagnostic. Ordinary-finish diagnostics have
  // separate existing execution tests (including exact diagnostic counts).
  assert.deepEqual(
    result.diagnostics.filter((d) => d.category === "control"),
    [],
  );
  if (
    scenario.providerFailure ||
    scenario.recoveryFailure ||
    scenario.recoveredWithoutAnswer
  ) {
    const expectedDiagnostics = [
      {
        category: "backend-failure",
        message: scenario.recoveryFailure
          ? "Pi recovery failed: [redacted]"
          : scenario.recoveredWithoutAnswer
            ? "Pi did not complete its message: [redacted]"
            : "Pi reported a failed message: [redacted]",
      },
    ];
    assert.deepEqual(result.diagnostics, expectedDiagnostics);
    // Check emission too: projection deduplication must not hide duplicates.
    assert.deepEqual(
      value.observations.flatMap((o) =>
        o.kind === "diagnostic" ? [o.diagnostic] : [],
      ),
      expectedDiagnostics,
    );
  }
  assert.deepEqual(
    value.record.consumedSteers,
    scenario.consumed ? ["queued guidance"] : [],
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /provider secret|acct_1234|summary is not an answer/,
  );
  if (scenario.recoveryFailure) {
    assert.deepEqual(
      value.before.diagnostics.filter(
        (o) =>
          o.kind === "diagnostic" &&
          o.diagnostic.message === "Pi recovery failed: [redacted]",
      ),
      [
        {
          kind: "diagnostic",
          diagnostic: {
            category: "backend-failure",
            message: "Pi recovery failed: [redacted]",
          },
        },
      ],
    );
  }
  assert.deepEqual(actual, expected);
}
