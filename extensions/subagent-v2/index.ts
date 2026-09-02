import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PINNED_EFFECT_VERSION } from "./effect-version.ts";

/** The slash command the M0 skeleton registers. It is the only registration. */
export const V2_COMMAND_NAME = "subagent-v2";

/**
 * A stable marker the skeleton prints. Tests assert on this string rather than
 * on the surrounding wording, so the sentence can be rewritten freely.
 */
export const V2_SKELETON_MARKER = "pi-subagent v2 skeleton active";

/** The one observable thing a maintainer gets for launching Pi with v2. */
export function formatSkeletonStatus(): string {
  return `${V2_SKELETON_MARKER} — Effect ${PINNED_EFFECT_VERSION}`;
}

/**
 * The M0 placeholder extension.
 *
 * It registers no model tools, message renderers, widgets, or session event
 * handlers: a Pi process that loads v2 has no subagent behaviour at all yet.
 * The single command exists so that launching Pi with only this entry point
 * loaded is confirmable without reading logs.
 */
export default function subagentV2Extension(pi: ExtensionAPI): void {
  pi.registerCommand(V2_COMMAND_NAME, {
    description: "Report that the pi-subagent v2 skeleton is loaded.",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSkeletonStatus(), "info");
    },
  });
}
