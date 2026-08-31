import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlSource } from "../../control-source.ts";
import type { Fact, RunReporter } from "../../run.ts";
import {
  type CodexAppServerEvent,
  createCodexAppServerSession,
} from "./app-server.ts";

type CodexAppServerTransport = NonNullable<
  Parameters<typeof createCodexAppServerSession>[1]
>;
type CodexTransportObserver = Parameters<CodexAppServerTransport["attach"]>[0];
type CodexTransportOccurrence = Parameters<CodexTransportObserver["admit"]>[0];
type CodexTransportTurn = Parameters<
  Parameters<CodexAppServerTransport["startTurn"]>[1]
>[0];
type ThreadTokenUsage = Parameters<
  CodexAppServerTransport["normalizeTurnUsage"]
>[0];
type CodexTransportMessage = Extract<
  CodexTransportOccurrence,
  { readonly type: "provider-message" }
>["message"];

const completed = (turnId = "turn-test"): CodexAppServerEvent => ({
  method: "turn/completed",
  params: {
    threadId: "thread-test",
    turn: {
      id: turnId,
      items: [],
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  },
});

const completedAgentMessage = (turnId = "turn-test"): CodexAppServerEvent => ({
  method: "item/completed",
  params: {
    threadId: "thread-test",
    turnId,
    completedAtMs: 1,
    item: {
      type: "agentMessage",
      id: "answer-test",
      text: "Attempt-owned answer",
      phase: "final_answer",
    },
  },
});

function reporter(facts: Fact[]): RunReporter {
  return {
    message: (fact) => facts.push(fact),
    transcript: () => {},
    activity: () => {},
    stderr: () => {},
  };
}

class DeterministicCodexTransport implements CodexAppServerTransport {
  continuationAvailable = true;
  hasIssuedTurn = false;
  stdoutTail = "";
  processAcquisitions = 0;
  closeCalls = 0;
  terminateCalls = 0;
  readonly steers: string[] = [];
  readonly escalations: ("SIGTERM" | "SIGKILL")[] = [];
  private started = false;
  private observer: CodexTransportObserver | undefined;
  private attachTurn: ((turn: CodexTransportTurn) => void) | undefined;

  beginTurn(): void {
    this.stdoutTail = "";
  }

  attach(observer: CodexTransportObserver): void {
    this.observer = observer;
  }

  detach(observer: CodexTransportObserver): void {
    if (this.observer === observer) this.observer = undefined;
  }

  start() {
    if (!this.started) {
      this.started = true;
      this.processAcquisitions += 1;
    }
    return { status: "ready" as const };
  }

  startTurn(_prompt: string, accept: (turn: CodexTransportTurn) => void): void {
    this.hasIssuedTurn = true;
    this.attachTurn = accept;
  }

  releaseTurn(): void {
    const turn: CodexTransportTurn = {
      steer: (text, _clientUserMessageId, accept) => {
        this.steers.push(text);
        accept();
      },
      matches: () => true,
      interrupt: () => {},
      completeInterruption: () => {},
    };
    this.attachTurn?.(turn);
    this.attachTurn = undefined;
  }

  emit(event: CodexAppServerEvent): void {
    const message: CodexTransportMessage = { consume: () => event };
    this.observer?.admit({ type: "provider-message", message });
  }

  emitUnknownNotification(): void {
    const message: CodexTransportMessage = { consume: () => undefined };
    this.observer?.admit({ type: "provider-message", message });
  }

  emitOccurrence(occurrence: CodexTransportOccurrence): void {
    if (
      occurrence.type === "process-close" ||
      occurrence.type === "process-error"
    )
      this.continuationAvailable = false;
    this.observer?.admit(occurrence);
  }

  frame(occurrences: readonly CodexTransportOccurrence[]): void {
    this.observer?.beginFrame();
    for (const occurrence of occurrences) this.emitOccurrence(occurrence);
    this.observer?.endFrame();
  }

  normalizeTurnUsage(tokenUsage: ThreadTokenUsage): ThreadTokenUsage {
    return tokenUsage;
  }

  redactDiagnostic(value: string): string {
    return value;
  }

  settlePending(): void {}
  terminate(): void {
    this.terminateCalls += 1;
    this.continuationAvailable = false;
  }

  escalate(stage: "SIGTERM" | "SIGKILL"): void {
    this.escalations.push(stage);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.continuationAvailable = false;
  }
}

test("a deterministic transport retains a pre-identity Control for the current Turn", async () => {
  const transport = new DeterministicCodexTransport();
  const controls = createControlSource();
  assert.equal(
    controls.offer({ type: "steer", text: "guidance before identity" }),
    "accepted",
  );
  const facts: Fact[] = [];
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );

  const settled = session.runNextTurn({
    prompt: "goal",
    controls: controls.controls,
    report: reporter(facts),
    missingAnswerMessage: "missing",
    translate: (event) =>
      event.method === "turn/completed"
        ? {
            facts: [
              { role: "assistant", parts: [{ type: "text", text: "ok" }] },
            ],
            terminal: true,
          }
        : undefined,
  });

  assert.deepEqual(transport.steers, []);
  transport.releaseTurn();
  assert.deepEqual(transport.steers, ["guidance before identity"]);
  transport.emit(completed());
  assert.deepEqual(await settled, { ending: "answered" });
  assert.equal(facts.at(-1)?.parts[0]?.type, "text");
  await session.close();
});

