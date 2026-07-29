/**
 * Claude Code backend — runs an agent profile through the Claude Agent SDK.
 *
 * The SDK owns the child CLI, tool execution, and its own transcript. This file
 * owns three things: mapping an agent profile onto SDK options, translating the
 * SDK message stream into pi `Message`s so the existing TUI renders a Claude
 * run identically to a pi run, and honoring abort.
 *
 * The SDK is imported lazily and declared an optional dependency, so a pi-only
 * setup that never selects this harness does not need it present.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
  Options as ClaudeOptions,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AssistantMessage,
  Message,
  StopReason,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { SubagentBackend, SubagentRunContext } from "../backend.ts";
import { appendStderr, DEPTH_ENV_KEY, settleAborted } from "../backend.ts";
import type { AgentConfig, Effort, SingleResult } from "../types.ts";
import { resolveAppendSystemPrompt } from "../types.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The tools a `claude` subagent may use — an allowlist, not a denylist.
 *
 * A claude subagent is still delegated to rather than configured: it reads,
 * writes, searches, runs commands, and uses its own skills, which is the point
 * of handing work to another harness. What it must not do is start or reach
 * another agent, because delegation has to stay visible to this extension rather
 * than disappearing into a hierarchy no depth guard bounds.
 *
 * That has to be an allowlist. Claude Code's tool set is open and grows with
 * every release, and naming today's spawn tools leaves tomorrow's reachable —
 * which is exactly what happened: withholding `Agent`/`Task`/`Workflow` still
 * left `CronCreate` (schedules a recurring cloud agent), `RemoteTrigger`
 * (launches a remote one), and `SendMessage` (reaches an existing one) available
 * through `ToolSearch`, each running with approvals bypassed and none inheriting
 * the depth guard — a scheduled agent outlives the pi session entirely.
 *
 * `ToolSearch` is therefore withheld too: it is the gateway to the whole
 * deferred built-in set, so leaving it in would re-open the set this list exists
 * to close. Bounding the base set also drops the ~13k tokens of deferred tool
 * definitions a run would otherwise carry.
 *
 * Two honest limits. `Bash` is here, and `Bash` can run `claude -p`, so no tool
 * policy makes this a hard recursion bound; what it does bound is the durable,
 * invisible cases — a scheduled or remote agent that outlives the session and
 * appears in no transcript. And the base set is not perfectly closed: the CLI
 * also surfaces its background-task pair (`TaskOutput`/`TaskStop`) alongside
 * `Bash` whether or not they are named here. Those only observe and stop tasks
 * this session already started, so they reach nothing new.
 *
 * Names from both generations of the background-shell tools are listed, since an
 * unrecognized name is ignored rather than an error, and which pair a given CLI
 * uses is a version detail.
 */
export const CLAUDE_ALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookEdit",
  "Skill",
] as const;

/**
 * Tools denied outright, on top of being absent from
 * {@link CLAUDE_ALLOWED_TOOLS}.
 *
 * Two mechanisms on purpose. The allowlist is what fails closed against a tool
 * this version has never heard of; the denylist still holds if a future CLI
 * widens its base set or stops honoring `tools`. `Agent` and `Task` are two
 * names for the one native delegation tool — `Task` was the original and is
 * still what some versions show the model — so both are named.
 */
export const CLAUDE_WITHHELD_TOOLS = ["Agent", "Task", "Workflow"] as const;

/** A minimal thinking budget; the SDK's effort scale has no "minimal" tier. */
const MINIMAL_THINKING_BUDGET = 1_024;

// ── SDK loading ───────────────────────────────────────────────────────────────

/** The single SDK entry point this backend uses. */
export type ClaudeQuery = AsyncIterable<SDKMessage> & {
  close?: () => void;
};

export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: ClaudeOptions;
}) => ClaudeQuery;

let cachedQuery: ClaudeQueryFn | undefined;

