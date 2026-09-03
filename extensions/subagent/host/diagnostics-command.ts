/**
 * `/subagent`: the operator's one place to start, and what is beneath it.
 *
 * Two commands used to overlap. `/subagent` printed every runtime and adapter
 * counter — the right report for a maintainer chasing a number, and the wrong
 * first thing to show somebody asking what is going on — while `/agents`
 * listed Profiles, and nothing said which to type first. So bare `/subagent`
 * is now a **shallow status**: how many Profiles, how many Runs and in what
 * phase, whether the runtime noticed anything, one line per Profile, and the
 * two subcommands that go deeper. The counters moved to
 * `/subagent diagnostics`, unchanged, zeroes included; the Profile list is
 * `/subagent profiles`, which is the same flow `/agents` opens.
 *
 * Nothing is summarised twice. The status counts Runs through the shared phase
 * vocabulary, so a status line and a widget row use one set of words.
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

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Profile } from "../domain/index.ts";
import { formatRowSummary, type RunRowView } from "../presentation/index.ts";
import { RunRepository } from "../runtime/repository.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import { formatNoAgentsMessage, openProfilesUi } from "./agents-command.ts";
import type { SessionHandle } from "./session-handle.ts";

/** The command name, unchanged from the M0 skeleton's. */
export const SUBAGENT_COMMAND_NAME = "subagent";

/**
 * The two ways deeper, in the order an operator wants them.
 *
 * Named in one place because three things read them: the status line that
 * offers them, the parser that dispatches on them, and the message an unknown
 * subcommand gets.
 */
export const SUBAGENT_SUBCOMMANDS = ["profiles", "diagnostics"] as const;

export type SubagentSubcommand = (typeof SUBAGENT_SUBCOMMANDS)[number];

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
export const NO_LIVE_SESSION = "No subagent Session is running.";

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

/* ------------------------------------------------------------------ */
/* The shallow status                                                   */
/* ------------------------------------------------------------------ */

/** What the live Session contributes to the status, when one is live. */
export interface LiveSessionStatus {
  /** Every Run this Session knows about, terminal ones included. */
  readonly runs: readonly RunRowView[];
  readonly counters: CountBlock;
  readonly probe: CountBlock;
}

/** What bare `/subagent` reads before it says anything. */
export interface SubagentStatus {
  /** Absent when no Session runtime is live. */
  readonly session?: LiveSessionStatus;
  readonly profiles: readonly Profile[];
  /** Where a Profile goes, for the Session that has none. */
  readonly agentsDir: string;
}

/**
 * Whether the runtime noticed anything, and what it is still holding.
 *
 * Only the first half is a verdict. Every counter is a thing that *happened*
 * which nobody had to be told about at the time, so "healthy" is "nothing
 * noticed" and needs no taxonomy of which counters are serious.
 *
 * The probe is deliberately reported rather than judged. A live Session holds
 * a repository subscription for its widget and a fiber per Run on purpose;
 * the probe only has to read zero once the Session Scope has *closed*, which
 * is a leak test's assertion and not something an operator can check from
 * inside a running Session. So the status says how much is held and leaves
 * the reader to know whether that is a lot.
 *
 * A status that is not healthy points at the report with the numbers rather
 * than reproducing them: that is what makes this the shallow end.
 */
export function formatRuntimeHealth(session: LiveSessionStatus): string {
  const noticed = sum(session.counters);
  const held = `${sum(session.probe)} held`;
  return noticed === 0
    ? `Runtime: healthy · ${held}`
    : `Runtime: ${noticed} counted · ${held} — /subagent diagnostics`;
}

function sum(block: CountBlock): number {
  return Object.values(block).reduce((total, value) => total + value, 0);
}

/** `2 Profiles` / `1 Profile` / `no Profiles`, so the line reads as English. */
function profileCount(profiles: readonly Profile[]): string {
  if (profiles.length === 0) return "no Profiles";
  return `${profiles.length} ${profiles.length === 1 ? "Profile" : "Profiles"}`;
}

