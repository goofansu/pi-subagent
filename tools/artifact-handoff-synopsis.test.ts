import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const synopsisTool = fileURLToPath(
  new URL("../skills/artifact-handoff/synopsis.mjs", import.meta.url),
);
const runKey = "worker-1";

const validSynopsis = `STATUS: pass
RUN_KEY: ${runKey}
SUMMARY: Completed the assigned criterion.
ATTENTION: no
HEAD: abc123

## Attention
- None.

## Criteria
- [x] C1 Completed — \`evidence/${runKey}/check.out\`

## Decisions worth knowing
- None.

## Residue
- None.
`;

const runningSynopsis = `STATUS: running
RUN_KEY: ${runKey}
SUMMARY: work in progress
ATTENTION: yes
HEAD: abc123

## Attention
- Work in progress.

## Criteria
- [ ] C1 Investigating the assigned criterion

## Decisions worth knowing
- None.

## Residue
- Work in progress.
`;

const fixture = (t: TestContext, synopsis = validSynopsis, mode = 0o600) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "artifact-handoff-synopsis-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, "evidence", runKey);
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(evidence, "check.out"), "ok\n", { mode: 0o600 });
  const artifact = path.join(root, `handoff-${runKey}.md`);
  fs.writeFileSync(artifact, synopsis, { mode });
  fs.chmodSync(artifact, mode);
  return { artifact, root };
};

const validate = (artifact: string, key = runKey) =>
  spawnSync(
    process.execPath,
    [synopsisTool, "validate", "--artifact", artifact, "--run-key", key],
    { encoding: "utf8" },
  );

const stage = (artifact: string, synopsis: string, mode = 0o600) => {
  const staged = `${artifact}.staged`;
  fs.writeFileSync(staged, synopsis, { mode });
  fs.chmodSync(staged, mode);
  return staged;
};

const publish = (artifact: string, staged = `${artifact}.staged`) =>
  spawnSync(
    process.execPath,
    [
      synopsisTool,
      "publish",
      "--staged",
      staged,
      "--artifact",
      artifact,
      "--run-key",
      runKey,
    ],
    { encoding: "utf8" },
  );

test("a bounded canonical passing Synopsis validates", (t) => {
  const { artifact } = fixture(t);
  const result = validate(artifact);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /VALID: .*handoff-worker-1\.md/);
});

test("CLI help succeeds and malformed invocations return usage errors", () => {
  const help = spawnSync(process.execPath, [synopsisTool, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:/);

  for (const arguments_ of [
    ["--unknown", "value"],
    ["--artifact"],
    ["--artifact", "a", "--artifact", "b", "--run-key", runKey],
  ]) {
    const result = spawnSync(
      process.execPath,
      [synopsisTool, "validate", ...arguments_],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.notEqual(result.stderr, "");
  }
});

test("publishing a running checkpoint initializes the canonical Synopsis", (t) => {
  const { artifact } = fixture(t);
  fs.rmSync(artifact);
  const staged = stage(artifact, runningSynopsis, 0o644);

  const result = publish(artifact, staged);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PUBLISHED: .*handoff-worker-1\.md/);
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readFileSync(artifact, "utf8"), runningSynopsis);
  assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);

  const terminalGate = validate(artifact);
  assert.equal(terminalGate.status, 1);
  assert.match(terminalGate.stderr, /STATUS must be pass, blocked, or failed/);
});

test("invalid staged content leaves the previous Synopsis untouched", (t) => {
  const { artifact } = fixture(t);
  const previous = fs.readFileSync(artifact);
  const staged = stage(artifact, "STATUS: pass\n", 0o644);

  const result = publish(artifact, staged);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /line 2 must start with 'RUN_KEY: '/);
  assert.deepEqual(fs.readFileSync(artifact), previous);
  assert.equal(fs.existsSync(staged), true);
  assert.equal(fs.statSync(staged).mode & 0o777, 0o600);

  const terminalGate = validate(artifact);
  assert.equal(terminalGate.status, 1);
  assert.match(terminalGate.stderr, /staged Synopsis remains/);
});

test("publishing requires the deterministic sibling staged path", (t) => {
  const { artifact, root } = fixture(t);
  const previous = fs.readFileSync(artifact);
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  const staged = path.join(elsewhere, "candidate.md");
  fs.writeFileSync(staged, validSynopsis, { mode: 0o600 });

  const result = publish(artifact, staged);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged path must be .*\.md\.staged/);
  assert.deepEqual(fs.readFileSync(artifact), previous);
  assert.equal(fs.existsSync(staged), true);
});

test("valid staged content atomically replaces the previous Synopsis", (t) => {
  const { artifact } = fixture(t);
  const replacement = validSynopsis.replace(
    "Completed the assigned criterion.",
    "Completed and independently checked the criterion.",
  );
  const staged = stage(artifact, replacement, 0o644);

  const result = publish(artifact, staged);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(artifact, "utf8"), replacement);
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
  assert.equal(validate(artifact).status, 0);
});

