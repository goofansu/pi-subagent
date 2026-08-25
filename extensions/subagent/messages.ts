import type { Fact, FactPart } from "./run.ts";

/** The argument most worth showing for a tool call. */
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
/** Keep an activity readable on one widget line. */
const ACTIVITY_LIMIT = 120;

function isToolCallPart(
  part: FactPart,
): part is Extract<FactPart, { type: "tool_call" }> {
  return part.type === "tool_call";
}

/** One line saying what a tool call is doing. */
export function describeToolCall(
  call: Extract<FactPart, { type: "tool_call" }>,
): string {
  for (const key of ACTIVITY_ARGUMENT_KEYS) {
    const value = call.arguments?.[key];
    if (typeof value === "string" && value.trim()) {
      const argument = value.trim().replace(/\s+/g, " ");
      return `${call.name}: ${argument}`.slice(0, ACTIVITY_LIMIT);
    }
  }
  return call.name;
}

/** What a run is doing, derived from its latest assistant tool-call fact. */
export function deriveActivity(facts: Fact[]): string | undefined {
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts[i];
    if (fact.role !== "assistant") continue;
    for (let j = fact.parts.length - 1; j >= 0; j--) {
      const part = fact.parts[j];
      if (isToolCallPart(part)) return describeToolCall(part);
    }
  }
  return undefined;
}

export function getFinalOutput(facts: Fact[]): string {
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts[i];
    if (fact.role !== "assistant") continue;
    const text = fact.parts
      .filter(
        (part): part is Extract<FactPart, { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return "";
}