test("a Codex Attempt owns its fresh translator", async () => {
  const transport = new DeterministicCodexTransport();
  const facts: Fact[] = [];
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );

  const settled = session.runNextTurn({
    prompt: "goal",
    report: reporter(facts),
    missingAnswerMessage: "missing",
  });
  transport.releaseTurn();
  transport.emit(completedAgentMessage());
  transport.emit(completed());

  assert.deepEqual(await settled, { ending: "answered" });
  assert.deepEqual(facts, [
    {
      role: "assistant",
      parts: [{ type: "text", text: "Attempt-owned answer" }],
      usage: { turns: 0 },
    },
  ]);
  await session.close();
});

test("transport occurrences retain provider-before-close order within one frame", async () => {
  const transport = new DeterministicCodexTransport();
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );
  const settled = session.runNextTurn({
    prompt: "goal",
    report: reporter([]),
    missingAnswerMessage: "missing",
    translate: (event) =>
      event.method === "turn/completed" ? { terminal: true } : undefined,
  });
  transport.releaseTurn();

  transport.frame([
    {
      type: "provider-message",
      message: { consume: () => completed() },
    },
    { type: "process-close", code: 1 },
  ]);

  assert.deepEqual(await settled, { ending: "answered" });
  assert.equal(session.continuationAvailable, false);
  await session.close();
});

test("unknown provider notifications are ignored through the transport seam", async () => {
  const transport = new DeterministicCodexTransport();
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );
  const translated: string[] = [];
  const settled = session.runNextTurn({
    prompt: "goal",
    report: reporter([]),
    missingAnswerMessage: "missing",
    translate: (event) => {
      translated.push(event.method);
      return event.method === "turn/completed" ? { terminal: true } : undefined;
    },
  });
  transport.releaseTurn();

  transport.emitUnknownNotification();
  transport.emit(completed());

  assert.deepEqual(await settled, { ending: "answered" });
  assert.deepEqual(translated, ["turn/completed"]);
  await session.close();
});

test("one deterministic transport retains its process across sequential Turns and closes once", async () => {
  const transport = new DeterministicCodexTransport();
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );
  const turnOptions = {
    prompt: "goal",
    report: reporter([]),
    missingAnswerMessage: "missing",
    translate: (event: CodexAppServerEvent) =>
      event.method === "turn/completed"
        ? { terminal: true as const }
        : undefined,
  };

  const first = session.runNextTurn(turnOptions);
  transport.releaseTurn();
  transport.emit(completed("turn-one"));
  assert.deepEqual(await first, { ending: "answered" });

  const second = session.runNextTurn(turnOptions);
  transport.releaseTurn();
  transport.emit(completed("turn-two"));
  assert.deepEqual(await second, { ending: "answered" });
  assert.equal(transport.processAcquisitions, 1);

  await Promise.all([session.close(), session.close()]);
  assert.equal(transport.closeCalls, 1);
});

test("transport failure becomes one observable failed Ending", async () => {
  const transport = new DeterministicCodexTransport();
  const diagnostics: string[] = [];
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );
  const settled = session.runNextTurn({
    prompt: "goal",
    missingAnswerMessage: "missing",
    translate: () => undefined,
    report: {
      ...reporter([]),
      stderr: (text) => diagnostics.push(text),
    },
  });
  transport.releaseTurn();

  transport.emitOccurrence({
    type: "process-error",
    error: new Error("transport broke"),
  });

  assert.deepEqual(await settled, {
    ending: "failed",
    errorMessage: "transport broke",
  });
  assert.deepEqual(diagnostics, ["transport broke\n"]);
  assert.equal(transport.terminateCalls, 1);
  await session.close();
});

test("escalation is reduced deterministically without timer sleeps", async () => {
  const transport = new DeterministicCodexTransport();
  const session = createCodexAppServerSession(
    { cwd: "/work", childDepth: 1 },
    transport,
  );
  const settled = session.runNextTurn({
    prompt: "goal",
    report: reporter([]),
    missingAnswerMessage: "missing",
    translate: () => undefined,
  });
  transport.releaseTurn();

  transport.emitOccurrence({ type: "escalation", stage: "SIGTERM" });
  assert.deepEqual(transport.escalations, ["SIGTERM"]);
  transport.emitOccurrence({ type: "process-close", code: 143 });

  assert.deepEqual(await settled, {
    ending: "failed",
    errorMessage: "Child codex exited with code 143",
  });
  await session.close();
});
