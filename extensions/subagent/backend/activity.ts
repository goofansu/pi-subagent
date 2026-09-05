import path from "node:path";
import { stripVTControlCharacters } from "node:util";

/** One line of activity, as wide as the widget can use. */
export const ACTIVITY_LIMIT = 120;
/** Leave room after a finished command for the output that just changed. */
const COMMAND_PREFIX_LIMIT = 60;

type ToolDetail =
  | { readonly kind: "shell"; readonly key: string }
  | { readonly kind: "path"; readonly key: string }
  | { readonly kind: "pattern"; readonly key: string };

/** Provider tool names and the argument that best says what each call is about. */
const TOOL_DETAILS: ReadonlyMap<string, ToolDetail> = new Map([
  ["bash", { kind: "shell", key: "command" }],
  ["Bash", { kind: "shell", key: "command" }],
  ["read", { kind: "path", key: "path" }],
  ["ls", { kind: "path", key: "path" }],
  ["write", { kind: "path", key: "path" }],
  ["edit", { kind: "path", key: "path" }],
  ["Read", { kind: "path", key: "file_path" }],
  ["Write", { kind: "path", key: "file_path" }],
  ["Edit", { kind: "path", key: "file_path" }],
  ["grep", { kind: "pattern", key: "pattern" }],
  ["find", { kind: "pattern", key: "pattern" }],
  ["Grep", { kind: "pattern", key: "pattern" }],
  ["Glob", { kind: "pattern", key: "pattern" }],
]);

/** Make provider text safe for a one-line activity observation. */
function collapsed(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function shellDetail(value: string): string {
  return collapsed(value.split(/\r\n|\r|\n/, 1)[0] ?? "");
}

function pathDetail(value: string): string {
  if (!path.isAbsolute(value)) return collapsed(value);
  const normalized = path.normalize(value);
  const basename = path.basename(normalized);
  if (!basename) return collapsed(value);
  const parent = path.basename(path.dirname(normalized));
  return collapsed(parent ? path.join(parent, basename) : basename);
}

/** Bound to the limit, ending in an ellipsis when something was cut. */
function capped(value: string): string {
  const text = collapsed(value);
  if (text.length <= ACTIVITY_LIMIT) return text;
  return `${text.slice(0, ACTIVITY_LIMIT - 1)}…`;
}

/** The latest non-blank line, treating carriage-return redraws as lines. */
function lastNonBlankLine(value: string): string | undefined {
  const lines = stripVTControlCharacters(value).split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return collapsed(line);
  }
  return undefined;
}

/** A finished shell call, preserving its command while giving output room. */
export function finishedShellActivity(
  commandActivity: string,
  output: string | undefined,
): string {
  const line = output === undefined ? undefined : lastNonBlankLine(output);
  if (line === undefined) return capped(commandActivity);
  const command = collapsed(commandActivity).slice(0, COMMAND_PREFIX_LIMIT);
  return capped(`${command} · ${line}`);
}

/** A tool call's bounded `name: detail`, or its bounded bare name. */
export function toolActivity(
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
): string {
  const detailKind = TOOL_DETAILS.get(name);
  let detail: string | undefined;
  if (detailKind !== undefined) {
    const value = args?.[detailKind.key];
    if (typeof value === "string") {
      detail =
        detailKind.kind === "shell"
          ? shellDetail(value)
          : detailKind.kind === "path"
            ? pathDetail(value)
            : collapsed(value);
    }
  } else {
    const value =
      args && Object.values(args).find((one) => typeof one === "string");
    if (typeof value === "string") detail = collapsed(value);
  }
  const activity = detail ? `${name}: ${detail}` : name;
  return capped(activity);
}
