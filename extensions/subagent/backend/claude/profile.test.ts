import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId, type Profile } from "../../domain/index.ts";
import {
  CLAUDE_DISPLAY_NAME,
  CLAUDE_MODEL_ALIASES,
  resolveClaudeModel,
  validateClaudeProfile,
} from "./profile.ts";

/**
 * Claude's Profile rules, which are v1's.
 *
 * A Profile that validated under v1 has to keep validating: the only migration
 * v2 asks a Profile author for is a renamed field. So these assertions are v1's
 * Claude Profile assertions, rephrased, and a difference here is a difference
 * a user would notice.
 */

const PATH = "/agents/reviewer.md";

function profile(fields: Record<string, unknown> = {}): Profile {
  return {
    name: "reviewer",
    description: "The reviewing specialist",
    backend: backendId("claude"),
    fields,
    systemPrompt: "Review.",
  };
}

function reasons(fields: Record<string, unknown>): string[] {
  return validateClaudeProfile(profile(fields), PATH).map(
    (diagnostic) => diagnostic.reason,
  );
}

test("a Profile with no fields is valid", () => {
  assert.deepEqual(reasons({}), []);
});

test("every family alias is accepted, whatever its casing", () => {
  for (const alias of CLAUDE_MODEL_ALIASES) {
    assert.deepEqual(reasons({ model: alias }), [], alias);
    assert.deepEqual(
      reasons({ model: alias.toUpperCase() }),
      [],
      alias.toUpperCase(),
    );
  }
});

test("a model that is not a family alias is diagnosed with the alias list", () => {
  const [reason, ...rest] = reasons({ model: "claude-sonnet-4-5-20250929" });

  assert.deepEqual(rest, []);
  assert.match(reason, /invalid Claude model 'claude-sonnet-4-5-20250929'/);
  for (const alias of CLAUDE_MODEL_ALIASES) {
    assert.match(reason, new RegExp(alias));
  }
});

test("the diagnostic names the file it came from", () => {
  const [diagnostic] = validateClaudeProfile(profile({ model: "gpt-5" }), PATH);

  assert.equal(diagnostic.filePath, PATH);
});

test("a field Claude has never heard of is a diagnostic, not a silent pass", () => {
  assert.deepEqual(reasons({ nonsense: "x" }), [
    `${CLAUDE_DISPLAY_NAME} backend does not recognize field 'nonsense'`,
  ]);
});

test("every value on the shared effort scale is accepted", () => {
  for (const effort of [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    assert.deepEqual(reasons({ effort }), [], effort);
  }
});

test("an effort outside the shared scale is rejected by name", () => {
  const [reason, ...rest] = reasons({ effort: "enormous" });

  assert.deepEqual(rest, []);
  assert.match(reason, /unknown effort 'enormous'/);
});

test("a bad effort and a bad model are both reported", () => {
  assert.equal(reasons({ effort: "enormous", model: "gpt-5" }).length, 2);
});

test("appendSystemPrompt must be a boolean", () => {
  const [reason, ...rest] = reasons({ appendSystemPrompt: "yes" });

  assert.deepEqual(rest, []);
  assert.match(reason, /appendSystemPrompt must be true or false/);
});

test("tools must be a string, and an empty list is meaningful", () => {
  assert.deepEqual(reasons({ tools: "Read, Bash" }), []);
  assert.deepEqual(reasons({ tools: "" }), []);
  const [reason] = reasons({ tools: ["Read"] });
  assert.match(reason, /tools must be a string/);
});

test("validation is deterministic", () => {
  const fields = { model: "gpt-5", effort: "enormous", nonsense: true };
  assert.deepEqual(
    validateClaudeProfile(profile(fields), PATH),
    validateClaudeProfile(profile(fields), PATH),
  );
});

test("the alias reaches the Query lowercased and unresolved", () => {
  assert.deepEqual(resolveClaudeModel(profile({ model: "Sonnet" })), {
    model: "sonnet",
  });
});

test("a Profile that pins no model borrows nothing, so the SDK's default stands", () => {
  assert.deepEqual(resolveClaudeModel(profile()), {});
});

test("effort is read from the Profile alone", () => {
  assert.deepEqual(resolveClaudeModel(profile({ effort: "xhigh" })), {
    effort: "xhigh",
  });
});
