import type { Message } from "@earendil-works/pi-ai";

/**
 * The argument most worth showing for a tool call, probed in the order the
 * common pi tools name their primary argument. A miss just means the activity
 * line shows the tool name alone.
 */
const ACTIVITY_ARGUMENT_KEYS = [
  "command",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
] as const;

/** Keep an activity readable on one widget line whatever the argument holds. */
const ACTIVITY_LIMIT = 120;

interface ToolCallPart {
  type: "toolCall";
  name: string;
  arguments?: Record<string, unknown>;
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as ToolCallPart).type === "toolCall" &&
    typeof (part as ToolCallPart).name === "string"
  );
}

/** One line saying what a tool call is doing: the tool, and its main argument. */
export function describeToolCall(call: ToolCallPart): string {
  for (const key of ACTIVITY_ARGUMENT_KEYS) {
    const value = call.arguments?.[key];
    if (typeof value === "string" && value.trim()) {
      const argument = value.trim().replace(/\s+/g, " ");
      return `${call.name}: ${argument}`.slice(0, ACTIVITY_LIMIT);
    }
  }
  return call.name;
}

/**
 * What a run is doing right now: its most recent tool call, summarised.
 *
 * The scan walks backwards for the latest assistant message that called a
 * tool. `undefined` before the child's first tool call — the caller decides
 * what stands in for it.
 */
export function deriveActivity(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (isToolCallPart(part)) return describeToolCall(part);
    }
  }
  return undefined;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const parts = msg.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { type: "text"; text: string }).text);
      if (parts.length > 0) return parts.join("");
    }
  }
  return "";
}
