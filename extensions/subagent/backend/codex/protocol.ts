/**
 * The App Server protocol, as much of it as this adapter consumes.
 *
 * Two rules shape this file, and both are ADR-0029 at a provider boundary.
 *
 * **Only what is consumed is declared.** The App Server emits far more than
 * this: remote-control status, MCP start-up progress, thread status changes,
 * account rate limits, item variants for hooks and sub-agents. None of it
 * becomes an observation, so none of it is declared, and an undeclared method
 * is *ignored* rather than rejected — a protocol addition must not be able to
 * fail a Run. What the pinned protocol check in `npm run check` proves is the
 * other direction: that the binary still emits the methods and fields declared
 * here.
 *
 * **A declared method with a payload that does not fit is malformed, not
 * fatal.** The caller turns it into one bounded diagnostic and carries on. The
 * distinction matters because the two cases mean different things: an unknown
 * method is a server that has grown, and a known method that does not fit is a
 * server that has changed under us.
 *
 * The envelope is decoded loosely — `method` plus `params` — and each method's
 * params are decoded by their own declaration. That is what makes "unknown
 * methods are ignored" a property of the dispatch rather than a special case
 * inside one large union, and it is why a schema here never needs to describe
 * a method this adapter does not read.
 *
 * One tolerance is deliberate and is v1's: the items inside a completion frame
 * are decoded **individually**, and a variant this adapter does not know is
 * dropped from the list rather than rejecting the frame. `turn/completed` is
 * the authoritative settlement signal, and losing it because the server added
 * an item kind would hang a Run.
 */

import { Schema } from "effect";

/* ============================================================== */
/* Primitives                                                      */
/* ============================================================== */

/** A whole, nonnegative count, which every token figure is. */
const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

const OptionalString = Schema.optionalKey(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optionalKey(Schema.NullOr(Schema.Finite));

/* ============================================================== */
/* Items                                                           */
/* ============================================================== */

/**
 * The phases an agent message can be in.
 *
 * Older servers omit it, and the rule v1 settled on is that anything other
 * than `commentary` is the final answer — so an omitted phase is terminal.
 * That is what makes a final answer win over a cancel that arrives afterwards.
 */
export const CODEX_COMMENTARY_PHASE = "commentary";

const UserMessageItem = Schema.Struct({
  type: Schema.Literal("userMessage"),
  id: Schema.String,
  clientId: OptionalString,
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.String,
  text: Schema.String,
  phase: OptionalString,
});

const PlanItem = Schema.Struct({
  type: Schema.Literal("plan"),
  id: Schema.String,
  text: Schema.String,
});

const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  summary: Schema.optionalKey(Schema.Array(Schema.String)),
  content: Schema.optionalKey(Schema.Array(Schema.String)),
});

const CommandAction = Schema.Struct({
  type: Schema.String,
  command: Schema.String,
});

/** The four statuses a command execution reports. */
export const CODEX_COMMAND_STATUSES = [
  "inProgress",
  "completed",
  "failed",
  "declined",
] as const;

const CommandExecutionItem = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: Schema.Literals(CODEX_COMMAND_STATUSES),
  aggregatedOutput: OptionalString,
  exitCode: OptionalNumber,
  durationMs: OptionalNumber,
  commandActions: Schema.optionalKey(Schema.Array(CommandAction)),
});

const FileChange = Schema.Struct({
  path: Schema.String,
  diff: Schema.String,
});

const FileChangeItem = Schema.Struct({
  type: Schema.Literal("fileChange"),
  id: Schema.String,
  changes: Schema.Array(FileChange),
});

const McpToolCallItem = Schema.Struct({
  type: Schema.Literal("mcpToolCall"),
  id: Schema.String,
  server: Schema.String,
  tool: Schema.String,
});

const WebSearchItem = Schema.Struct({
  type: Schema.Literal("webSearch"),
  id: Schema.String,
  query: Schema.String,
});

export const CodexItem = Schema.Union([
  UserMessageItem,
  AgentMessageItem,
  PlanItem,
  ReasoningItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  WebSearchItem,
]);

export type CodexItem = typeof CodexItem.Type;

export type CodexCommandItem = Extract<
  CodexItem,
  { readonly type: "commandExecution" }
>;

const decodeItem = Schema.decodeUnknownResult(CodexItem);

/**
 * One text block of a message's content.
 *
 * Declared rather than hand-narrowed at the call site: `content` is a wire
 * array this adapter reads the text out of, and reading a wire payload by
 * declaration is the whole of ADR-0029's rule at this boundary. A block that
 * is not text — an image, an attachment, something added later — produces
 * nothing rather than a cast that happens to work.
 */
const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const decodeTextBlock = Schema.decodeUnknownResult(TextBlock);

/** The text a user-message item echoed back, in order. */
export function codexEchoedText(
  item: Extract<CodexItem, { readonly type: "userMessage" }>,
): readonly string[] {
  const texts: string[] = [];
  for (const block of item.content ?? []) {
    const decoded = decodeTextBlock(block);
    if (decoded._tag === "Success") texts.push(decoded.success.text);
  }
  return texts;
}

