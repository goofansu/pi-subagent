import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type RESUME_OUTCOMES,
  type ResumeOutcome,
  redactedDiagnostic,
  runId,
  type START_OUTCOMES,
  type StartOutcome,
  subagentId,
} from "./domain/index.ts";
import {
  formatResumeOutcome,
  formatStartOutcome,
  formatToolInputRejected,
} from "./presentation/index.ts";

/**
 * The soak tally script's reading of this extension's prose, checked here.
 *
 * `scripts/soak-tally.mjs` computes the release-candidate soak's operation
 * tally out of Pi's session logs. The Run and Subagent identifiers it needs are
 * not in a field: they are in the *sentences* `presentation/prose.ts` produces,
 * which the script reads by their opening words. So the prose is a format the
 * script depends on, and it is the half nobody thinks of as a format — which
 * makes it the half that gets reworded.
 *
 * A reword would not break anything loudly. The script would stop resolving
 * every resume, steer and cancel, and the tally would read as a quieter week
 * than the week was. The script throws rather than undercounting when it meets
 * an opening it does not know, but that happens on a soak day, once the usage
 * it could not count has already happened. This test moves the failure to
 * `npm run check`, where a reword is still an edit rather than lost evidence.
 *
 * It reads in both directions, because each catches a different mistake:
 *
 * - **Every sentence this tree produces opens with something the script
 *   knows.** Catches a reworded or newly added outcome.
 * - **Every opening the script knows is one this tree still produces.**
 *   Catches an opening left in the script after the sentence behind it went,
 *   which would leave the script silently permissive.
 *
 * **What it holds is the opening, not the sentence.** The script reads
 * families — `Started `, `Cannot start `, `Unknown agent: ` — because that is
 * all it needs to tell a Run that started from one that did not. So rewording
 * the body of a refusal passes here and should: the script does not read the
 * body. What fails is a change to an *opening*, which is exactly the change
 * that would stop the script resolving ids.
 *
 * The sample of each outcome is built from the union's own name list, so an
 * outcome added to `agent_start` or `agent_resume` fails here as well as
 * failing to compile in the formatter.
 *
 * This file is at the tree root rather than beside the prose, for the reason
 * `packaging.test.ts` is: it asserts an agreement between this extension and
 * the repository around it, and a presentation file may name only the domain
 * and Pi.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** What the script expects each operation's result to open with. */
interface ResultProse {
  readonly started: string;
  readonly refused: readonly string[];
}

/**
 * The script's own list, read from the script.
 *
 * A computed specifier, because the script is plain Node with no dependencies
 * and no types — deliberately, since it must run against a maintainer's Pi home
 * without this tree being built. Importing it by a literal path would be a
 * typecheck error rather than a stricter check.
 */
async function scriptProse(): Promise<Record<string, ResultProse>> {
  const script = pathToFileURL(
    path.join(repositoryRoot, "scripts", "soak-tally.mjs"),
  ).href;
  const loaded = (await import(script)) as {
    readonly RESULT_PROSE?: Record<string, ResultProse>;
  };
  assert.ok(
    loaded.RESULT_PROSE,
    "scripts/soak-tally.mjs no longer exports RESULT_PROSE",
  );
  return loaded.RESULT_PROSE;
}

const RUN = runId("run-1");
const SUBAGENT = subagentId("subagent-1");

/** One sample of every `agent_start` outcome, keyed by its name. */
const startSamples: Record<(typeof START_OUTCOMES)[number], StartOutcome> = {
  started: { outcome: "started", runId: RUN, subagentId: SUBAGENT },
  "unknown agent": { outcome: "unknown agent", agent: "ghost" },
  "invalid profile": {
    outcome: "invalid profile",
    diagnostics: [{ filePath: "/agents/broken.md", reason: "no description" }],
  },
  "empty label": { outcome: "empty label" },
  "at capacity": { outcome: "at capacity" },
  "shutting down": { outcome: "shutting down" },
  "delegation-depth exceeded": {
    outcome: "delegation-depth exceeded",
    depth: 2,
  },
  "backend unavailable": {
    outcome: "backend unavailable",
    diagnostic: redactedDiagnostic("backend-failure"),
  },
};

