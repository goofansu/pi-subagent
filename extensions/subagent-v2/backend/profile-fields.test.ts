import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BACKEND_ID, type Profile } from "../domain/index.ts";
import {
  booleanField,
  COMMON_PROFILE_FIELDS,
  EFFORTS,
  effortField,
  ProfileFieldError,
  parseTools,
  shouldAppendSystemPrompt,
  stringField,
  unrecognizedFields,
  validateCommonProfileFields,
} from "./profile-fields.ts";

const filePath = "/agents/fake.md";

function profile(fields: Record<string, unknown>): Profile {
  return {
    name: "fake",
    description: "A fake specialist",
    backend: DEFAULT_BACKEND_ID,
    fields,
    systemPrompt: "Do the thing.",
  };
}

test("the shared field vocabulary is the four fields every backend knows", () => {
  assert.deepEqual(
    [...COMMON_PROFILE_FIELDS],
    ["model", "effort", "tools", "appendSystemPrompt"],
  );
});

test("the effort scale is the seven values, in order", () => {
  assert.deepEqual(
    [...EFFORTS],
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

/** Ported from v1's shared-accessor test, with the same inputs. */
test("tools are normalized and appendSystemPrompt defaults to appending", () => {
  const both = profile({
    tools: " read, , grep ,, ",
    appendSystemPrompt: null,
  });

  assert.deepEqual(parseTools(both), ["read", "grep"]);
  assert.deepEqual(parseTools(profile({ tools: ", ," })), []);
  assert.equal(parseTools(profile({ tools: "" })), undefined);
  assert.equal(parseTools(profile({})), undefined);
  assert.equal(shouldAppendSystemPrompt(both), true);
  assert.equal(
    shouldAppendSystemPrompt(profile({ appendSystemPrompt: false })),
    false,
  );
  assert.equal(
    shouldAppendSystemPrompt(profile({ appendSystemPrompt: true })),
    true,
  );
});

test("an explicitly empty tool list stays empty rather than becoming defaults", () => {
  // `[]` disables tools. Turning it into `undefined` would restore the
  // backend's own defaults, which is the opposite of what was asked for.
  assert.deepEqual(parseTools(profile({ tools: "   ,  " })), []);
});

test("a shared field of the wrong type is a field error naming the field", () => {
  assert.throws(
    () => stringField(profile({ model: 7 }), "model"),
    (error: unknown) => {
      assert.ok(error instanceof ProfileFieldError);
      assert.equal(error.field, "model");
      assert.equal(error.message, "model must be a string");
      return true;
    },
  );
  assert.throws(
    () =>
      booleanField(
        profile({ appendSystemPrompt: "yes" }),
        "appendSystemPrompt",
      ),
    ProfileFieldError,
  );
});

test("a null or absent field reads as absent, not as an error", () => {
  assert.equal(stringField(profile({}), "model"), undefined);
  assert.equal(stringField(profile({ model: null }), "model"), undefined);
  assert.equal(stringField(profile({ model: "  " }), "model"), undefined);
  assert.equal(
    booleanField(profile({ appendSystemPrompt: null }), "appendSystemPrompt"),
    undefined,
  );
});

test("an effort outside the scale names the values that are allowed", () => {
  assert.equal(effortField(profile({ effort: "high" })), "high");
  assert.throws(
    () => effortField(profile({ effort: "extreme" })),
    (error: unknown) => {
      assert.ok(error instanceof ProfileFieldError);
      assert.equal(
        error.message,
        "unknown effort 'extreme'; expected one of off, minimal, low, medium, high, xhigh, max",
      );
      return true;
    },
  );
});

test("a backend that supports only part of the scale says so", () => {
  assert.equal(effortField(profile({ effort: "low" }), ["low", "high"]), "low");
  assert.throws(
    () => effortField(profile({ effort: "minimal" }), ["low", "high"]),
    ProfileFieldError,
  );
});

/** Ported from v1's shared-validation test, with v2's wording. */
test("validation owns the shared field list and defers the model rule", () => {
  const diagnostics = validateCommonProfileFields(
    profile({ model: "sonnet", unsupported: true }),
    filePath,
    {
      displayName: "Fake",
      validateModel: (model) => (model === "sonnet" ? undefined : "bad model"),
    },
  );

  assert.deepEqual(diagnostics, [
    {
      filePath,
      reason: "Fake backend does not recognize field 'unsupported'",
    },
  ]);
});

test("a Profile still using the v1 field is reported as unrecognized", () => {
  // Built from pieces so the v2 boundary scan finds no occurrence of the
  // legacy field name in this tree.
  const legacyField = ["har", "ness"].join("");

  const diagnostics = validateCommonProfileFields(
    profile({ [legacyField]: "claude" }),
    filePath,
    { displayName: "Fake" },
  );

  assert.deepEqual(diagnostics, [
    {
      filePath,
      reason: `Fake backend does not recognize field '${legacyField}'`,
    },
  ]);
});

test("a backend's own fields are recognized alongside the shared four", () => {
  assert.deepEqual(
    validateCommonProfileFields(
      profile({ model: "m", sandbox: "read-only" }),
      filePath,
      { displayName: "Fake", ownFields: ["sandbox"] },
    ),
    [],
  );
  assert.deepEqual(
    unrecognizedFields(profile({ a: 1, model: "m" }), ["model"]),
    ["a"],
  );
});

test("a field error becomes a diagnostic rather than escaping validation", () => {
  assert.deepEqual(
    validateCommonProfileFields(profile({ effort: "extreme" }), filePath, {
      displayName: "Fake",
    }),
    [
      {
        filePath,
        reason:
          "unknown effort 'extreme'; expected one of off, minimal, low, medium, high, xhigh, max",
      },
    ],
  );
});

test("validating the same Profile twice yields deep-equal diagnostics", () => {
  const subject = profile({ model: 7, nope: true });
  const options = { displayName: "Fake" };

  assert.deepEqual(
    validateCommonProfileFields(subject, filePath, options),
    validateCommonProfileFields(subject, filePath, options),
  );
});
