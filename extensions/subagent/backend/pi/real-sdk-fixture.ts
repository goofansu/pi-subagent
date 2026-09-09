/** Private offline fixture for managed-finalization contract tests. No lifecycle doubles. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiSessionEvent } from "./session.ts";

function sdkGate() {
  let release = () => {};
  let opened = false;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      opened = true;
      resolve();
    };
  });
  return {
    promise,
    release,
    get opened() {
      return opened;
    },
  };
}

const model: Model<"openai-completions"> = {
  id: "offline-finalization",
  name: "Offline finalization",
  provider: "fixture",
  api: "openai-completions",
  baseUrl: "https://unexpected.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export async function realSdkFixture(
  t: TestContext,
  mode: "continue" | "cancel-second" | "auth",
) {
  const events: PiSessionEvent[] = [];
  const requests: { summary: boolean; context: string }[] = [];
  const faults: string[] = [];
  const authEntered = sdkGate();
  const authRelease = sdkGate();
  const summaryEntered = sdkGate();
  const summaryRelease = sdkGate();
  const secondEntered = sdkGate();
  const secondRelease = sdkGate();
  const abortEntered = sdkGate();
  let taskRequests = 0;
  let summaryActive = false;
  let initialAuthChecks = 0;
  let summarizationAuthCalls = 0;
  let disposed = 0;
  let promptFinished = false;
  let liveStreams = 0;
  let toolCalls = 0;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  // Initial prompt preflight is deliberately distinct from summarization getAuth.
  t.mock.method(runtime, "hasConfiguredAuth", () => {
    initialAuthChecks++;
    return true;
  });
  t.mock.method(runtime, "getAuth", async () => {
    summarizationAuthCalls++;
    assert.equal(events.filter((e) => e.type === "agent_end").length, 1);
    assert.equal(
      events.some((e) => e.type === "compaction_start"),
      false,
    );
    authEntered.release();
    await authRelease.promise;
    return undefined;
  });
  const loader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Offline finalization fixture.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  function message(
    text: string,
    stopReason: AssistantMessage["stopReason"],
    n: number,
  ): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason,
      timestamp: 1000 + n,
      usage: {
        input: n * 10,
        output: n * 2,
        cacheRead: n,
        cacheWrite: 0,
        totalTokens: n * 13,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: n / 100,
        },
      },
    };
  }
  const stream: StreamFn = (_model, context, options) => {
    const summary = summaryActive;
    requests.push({ summary, context: JSON.stringify(context) });
    const output = createAssistantMessageEventStream();
    liveStreams++;
    const run = async () => {
      if (summary) {
        summaryEntered.release();
        await summaryRelease.promise;
        const failure = message("", "error", 0);
        failure.errorMessage = "PRIVATE_SUMMARY_PROVIDER_DETAIL";
        output.push({ type: "error", reason: "error", error: failure });
        output.end();
        return;
      }
      const n = ++taskRequests;
      assert.ok(n <= 3, "unexpected task request");
      if (n === 2) {
        secondEntered.release();
        if (mode === "cancel-second") {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          const aborted = message("", "aborted", 0);
          output.push({ type: "error", reason: "aborted", error: aborted });
          output.end();
          return;
        }
        await secondRelease.promise;
      }
      const response = message(
        n === 1
          ? "original partial"
          : n === 2
            ? "later tool work"
            : "later complete answer",
        n === 1 ? "length" : n === 2 ? "toolUse" : "stop",
        n,
      );
      if (n === 2)
        response.content.push({
          type: "toolCall",
          id: "offline-tool",
          name: "fixture_tool",
          arguments: {},
        });
      output.push({
        type: "done",
        reason: response.stopReason as "length" | "toolUse" | "stop",
        message: response,
      });
      output.end();
    };
    void run()
      .catch((error) => {
        faults.push(String(error));
        const failure = message("", "error", 0);
        failure.errorMessage = String(error);
        output.push({ type: "error", reason: "error", error: failure });
        output.end();
      })
      .finally(() => {
        liveStreams--;
      });
    return output;
  };
  const agent = new Agent({
    initialState: { model, thinkingLevel: "off" },
    streamFn: stream,
  });
  const session = new AgentSession({
    agent,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory("/offline"),
    settingsManager: SettingsManager.inMemory({
      // A tiny real cut-point budget makes this short conversation summarizable.
      // At 10 the SDK correctly found nothing to summarize; no lifecycle is patched.
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
    resourceLoader: loader,
    cwd: "/offline",
    initialActiveToolNames: ["fixture_tool"],
    baseToolsOverride: {
      fixture_tool: {
        name: "fixture_tool",
        label: "Fixture tool",
        description: "Pure offline tool",
        parameters: { type: "object", properties: {}, required: [] },
        execute: async () => {
          toolCalls++;
          return {
            content: [{ type: "text", text: "later tool result" }],
            details: {},
          };
        },
      },
    },
  });
  const unsubscribe = session.subscribe((event) => {
    events.push(structuredClone(event));
    if (event.type === "compaction_start") summaryActive = true;
    if (event.type === "compaction_end") summaryActive = false;
  });
  const prompt = session.prompt.bind(session);
  t.mock.method(
    session,
    "prompt",
    async (...args: Parameters<typeof prompt>) => {
      try {
        await prompt(...args);
      } finally {
        promptFinished = true;
      }
    },
  );
  const abort = session.abort.bind(session);
  t.mock.method(session, "abort", () => {
    abortEntered.release();
    return abort();
  });
  const dispose = session.dispose.bind(session);
  t.mock.method(session, "dispose", () => {
    disposed++;
    unsubscribe();
    dispose();
  });
  const releaseAll = () => {
    authRelease.release();
    summaryRelease.release();
    secondRelease.release();
  };
  t.after(async () => {
    releaseAll();
    if (!disposed) {
      await session.abort();
      session.dispose();
    }
  });
  return {
    session,
    events,
    requests,
    faults,
    authEntered,
    authRelease,
    summaryEntered,
    summaryRelease,
    secondEntered,
    secondRelease,
    abortEntered,
    releaseAll,
    record: () => ({
      initialAuthChecks,
      summarizationAuthCalls,
      disposed,
      promptFinished,
      liveStreams,
      toolCalls,
      taskRequests,
    }),
  };
}