/** One line per Profile: its name and the backend it names. */
function profileLines(profiles: readonly Profile[]): readonly string[] {
  const width = profiles.reduce(
    (widest, profile) => Math.max(widest, profile.name.length),
    0,
  );
  return profiles.map(
    (profile) => `  ${profile.name.padEnd(width)}  ${profile.backend}`,
  );
}

/** The two ways deeper, each with what it is for. */
function subcommandLines(): readonly string[] {
  return [
    "/subagent profiles — list Profiles and read their prompts",
    "/subagent diagnostics — runtime counters and cleanup probes",
  ];
}

/**
 * The whole shallow status, as the text an operator reads.
 *
 * Four things and then the way deeper: what is loaded, what is running, how
 * the runtime is, and which Profiles there are. Deliberately no counters — a
 * status that printed them would be the command this one replaced.
 */
export function formatSubagentStatus(status: SubagentStatus): string {
  const { session, profiles } = status;
  const runs =
    session === undefined
      ? undefined
      : formatRowSummary(session.runs) || "no Runs";

  const sections: string[] = [
    session === undefined
      ? NO_LIVE_SESSION
      : [
          `Subagents: ${profileCount(profiles)} · ${runs}`,
          formatRuntimeHealth(session),
        ].join("\n"),
  ];
  sections.push(
    profiles.length === 0
      ? formatNoAgentsMessage(status.agentsDir)
      : profileLines(profiles).join("\n"),
  );
  sections.push(subcommandLines().join("\n"));
  return sections.join("\n\n");
}

/** What an operator who typed something else is told. */
export function formatUnknownSubcommand(subcommand: string): string {
  return `/subagent has no "${subcommand}". Try ${SUBAGENT_SUBCOMMANDS.map(
    (name) => `/subagent ${name}`,
  ).join(" or ")}.`;
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

/**
 * Register `/subagent` once per process.
 *
 * The handle and the Profiles are read at handler time rather than captured,
 * because the command registers once and both belong to whichever Session is
 * live — and between Sessions there is none, which is an answer rather than an
 * error.
 */
export function registerSubagentCommand(
  pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">,
  handle: SessionHandle,
  adapterProbe: () => AdapterProbe | undefined,
  profiles: () => readonly Profile[],
  agentsDir: string,
): void {
  pi.registerCommand(SUBAGENT_COMMAND_NAME, {
    description: "Subagent status, Profiles, and runtime diagnostics.",
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/, 1)[0] ?? "";
      switch (subcommand) {
        case "":
          ctx.ui.notify(
            formatSubagentStatus({
              ...(await readStatus(handle)),
              profiles: profiles(),
              agentsDir,
            }),
            "info",
          );
          return;
        case "profiles":
          await openProfilesUi(pi, profiles, agentsDir, ctx);
          return;
        case "diagnostics":
          await reportDiagnostics(handle, adapterProbe, ctx);
          return;
        default:
          ctx.ui.notify(formatUnknownSubcommand(subcommand), "info");
      }
    },
  });
}

/** Read the live Session's contribution to the status, or nothing. */
async function readStatus(
  handle: SessionHandle,
): Promise<{ readonly session?: LiveSessionStatus }> {
  const session = await handle.run<LiveSessionStatus | undefined>(
    Effect.gen(function* () {
      const supervisor = yield* SubagentSupervisor;
      const repository = yield* RunRepository;
      return {
        runs: yield* repository.list(),
        counters: { ...supervisor.counters() },
        probe: { ...supervisor.probe() },
      };
    }),
    undefined,
  );
  return session === undefined ? {} : { session };
}

/** The counters-and-probes report, exactly as bare `/subagent` once printed. */
async function reportDiagnostics(
  handle: SessionHandle,
  adapterProbe: () => AdapterProbe | undefined,
  ctx: Pick<ExtensionCommandContext, "ui">,
): Promise<void> {
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
}
