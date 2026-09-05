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
import {
  COUNTER_CLASSES,
  type SupervisorCounter,
} from "../runtime/counters.ts";
import { RunRepository } from "../runtime/repository.ts";
import { SubagentSupervisor } from "../runtime/supervisor.ts";
import { formatNoAgentsMessage, openProfilesUi } from "./agents-command.ts";
import type { SessionHandle } from "./session-handle.ts";

/** The command name, unchanged from the M0 skeleton's. */
export const SUBAGENT_COMMAND_NAME = "subagent";

/**
 * The two ways deeper, in the order an operator wants them.
 *
 * Read by {@link formatUnknownSubcommand} alone: the handler dispatches on its
 * own `case` and the status line writes its own sentence, both of which say
 * more than a name. This is the one place that needs them enumerated rather
 * than spelled out.
 */
export const SUBAGENT_SUBCOMMANDS = ["profiles", "diagnostics"] as const;

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
  /**
   * What this Session's completion hand-offs did, by outcome.
   *
   * The sink's, not the runtime's, and reported here rather than folded into
   * the counters because they answer a different question: a counter that
   * cannot tell a refused hand-off from a lost one cannot say which half of
   * the pipeline is failing. It also carries `consumedBeforeLanding`, which is
   * the number a later hold-while-active envelope is scheduled on.
   *
   * **Required**, where the adapter probe is optional, and the difference is
   * the point: a Session with no backend probes genuinely has none to report,
   * while every Session has a sink. An optional field here would let a caller
   * drop the block by forgetting it, which is the one failure a diagnostics
   * command must not have.
   */
  readonly handoff: CountBlock;
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
    // After the runtime's own numbers and before the adapters': the hand-off
    // is the host's half of what a Session did, and it sits between the two
    // halves it joins.
    block("Notification hand-offs", diagnostics.handoff),
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
 * The bucket a counter the host does not recognise falls into.
 *
 * Not a fourth {@link CounterClass}: the classification in `runtime/counters.ts`
 * is exhaustive by type and cannot have one. This is what the *host* does with
 * a name that reached it anyway — the counter block is structural, so a
 * counter can arrive here that the compiled record does not know, and the one
 * thing that must not happen is its disappearing into "healthy".
 */
const UNCLASSIFIED = "unclassified";

/** How the health line names each class it has to report, singular and plural. */
const CLASS_NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  defect: ["defect", "defects"],
  incident: ["incident", "incidents"],
  [UNCLASSIFIED]: [UNCLASSIFIED, UNCLASSIFIED],
};

/** The order the line names classes in: worst first, then the unknown. */
const REPORTED_CLASSES = ["defect", "incident", UNCLASSIFIED] as const;

/**
 * Whether the runtime noticed anything **actionable**, and what it is holding.
 *
 * Only the first half is a verdict, and the verdict is by class rather than by
 * sum. Every counter is a thing that happened which nobody had to be told
 * about at the time — but they are not the same kind of thing, and adding them
 * up says the wrong one. A Session with twenty late events and two
 * reconciliation differences is running exactly as designed; one that
 * committed a conflicting result is not. The taxonomy that says which is which
 * is `COUNTER_CLASSES`, in the runtime, exhaustive by type, so a counter added
 * without a class fails to compile rather than quietly reading as a symptom.
 *
 * Expected counters therefore never appear here at all. They are in
 * `/subagent diagnostics`, where a maintainer chasing a number wants them.
 *
 * A name this host does not recognise is {@link UNCLASSIFIED} and is named in
 * the line: the counter block is structural so that a counter cannot be added
 * without appearing, and a counter that appeared and was silently ignored
 * would defeat that.
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
  const held = `${sum(session.probe)} held`;
  const raised = REPORTED_CLASSES.flatMap((name) => {
    const count = countOfClass(session.counters, name);
    if (count === 0) return [];
    const [singular, plural] = CLASS_NOUNS[name];
    return [`${count} ${count === 1 ? singular : plural}`];
  });
  return raised.length === 0
    ? `Runtime: healthy · ${held}`
    : `Runtime: attention needed · ${raised.join(" · ")} · ${held} — /subagent diagnostics`;
}

/** How much of one class the block holds, by looking each name up. */
function countOfClass(block: CountBlock, wanted: string): number {
  let total = 0;
  for (const [name, value] of Object.entries(block)) {
    const found: string =
      COUNTER_CLASSES[name as SupervisorCounter] ?? UNCLASSIFIED;
    if (found === wanted) total += value;
  }
  return total;
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
  /**
   * What the Session push sink's hand-offs did, by outcome.
   *
   * A function returning plain counts rather than the sink itself, for the
   * reason the widget is handed a read model: a command that could name the
   * sink could push a notification. It is read at handler time because the
   * counts belong to whichever Session is live.
   */
  handoffCounts: () => CountBlock,
  profiles: () => readonly Profile[],
  agentsDir: string,
): void {
  pi.registerCommand(SUBAGENT_COMMAND_NAME, {
    description: "Subagent status, Profiles, and runtime diagnostics.",
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
        case "diagnostics":
          reportDiagnostics(
            await readLiveSession(handle),
            adapterProbe,
            handoffCounts,
            ctx,
          );
          return;
        default:
          ctx.ui.notify(formatUnknownSubcommand(subcommand), "info");
      }
    },
  });
}

/** Read the live Session's contribution to the status, or nothing. */
/**
 * Read the live Session once, for whichever of the two reports wants it.
 *
 * One reader rather than two, because the status and the diagnostics report
 * ask the same Session the same three questions and a second reader could
 * answer them from a different instant. `undefined` means no Session runtime
 * is live, which is an answer rather than an error: the command registers once
 * per process and between Sessions there is none.
 */
async function readLiveSession(
  handle: SessionHandle,
): Promise<LiveSessionStatus | undefined> {
  return handle.run<LiveSessionStatus | undefined>(
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
}

/** The counters-and-probes report, exactly as bare `/subagent` once printed. */
function reportDiagnostics(
  session: LiveSessionStatus | undefined,
  adapterProbe: () => AdapterProbe | undefined,
  handoffCounts: () => CountBlock,
  ctx: Pick<ExtensionCommandContext, "ui">,
): void {
  if (session === undefined) {
    ctx.ui.notify(NO_LIVE_SESSION, "info");
    return;
  }
  const held = adapterProbe();
  ctx.ui.notify(
    formatSessionDiagnostics({
      counters: session.counters,
      probe: session.probe,
      handoff: handoffCounts(),
      ...(held === undefined ? {} : { adapterProbe: held }),
    }),
    "info",
  );
}
