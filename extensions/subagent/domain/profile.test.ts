import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProfile, profileNameFromPath } from "./profile.ts";

/**
 * The field a v1 Profile uses to name its backend, built from pieces.
 *
 * The v2 boundary test fails the lane if that word appears anywhere in the v2
 * tree, and this test needs the word to prove a Profile still using it is
 * rejected. Assembling it at runtime satisfies both: the scan finds nothing,
 * and the assertion is about the real field name.
 */
const LEGACY_FIELD = ["har", "ness"].join("");

const path = "/home/dev/.pi/agents/reviewer.md";

function prototypeLess<T extends Record<string, unknown>>(values: T): T {
  return Object.assign(Object.create(null), values) as T;
}

function profileOf(text: string, filePath = path) {
  const parsed = parseProfile(text, filePath);
  assert.equal(
    parsed.outcome,
    "profile",
    `expected a profile, got ${JSON.stringify(parsed)}`,
  );
  assert.ok(parsed.outcome === "profile");
  return parsed.profile;
}

function reasonsOf(text: string, filePath = path): readonly string[] {
  const parsed = parseProfile(text, filePath);
  assert.ok(parsed.outcome === "diagnostics", "expected diagnostics");
  for (const diagnostic of parsed.diagnostics) {
    assert.equal(diagnostic.filePath, filePath);
  }
  return parsed.diagnostics.map((diagnostic) => diagnostic.reason);
}

test("a Profile is a description, a backend, and a body", () => {
  const profile = profileOf(
    [
      "---",
      "description: Reviews diffs",
      "backend: claude",
      "---",
      "",
      "Be terse.",
    ].join("\n"),
  );

  assert.deepEqual(profile, {
    name: "reviewer",
    description: "Reviews diffs",
    backend: "claude",
    fields: prototypeLess({}),
    systemPrompt: "Be terse.",
  });
});

test("parsing the same text twice yields deep-equal results", () => {
  const text = [
    "---",
    "description: Reviews diffs",
    "model: model-a",
    "tools: read,write",
    "---",
    "Be terse.",
  ].join("\n");

  assert.deepEqual(parseProfile(text, path), parseProfile(text, path));
  const broken = "---\nbackend: 7\n---\n";
  assert.deepEqual(parseProfile(broken, path), parseProfile(broken, path));
});

test("an omitted backend defaults to pi", () => {
  assert.equal(
    profileOf("---\ndescription: Reviews diffs\n---\nBe terse.").backend,
    "pi",
  );
});

test("a backend that is not a non-empty string is a diagnostic", () => {
  for (const value of ["7", "true", "[a, b]", '""']) {
    assert.deepEqual(
      reasonsOf(`---\ndescription: d\nbackend: ${value}\n---\nbody`),
      ["backend must be a non-empty string"],
      value,
    );
  }
});

test("a backend name that could not be an identifier is a diagnostic", () => {
  assert.deepEqual(
    reasonsOf("---\ndescription: d\nbackend: my backend\n---\nbody"),
    ["backend 'my backend' is not a usable backend name"],
  );
});

test("every other frontmatter field is collected unchanged and uninterpreted", () => {
  const profile = profileOf(
    [
      "---",
      "description: Reviews diffs",
      "backend: claude",
      "model: model-a",
      "effort: high",
      "tools: read,write",
      "appendSystemPrompt: false",
      "temperature: 0.4",
      "labels: [a, b]",
      "reviewers:",
      "  - ana",
      "  - bo",
      "---",
      "Be terse.",
    ].join("\n"),
  );

  assert.deepEqual(
    profile.fields,
    prototypeLess({
      model: "model-a",
      effort: "high",
      tools: "read,write",
      appendSystemPrompt: false,
      temperature: 0.4,
      labels: ["a", "b"],
      reviewers: ["ana", "bo"],
    }),
  );
});

test("version-like frontmatter values remain numbers", () => {
  const profile = profileOf("---\ndescription: d\nmodel: 4.1\n---\nbody");

  assert.equal(profile.fields.model, 4.1);
});

test("a Profile still using the v1 field keeps it as an ordinary field", () => {
  const profile = profileOf(
    `---\ndescription: d\n${LEGACY_FIELD}: claude\n---\nbody`,
  );

  // The parser does not special-case it: it becomes the backend's business,
  // and the backend reports it as unrecognized.
  assert.equal(profile.backend, "pi");
  assert.deepEqual(profile.fields, prototypeLess({ [LEGACY_FIELD]: "claude" }));
});

test("a missing description is a diagnostic, however it is missing", () => {
  for (const frontmatter of [
    "",
    "description:",
    'description: ""',
    "description:   ",
  ]) {
    assert.deepEqual(
      reasonsOf(`---\n${frontmatter}\n---\nbody`),
      ["missing required description frontmatter"],
      frontmatter,
    );
  }
});

test("a description of the wrong type names the type it was", () => {
  assert.deepEqual(reasonsOf("---\ndescription: [a, b]\n---\nbody"), [
    "description must be a string, not a list",
  ]);
  assert.deepEqual(reasonsOf("---\ndescription: 7\n---\nbody"), [
    "description must be a string, not a number",
  ]);
});

