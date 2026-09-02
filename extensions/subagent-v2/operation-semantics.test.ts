import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CANCEL_OUTCOMES,
  RESULT_OUTCOMES,
  RESUME_OUTCOMES,
  START_OUTCOMES,
  STEER_OUTCOMES,
  WAIT_OUTCOMES,
} from "./domain/outcomes.ts";

/**
 * The typed outcomes against the document that decided them.
 *
 * `docs/v2/operation-semantics.md` settled what a caller observes from every
 * public operation before any of it was written. The unions in
 * `domain/outcomes.ts` are a transcription of it, and a transcription drifts
 * unless something reads both. This test does: every outcome name is either
 * spelled in that document verbatim or listed below as a deliberate
 * difference with the reason for it.
 *
 * This file is not in the domain module, because reading a file is not a pure
 * function.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * The document with its line wrapping normalized away.
 *
 * The outcome names are prose in that document, and prose wraps: "resume
 * unsupported" is split across two lines there. Comparing against a
 * whitespace-normalized copy checks the words rather than the line breaks.
 */
const semantics = readFileSync(
  path.join(repositoryRoot, "docs", "v2", "operation-semantics.md"),
  "utf8",
).replace(/\s+/g, " ");

/**
 * Outcome names that are not verbatim in the document, and why.
 *
 * Each one is a naming decision rather than a semantic difference, and each is
 * recorded here so a reader comparing the two can see the mapping instead of
 * wondering whether something was missed.
 */
const DELIBERATE_DIFFERENCES: ReadonlyMap<string, string> = new Map([
  [
    "started",
    "The document describes the success case rather than naming it; a union needs a name for it.",
  ],
  [
    "conversation lost",
    "The document says 'Conversation loss'. The union uses the words ADR-0014 and the backend contract use, so what a backend reports and what a caller sees are the same name.",
  ],
  [
    "already completed",
    "One expansion of the document's `already <status>` notation.",
  ],
  [
    "already failed",
    "One expansion of the document's `already <status>` notation.",
  ],
  [
    "already cancelled",
    "One expansion of the document's `already <status>` notation.",
  ],
]);

/** The phrases the milestone requires to be present in both places. */
const REQUIRED_PHRASES = [
  "ResultExpired",
  "RunNotTerminal",
  "mailbox full",
  "mailbox closed",
  "already <status>",
  "shutting down",
] as const;

test("the semantics document spells every phrase the milestone requires", () => {
  for (const phrase of REQUIRED_PHRASES) {
    assert.ok(
      semantics.includes(phrase),
      `operation-semantics.md does not spell '${phrase}'`,
    );
  }
});

test("the outcome unions represent every phrase the milestone requires", () => {
  const everyName: readonly string[] = [
    ...START_OUTCOMES,
    ...RESUME_OUTCOMES,
    ...STEER_OUTCOMES,
    ...CANCEL_OUTCOMES,
    ...WAIT_OUTCOMES,
    ...RESULT_OUTCOMES,
  ];

  for (const phrase of REQUIRED_PHRASES) {
    const expected =
      phrase === "already <status>" ? "already completed" : phrase;
    assert.ok(
      everyName.includes(expected),
      `no outcome union represents '${phrase}'`,
    );
  }
});

test("every outcome name is in the document or recorded as a difference", () => {
  const unexplained: string[] = [];
  for (const name of [
    ...START_OUTCOMES,
    ...RESUME_OUTCOMES,
    ...STEER_OUTCOMES,
    ...CANCEL_OUTCOMES,
    ...WAIT_OUTCOMES,
    ...RESULT_OUTCOMES,
  ]) {
    if (semantics.includes(name)) continue;
    if (DELIBERATE_DIFFERENCES.has(name)) continue;
    unexplained.push(name);
  }

  assert.deepEqual(unexplained, []);
});

test("every recorded difference is still a difference and still explained", () => {
  for (const [name, reason] of DELIBERATE_DIFFERENCES) {
    assert.ok(reason.length > 40, `the reason for '${name}' explains nothing`);
    if (name.startsWith("already ")) continue;
    assert.ok(
      !semantics.includes(name),
      `'${name}' is now spelled in the document; remove it from the differences`,
    );
  }
});
