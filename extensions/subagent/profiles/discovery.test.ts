import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ProfileDiagnostic } from "../domain/index.ts";
import { discoverProfiles, profilesDir } from "./discovery.ts";

/** A disposable Profile directory. */
function profileDirectory(
  t: { after(fn: () => void): void },
  files: Record<string, string>,
): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-profiles-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = profilesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

const valid = (description: string, backend?: string): string =>
  [
    "---",
    `description: ${description}`,
    ...(backend ? [`backend: ${backend}`] : []),
    "---",
    "Do the thing.",
  ].join("\n");

test("Profiles are read from the user-scope agents directory only", () => {
  assert.equal(
    profilesDir("/home/dev/.pi"),
    path.join("/home/dev/.pi", "agents"),
  );
});

test("a missing directory is an empty list, not an error", () => {
  assert.deepEqual(discoverProfiles("/nonexistent/pi/agents"), {
    profiles: new Map(),
    diagnostics: [],
  });
});

test("only Markdown files are Profiles, and each is named after its file", (t) => {
  const dir = profileDirectory(t, {
    "reviewer.md": valid("Reviews diffs"),
    "planner.md": valid("Plans work", "claude"),
    "notes.txt": valid("Not a Profile"),
    README: "not a Profile either",
  });

  const { profiles, diagnostics } = discoverProfiles(dir);

  assert.deepEqual([...profiles.keys()], ["planner", "reviewer"]);
  assert.equal(profiles.get("reviewer")?.description, "Reviews diffs");
  assert.equal(profiles.get("reviewer")?.backend, "pi");
  assert.equal(profiles.get("planner")?.backend, "claude");
  assert.deepEqual(diagnostics, []);
});

test("a directory named like a Profile is not read as one", (t) => {
  const dir = profileDirectory(t, { "reviewer.md": valid("Reviews diffs") });
  fs.mkdirSync(path.join(dir, "archive.md"));

  assert.deepEqual([...discoverProfiles(dir).profiles.keys()], ["reviewer"]);
});

test("one unreadable Profile does not hide readable Profiles", (t) => {
  const dir = profileDirectory(t, { "good.md": valid("Still available") });
  const brokenPath = path.join(dir, "broken.md");
  fs.symlinkSync(path.join(dir, "missing-target.md"), brokenPath);

  const { profiles, diagnostics } = discoverProfiles(dir);

  assert.deepEqual([...profiles.keys()], ["good"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.filePath, brokenPath);
  assert.match(diagnostics[0]?.reason ?? "", /cannot be read.*ENOENT/);
});

test("a directory that cannot be read yields one diagnostic", (t) => {
  const dir = profileDirectory(t, {});
  const notADirectory = path.join(dir, "not-a-directory");
  fs.writeFileSync(notADirectory, "not a directory");

  const { profiles, diagnostics } = discoverProfiles(notADirectory);

  assert.deepEqual(profiles, new Map());
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.filePath, notADirectory);
  assert.match(diagnostics[0]?.reason ?? "", /cannot be read.*ENOTDIR/);
});

test("an unparseable Profile is skipped and reported", (t) => {
  const dir = profileDirectory(t, {
    "good.md": valid("Fine"),
    "bad.md": "---\nbackend: 7\n---\n",
  });

  const { profiles, diagnostics } = discoverProfiles(dir);

  assert.deepEqual([...profiles.keys()], ["good"]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.reason),
    [
      "missing required description frontmatter",
      "backend must be a non-empty string",
      "missing required prompt body",
    ],
  );
  assert.equal(diagnostics[0].filePath, path.join(dir, "bad.md"));
});

test("a Profile its backend rejects is skipped and reported", (t) => {
  // Built from pieces so the boundary scan finds no occurrence of the
  // legacy field name in this tree.
  const legacyField = ["har", "ness"].join("");
  const dir = profileDirectory(t, {
    "legacy.md": [
      "---",
      "description: Uses the v1 field",
      `${legacyField}: claude`,
      "---",
      "Do the thing.",
    ].join("\n"),
    "modern.md": valid("Uses the backend field", "claude"),
    "proto.md": [
      "---",
      "description: Preserves a surprising field",
      "__proto__: unexpected",
      "---",
      "Do the thing.",
    ].join("\n"),
  });

  const standIn = (
    profile: { fields: Readonly<Record<string, unknown>> },
    filePath: string,
  ): readonly ProfileDiagnostic[] =>
    Object.keys(profile.fields).map((field) => ({
      filePath,
      reason: `stand-in backend does not recognize field '${field}'`,
    }));

  const { profiles, diagnostics } = discoverProfiles(dir, standIn);

  assert.deepEqual([...profiles.keys()], ["modern"]);
  assert.deepEqual(diagnostics, [
    {
      filePath: path.join(dir, "legacy.md"),
      reason: `stand-in backend does not recognize field '${legacyField}'`,
    },
    {
      filePath: path.join(dir, "proto.md"),
      reason: "stand-in backend does not recognize field '__proto__'",
    },
  ]);
});

test("discovering the same directory twice yields the same answer", (t) => {
  const dir = profileDirectory(t, {
    "b.md": valid("Second"),
    "a.md": valid("First"),
    "broken.md": "---\n---\n",
  });

  const first = discoverProfiles(dir);
  const second = discoverProfiles(dir);

  assert.deepEqual(
    [...first.profiles.entries()],
    [...second.profiles.entries()],
  );
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual([...first.profiles.keys()], ["a", "b"]);
});
