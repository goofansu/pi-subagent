/**
 * `/subagent-v2`: what the live Session's runtime is counting and holding.
 *
 * The roadmap asks M4 for dogfood diagnostics — cleanup escalation, duplicate
 * settlement attempts, queue overflow, reconciliation differences, late
 * events, delivery failures — and the honest way to provide them is to report
 * the counters the runtime already keeps rather than to invent a second set of
 * numbers that could disagree with them.
 *
 * Two kinds of block, and the split is the point. The **counters** are things
 * that happened and nobody had to be told about at the time; a Session with
 * thousands of duplicate settlements is a Session with a bug, and this is
 * where a maintainer sees that. The **probes** are what is still alive: the
 * runtime's own, which says whether the core leaked a fiber or a queue, and
 * one per backend adapter, which says whether that provider's own handles are
 * still held. None is visible anywhere else, and after a Session closes every
 * one of them must read zero.
 *
 * There is a probe block **per backend** rather than one, because a Session is
 * built from a set and a set holds as many backends as it likes. Merging them
 * would make "which adapter is still holding something" unanswerable, which is
 * the only question the block exists to answer.
 *
 * Every field is printed, including the zeroes. A diagnostics command that
 * hid its zeroes would make "is this counter even wired up" unanswerable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import type { SessionHandle } from "./session-handle.ts";

/** The command name, unchanged from the M0 skeleton's. */
export const DIAGNOSTICS_COMMAND_NAME = "subagent-v2";

/**
 * A block of named counts.
 *
 * Deliberately structural. The command reports whatever the runtime and the
 * live adapter are counting; naming the fields here would mean a counter added
 * to either could be added without appearing, which is the one failure a
 * diagnostics command must not have.
 */
export type CountBlock = Readonly<Record<string, number>>;

/**
 * What the backend adapters are still holding, one named block each.
 *
 * The key is the backend's own name, so the report says which adapter a
 * count belongs to. An empty record is what a set with no probes supplies.
 */
export type AdapterProbe = Readonly<Record<string, CountBlock>>;

/** What one Session's diagnostics read, gathered before they are formatted. */
export interface SessionDiagnostics {
  readonly counters: CountBlock;
  readonly probe: CountBlock;
  readonly adapterProbe?: AdapterProbe;
}

/** What the command says when no Session runtime is live. */
export const NO_LIVE_SESSION = "No v2 Session is running.";

function block(title: string, values: CountBlock): string {
  const rows = Object.entries(values).map(
    ([name, value]) => `  ${name}: ${value}`,
  );
  return [`${title}:`, ...(rows.length > 0 ? rows : ["  (none)"])].join("\n");
}

/** The whole report, as the text a maintainer reads. */
export function formatSessionDiagnostics(
  diagnostics: SessionDiagnostics,
): string {
  return [
    block("Runtime counters", diagnostics.counters),
    block("Runtime probe", diagnostics.probe),
    ...Object.entries(diagnostics.adapterProbe ?? {}).map(([name, held]) =>
      block(`Backend probe (${name})`, held),
    ),
  ].join("\n");
}

/**
 * Register `/subagent-v2` once per process.
 *
 * The handle is read at handler time rather than captured, because the command
 * registers once and the runtime belongs to whichever Session is live — and
 * between Sessions there is none, which is an answer rather than an error.
 */
export function registerDiagnosticsCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  handle: SessionHandle,
  adapterProbe: () => AdapterProbe | undefined,
): void {
  pi.registerCommand(DIAGNOSTICS_COMMAND_NAME, {
    description: "Report the v2 Session's runtime counters and probes.",
    handler: async (_args, ctx) => {
      const read = await handle.run<SessionDiagnostics | undefined>(
        Effect.map(
          SubagentSupervisor,
          (supervisor): SessionDiagnostics => ({
            counters: { ...supervisor.counters() },
            probe: { ...supervisor.probe() },
          }),
        ),
        undefined,
      );
      if (read === undefined) {
        ctx.ui.notify(NO_LIVE_SESSION, "info");
        return;
      }
      const held = adapterProbe();
      ctx.ui.notify(
        formatSessionDiagnostics({
          ...read,
          ...(held === undefined ? {} : { adapterProbe: held }),
        }),
        "info",
      );
    },
  });
}