/** One item, or nothing when it is a variant this adapter does not read. */
export function decodeCodexItem(value: unknown): CodexItem | undefined {
  const decoded = decodeItem(value);
  return decoded._tag === "Success" ? decoded.success : undefined;
}

/* ============================================================== */
/* Notification params                                             */
/* ============================================================== */

const ItemFrameParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  item: Schema.Unknown,
});

const DeltaParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
  delta: Schema.String,
});

const TokenBreakdown = Schema.Struct({
  totalTokens: Count,
  inputTokens: Count,
  cachedInputTokens: Count,
  cacheWriteInputTokens: Schema.optionalKey(Count),
  outputTokens: Count,
  reasoningOutputTokens: Count,
});

export type CodexTokenBreakdown = typeof TokenBreakdown.Type;

const TokenUsageParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  tokenUsage: Schema.Struct({
    total: TokenBreakdown,
    last: TokenBreakdown,
    modelContextWindow: OptionalNumber,
  }),
});

/** The statuses a completion frame can report. */
export const CODEX_TURN_STATUSES = [
  "completed",
  "interrupted",
  "failed",
  "inProgress",
] as const;

export type CodexTurnStatus = (typeof CODEX_TURN_STATUSES)[number];

const TurnError = Schema.Struct({
  message: Schema.String,
});

const TurnCompletedParams = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(CODEX_TURN_STATUSES),
    items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    error: Schema.optionalKey(Schema.NullOr(TurnError)),
  }),
});

const ErrorParams = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  willRetry: Schema.Boolean,
  error: TurnError,
});

/* ============================================================== */
/* The decoded notification                                        */
/* ============================================================== */

/** Everything this adapter consumes, with the wire left behind. */
export type CodexNotification =
  | {
      readonly method: "item/started" | "item/completed";
      readonly turnId: string;
      readonly item: CodexItem;
    }
  | {
      readonly method:
        | "item/agentMessage/delta"
        | "item/commandExecution/outputDelta"
        | "item/reasoning/summaryTextDelta";
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly method: "thread/tokenUsage/updated";
      readonly turnId: string;
      readonly total: CodexTokenBreakdown;
      readonly last: CodexTokenBreakdown;
      readonly contextWindow?: number;
    }
  | {
      readonly method: "turn/completed";
      readonly turnId: string;
      readonly status: CodexTurnStatus;
      readonly items: readonly CodexItem[];
      readonly errorMessage?: string;
    }
  | {
      readonly method: "error";
      readonly turnId: string;
      readonly willRetry: boolean;
      readonly errorMessage: string;
    };

/** The methods declared above, as data, for the drift check and the tests. */
export const CODEX_NOTIFICATION_METHODS = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/reasoning/summaryTextDelta",
  "thread/tokenUsage/updated",
  "turn/completed",
  "error",
] as const;

export type CodexNotificationMethod =
  (typeof CODEX_NOTIFICATION_METHODS)[number];

/** What reading one notification produced. */
export type CodexNotificationReading =
  /** A method this adapter does not consume. Nothing happens. */
  | { readonly outcome: "ignored" }
  | {
      readonly outcome: "notification";
      readonly notification: CodexNotification;
    }
  /** A declared method whose payload does not fit. One diagnostic. */
  | { readonly outcome: "malformed"; readonly method: string };

const decodeItemFrame = Schema.decodeUnknownResult(ItemFrameParams);
const decodeDelta = Schema.decodeUnknownResult(DeltaParams);
const decodeTokenUsage = Schema.decodeUnknownResult(TokenUsageParams);
const decodeTurnCompleted = Schema.decodeUnknownResult(TurnCompletedParams);
const decodeError = Schema.decodeUnknownResult(ErrorParams);

const malformed = (method: string): CodexNotificationReading => ({
  outcome: "malformed",
  method,
});