export async function loadClaudeQuery(): Promise<ClaudeQueryFn> {
  if (cachedQuery) return cachedQuery;
  let mod: { query: ClaudeQueryFn };
  try {
    mod = (await import(SDK_PACKAGE)) as unknown as { query: ClaudeQueryFn };
  } catch (cause) {
    throw new Error(
      `harness 'claude' requires the '${SDK_PACKAGE}' package, which could not be loaded. ` +
        `It is an optional dependency of pi-subagent, so reinstalling the package should restore it; ` +
        `a global install will not be found, because the import resolves from pi-subagent's own directory. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  cachedQuery = mod.query;
  return cachedQuery;
}

/**
 * The packages the SDK looks in for its CLI binary, in its own order. Mirrors
 * the resolution `query()` performs, because the binary is not part of the SDK
 * package: it ships in a per-platform optional dependency, which an install can
 * be missing — a platform with no prebuilt, or `npm install --omit=optional` —
 * while the SDK itself imports fine.
 */
export function claudeBinaryCandidates(
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  const binary = platform === "win32" ? "claude.exe" : "claude";
  const packages =
    platform === "android"
      ? [`${SDK_PACKAGE}-linux-${arch}-android`]
      : platform === "linux"
        ? [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`]
        : [`${SDK_PACKAGE}-${platform}-${arch}`];
  return packages.map((name) => `${name}/${binary}`);
}

/**
 * Whether the CLI the SDK drives is actually installed. Resolution starts from
 * the SDK's own location, as the SDK's does, so a nested install is found where
 * resolving from this file would miss it.
 *
 * A miss is not fatal on its own — `run` still surfaces whatever `query()` says
 * — but it is what makes the startup warning fire instead of every delegation
 * failing later.
 */
export function findClaudeBinary(
  resolve: (specifier: string, from?: string) => string = (specifier, from) =>
    createRequire(from ?? import.meta.url).resolve(specifier),
  exists: (filePath: string) => boolean = fs.existsSync,
  candidates: readonly string[] = claudeBinaryCandidates(),
): string | undefined {
  let sdkPath: string;
  try {
    sdkPath = resolve(SDK_PACKAGE);
  } catch {
    return undefined;
  }
  for (const candidate of candidates) {
    try {
      const binaryPath = resolve(candidate, sdkPath);
      if (exists(binaryPath)) return binaryPath;
    } catch {
      /* this platform package is not installed */
    }
  }
  return undefined;
}

/** Whether the CLI the SDK drives is installed. See {@link findClaudeBinary}. */
export function hasClaudeBinary(
  ...args: Parameters<typeof findClaudeBinary>
): boolean {
  return findClaudeBinary(...args) !== undefined;
}

/**
 * The command a person can run to reopen a Claude session — `claude` when a
 * Claude Code install put it on PATH, otherwise the absolute path to the SDK's
 * bundled binary.
 *
 * The bundled binary is not a real fallback so much as the common case: neither
 * the SDK nor its platform package declares an npm `bin`, so an install can run
 * claude subagents perfectly well with no `claude` on PATH at all — and a resume
 * hint printed there would only ever say "command not found".
 *
 * Resolved once. Nothing here changes within a session, and this runs per
 * rendered result.
 */
let cachedResumeCommand: string | undefined;

export function resolveClaudeCommand(
  onPath: (command: string) => boolean = isOnPath,
  findBinary: () => string | undefined = () => findClaudeBinary(),
  useCache = true,
): string {
  if (useCache && cachedResumeCommand) return cachedResumeCommand;
  const command = onPath("claude") ? "claude" : (findBinary() ?? "claude");
  if (useCache) cachedResumeCommand = command;
  return command;
}

function isOnPath(command: string): boolean {
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .map((extension) => command + extension.toLowerCase())
      : [command];
  return entries.some((entry) =>
    names.some((name) => {
      if (!entry) return false;
      try {
        fs.accessSync(path.join(entry, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

// ── Profile → SDK options ─────────────────────────────────────────────────────

/**
 * The model to pin, or `undefined` to let Claude Code choose. Passed exactly as
 * written: a bare id, a Bedrock id, or an inference-profile ARN are all things
 * Claude Code accepts, and nothing here is in a position to tell them apart.
 *
 * `inherit` does not forward the caller's pi model: the caller may be on a
 * different provider entirely, so Claude Code's own default is the only safe
 * neutral choice.
 */
export function resolveClaudeModel(config: AgentConfig): string | undefined {
  if (!config.model || config.model === "inherit") return undefined;
  return config.model;
}

/** Reasoning depth. Its own field, so there is nothing to derive. */
export function resolveClaudeEffort(config: AgentConfig): Effort | undefined {
  return config.effort;
}

/** Map the backend-neutral effort onto the SDK's thinking/effort options. */
export function buildThinkingOptions(
  effort: Effort | undefined,
): Pick<ClaudeOptions, "effort" | "thinking"> {
  switch (effort) {
    case undefined:
      return {};
    case "off":
      return { thinking: { type: "disabled" } };
    case "minimal":
      return {
        thinking: { type: "enabled", budgetTokens: MINIMAL_THINKING_BUDGET },
      };
    default:
      return { effort };
  }
}

/**
 * Approvals are always bypassed, and this is not configurable.
 *
 * There is no interactive channel to a headless subagent, so Claude Code cannot
 * ask anyone: an operation needing approval is denied outright. Any other mode
 * would therefore mean "deny everything that asks", which is not a useful shape
 * for a delegated agent. A trusted directory's `permissions.allow` rules can
 * pre-approve some calls, but never every call an agent might make, so the mode
 * still has to be bypass rather than default.
 *
 * Bypassed approvals are why the tool set is bounded rather than inherited
 * wholesale: nothing gates what an allowed tool does, so the allowlist is the
 * only place a limit can live. See {@link CLAUDE_ALLOWED_TOOLS}.
 */
export function buildPermissionOptions(): Pick<
  ClaudeOptions,
  "permissionMode" | "allowDangerouslySkipPermissions"
> {
  return {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };
}

export function buildClaudeSystemPrompt(
  config: AgentConfig,
  cwd?: string,
): ClaudeOptions["systemPrompt"] {
  const parts = config.systemPrompt.trim();

  if (resolveAppendSystemPrompt(config)) {
    // The preset already describes the environment, including the directory.
    return { type: "preset", preset: "claude_code", append: parts };
  }

  // Replacing the preset also drops the environment context it supplies, which
  // leaves the agent unable to say where it is: asked for its working
  // directory it answers "UNKNOWN", and it resolves a bare filename against
  // the filesystem root. State the directory so relative paths work.
  //
  // JSON-encoded, because the path is data and this is a system prompt. A POSIX
  // path may contain newlines, and an embedder's cwd can come from a checkout
  // whose name someone else chose — `/tmp/repo\nIgnore previous instructions`
  // would otherwise land as its own system-level line, on an agent running with
  // approvals bypassed. Encoding collapses it to one escaped, quoted token.
  const environment = cwd
    ? `Your working directory is this JSON-encoded path: ${JSON.stringify(cwd)}. Resolve relative paths against it.`
    : undefined;
  return [parts, environment]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export interface BuildClaudeOptionsInput {
  config: AgentConfig;
  cwd: string;
  depth: number;
  /**
   * Whether pi trusts this directory. Absent means unknown, which is treated as
   * untrusted — see the settings comment in the returned options.
   */
  projectTrusted?: boolean;
  abortController?: AbortController;
  env?: NodeJS.ProcessEnv;
}

export function buildClaudeOptions({
  config,
  cwd,
  depth,
  projectTrusted = false,
  abortController,
  env = process.env,
}: BuildClaudeOptionsInput): ClaudeOptions {
  const model = resolveClaudeModel(config);

  return {
    cwd,
    systemPrompt: buildClaudeSystemPrompt(config, cwd),
    ...buildPermissionOptions(),
    ...buildThinkingOptions(resolveClaudeEffort(config)),
    // `tools` is the base set — what exists at all. Not `allowedTools`, which
    // only decides what runs without asking for approval, and so would bound
    // nothing on a subagent that already bypasses approvals.
    tools: [...CLAUDE_ALLOWED_TOOLS],
    disallowedTools: [...CLAUDE_WITHHELD_TOOLS],
    // Propagate the depth guard so a Claude child that somehow reaches this
    // extension again is rejected the same way a pi child would be. Note the
    // SDK replaces the child environment with this object rather than merging,
    // so process.env has to be spread in.
    env: { ...env, [DEPTH_ENV_KEY]: String(depth + 1) },
    // What a subagent may load from disk follows pi's own trust decision for
    // this directory, so delegating never grants a directory more than working
    // in it already did.
    //
    // Trusted: nothing is set, so Claude Code loads what it normally would —
    // your settings, your skills and plugins, your CLAUDE.md, your MCP servers.
    // That is the point of delegating on your own machine; a subagent that
    // cannot see your skills is a worse version of you.
    //
    // Untrusted: user scope only, and MCP restricted to servers passed
    // programmatically (none are). A subagent runs with approvals bypassed, and
    // a checkout you have not trusted can register hooks in its
    // .claude/settings.json — arbitrary commands no tool policy intercepts — or
    // name a stdio server in .mcp.json, which is itself a command to launch.
    // `project` is also what would load its CLAUDE.md.
    //
    // Absent trust information the guarded shape applies: a host that cannot
    // say must not be read as saying yes.
    ...(projectTrusted
      ? {}
      : { settingSources: ["user" as const], strictMcpConfig: true }),
    ...(model ? { model } : {}),
    // `skills` is deliberately not set. Claude Code manages its own skills, the
    // same way it manages its own tools — a claude subagent is delegated to, not
    // configured. A profile's `skills` field is a pi-only field, rejected at
    // load time rather than injected here.
    ...(abortController ? { abortController } : {}),
  };
}

// ── SDK messages → pi messages ───────────────────────────────────────────────

/** Tool-call ids seen so far, so tool results can recover their tool name. */
export interface ClaudeTranslationState {
  toolNames: Map<string, string>;
  /**
   * API response ids whose usage has already been counted. Claude Code emits one
   * assistant frame per content block, every frame repeating the same
   * `message.id` and the same `usage` object, so counting per frame inflates
   * tokens and turns by the number of blocks in the response.
   */
  countedResponseIds: Set<string>;
  /**
   * The SDK error each errored response reported, and the id of the most recent
   * response. A refusal can be retried on a fallback model and then succeed, so
   * only an error on the *last* response means the run failed — an earlier one
   * the CLI recovered from must not condemn the whole run.
   */
  responseErrors: Map<string, string>;
  lastResponseId?: string;
  /**
   * The transcript message each response is being assembled into, so the frames
   * of one response become one message rather than one message each.
   */
  responseMessages: Map<string, AssistantMessage>;
  /**
   * Wire uuids of frames already folded in, so a replayed frame is not recorded
   * twice. Identity has to come from the uuid rather than the content: the
   * content array is ordered and its blocks need not be distinct, so treating an
   * exact repeat as a replay would collapse two deliberate `"ha"` blocks into
   * one.
   */
  seenFrames: Set<string>;
  /**
   * What each wire message contributed to the transcript, so the refusal
   * fallback's eviction signal can take it back out again.
   */
  contributions: Map<string, Contribution>;
  /**
   * Tool-call ids whose result is already in the transcript, so a replayed
   * frame is recognized without re-reading the transcript. An index rather than
   * a scan: a `tool_result` block would otherwise search every message recorded
   * so far, which is quadratic in a run that makes hundreds of tool calls.
   *
   * Kept in step with the transcript by {@link dropMessage}, so a result the
   * refusal fallback retracted can be recorded again if it is re-delivered.
   */
  recordedToolResults: Set<string>;
  /**
   * Whether the run reported its own totals. Only the result frame carries them,
   * so its absence is what makes the accumulated `output` figure unusable — see
   * {@link applyAuthoritativeUsage} and `UsageStats.outputUnreported`.
   */
  sawResultFrame: boolean;
}

/**
 * The transcript state one wire message produced. An assistant frame appends
 * blocks to a message shared with the other frames of its response, so only its
 * own blocks may be withdrawn; a user frame produces whole tool-result rows.
 */
type Contribution =
  | {
      kind: "blocks";
      message: AssistantMessage;
      blocks: AssistantMessage["content"];
    }
  | { kind: "messages"; messages: Message[] };

export function createClaudeTranslationState(): ClaudeTranslationState {
  return {
    toolNames: new Map(),
    countedResponseIds: new Set(),
    responseErrors: new Map(),
    responseMessages: new Map(),
    seenFrames: new Set(),
    contributions: new Map(),
    recordedToolResults: new Set(),
    sawResultFrame: false,
  };
}

/**
 * Stop reasons that mean the turn did not finish cleanly. A `success` result
 * frame does not overrule these — see {@link applyResult}.
 */
const FAILED_STOP_REASONS: Record<string, string> = {
  length:
    "Claude Code hit its output token limit; the output below is truncated.",
  aborted: "Claude Code aborted the turn; the output below is incomplete.",
  error: "Claude Code ended the turn with an error.",
};

function mapStopReason(raw: string | null | undefined): StopReason | undefined {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    // The turn ran out of context rather than out of output budget. Both mean
    // the answer stops mid-thought, which is what "length" says here.
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    // `pause_turn` is deliberately unmapped: the CLI resumes that turn itself,
    // so it is not an outcome. Same for an unrecognized future value — leaving
    // it undefined keeps whatever the run already concluded.
    default:
      return undefined;
  }
}

/** A usage field as a number, treating anything else as zero. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Context occupancy after one API request. An assistant message's usage
 * describes only that request: the whole prompt (fresh + cache-read +
 * cache-written input) plus this response's output, which is what now sits in
 * the context window. The run's aggregate usage re-counts cached context once
 * per request, so it must never be read as occupancy.
 *
 * The output term is a floor rather than a total, for the reason
 * {@link applyAuthoritativeUsage} describes: a frame is delivered mid-response,
 * so its `output_tokens` counts only what had been generated by then. The
 * prompt terms dominate, and no per-request total is reported anywhere, so this
 * stays the closest available reading.
 */
export function contextOccupancyTokens(usage: {
  input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens?: number | null;
}): number | undefined {
  if (typeof usage.input_tokens !== "number") return undefined;
  return (
    tokenCount(usage.input_tokens) +
    tokenCount(usage.cache_read_input_tokens) +
    tokenCount(usage.cache_creation_input_tokens) +
    tokenCount(usage.output_tokens)
  );
}

/**
 * Replace the frame-accumulated token counts with the run's own totals.
 *
 * An assistant frame's `output_tokens` is a mid-response snapshot, not that
 * response's total: the frame is delivered as soon as its content block closes,
 * while generation continues — its `stop_reason` is still `null` — so the count
 * is whatever had been emitted at that instant. A 550-character text block
 * arrives reporting 5 output tokens against a response that really spent 212.
 * Summing frames therefore under-reports output several-fold.
 *
 * Prompt-side counts are settled before generation starts and do sum correctly,
 * but they are taken from here too: the result frame is the same source the
 * `cost` beside them already comes from, and one source for the whole row is
 * what keeps tokens and cost telling the same story.
 *
 * Each counter is replaced only where the frame actually reports one. A total
 * the run did not state is not a total of zero, and overwriting the running
 * estimate with one would turn a spent run into a free-looking one.
 */
function applyAuthoritativeUsage(
  usage: SDKResultMessage["usage"] | undefined,
  result: SingleResult,
): void {
  if (!usage) return;
  const fields = [
    ["input", usage.input_tokens],
    ["output", usage.output_tokens],
    ["cacheRead", usage.cache_read_input_tokens],
    ["cacheWrite", usage.cache_creation_input_tokens],
  ] as const;
  for (const [key, reported] of fields) {
    if (typeof reported === "number" && Number.isFinite(reported)) {
      result.usage[key] = tokenCount(reported);
    }
  }
}

/**
 * Bill one API response's tokens, once. Claude Code emits a frame per content
 * block, every frame repeating the same `message.id` and the same usage object,
 * so counting per frame inflates the total by the number of blocks.
 *
 * Applies to delegated subagent responses too: their tokens are spent even
 * though their messages are kept out of this run's transcript.
 *
 * This is the running estimate the progress display reads while the run is in
 * flight; {@link applyAuthoritativeUsage} replaces the token counts with the
 * run's real totals when the result frame lands. `turns` is only counted here —
 * one per API response — and stands as the final figure.
 */
function countAssistantUsage(
  message: SDKAssistantMessage,
  result: SingleResult,
  state: ClaudeTranslationState,
): void {
  const responseId = message.message.id;
  if (responseId && state.countedResponseIds.has(responseId)) return;
  if (responseId) state.countedResponseIds.add(responseId);

  const usage = message.message.usage;
  result.usage.turns++;
  result.usage.input += usage?.input_tokens ?? 0;
  result.usage.output += usage?.output_tokens ?? 0;
  result.usage.cacheRead += usage?.cache_read_input_tokens ?? 0;
  result.usage.cacheWrite += usage?.cache_creation_input_tokens ?? 0;
}

function applyAssistant(
  message: SDKAssistantMessage,
  result: SingleResult,
  state: ClaudeTranslationState,
): boolean {
  const responseId = message.message.id;
  const uuid = message.uuid;
  // Frames of one response repeat its `message.id` but carry their own wire
  // uuid, so the uuid is what tells a new frame from a replay of one already
  // folded in.
  if (uuid) {
    if (state.seenFrames.has(uuid)) return false;
    state.seenFrames.add(uuid);
  }

  // A refusal retried on a fallback model names the frames the refused leg left
  // behind. They are retracted, not history: evict them before this frame lands
  // so the retracted text cannot be read as output.
  evictRetracted(message.supersedes, result, state);

  const content: AssistantMessage["content"] = [];
  for (const block of message.message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      content.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "redacted_thinking") {
      content.push({ type: "thinking", thinking: "", redacted: true });
    } else if (block.type === "tool_use") {
      state.toolNames.set(block.id, block.name);
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  const usage = message.message.usage;
  const stopReason = mapStopReason(message.message.stop_reason);

  if (content.length === 0) {
    // A frame can translate to nothing — it carried only a block type this
    // backend does not render, such as `server_tool_use`, or no block at all —
    // and still report the run's usage, stop reason, error, or abort. Those
    // belong to the turn, not to any block, so they are folded in regardless:
    // dropping them loses tokens and lets a later success frame present an
    // aborted turn as clean.
    applyAssistantOutcome(message, result, state, stopReason);
    return true;
  }

  // One API response arrives as several frames, one per content block. Folding
  // them back into a single message is what makes the response's whole text the
  // final answer: `getFinalOutput` reads the last assistant message, so a reply
  // split across frames would otherwise be cut down to its last piece.
  const open = responseId ? state.responseMessages.get(responseId) : undefined;
  if (open) {
    open.content.push(...content);
    if (stopReason) open.stopReason = stopReason;
    if (uuid) {
      state.contributions.set(uuid, {
        kind: "blocks",
        message: open,
        blocks: content,
      });
    }
    applyAssistantOutcome(message, result, state, stopReason);
    return true;
  }

  const assistant: AssistantMessage = {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "claude-code",
    model: message.message.model,
    usage: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      totalTokens: contextOccupancyTokens(usage ?? {}) ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: stopReason ?? "stop",
    timestamp: Date.now(),
  };

  result.messages.push(assistant);
  if (responseId) state.responseMessages.set(responseId, assistant);
  if (uuid) {
    state.contributions.set(uuid, {
      kind: "blocks",
      message: assistant,
      blocks: content,
    });
  }
  result.model = message.message.model;

  applyAssistantOutcome(message, result, state, stopReason);
  return true;
}

/**
 * Fold what a frame says about the run — usage, occupancy, and how the turn
 * ended — into the result. Runs for every frame of a response, including the
 * ones coalesced into an already-open message, since any of them can carry the
 * stop reason or an error.
 */
function applyAssistantOutcome(
  message: SDKAssistantMessage,
  result: SingleResult,
  state: ClaudeTranslationState,
  stopReason: StopReason | undefined,
): void {
  countAssistantUsage(message, result, state);

  // Occupancy is per-request, so it is assigned rather than accumulated and is
  // safe to repeat across the frames of one response.
  const occupancy = contextOccupancyTokens(message.message.usage ?? {}) ?? 0;
  if (occupancy > 0) result.usage.contextTokens = occupancy;
  if (stopReason) result.stopReason = stopReason;

  // A turn the API cut short, or one the SDK reports as errored, must not be
  // presented as a clean result — the parent agent would act on partial output.
  if (message.message.stop_reason === "max_tokens" || message.aborted) {
    result.stopReason = message.aborted ? "aborted" : "length";
  }
  if (message.message.id) state.lastResponseId = message.message.id;
  if (message.error) {
    result.errorMessage ??= `Claude Code reported ${message.error}`;
    if (message.message.id) {
      state.responseErrors.set(message.message.id, message.error);
    }
  }
}

/**
 * Take back what the named wire messages contributed.
 *
 * A refusal retried on a fallback model retracts the refused leg — the partial
 * assistant frames and any tombstoned tool results — and names them twice: on
 * the replacement frame's `supersedes`, and again on the end-of-turn
 * `model_refusal_fallback` notice. Both are honored, and eviction is idempotent,
 * so the second signal is a no-op. Left in place, retracted text stays in the
 * transcript and can be handed to the parent as the answer.
 *
 * Returns whether anything was removed.
 */
function evictRetracted(
  uuids: readonly string[] | undefined,
  result: SingleResult,
  state: ClaudeTranslationState,
): boolean {
  if (!uuids?.length) return false;
  let changed = false;
  for (const uuid of uuids) {
    const contribution = state.contributions.get(uuid);
    if (!contribution) continue;
    state.contributions.delete(uuid);
    if (contribution.kind === "messages") {
      for (const message of contribution.messages) {
        changed = dropMessage(message, result, state) || changed;
      }
      continue;
    }
    // Only this frame's own blocks go: the message may also hold blocks from
    // sibling frames of the same response that were not retracted.
    const { message, blocks } = contribution;
    const kept = message.content.filter((block) => !blocks.includes(block));
    if (kept.length !== message.content.length) changed = true;
    message.content = kept;
    if (kept.length === 0) dropMessage(message, result, state);
  }
  return changed;
}

/** Remove a message from the transcript, and stop treating it as open. */
function dropMessage(
  message: Message,
  result: SingleResult,
  state: ClaudeTranslationState,
): boolean {
  // A response whose message is gone must start a fresh one if it emits again,
  // rather than appending to a message no longer in the transcript.
  for (const [responseId, open] of state.responseMessages) {
    if (open === message) state.responseMessages.delete(responseId);
  }
  // A retracted tool result is no longer in the transcript, so a re-delivery is
  // not a replay and must be recorded rather than suppressed. This is what the
  // transcript scan gave for free before the index replaced it.
  if (message.role === "toolResult") {
    state.recordedToolResults.delete(message.toolCallId);
  }
  const index = result.messages.indexOf(message);
  if (index === -1) return false;
  result.messages.splice(index, 1);
  return true;
}

/**
 * Translate a tool result's content, preserving images. A tool that returns
 * only a screenshot would otherwise render as a blank result.
 */
export function toolResultContent(
  content: unknown,
): ToolResultMessage["content"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    const parts: ToolResultMessage["content"] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const block = part as {
        type?: unknown;
        text?: unknown;
        source?: { type?: unknown; data?: unknown; media_type?: unknown };
      };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        block.source?.type === "base64" &&
        typeof block.source.data === "string"
      ) {
        parts.push({
          type: "image",
          data: block.source.data,
          mimeType:
            typeof block.source.media_type === "string"
              ? block.source.media_type
              : "image/png",
        });
      }
    }
    if (parts.length > 0) return parts;
  }
  let text = "";
  try {
    text = JSON.stringify(content) ?? "";
  } catch {
    text = "";
  }
  return [{ type: "text", text }];
}

function applyUser(
  message: SDKUserMessage,
  result: SingleResult,
  state: ClaudeTranslationState,
): boolean {
  const content = message.message.content;
  if (!Array.isArray(content)) return false;

  const created: Message[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    // A replayed frame carries the same tool_use_id as one already recorded.
    // `type: "user"` alone cannot distinguish a replay, so drop the duplicate
    // rather than showing the result twice with the second one unnamed.
    if (state.recordedToolResults.has(block.tool_use_id)) continue;
    state.recordedToolResults.add(block.tool_use_id);
    const toolName = state.toolNames.get(block.tool_use_id) ?? "unknown";
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: block.tool_use_id,
      toolName,
      content: toolResultContent(block.content),
      isError: block.is_error ?? false,
      timestamp: Date.now(),
    };
    result.messages.push(toolResult);
    created.push(toolResult);
  }
  // A refused leg's tool results are tombstoned and named in the same eviction
  // signal as its assistant frames, so they have to be traceable to their frame.
  if (message.uuid && created.length > 0) {
    state.contributions.set(message.uuid, {
      kind: "messages",
      messages: created,
    });
  }
  return created.length > 0;
}

/**
 * The text of the transcript's last assistant message, empty when it produced
 * none. Deliberately not `getFinalOutput`, which walks back past a text-free
 * message to an earlier one: here the question is whether the turn that *ended*
 * the run said anything, so an earlier turn must not answer it.
 */
function trailingAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("");
  }
  return "";
}

function applyResult(
  message: SDKResultMessage,
  result: SingleResult,
  state: ClaudeTranslationState,
): boolean {
  state.sawResultFrame = true;
  result.usage.cost = message.total_cost_usd ?? result.usage.cost;
  applyAuthoritativeUsage(message.usage, result);

  if (message.subtype === "success") {
    // `success` describes the session, not the answer: a turn the API cut short,
    // one the SDK aborted, and a refusal all arrive here. Whatever failure the
    // assistant frames recorded outranks the subtype, or the parent would act on
    // partial or refused output presented as a finished answer.
    const trailingError = state.lastResponseId
      ? state.responseErrors.get(state.lastResponseId)
      : undefined;
    // The result frame carries its own stop reason for the final turn, which can
    // name a failure the assistant frames never showed — so consult both, and
    // let the frame that reports a failure decide.
    const failedStop = [
      mapStopReason(message.stop_reason),
      result.stopReason,
    ].find((reason) => reason && reason in FAILED_STOP_REASONS);
    // `subtype: "success"` and `is_error: true` coexist — the subtype says the
    // session reached a result, the flag says that result is a failure (an API
    // error such as a rate limit, whose text lands in `result`). Ignoring the
    // flag hands the parent "Rate limit exceeded" as an answer.
    const finalText = message.result?.trim();
    // `result` carries the API's account of the failure rather than an answer
    // exactly when the flag is set and no stop reason named the failure. Computed
    // out here because both the error message and the synthesis below need it.
    const reportedFailure =
      message.is_error && !failedStop ? finalText : undefined;

    if (failedStop || trailingError || message.is_error) {
      result.exitCode = 1;
      result.stopReason = failedStop ?? "error";
      // Only the terminal response describes what ended the run. `result`
      // .errorMessage is deliberately not consulted: it holds the *first* error
      // any frame reported, which may be a retryable one — `overloaded` — that
      // the CLI went on to retry successfully, and reporting that instead of
      // the real ending is worse than the generic explanation. So: the last
      // response's own error, else the flagged result's text (the API's account
      // of the failure), else what the stop reason means. A failure the stop
      // reason already named keeps its own explanation, since then `result`
      // holds the truncated answer rather than an error.
      result.errorMessage = trailingError
        ? `Claude Code reported ${trailingError}`
        : (reportedFailure ?? FAILED_STOP_REASONS[result.stopReason]);
    } else {
      result.exitCode = 0;
      result.stopReason = "stop";
    }
    // The SDK's `result` is the authoritative final answer. Synthesize a message
    // for it only when the run's *last* assistant message carries no text — e.g.
    // a final turn that was tool calls only. Asking whether the transcript holds
    // any text at all would let earlier commentary stand in for the answer.
    //
    // Except when the flag says `result` is not an answer at all. `reportedFailure`
    // is exactly the case where its text was consumed as the error message — the
    // API's account of a rate limit or the like — and putting that in the
    // transcript renders "Rate limit exceeded" as what the agent said. When a stop
    // reason named the failure instead, `result` holds the truncated answer and is
    // still worth keeping.
    if (
      finalText &&
      !reportedFailure &&
      !trailingAssistantText(result.messages)
    ) {
      result.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
        api: "anthropic-messages",
        provider: "claude-code",
        model: result.model ?? "claude-code",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } satisfies AssistantMessage as Message);
    }
    return true;
  }

  result.exitCode = 1;
  result.stopReason =
    message.subtype === "error_max_turns" ? "length" : "error";
  result.errorMessage =
    message.errors.filter((error) => error.trim()).join("\n") ||
    message.stop_reason ||
    `Claude Code ended with ${message.subtype}`;
  return true;
}

/**
 * Fold one SDK message into the normalized result. Returns whether the result
 * changed, so the caller only re-renders when there is something new.
 */
export function applyClaudeMessage(
  message: SDKMessage,
  result: SingleResult,
  state: ClaudeTranslationState,
): boolean {
  // Sidechain messages belong to a delegated Claude subagent with its own
  // context. Keep them out of the transcript and out of occupancy — a nested
  // agent's last text is not this run's answer, and its prompt does not sit in
  // this run's window — while still billing their tokens, since a delegated
  // agent's work is spent money either way.
  //
  // Inert as things stand: `parent_tool_use_id` is set only on subagent traffic,
  // and no tool in CLAUDE_ALLOWED_TOOLS can start a subagent. Kept because it is
  // what makes re-allowing a delegation tool safe — without it, the first
  // profile permitted to delegate would fold a nested agent's text into this
  // transcript and hand it back as the answer, and spend tokens uncounted.
  if ("parent_tool_use_id" in message && message.parent_tool_use_id != null) {
    if (message.type === "assistant") {
      countAssistantUsage(message, result, state);
    }
    return false;
  }

  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        result.model = message.model || result.model;
        // Claude Code persists a transcript per session, so recording the id is
        // what lets a finished run be reopened with `claude -r <id>`.
        result.sessionId = message.session_id || result.sessionId;
        return true;
      }
      if (message.subtype === "model_refusal_fallback") {
        // The audit record for the turn, emitted after the replacement frame
        // already evicted the same uuids. Honored as a backstop for a fallback
        // frame that arrived without `supersedes`.
        return evictRetracted(message.retracted_message_uuids, result, state);
      }
      return false;
    case "assistant":
      return applyAssistant(message, result, state);
    case "user":
      return applyUser(message, result, state);
    case "result":
      return applyResult(message, result, state);
    default:
      return false;
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

/**
 * How long a cancelled run waits for its stream to end before giving up on it.
 *
 * Cancellation asks the SDK to close, and the SDK's own path — stdin EOF, then a
 * ~2s grace, then a kill — normally ends the stream well inside this. But the
 * drain loop is the only exit from `run`, so a transport that never settles
 * (an MCP teardown that hangs, a child ignoring stdin EOF) would leave the
 * parent's tool call waiting forever on a run whose answer is already discarded.
 *
 * Five seconds matches what the pi backend allows between SIGTERM and SIGKILL,
 * so both harnesses bound the same window the same way.
 */
export const ABORT_TEARDOWN_GRACE_MS = 5_000;

export interface ClaudeBackendOptions {
  /** Injected for tests; defaults to the lazily imported SDK `query`. */
  loadQuery?: () => Promise<ClaudeQueryFn>;
  /** Injected for tests; defaults to probing for the SDK's CLI binary. */
  hasBinary?: () => boolean;
  /** Injected for tests; see {@link ABORT_TEARDOWN_GRACE_MS}. */
  abortGraceMs?: number;
}

/** Whether the host has already cancelled; settles the result when it has. */
function isCancelled(
  signal: AbortSignal | undefined,
  result: SingleResult,
): boolean {
  if (!signal?.aborted) return false;
  settleAborted(result);
  return true;
}

export function createClaudeBackend(
  options: ClaudeBackendOptions = {},
): SubagentBackend {
  const loadQuery = options.loadQuery ?? loadClaudeQuery;
  const hasBinary = options.hasBinary ?? (() => hasClaudeBinary());
  const abortGraceMs = options.abortGraceMs ?? ABORT_TEARDOWN_GRACE_MS;

  return {
    name: "claude",
    async isAvailable() {
      try {
        await loadQuery();
      } catch {
        return false;
      }
      // Importing the SDK is only half the requirement. It drives a CLI that
      // ships in a separate per-platform package, and an install can hold one
      // without the other — in which case every delegation fails at `query()`,
      // which is exactly what the startup warning exists to pre-empt.
      return hasBinary();
    },
    async run(ctx: SubagentRunContext): Promise<SingleResult> {
      const { task, result, emit, signal } = ctx;

      // A rendering failure in the host must not be mistaken for a subagent
      // failure, and must not abandon the stream with the child still running.
      const safeEmit = () => {
        try {
          emit();
        } catch {
          /* progress rendering is best-effort */
        }
      };

      // Cancelled before anything started: report that, rather than the SDK's
      // absence or a wait for it to load. Nothing here is worth doing for a run
      // whose answer will be discarded.
      if (isCancelled(signal, result)) return result;

      // A run that could not start is still a run that failed. The backend
      // contract reserves rejection for what cannot be represented as a result
      // at all, so everything but abort settles here instead.
      const failWith = (cause: unknown): SingleResult => {
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage =
          cause instanceof Error ? cause.message : String(cause);
        safeEmit();
        return result;
      };

      let query: ClaudeQueryFn;
      try {
        query = await loadQuery();
      } catch (cause) {
        // The SDK is an optional dependency, so a setup can reach here without
        // it. That is a missing-harness diagnosis for the parent to read, not
        // an exception for the dispatcher to handle.
        return failWith(cause);
      }

      result.model = resolveClaudeModel(task.config) ?? result.model;

      const abortController = new AbortController();
      const state = createClaudeTranslationState();
      let wasAborted = false;

      const claudeOptions = buildClaudeOptions({
        config: task.config,
        cwd: task.cwd,
        depth: task.depth,
        projectTrusted: task.projectTrusted ?? false,
        abortController,
      });

      // Capture the child CLI's stderr so a crash has a diagnosis instead of
      // "no further detail". Nothing else populates this field on this harness.
      // Bounded: the SDK hands over every chunk with no backpressure, so a
      // child stuck in a noisy retry loop would otherwise grow this without end.
      claudeOptions.stderr = (data: string) => {
        result.stderr = appendStderr(result.stderr, data);
      };

      // Emit initial "running" state
      safeEmit();

      // Cancelled while the SDK loaded: don't spawn a bypass-permissions child
      // just to tear it down on the first stream read.
      if (isCancelled(signal, result)) return result;

      let stream: ClaudeQuery;
      try {
        stream = query({ prompt: task.prompt, options: claudeOptions });
      } catch (cause) {
        // Setting a run up throws synchronously — the CLI binary is missing,
        // or the SDK rejects an option. That is a failed run like any other, so
        // it is reported as a result rather than thrown at the dispatcher,
        // which would lose the persisted detail and the agent-error rendering.
        return failWith(cause);
      }

      // A deadline that only exists once an abort has landed. Constructed here
      // so `arm` is assigned before anything can call it; the timer itself is
      // never started for a run nobody cancelled. A healthy turn may legitimately
      // go quiet for longer than the grace — a long build, a slow search — and
      // nothing else bounds a run, so arming it unconditionally would cut off
      // work that was going fine.
      let teardownTimer: ReturnType<typeof setTimeout> | undefined;
      let armTeardownDeadline = (): void => {};
      const teardownDeadline = new Promise<void>((resolve) => {
        armTeardownDeadline = () => {
          if (teardownTimer) return; // arming twice would not make it sooner
          teardownTimer = setTimeout(resolve, abortGraceMs);
          teardownTimer.unref?.();
        };
      });

      const abort = () => {
        wasAborted = true;
        abortController.abort();
        stream.close?.();
        armTeardownDeadline();
      };
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        // A cancellation that landed while `query()` was setting the run up
        // fired before there was a listener to hear it, and `addEventListener`
        // does not replay it on an already-aborted signal. Without this the
        // abort is dropped: the child runs to completion and its output is
        // handed back as a clean answer to a question nobody is waiting for.
        // `abort` is idempotent, so checking after registering — rather than
        // branching around it — cannot abort twice.
        if (signal.aborted) abort();
      }

      // Draining is its own promise rather than an inline loop so the abort path
      // can stop waiting on it. The `wasAborted` check still guards every frame,
      // so a stream that outlives the wait cannot go on mutating a result the
      // host has already been handed.
      const drained = (async () => {
        for await (const message of stream) {
          // Closing the stream does not empty it: frames already queued when
          // the abort landed still arrive. Applying them would record and
          // display output produced after the user cancelled, on a run whose
          // answer is discarded anyway.
          if (wasAborted) break;
          if (applyClaudeMessage(message, result, state)) safeEmit();
        }
      })().catch((cause: unknown) => {
        // Handled here rather than around the await: a drain the deadline
        // abandoned would otherwise reject with nobody listening, and an
        // unhandled rejection takes down a process over a run already reported.
        //
        // A run the result message already settled stays settled: a transport
        // teardown after the final result must not discard a completed answer.
        if (!wasAborted && result.exitCode === -1) {
          result.exitCode = 1;
          result.stopReason = "error";
          result.errorMessage =
            cause instanceof Error ? cause.message : String(cause);
          safeEmit();
        }
      });

      try {
        await Promise.race([drained, teardownDeadline]);
      } finally {
        clearTimeout(teardownTimer);
        signal?.removeEventListener("abort", abort);
        stream.close?.();
      }

      // No result frame means the run never stated its own totals, so what was
      // accumulated from the frames stands in for them — and for `output` that
      // is a placeholder, not an estimate. Flagged for every such ending:
      // cancelled, timed out, or a stream that died mid-run.
      if (!state.sawResultFrame) result.usage.outputUnreported = true;

      // A run the result message already settled stays settled, the same as for
      // a transport teardown: the stream can still be draining when the abort
      // lands, and a cancellation that arrives after the answer must not
      // discard a finished answer.
      if (wasAborted && result.exitCode === -1) {
        settleAborted(result);
        return result;
      }

      if (result.exitCode === -1) {
        // The stream ended without a result message: the CLI died or was cut
        // off. Report it rather than presenting a partial run as a success —
        // the last assistant message's own stop reason says nothing about the
        // run's outcome, so it must not be left in place here.
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage ??=
          "Claude Code ended without reporting a result. " +
          (result.stderr.trim() || "No further detail was available.");
      }

      return result;
    },
  };
}

export const claudeBackend: SubagentBackend = createClaudeBackend();