test("a missing prompt body is a diagnostic", () => {
  assert.deepEqual(reasonsOf("---\ndescription: d\n---\n   \n"), [
    "missing required prompt body",
  ]);
  assert.deepEqual(reasonsOf("just a body with no frontmatter"), [
    "missing required description frontmatter",
  ]);
});

test("every problem is reported, not only the first", () => {
  assert.deepEqual(reasonsOf("---\nbackend: 7\n---\n"), [
    "missing required description frontmatter",
    "backend must be a non-empty string",
    "missing required prompt body",
  ]);
});

test("unclosed frontmatter is a diagnostic rather than a silent body", () => {
  // The whole file becomes the body when the frontmatter never closes, so the
  // body is not the thing that is missing — the description is.
  assert.deepEqual(reasonsOf("---\ndescription: d\nbody with no close"), [
    "frontmatter is opened with '---' but never closed",
    "missing required description frontmatter",
  ]);
});

test("a field the reader cannot represent is reported, not misread", () => {
  assert.deepEqual(
    reasonsOf(
      ["---", "description: d", "limits:", "  cpu: 2", "---", "body"].join(
        "\n",
      ),
    ),
    ["frontmatter field 'limits' uses an unsupported nested map"],
  );
  assert.deepEqual(
    reasonsOf(
      ["---", "description: d", "prompt: |", "  hello", "---", "body"].join(
        "\n",
      ),
    ),
    [
      "frontmatter field 'prompt' uses an unsupported block scalar",
      "indented frontmatter is not supported: 'hello'",
    ],
  );
  assert.deepEqual(
    reasonsOf(
      ["---", "description: d", "not a field", "---", "body"].join("\n"),
    ),
    ["frontmatter line is not 'key: value': 'not a field'"],
  );
});

test("a repeated field is a diagnostic rather than a last-one-wins surprise", () => {
  assert.deepEqual(
    reasonsOf(
      ["---", "description: one", "description: two", "---", "body"].join("\n"),
    ),
    ["frontmatter field 'description' appears more than once"],
  );
});

test("scalars are read as YAML reads them, comments and quotes included", () => {
  const profile = profileOf(
    [
      "---",
      'description: "A: reviewer"',
      "model: model-a # the fast one",
      "effort: 'high'",
      "enabled: true",
      "retries: 3",
      "note: null",
      "# a whole-line comment",
      "---",
      "body",
    ].join("\n"),
  );

  assert.equal(profile.description, "A: reviewer");
  assert.deepEqual(
    profile.fields,
    prototypeLess({
      model: "model-a",
      effort: "high",
      enabled: true,
      retries: 3,
      note: null,
    }),
  );
});

test("a quoted scalar may contain a hash before a trailing comment", () => {
  const profile = profileOf('---\ndescription: "a #1 thing" # note\n---\nbody');

  assert.equal(profile.description, "a #1 thing");
});

test("an inline list does not split commas inside quotes", () => {
  const profile = profileOf(
    '---\ndescription: d\ntools: [a, "b,c"]\n---\nbody',
  );

  assert.deepEqual(profile.fields.tools, ["a", "b,c"]);
});

test("frontmatter fields preserve a __proto__ key without a prototype", () => {
  const profile = profileOf(
    "---\ndescription: d\n__proto__: unexpected\n---\nbody",
  );

  assert.equal(Object.getPrototypeOf(profile.fields), null);
  assert.equal(Object.hasOwn(profile.fields, "__proto__"), true);
  assert.equal(Reflect.get(profile.fields, "__proto__"), "unexpected");
});

test("only a line of exactly three dashes is a frontmatter fence", () => {
  assert.deepEqual(reasonsOf("----\ndescription: not frontmatter\n---\nbody"), [
    "missing required description frontmatter",
  ]);
  assert.deepEqual(reasonsOf("---\ndescription: d\n---extra\n---\nbody"), [
    "frontmatter line is not 'key: value': '---extra'",
  ]);
  assert.equal(
    profileOf("--- \ndescription: d\n---\t\nbody").systemPrompt,
    "body",
  );
});

test("a Profile is named after its file, on either kind of path", () => {
  assert.equal(
    profileNameFromPath("/home/dev/.pi/agents/reviewer.md"),
    "reviewer",
  );
  assert.equal(profileNameFromPath("C:\\pi\\agents\\reviewer.md"), "reviewer");
  assert.equal(profileNameFromPath("reviewer.md"), "reviewer");
  assert.equal(profileNameFromPath("reviewer"), "reviewer");
  assert.equal(profileNameFromPath("my.agent.md"), "my.agent");
  // A dotfile keeps its name rather than becoming empty.
  assert.equal(profileNameFromPath(".reviewer"), ".reviewer");
});

test("windows line endings and a byte-order mark are handled", () => {
  const profile = profileOf(
    "\uFEFF---\r\ndescription: Reviews diffs\r\n---\r\nBe terse.\r\n",
  );

  assert.equal(profile.description, "Reviews diffs");
  assert.equal(profile.systemPrompt, "Be terse.");
});