/** Read one notification. Total: it never throws and never rejects a Run. */
export function readCodexNotification(
  method: string,
  params: unknown,
): CodexNotificationReading {
  switch (method) {
    case "item/started":
    case "item/completed": {
      const decoded = decodeItemFrame(params);
      if (decoded._tag === "Failure") return malformed(method);
      const item = decodeCodexItem(decoded.success.item);
      // An item variant this adapter does not read is not a malformed frame.
      // It is a frame about something that produces no observation.
      if (item === undefined) return { outcome: "ignored" };
      return {
        outcome: "notification",
        notification: { method, turnId: decoded.success.turnId, item },
      };
    }
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/reasoning/summaryTextDelta": {
      const decoded = decodeDelta(params);
      if (decoded._tag === "Failure") return malformed(method);
      return {
        outcome: "notification",
        notification: {
          method,
          turnId: decoded.success.turnId,
          itemId: decoded.success.itemId,
          delta: decoded.success.delta,
        },
      };
    }
    case "thread/tokenUsage/updated": {
      const decoded = decodeTokenUsage(params);
      if (decoded._tag === "Failure") return malformed(method);
      const { turnId, tokenUsage } = decoded.success;
      const window = tokenUsage.modelContextWindow;
      return {
        outcome: "notification",
        notification: {
          method: "thread/tokenUsage/updated",
          turnId,
          total: tokenUsage.total,
          last: tokenUsage.last,
          ...(typeof window === "number" &&
          Number.isInteger(window) &&
          window > 0
            ? { contextWindow: window }
            : {}),
        },
      };
    }
    case "turn/completed": {
      const decoded = decodeTurnCompleted(params);
      if (decoded._tag === "Failure") return malformed(method);
      const { turn } = decoded.success;
      const items = (turn.items ?? [])
        .map(decodeCodexItem)
        .filter((item): item is CodexItem => item !== undefined);
      const message = turn.error?.message;
      return {
        outcome: "notification",
        notification: {
          method: "turn/completed",
          turnId: turn.id,
          status: turn.status,
          items,
          ...(message === undefined || message === ""
            ? {}
            : { errorMessage: message }),
        },
      };
    }
    case "error": {
      const decoded = decodeError(params);
      if (decoded._tag === "Failure") return malformed(method);
      return {
        outcome: "notification",
        notification: {
          method: "error",
          turnId: decoded.success.turnId,
          willRetry: decoded.success.willRetry,
          errorMessage: decoded.success.error.message,
        },
      };
    }
    default:
      return { outcome: "ignored" };
  }
}

/* ============================================================== */
/* Requests this adapter writes                                    */
/* ============================================================== */

/** How the client introduces itself. v1's values, unchanged. */
export const CODEX_CLIENT_INFO = {
  name: "pi-subagent",
  title: "pi-subagent",
  version: "1.0.0",
} as const;

export type CodexParams = Readonly<Record<string, unknown>>;

export function initializeParams(): CodexParams {
  return { clientInfo: CODEX_CLIENT_INFO, capabilities: null };
}

const InitializeResult = Schema.Struct({
  userAgent: Schema.String,
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
});

const decodeInitialize = Schema.decodeUnknownResult(InitializeResult);

/** Whether the server answered `initialize` with the shape it documents. */
export function isCodexInitializeResult(value: unknown): boolean {
  return decodeInitialize(value)._tag === "Success";
}

/**
 * The fixed posture every thread starts with.
 *
 * Never-approve and full access, regardless of the trust value the Subagent
 * forwards. ADR-0009 fixed that for v2: a child runs non-interactively and
 * cannot answer an approval prompt, so an approving policy would be a child
 * that hangs rather than a child that is safe. Revisiting it for Claude and
 * Codex together is a later decision, and until then the posture is uniform.
 */
export const CODEX_APPROVAL_POLICY = "never";
export const CODEX_SANDBOX = "danger-full-access";

export interface CodexThreadParameters {
  readonly cwd: string;
  readonly model?: string;
  /** Already mapped by the Profile module: `off` has become `none`. */
  readonly effort?: string;
}

export function threadStartParams(
  parameters: CodexThreadParameters,
): CodexParams {
  return {
    cwd: parameters.cwd,
    ephemeral: true,
    approvalPolicy: CODEX_APPROVAL_POLICY,
    sandbox: CODEX_SANDBOX,
    ...(parameters.model === undefined ? {} : { model: parameters.model }),
    ...(parameters.effort === undefined
      ? {}
      : { config: { model_reasoning_effort: parameters.effort } }),
  };
}

/** One text input element, as `turn/start` and `turn/steer` both spell it. */
function textInput(text: string): readonly CodexParams[] {
  return [{ type: "text", text, text_elements: [] }];
}

export function turnStartParams(threadId: string, text: string): CodexParams {
  return { threadId, input: textInput(text) };
}

export function turnSteerParams(
  threadId: string,
  turnId: string,
  text: string,
  clientMessageId: string,
): CodexParams {
  return {
    threadId,
    expectedTurnId: turnId,
    input: textInput(text),
    clientUserMessageId: clientMessageId,
  };
}

export function turnInterruptParams(
  threadId: string,
  turnId: string,
): CodexParams {
  return { threadId, turnId };
}

const ThreadStartResult = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
});

const TurnStartResult = Schema.Struct({
  turn: Schema.Struct({ id: Schema.String }),
});

const decodeThreadStart = Schema.decodeUnknownResult(ThreadStartResult);
const decodeTurnStart = Schema.decodeUnknownResult(TurnStartResult);

/** The root thread id `thread/start` answered with, or nothing. */
export function readCodexThreadId(value: unknown): string | undefined {
  const decoded = decodeThreadStart(value);
  return decoded._tag === "Success" ? decoded.success.thread.id : undefined;
}

/** The turn id `turn/start` answered with, or nothing. */
export function readCodexTurnId(value: unknown): string | undefined {
  const decoded = decodeTurnStart(value);
  return decoded._tag === "Success" ? decoded.success.turn.id : undefined;
}