test("publishing refuses a staged symlink without changing the Synopsis", (t) => {
  const { artifact, root } = fixture(t);
  const previous = fs.readFileSync(artifact);
  const target = path.join(root, "staged-target.md");
  fs.writeFileSync(target, validSynopsis, { mode: 0o600 });
  fs.symlinkSync(target, `${artifact}.staged`);

  const result = publish(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged Synopsis is not a regular file/i);
  assert.deepEqual(fs.readFileSync(artifact), previous);
  assert.equal(fs.lstatSync(`${artifact}.staged`).isSymbolicLink(), true);

  const terminalGate = validate(artifact);
  assert.equal(terminalGate.status, 1);
  assert.match(terminalGate.stderr, /staged Synopsis remains/);
});

test("publishing replaces rather than follows a canonical symlink", (t) => {
  const { artifact, root } = fixture(t);
  const target = path.join(root, "old-target.md");
  fs.renameSync(artifact, target);
  fs.symlinkSync(target, artifact);
  const replacement = validSynopsis.replace(
    "Completed the assigned criterion.",
    "Published without following the destination symlink.",
  );
  stage(artifact, replacement);

  const result = publish(artifact);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.lstatSync(artifact).isFile(), true);
  assert.equal(fs.readFileSync(artifact, "utf8"), replacement);
  assert.equal(fs.readFileSync(target, "utf8"), validSynopsis);
});

test("size and section shape are hard failures", (t) => {
  const oversized = validSynopsis.replace(
    "## Residue",
    `${"extended report ".repeat(1200)}\n\n## Extra\ntext\n\n## Residue`,
  );
  const { artifact } = fixture(t, oversized);
  const result = validate(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds 16384 bytes/);
  assert.match(result.stderr, /section headings must be exactly/);
});

test("a terminal Synopsis must end with a newline", (t) => {
  const { artifact } = fixture(t, validSynopsis.trimEnd());
  const result = validate(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must end with a newline/);
});

test("a pass rejects unchecked criteria and stale working state", (t) => {
  const stale = validSynopsis
    .replace("- [x] C1", "- [ ] C1")
    .replace("## Residue\n- None.", "## Residue\n- Work in progress.");
  const { artifact } = fixture(t, stale);
  const result = validate(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /passing Synopsis has an unchecked criterion/);
  assert.match(result.stderr, /contains a work in progress placeholder/);
});

test("checked criteria require Evidence and criterion IDs are unique", (t) => {
  const noEvidence = validSynopsis.replace(
    "- [x] C1 Completed — `evidence/worker-1/check.out`",
    "- [x] C1 Completed without retained evidence",
  );
  const noEvidenceFixture = fixture(t, noEvidence);
  const noEvidenceResult = validate(noEvidenceFixture.artifact);
  assert.equal(noEvidenceResult.status, 1);
  assert.match(noEvidenceResult.stderr, /lacks an Evidence pointer/);

  const duplicate = validSynopsis.replace(
    "## Decisions worth knowing",
    "- [x] C1 Duplicate — `evidence/worker-1/check.out`\n\n## Decisions worth knowing",
  );
  const duplicateFixture = fixture(t, duplicate);
  const duplicateResult = validate(duplicateFixture.artifact);
  assert.equal(duplicateResult.status, 1);
  assert.match(duplicateResult.stderr, /duplicate criterion id: C1/);
});

test("header fields and nonempty canonical section bodies are validated", (t) => {
  const invalid = validSynopsis
    .replace(
      "SUMMARY: Completed the assigned criterion.",
      `SUMMARY: ${"x".repeat(201)}`,
    )
    .replace("ATTENTION: no", "ATTENTION: maybe")
    .replace("HEAD: abc123", "HEAD: ")
    .replace("## Attention\n- None.", "## Attention\nnot a bullet")
    .replace(
      "- [x] C1 Completed — `evidence/worker-1/check.out`",
      "- [X] C1 malformed",
    )
    .replace(
      "## Decisions worth knowing\n- None.\n\n## Residue\n- None.",
      "## Decisions worth knowing\n\n## Residue\n",
    );
  const { artifact } = fixture(t, invalid);
  const result = validate(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /SUMMARY exceeds 200 characters/);
  assert.match(result.stderr, /ATTENTION must be yes or no/);
  assert.match(result.stderr, /HEAD must not be empty/);
  assert.match(result.stderr, /every Attention item must be a one-line bullet/);
  assert.match(result.stderr, /invalid criterion checklist item/);
  assert.match(result.stderr, /Decisions worth knowing must not be empty/);
  assert.match(result.stderr, /Residue must not be empty/);
});