/** One sample of every `agent_resume` outcome, keyed by its name. */
const resumeSamples: Record<(typeof RESUME_OUTCOMES)[number], ResumeOutcome> = {
  started: { outcome: "started", runId: RUN, subagentId: SUBAGENT },
  "unknown Subagent": { outcome: "unknown Subagent", subagentId: SUBAGENT },
  "Subagent already running": {
    outcome: "Subagent already running",
    subagentId: SUBAGENT,
  },
  "empty label": { outcome: "empty label" },
  "resume unsupported": { outcome: "resume unsupported" },
  "conversation lost": { outcome: "conversation lost" },
  "at capacity": { outcome: "at capacity" },
  "shutting down": { outcome: "shutting down" },
};

/**
 * Every sentence one operation can answer with, by outcome name.
 *
 * `formatToolInputRejected` is in here beside the outcome formatter because it
 * is the other way one of these calls can come back: a decode failure is a tool
 * *outcome* rather than a throw, so a model sees its sentence and so does a
 * session log.
 */
function sentencesOf(
  operation: "agent_start" | "agent_resume",
): ReadonlyMap<string, string> {
  const sentences = new Map<string, string>();
  if (operation === "agent_start") {
    for (const [name, outcome] of Object.entries(startSamples))
      sentences.set(name, formatStartOutcome("explore", outcome, ["explore"]));
  } else {
    for (const [name, outcome] of Object.entries(resumeSamples))
      sentences.set(name, formatResumeOutcome(SUBAGENT, outcome));
  }
  sentences.set(
    "arguments rejected",
    formatToolInputRejected(operation, "description must be a string"),
  );
  return sentences;
}

test("every sentence a start or a resume answers with opens with something the soak tally script knows", async () => {
  const prose = await scriptProse();

  for (const operation of ["agent_start", "agent_resume"] as const) {
    const expected = prose[operation];
    assert.ok(expected, `the script knows no openings for ${operation}`);

    for (const [name, sentence] of sentencesOf(operation)) {
      const opening =
        name === "started"
          ? expected.started
          : expected.refused.find((refusal) => sentence.startsWith(refusal));
      assert.ok(
        opening !== undefined && sentence.startsWith(opening),
        `${operation}'s "${name}" reads ${JSON.stringify(sentence.slice(0, 60))}, ` +
          "which opens with none of the sentences scripts/soak-tally.mjs knows. " +
          "Add the opening to RESULT_PROSE there, or keep the wording.",
      );
    }
  }
});

test("every opening the soak tally script knows is one a start or a resume still produces", async () => {
  const prose = await scriptProse();

  for (const operation of ["agent_start", "agent_resume"] as const) {
    const sentences = [...sentencesOf(operation).values()];
    const producedBySome = (opening: string) =>
      sentences.some((sentence) => sentence.startsWith(opening));

    assert.ok(
      producedBySome(prose[operation].started),
      `scripts/soak-tally.mjs expects ${operation} to start a Run with ` +
        `${JSON.stringify(prose[operation].started)}, and nothing here says that`,
    );
    for (const refusal of prose[operation].refused) {
      assert.ok(
        producedBySome(refusal),
        `scripts/soak-tally.mjs still lists ${JSON.stringify(refusal)} as an ` +
          `${operation} refusal, and nothing here says it any more. An opening ` +
          "left behind makes the script quietly permissive.",
      );
    }
  }
});

test("the script tells a started result from a refused one, so it never reads ids out of a refusal", async () => {
  const prose = await scriptProse();

  // The two sets must not overlap. If a refusal opened with the started
  // opening, the script would look for ids in it, fail to find them, and throw
  // on a Session where nothing was wrong.
  for (const operation of ["agent_start", "agent_resume"] as const) {
    for (const refusal of prose[operation].refused) {
      assert.equal(
        refusal.startsWith(prose[operation].started) ||
          prose[operation].started.startsWith(refusal),
        false,
        `${operation}'s refusal ${JSON.stringify(refusal)} and its started ` +
          "opening are not distinguishable by their first words",
      );
    }
  }
});
