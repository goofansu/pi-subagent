import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId, type Profile } from "../../domain/index.ts";
import { EFFORTS } from "../profile-fields.ts";
import {
  CODEX_DISPLAY_NAME,
  CODEX_EFFORT_NONE,
  codexEffort,
  codexTurnInput,
  resolveCodexModel,
  validateCodexProfile,
} from "./profile.ts";

/**
 * Codex Profile validation, which is v1's rules under v2's field name.
 *
 * The interesting thing about this backend's rules is what they *reject*: two
 * of the four shared fields. `tools` and `appendSystemPrompt` are vocabulary
 * every other backend understands and this one cannot express, and ADR-0009
 * says that is a diagnostic rather than a silent drop. So the tests that
 * matter here are the ones that insist a Profile asking for either is told.
 */

const PROFILE: Profile = {
  name: "build",
  description: "The building specialist",
  backend: backendId("codex"),
  fields: {},
  systemPrompt: "Build it.",
};

function withFields(fields: Readonly<Record<string, unknown>>): Profile {
  return { ...PROFILE, fields };
}

function reasons(profile: Profile): readonly string[] {
  return validateCodexProfile(profile, "build.md").map(
    (diagnostic) => diagnostic.reason,
  );
}

test("a Profile with no fields at all validates", () => {
  assert.deepEqual(reasons(PROFILE), []);
});

test("a model is passed through for Codex to check, whatever it says", () => {
  // Deliberately not a model that exists. There is no catalogue to check one
  // against and no alias list to compare it with: the App Server resolves a
  // model name itself and rejects one it cannot, and a local allowlist would
  // go stale as models ship.
  const profile = withFields({ model: "gpt-nonesuch-9" });

  assert.deepEqual(reasons(profile), []);
  assert.deepEqual(resolveCodexModel(profile), { model: "gpt-nonesuch-9" });
});

test("a model that is not a string is a diagnostic", () => {
  assert.deepEqual(reasons(withFields({ model: 7 })), [
    "model must be a string",
  ]);
});

test("every value on the shared effort scale is accepted", () => {
  for (const effort of EFFORTS) {
    assert.deepEqual(
      reasons(withFields({ effort })),
      [],
      `effort ${effort} was rejected`,
    );
  }
});

test("an effort outside the shared scale is rejected by name", () => {
  assert.deepEqual(reasons(withFields({ effort: "eager" })), [
    `unknown effort 'eager'; expected one of ${EFFORTS.join(", ")}`,
  ]);
});

test("effort off becomes none, and every other value passes through", () => {
  assert.equal(codexEffort("off"), CODEX_EFFORT_NONE);
  assert.equal(codexEffort(undefined), undefined);
  for (const effort of EFFORTS.filter((each) => each !== "off")) {
    assert.equal(codexEffort(effort), effort);
  }
  assert.deepEqual(resolveCodexModel(withFields({ effort: "off" })), {
    effort: CODEX_EFFORT_NONE,
  });
  assert.deepEqual(resolveCodexModel(withFields({ effort: "high" })), {
    effort: "high",
  });
});

test("a field Codex has never heard of is a diagnostic, not a silent pass", () => {
  assert.deepEqual(reasons(withFields({ nonsense: "x" })), [
    `${CODEX_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
  ]);
});

test("tools and appendSystemPrompt are shared vocabulary Codex refuses", () => {
  // Both are fields every other backend understands. Codex's thread carries
  // its own tool set and its prompt is composed into the first Turn's input,
  // so neither can be honoured — and a Profile that asked for one is told
  // rather than having it quietly ignored.
  assert.deepEqual(reasons(withFields({ tools: "read,write" })), [
    `${CODEX_DISPLAY_NAME} backend does not recognize field 'tools'`,
  ]);
  assert.deepEqual(reasons(withFields({ appendSystemPrompt: false })), [
    `${CODEX_DISPLAY_NAME} backend does not recognize field 'appendSystemPrompt'`,
  ]);
});

test("two problems in one Profile are two diagnostics", () => {
  assert.deepEqual(reasons(withFields({ nonsense: 1, effort: "eager" })), [
    `${CODEX_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
    `unknown effort 'eager'; expected one of ${EFFORTS.join(", ")}`,
  ]);
});

test("validation is deterministic: the same Profile always answers the same", () => {
  const profile = withFields({ nonsense: 1, effort: "eager", model: 3 });
  const first = reasons(profile);

  assert.deepEqual(reasons(profile), first);
  assert.deepEqual(reasons(profile), first);
});

test("the first Turn carries the Profile prompt and the task; later Turns do not", () => {
  assert.equal(
    codexTurnInput(PROFILE, "review the diff", true),
    "Build it.\n\nreview the diff",
  );
  assert.equal(
    codexTurnInput(PROFILE, "review the diff", false),
    "review the diff",
  );
});

test("a Profile with an empty prompt body composes nothing onto the task", () => {
  assert.equal(
    codexTurnInput({ ...PROFILE, systemPrompt: "   " }, "go", true),
    "go",
  );
});
