import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BACKEND_ID,
  type Profile,
  type SubagentContext,
  subagentId,
} from "../../domain/index.ts";
import {
  catalogueSummary,
  MAX_CATALOGUE_DIAGNOSTIC_CHARS,
  resolvePiModel,
  validatePiProfile,
} from "./profile.ts";

/**
 * Pi's Profile rules, which are v1's.
 *
 * A Profile that validated under v1 has to keep validating: the only migration
 * v2 asks a Profile author for is a renamed field. So these assertions are v1's
 * Pi Profile assertions, rephrased, and a difference here is a difference a
 * user would notice.
 */

const PATH = "/agents/explore.md";

function profile(fields: Record<string, unknown> = {}): Profile {
  return {
    name: "explore",
    description: "The explore specialist",
    backend: DEFAULT_BACKEND_ID,
    fields,
    systemPrompt: "Explore.",
  };
}

function reasons(
  fields: Record<string, unknown>,
  models?: readonly { readonly provider: string; readonly id: string }[],
): string[] {
  return validatePiProfile(
    profile(fields),
    PATH,
    models === undefined ? undefined : { models },
  ).map((diagnostic) => diagnostic.reason);
}

const CATALOGUE = [
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "anthropic", id: "claude-sonnet-4-6" },
];

test("a Profile with no fields is valid", () => {
  assert.deepEqual(reasons({}), []);
});

test("a model spelled as the catalogue's own id is accepted", () => {
  assert.deepEqual(reasons({ model: "gpt-5.4-mini" }, CATALOGUE), []);
});

test("a model spelled provider-qualified is accepted", () => {
  assert.deepEqual(
    reasons({ model: "openai-codex/gpt-5.4-mini" }, CATALOGUE),
    [],
  );
});

test("a model the catalogue does not hold names what it does hold", () => {
  const [reason, ...rest] = reasons({ model: "gpt-9-imaginary" }, CATALOGUE);

  assert.deepEqual(rest, []);
  assert.match(
    reason,
    /model 'gpt-9-imaginary' was not found in Pi's model catalogue/,
  );
  assert.match(reason, /openai-codex\/gpt-5\.4-mini/);
  assert.match(reason, /anthropic\/claude-sonnet-4-6/);
});

test("omitting the catalogue means an empty one, so a pinned model is unknown", () => {
  const [reason] = reasons({ model: "gpt-5.4-mini" });

  assert.match(reason, /catalogue models include: none/);
});

test("the catalogue summary is bounded and says how many it left out", () => {
  const many = Array.from(
    { length: 200 },
    (_unused, index) => `provider-${index}/a-fairly-long-model-name-${index}`,
  );

  const summary = catalogueSummary(many);

  assert.ok(
    summary.length <= MAX_CATALOGUE_DIAGNOSTIC_CHARS,
    `the summary is ${summary.length} characters`,
  );
  assert.match(summary, /\(200 catalogue models total\)/);
  assert.match(summary, /provider-0\/a-fairly-long-model-name-0/);
});

test("a catalogue that fits is listed whole, with no omission note", () => {
  const summary = catalogueSummary(["a/one", "b/two"]);

  assert.equal(summary, "a/one, b/two");
});

test("an effort outside the shared scale is rejected by name", () => {
  const [reason] = reasons({ effort: "enormous" });

  assert.match(reason, /unknown effort 'enormous'/);
  assert.match(reason, /off, minimal, low, medium, high, xhigh, max/);
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

test("tools is a comma-separated list, and an empty list is meaningful", () => {
  assert.deepEqual(reasons({ tools: "read_file, bash" }), []);
  assert.deepEqual(reasons({ tools: "" }), []);
});

test("a non-string tools field is rejected", () => {
  assert.deepEqual(reasons({ tools: 7 }), ["tools must be a string"]);
});

test("appendSystemPrompt must be a boolean", () => {
  assert.deepEqual(reasons({ appendSystemPrompt: false }), []);
  assert.deepEqual(reasons({ appendSystemPrompt: "no" }), [
    "appendSystemPrompt must be true or false",
  ]);
});

test("a field Pi has never heard of is a diagnostic, not a silent pass", () => {
  assert.deepEqual(reasons({ nonsense: "x" }), [
    "Pi backend does not recognize field 'nonsense'",
  ]);
});

test("two bad fields produce two diagnostics", () => {
  assert.deepEqual(reasons({ effort: "enormous", tools: 7 }).sort(), [
    "tools must be a string",
    "unknown effort 'enormous'; expected one of off, minimal, low, medium, high, xhigh, max",
  ]);
});

test("validation is deterministic", () => {
  const subject = profile({ model: "gpt-9-imaginary", nonsense: true });

  assert.deepEqual(
    validatePiProfile(subject, PATH, { models: CATALOGUE }),
    validatePiProfile(subject, PATH, { models: CATALOGUE }),
  );
});

// ── Model and thinking inheritance ───────────────────────────────────────────

function subagent(
  parentModel?: SubagentContext["parentModel"],
): SubagentContext {
  return {
    subagentId: subagentId("subagent-1"),
    cwd: "/work",
    childDepth: 1,
    projectTrusted: true,
    ...(parentModel === undefined ? {} : { parentModel }),
  };
}

test("a Profile's own model wins over the parent's", () => {
  assert.deepEqual(
    resolvePiModel(
      profile({ model: "gpt-5.4-mini" }),
      subagent({ provider: "anthropic", id: "claude-sonnet-4-6" }),
    ),
    { model: "gpt-5.4-mini" },
  );
});

test("with no Profile model, the parent's is inherited provider-qualified", () => {
  assert.deepEqual(
    resolvePiModel(
      profile(),
      subagent({ provider: "anthropic", id: "claude-sonnet-4-6" }),
    ),
    { model: "anthropic/claude-sonnet-4-6" },
  );
});

test("with no Profile model and no parent, nothing is pinned", () => {
  assert.deepEqual(resolvePiModel(profile(), subagent()), {});
});

test("a Profile's effort wins over the parent's thinking level", () => {
  assert.deepEqual(
    resolvePiModel(
      profile({ effort: "high" }),
      subagent({
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        thinkingLevel: "low",
      }),
    ),
    { model: "anthropic/claude-sonnet-4-6", thinking: "high" },
  );
});

test("the parent's thinking level is inherited only when no model is pinned", () => {
  const parent = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    thinkingLevel: "low",
  };

  assert.deepEqual(resolvePiModel(profile(), subagent(parent)), {
    model: "anthropic/claude-sonnet-4-6",
    thinking: "low",
  });
  // A Profile that chose a different model has not agreed to the parent's
  // effort for it.
  assert.deepEqual(
    resolvePiModel(profile({ model: "gpt-5.4-mini" }), subagent(parent)),
    { model: "gpt-5.4-mini" },
  );
});
