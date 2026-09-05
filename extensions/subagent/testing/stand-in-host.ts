/**
 * A stand-in Pi host: the seam every M3 host test drives.
 *
 * The M3 exit gate says every public operation works "through the actual host
 * handlers". That means a test has to be on the far side of the registration
 * boundary — calling the `execute` Pi would call, with the arguments Pi would
 * pass, and reading the text a model would read. So this records every
 * registration surface a Pi host offers, hands out the contexts Pi hands out,
 * and can emit the five host events the extension listens to.
 *
 * It is deliberately a *recorder* rather than a simulator. It does not
 * schedule turns, does not decide when a message lands, and does not
 * interleave events on its own: a test says what happened, in what order, and
 * the assertions are about what the extension did in response. A stand-in that
 * guessed at Pi's scheduling would be a stand-in whose bugs looked like the
 * extension's.
 *
 * Like the Session rig, this is a **test boundary**: it is where a `node:test`
 * callback crosses into the extension's own promises, and the extension is
 * where an Effect is run. No production module does either.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RenderableTheme } from "../presentation/index.ts";

/** One registered tool, as the host holds it. */
export interface StandInTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly renderCall?: (...args: never[]) => unknown;
  readonly renderResult?: (...args: never[]) => unknown;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<StandInToolResult>;
}

export interface StandInToolResult {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
  readonly details?: unknown;
}

