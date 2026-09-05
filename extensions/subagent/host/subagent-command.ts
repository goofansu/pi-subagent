/**
 * `/subagent`: the operator's one place to start, and what is beneath it.
 *
 * Two commands used to overlap. `/subagent` printed every runtime and adapter
 * counter — the right report for a maintainer chasing a number, and the wrong
 * first thing to show somebody asking what is going on — while `/agents`
 * listed Profiles, and nothing said which to type first. So bare `/subagent`
 * is a **shallow status**: how many Profiles, how many Runs and in what phase,
 * one line per Profile, and the way deeper. The Profile list is
 * `/subagent profiles`, which is the same flow `/agents` opened.
 *
 * Nothing is summarised twice. The status counts Runs through the shared phase
 * vocabulary, so a status line and a widget row use one set of words.
 *
 * **No counters, and no verdict over them.** The runtime and the adapters keep
 * their counters and probes, and they are load-bearing — the conformance
 * suites, the adapter tests, the stress lane and the live smokes all read them
 * to prove a Session leaks nothing. What no command prints is any of them. A
 * number an operator cannot act on is a number that costs a screen to show and
 * a paragraph to explain, and the one-line health verdict the status once
 * carried over them went the same way: whether the runtime has noticed
 * something is a maintainer's question, answered by the tests and the live
 * smokes rather than by a line an operator reads mid-Session and cannot act on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Profile } from "../domain/index.ts";
import { formatRowSummary, type RunRowView } from "../presentation/index.ts";
import { RunRepository } from "../runtime/repository.ts";
import { formatNoAgentsMessage, openProfilesUi } from "./agents-command.ts";
import type { SessionHandle } from "./session-handle.ts";

/** The command name, unchanged from the M0 skeleton's. */
export const SUBAGENT_COMMAND_NAME = "subagent";

/**
 * Every subcommand `/subagent` has, for the message an unknown one gets.
 *
 * A list of one. The handler dispatches on its own `case` and the status line
 * writes its own sentence, both of which say more than a name — so this is
 * read by {@link formatUnknownSubcommand} alone, which is the one place that
 * needs them enumerated rather than spelled out.
 */
export const SUBAGENT_SUBCOMMANDS = ["profiles"] as const;

/** What the command says when no Session runtime is live. */
export const NO_LIVE_SESSION = "No subagent Session is running.";

/* ------------------------------------------------------------------ */
/* The shallow status                                                   */
/* ------------------------------------------------------------------ */

/** What the live Session contributes to the status, when one is live. */
export interface LiveSessionStatus {
  /** Every Run this Session knows about, terminal ones included. */
  readonly runs: readonly RunRowView[];
}

/** What bare `/subagent` reads before it says anything. */
export interface SubagentStatus {
  /** Absent when no Session runtime is live. */
  readonly session?: LiveSessionStatus;
  readonly profiles: readonly Profile[];
  /** Where a Profile goes, for the Session that has none. */
  readonly agentsDir: string;
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

/** The way deeper, with what it is for. */
function subcommandLines(): readonly string[] {
  return ["/subagent profiles — list Profiles and read their prompts"];
}

/**
 * The whole shallow status, as the text an operator reads.
 *
 * Three things and then the way deeper: what is loaded, what is running, and
 * which Profiles there are. Deliberately no counters — a status that printed
 * them would be the command this one replaced.
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
      : `Subagents: ${profileCount(profiles)} · ${runs}`,
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
  profiles: () => readonly Profile[],
  agentsDir: string,
): void {
  pi.registerCommand(SUBAGENT_COMMAND_NAME, {
    description: "Subagent status and Profiles.",
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/, 1)[0] ?? "";
      switch (subcommand) {
        case "": {
          const session = await readLiveSession(handle);
          ctx.ui.notify(
            formatSubagentStatus({
              ...(session === undefined ? {} : { session }),
              profiles: profiles(),
              agentsDir,
            }),
            "info",
          );
          return;
        }
        case "profiles":
          await openProfilesUi(pi, profiles, agentsDir, ctx);
          return;
        default:
          ctx.ui.notify(formatUnknownSubcommand(subcommand), "info");
      }
    },
  });
}

/**
 * Read the live Session's contribution to the status, or nothing.
 *
 * `undefined` means no Session runtime is live, which is an answer rather than
 * an error: the command registers once per process and between Sessions there
 * is none.
 */
async function readLiveSession(
  handle: SessionHandle,
): Promise<LiveSessionStatus | undefined> {
  return handle.run<LiveSessionStatus | undefined>(
    Effect.gen(function* () {
      const repository = yield* RunRepository;
      return { runs: yield* repository.list() };
    }),
    undefined,
  );
}