test("non-passing status and Attention bounds are validated", (t) => {
  for (const status of ["blocked", "failed"]) {
    const invalid = validSynopsis.replace("STATUS: pass", `STATUS: ${status}`);
    const { artifact } = fixture(t, invalid);
    const result = validate(artifact);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`${status} status requires ATTENTION: yes`),
    );
  }

  const attentionItems = Array.from(
    { length: 11 },
    (_, index) => `- Attention item ${index + 1}.`,
  ).join("\n");
  const tooMany = validSynopsis
    .replace("ATTENTION: no", "ATTENTION: yes")
    .replace("## Attention\n- None.", `## Attention\n${attentionItems}`);
  const { artifact } = fixture(t, tooMany);
  const result = validate(artifact);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Attention must contain 1-10 one-line bullets/);
});

test("a blocked Synopsis with concrete Attention validates", (t) => {
  const blocked = validSynopsis
    .replace("STATUS: pass", "STATUS: blocked")
    .replace("ATTENTION: no", "ATTENTION: yes")
    .replace(
      "## Attention\n- None.",
      "## Attention\n- Caller must choose an API.",
    )
    .replace(
      "- [x] C1 Completed — `evidence/worker-1/check.out`",
      "- [ ] C1 Waiting for the caller's API choice",
    )
    .replace(
      "## Residue\n- None.",
      "## Residue\n- The migration is work in progress on its delivery branch.",
    );
  const { artifact } = fixture(t, blocked);
  const result = validate(artifact);

  assert.equal(result.status, 0, result.stderr);
});

test("Attention and waiver semantics are validated", (t) => {
  const invalidWaiver = validSynopsis.replace(
    "- [x] C1 Completed — `evidence/worker-1/check.out`",
    "- [x] C1 WAIVED because it was inconvenient",
  );
  const { artifact } = fixture(t, invalidWaiver);
  const result = validate(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /waiver must use 'WAIVED by <actor>: <reason>'/);
  assert.match(result.stderr, /waiver requires ATTENTION: yes/);
});

test("an attributed attention-marked waiver validates", (t) => {
  const waived = validSynopsis
    .replace("ATTENTION: no", "ATTENTION: yes")
    .replace(
      "## Attention\n- None.",
      "## Attention\n- C1 was waived by the caller.",
    )
    .replace(
      "- [x] C1 Completed — `evidence/worker-1/check.out`",
      "- [x] C1 WAIVED by caller: accepted for this run",
    );
  const { artifact } = fixture(t, waived);
  const result = validate(artifact);

  assert.equal(result.status, 0, result.stderr);
});

test("Evidence pointers must exist and remain below evidence", (t) => {
  const missing = validSynopsis.replace("check.out", "missing.out");
  const missingFixture = fixture(t, missing);
  const missingResult = validate(missingFixture.artifact);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /Evidence pointer does not exist/);

  const escaped = validSynopsis.replace(
    `evidence/${runKey}/check.out`,
    `evidence/${runKey}/../../outside.out`,
  );
  const escapedFixture = fixture(t, escaped);
  const escapedResult = validate(escapedFixture.artifact);
  assert.equal(escapedResult.status, 1);
  assert.match(escapedResult.stderr, /must use evidence\/<owner>\/<file>/);

  const linkedFixture = fixture(t);
  const outside = path.join(linkedFixture.root, "outside.out");
  fs.writeFileSync(outside, "outside\n", { mode: 0o600 });
  fs.symlinkSync(
    outside,
    path.join(linkedFixture.root, "evidence", runKey, "linked.out"),
  );
  fs.writeFileSync(
    linkedFixture.artifact,
    validSynopsis.replace("check.out", "linked.out"),
    { mode: 0o600 },
  );
  const linkedResult = validate(linkedFixture.artifact);
  assert.equal(linkedResult.status, 1);
  assert.match(linkedResult.stderr, /escapes the evidence root through a link/);
});

test("a missing evidence root and unsafe run key are rejected", (t) => {
  const missingEvidence = fixture(t);
  fs.rmSync(path.join(missingEvidence.root, "evidence"), {
    recursive: true,
    force: true,
  });
  const missingResult = validate(missingEvidence.artifact);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /evidence root does not exist/);

  const unsafeKey = fixture(t);
  const unsafeResult = validate(unsafeKey.artifact, "../worker");
  assert.equal(unsafeResult.status, 1);
  assert.match(
    unsafeResult.stderr,
    /run key must be 1-64 filesystem-safe characters/,
  );
});

test("the allocated key, filename, and private mode are validated read-only", (t) => {
  const { artifact } = fixture(t, validSynopsis, 0o644);
  const before = fs.statSync(artifact);
  const previous = fs.readFileSync(artifact);

  const result = validate(artifact, "another-worker");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_KEY header must equal another-worker/);
  assert.match(result.stderr, /filename must be handoff-another-worker\.md/);
  assert.match(result.stderr, /mode must be 600/);
  const after = fs.statSync(artifact);
  assert.deepEqual(fs.readFileSync(artifact), previous);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mode & 0o777, 0o644);
});

test("the Synopsis itself must be a regular file", (t) => {
  const { artifact, root } = fixture(t);
  const target = path.join(root, "synopsis-target.md");
  fs.renameSync(artifact, target);
  fs.symlinkSync(target, artifact);

  const result = validate(artifact);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Synopsis is not a regular file/);
});