/** The text a tool result carries, which is what a model would read. */
export function resultText(result: StandInToolResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export interface StandInCommand {
  readonly name: string;
  readonly description?: string;
  readonly handler: (args: string, ctx: unknown) => Promise<void> | void;
}

export interface SentMessage {
  readonly message: {
    readonly customType?: string;
    readonly content?: unknown;
    readonly details?: unknown;
  };
  readonly options?: {
    readonly deliverAs?: string;
    readonly triggerTurn?: boolean;
  };
}

export interface StandInNotice {
  readonly message: string;
  readonly level: string;
}

/** How a test says what the Session looks like. */
export interface StandInHostOptions {
  readonly cwd?: string;
  readonly projectTrusted?: boolean;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: string;
  /** Models the Session's registry reports, for Profile validation. */
  readonly models?: readonly {
    readonly provider: string;
    readonly id: string;
  }[];
  /** Make `sendMessage` throw, the way a stale Session's host does. */
  readonly sendFails?: () => boolean;
  /** Whether Pi reports that it still holds pending messages. */
  readonly hasPendingMessages?: boolean;
  /**
   * How often the host actually draws when a widget asks it to.
   *
   * `1` is a fast terminal: every request is drawn at once. A higher number is
   * a **slow** one — it draws every nth request and ignores the rest, which is
   * the shape a coalescing assertion needs, because coalescing is only visible
   * against a consumer that has not caught up. `0` never draws at all.
   *
   * Drawing matters because it is what clears a widget's pending-render flag,
   * so a host that never draws makes every subsequent change free by
   * construction — and an assertion against it could not fail.
   */
  readonly renderEvery?: number;
}

/** A theme that paints nothing, so an assertion reads the text itself. */
export const PLAIN_THEME: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface WidgetComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface StandInHost {
  readonly pi: ExtensionAPI;
  readonly tools: () => readonly StandInTool[];
  /** One registered tool by name, or a failure naming what is registered. */
  readonly tool: (name: string) => StandInTool;
  /** Call a tool's `execute` the way Pi would. */
  readonly call: (
    name: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<StandInToolResult>;
  readonly commands: () => readonly StandInCommand[];
  readonly renderers: () => readonly string[];
  /** Which host events the extension subscribed to, in order. */
  readonly subscribed: () => readonly string[];
  readonly sent: () => readonly SentMessage[];
  readonly userMessages: () => readonly string[];
  readonly notices: () => readonly StandInNotice[];

  /* The host events, awaited so a handler's promise is settled first. */
  readonly sessionStart: () => Promise<void>;
  readonly sessionShutdown: () => Promise<void>;
  readonly messageStart: (message: unknown) => Promise<void>;
  readonly turnEnd: (evidence: {
    readonly stopReason?: string;
    readonly signalAborted?: boolean;
  }) => Promise<void>;
  readonly agentSettled: () => Promise<void>;

  /* The widget, as the host currently holds it. */
  readonly hasWidget: () => boolean;
  /** How many times `setWidget` installed a component. */
  readonly widgetInstalls: () => number;
  /** How many times `setWidget` cleared it. */
  readonly widgetClears: () => number;
  /** How many redraws the widget asked the host for. */
  readonly renderRequests: () => number;
  /** How many of those the host actually drew. See `renderEvery`. */
  readonly rendersPerformed: () => number;
  /** The widget's current lines, with no theme escapes. */
  readonly widgetLines: (width?: number) => readonly string[];
}

/** The default width a widget assertion renders at. */
const DEFAULT_WIDGET_WIDTH = 80;

export function createStandInHost(
  options: StandInHostOptions = {},
): StandInHost {
  const tools: StandInTool[] = [];
  const commands: StandInCommand[] = [];
  const renderers: string[] = [];
  const subscribed: string[] = [];
  const sent: SentMessage[] = [];
  const userMessages: string[] = [];
  const notices: StandInNotice[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

  let widget: WidgetComponent | undefined;
  let widgetInstalls = 0;
  let widgetClears = 0;
  let renderRequests = 0;
  let rendersPerformed = 0;

  const renderEvery = options.renderEvery ?? 1;
  const tui = {
    requestRender: () => {
      renderRequests += 1;
      // A real host draws in response to the request, and drawing is what
      // clears the widget's pending flag. A stand-in that only counted would
      // leave that flag set forever and make coalescing unfalsifiable.
      if (renderEvery <= 0 || renderRequests % renderEvery !== 0) return;
      rendersPerformed += 1;
      widget?.render(DEFAULT_WIDGET_WIDTH);
    },
  };

  const ui = {
    notify: (message: string, level = "info") => {
      notices.push({ message, level });
    },
    setWidget: (_key: string, content: WidgetFactory | undefined) => {
      if (content === undefined) {
        widget = undefined;
        widgetClears += 1;
        return;
      }
      widgetInstalls += 1;
      widget = content(tui, PLAIN_THEME);
    },
  };

  /**
   * The context Pi hands a handler.
   *
   * One object for every handler and every tool call, because that is what Pi
   * does: a Session's context is a Session's context, and a test that could
   * vary it per call would be testing a host that does not exist.
   */
  const ctx = {
    cwd: options.cwd ?? "/work",
    ui,
    model: options.model,
    isProjectTrusted: () => options.projectTrusted ?? false,
    modelRegistry: { getAll: () => [...(options.models ?? [])] },
    hasPendingMessages: () => options.hasPendingMessages ?? false,
    signal: undefined as AbortSignal | undefined,
  };

  const emit = async (event: string, payload: unknown): Promise<void> => {
    const handler = handlers.get(event);
    if (!handler) return;
    await handler(payload, ctx);
  };

  const pi = {
    registerTool(tool: StandInTool) {
      tools.push(tool);
    },
    registerCommand(name: string, definition: Omit<StandInCommand, "name">) {
      commands.push({ name, ...definition });
    },
    registerMessageRenderer(customType: string) {
      renderers.push(customType);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      subscribed.push(event);
      handlers.set(event, handler);
    },
    sendMessage(message: SentMessage["message"], sendOptions?: unknown) {
      if (options.sendFails?.() === true) {
        throw new Error("the stand-in Session refused the message");
      }
      sent.push({
        message,
        ...(sendOptions === undefined
          ? {}
          : { options: sendOptions as SentMessage["options"] }),
      });
    },
    sendUserMessage(content: string) {
      userMessages.push(content);
    },
    getThinkingLevel: () => options.thinkingLevel ?? "off",
  } as unknown as ExtensionAPI;

  const tool = (name: string): StandInTool => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) {
      throw new Error(
        `no tool named '${name}'; registered: ${tools
          .map((entry) => entry.name)
          .join(", ")}`,
      );
    }
    return found;
  };

  return {
    pi,
    tools: () => [...tools],
    tool,
    call: (name, params, callOptions) =>
      tool(name).execute(
        `call-${name}`,
        params,
        callOptions?.signal,
        undefined,
        ctx,
      ),
    commands: () => [...commands],
    renderers: () => [...renderers],
    subscribed: () => [...subscribed],
    sent: () => [...sent],
    userMessages: () => [...userMessages],
    notices: () => [...notices],

    sessionStart: () => emit("session_start", { type: "session_start" }),
    sessionShutdown: () =>
      emit("session_shutdown", { type: "session_shutdown", reason: "quit" }),
    messageStart: (message) =>
      emit("message_start", { type: "message_start", message }),
    turnEnd: async (evidence) => {
      // The host reports the signal on the *context*, not on the event, so a
      // test that says the signal aborted has to say it the way Pi does.
      const previous = ctx.signal;
      ctx.signal =
        evidence.signalAborted === true
          ? ({ aborted: true } as AbortSignal)
          : undefined;
      try {
        await emit("turn_end", {
          type: "turn_end",
          turnIndex: 0,
          message:
            evidence.stopReason === undefined
              ? {}
              : { stopReason: evidence.stopReason },
          toolResults: [],
        });
      } finally {
        ctx.signal = previous;
      }
    },
    agentSettled: () => emit("agent_settled", { type: "agent_settled" }),

    hasWidget: () => widget !== undefined,
    widgetInstalls: () => widgetInstalls,
    widgetClears: () => widgetClears,
    renderRequests: () => renderRequests,
    rendersPerformed: () => rendersPerformed,
    widgetLines: (width = DEFAULT_WIDGET_WIDTH) =>
      widget ? widget.render(width).map((line) => line.trimEnd()) : [],
  };
}
