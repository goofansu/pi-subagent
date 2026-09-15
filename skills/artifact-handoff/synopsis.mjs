import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 16 * 1024;
const MAX_SUMMARY_CHARACTERS = 200;
const MAX_ATTENTION_ITEMS = 10;
const HEADINGS = [
  "## Attention",
  "## Criteria",
  "## Decisions worth knowing",
  "## Residue",
];
const RUN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TERMINAL_STATUSES = ["pass", "blocked", "failed"];

const usage = `Usage:
  node synopsis.mjs validate --artifact <path> --run-key <key>
  node synopsis.mjs publish --staged <path> --artifact <path> --run-key <key>`;

function parseArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--help") return undefined;

  const [command, ...optionArguments] = arguments_;
  if (command !== "validate" && command !== "publish") throw new Error(usage);

  const values = new Map();
  for (let index = 0; index < optionArguments.length; index += 2) {
    const option = optionArguments[index];
    const value = optionArguments[index + 1];
    if (!option?.startsWith("--") || value === undefined)
      throw new Error(usage);
    if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
    values.set(option, value);
  }

  const allowed = new Set(["--artifact", "--run-key"]);
  if (command === "publish") allowed.add("--staged");
  const unknown = [...values.keys()].find((option) => !allowed.has(option));
  if (unknown) throw new Error(`Unknown option: ${unknown}`);

  const artifactPath = values.get("--artifact");
  const runKey = values.get("--run-key");
  const stagedPath = values.get("--staged");
  if (!artifactPath || !runKey || (command === "publish" && !stagedPath))
    throw new Error(usage);

  return {
    artifactPath: path.resolve(artifactPath),
    command,
    runKey,
    stagedPath: stagedPath ? path.resolve(stagedPath) : undefined,
  };
}

function parseHeader(lines, index, label, errors) {
  const prefix = `${label}: `;
  const line = lines[index] ?? "";
  if (!line.startsWith(prefix)) {
    errors.push(`line ${index + 1} must start with '${prefix}'`);
    return "";
  }
  return line.slice(prefix.length);
}

function sectionLines(lines, headingIndexes, headingIndex) {
  const start = headingIndexes[headingIndex] + 1;
  const end = headingIndexes[headingIndex + 1] ?? lines.length;
  return lines.slice(start, end).filter((line) => line.trim().length > 0);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function pathEntryExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function evidencePointers(line) {
  return [...line.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith("evidence/"));
}

function validateEvidencePointer(pointer, synopsisRoot, evidenceRoot, errors) {
  const parts = pointer.split("/");
  if (
    parts.length < 3 ||
    !RUN_KEY_PATTERN.test(parts[1]) ||
    parts.slice(2).some((part) => part === "" || part === "." || part === "..")
  ) {
    errors.push(
      `Evidence pointer must use evidence/<owner>/<file> without traversal: ${pointer}`,
    );
    return;
  }

  const resolved = path.resolve(synopsisRoot, pointer);
  if (!isWithin(evidenceRoot, resolved)) {
    errors.push(`Evidence pointer escapes the evidence root: ${pointer}`);
    return;
  }
  if (!fs.existsSync(resolved)) {
    errors.push(`Evidence pointer does not exist: ${pointer}`);
    return;
  }

  const realEvidenceRoot = fs.realpathSync(evidenceRoot);
  const realTarget = fs.realpathSync(resolved);
  if (!isWithin(realEvidenceRoot, realTarget)) {
    errors.push(
      `Evidence pointer escapes the evidence root through a link: ${pointer}`,
    );
    return;
  }
  if (!fs.statSync(realTarget).isFile())
    errors.push(`Evidence pointer is not a file: ${pointer}`);
}

export function validateSynopsis({
  artifactPath,
  runKey,
  sourcePath = artifactPath,
  allowRunning = false,
}) {
  const resolvedArtifactPath = path.resolve(artifactPath);
  const resolvedSourcePath = path.resolve(sourcePath);
  const sourceLabel =
    resolvedSourcePath === resolvedArtifactPath
      ? "Synopsis"
      : "Staged Synopsis";
  const errors = [];
  if (!RUN_KEY_PATTERN.test(runKey))
    errors.push("run key must be 1-64 filesystem-safe characters");
  if (
    resolvedSourcePath === resolvedArtifactPath &&
    pathEntryExists(`${resolvedArtifactPath}.staged`)
  )
    errors.push(
      `staged Synopsis remains beside the canonical file: ${resolvedArtifactPath}.staged`,
    );

  if (!fs.existsSync(resolvedSourcePath))
    return {
      bytes: 0,
      errors: [
        ...errors,
        `${sourceLabel} does not exist: ${resolvedSourcePath}`,
      ],
    };

  const stats = fs.lstatSync(resolvedSourcePath);
  if (!stats.isFile())
    return {
      bytes: stats.size,
      errors: [
        ...errors,
        `${sourceLabel} is not a regular file: ${resolvedSourcePath}`,
      ],
    };

  const mode = stats.mode & 0o777;
  if (mode !== 0o600)
    errors.push(`Synopsis mode must be 600, found ${mode.toString(8)}`);

  const bytes = stats.size;
  if (bytes > MAX_BYTES)
    errors.push(`Synopsis exceeds ${MAX_BYTES} bytes: ${bytes}`);

  const contents = fs.readFileSync(resolvedSourcePath, "utf8");
  if (!contents.endsWith("\n")) errors.push("Synopsis must end with a newline");
  const lines = contents.split(/\r?\n/);
  const status = parseHeader(lines, 0, "STATUS", errors);
  const actualRunKey = parseHeader(lines, 1, "RUN_KEY", errors);
  const summary = parseHeader(lines, 2, "SUMMARY", errors);
  const attention = parseHeader(lines, 3, "ATTENTION", errors);
  const head = parseHeader(lines, 4, "HEAD", errors);

  const allowedStatuses = allowRunning
    ? ["running", ...TERMINAL_STATUSES]
    : TERMINAL_STATUSES;
  if (!allowedStatuses.includes(status))
    errors.push(
      `STATUS must be ${allowedStatuses.join(", ").replace(/, ([^,]+)$/, ", or $1")}`,
    );
  if (actualRunKey !== runKey)
    errors.push(`RUN_KEY header must equal ${runKey}`);
  if (path.basename(resolvedArtifactPath) !== `handoff-${runKey}.md`)
    errors.push(`Synopsis filename must be handoff-${runKey}.md`);
  if (summary.length === 0) errors.push("SUMMARY must not be empty");
  if ([...summary].length > MAX_SUMMARY_CHARACTERS)
    errors.push(`SUMMARY exceeds ${MAX_SUMMARY_CHARACTERS} characters`);
  if (!["yes", "no"].includes(attention))
    errors.push("ATTENTION must be yes or no");
  if (head.length === 0) errors.push("HEAD must not be empty");
  const hasWorkingPlaceholder =
    summary.toLowerCase() === "work in progress" ||
    lines.some((line) => line.trim().toLowerCase() === "- work in progress.");
  if (status !== "running" && hasWorkingPlaceholder)
    errors.push("Synopsis contains a work in progress placeholder");

  const headings = lines.filter((line) => line.startsWith("## "));
  if (
    headings.length !== HEADINGS.length ||
    headings.some((heading, index) => heading !== HEADINGS[index])
  )
    errors.push(`section headings must be exactly: ${HEADINGS.join(", ")}`);

  const headingIndexes = HEADINGS.map((heading) => lines.indexOf(heading));
  if (headingIndexes.some((index) => index === -1)) return { bytes, errors };
  if (lines.slice(5, headingIndexes[0]).some((line) => line.trim().length > 0))
    errors.push("only blank lines may appear between the header and Attention");

  const attentionLines = sectionLines(lines, headingIndexes, 0);
  if (
    attentionLines.length === 0 ||
    attentionLines.length > MAX_ATTENTION_ITEMS
  )
    errors.push(
      `Attention must contain 1-${MAX_ATTENTION_ITEMS} one-line bullets`,
    );
  if (attentionLines.some((line) => !line.startsWith("- ")))
    errors.push("every Attention item must be a one-line bullet");
  if (
    attention === "no" &&
    (attentionLines.length !== 1 || attentionLines[0] !== "- None.")
  )
    errors.push("ATTENTION: no requires exactly '- None.'");
  if (attention === "yes" && attentionLines.includes("- None."))
    errors.push("ATTENTION: yes requires concrete Attention items");
  if (status !== "pass" && attention !== "yes")
    errors.push(`${status || "non-passing"} status requires ATTENTION: yes`);

  const criteriaLines = sectionLines(lines, headingIndexes, 1);
  if (criteriaLines.length === 0)
    errors.push("Criteria must contain at least one checklist item");
  const criterionIds = new Set();
  for (const criterion of criteriaLines) {
    const match = criterion.match(/^- \[([ x])\] (C[1-9][0-9]*) (.+)$/);
    if (!match) {
      errors.push(`invalid criterion checklist item: ${criterion}`);
      continue;
    }

    const checked = match[1] === "x";
    const criterionId = match[2];
    const text = match[3];
    if (criterionIds.has(criterionId))
      errors.push(`duplicate criterion id: ${criterionId}`);
    criterionIds.add(criterionId);
    const waived = /\bWAIVED\b/.test(text);
    const pointers = evidencePointers(criterion);
    if (status === "pass" && !checked)
      errors.push(`passing Synopsis has an unchecked criterion: ${criterion}`);
    if (waived && !/\bWAIVED by [^:]+:\s*\S/.test(text))
      errors.push("waiver must use 'WAIVED by <actor>: <reason>'");
    if (waived && attention !== "yes")
      errors.push("waiver requires ATTENTION: yes");
    if (checked && !waived && pointers.length === 0)
      errors.push(
        `satisfied criterion lacks an Evidence pointer: ${criterion}`,
      );
  }

  for (const sectionIndex of [2, 3]) {
    if (sectionLines(lines, headingIndexes, sectionIndex).length === 0)
      errors.push(`${HEADINGS[sectionIndex].slice(3)} must not be empty`);
  }

  const synopsisRoot = path.dirname(resolvedArtifactPath);
  const evidenceRoot = path.join(synopsisRoot, "evidence");
  if (!fs.existsSync(evidenceRoot) || !fs.statSync(evidenceRoot).isDirectory())
    errors.push(`evidence root does not exist: ${evidenceRoot}`);
  else {
    const realSynopsisRoot = fs.realpathSync(synopsisRoot);
    const realEvidenceRoot = fs.realpathSync(evidenceRoot);
    if (!isWithin(realSynopsisRoot, realEvidenceRoot))
      errors.push(
        `evidence root escapes the Synopsis directory: ${evidenceRoot}`,
      );
    else {
      const pointers = new Set(
        contents.split(/\r?\n/).flatMap(evidencePointers),
      );
      for (const pointer of pointers)
        validateEvidencePointer(pointer, synopsisRoot, evidenceRoot, errors);
    }
  }

  return { bytes, errors };
}

export function publishSynopsis({ artifactPath, runKey, stagedPath }) {
  const resolvedArtifactPath = path.resolve(artifactPath);
  const resolvedStagedPath = path.resolve(stagedPath);
  const errors = [];

  if (!RUN_KEY_PATTERN.test(runKey))
    errors.push("run key must be 1-64 filesystem-safe characters");
  if (path.basename(resolvedArtifactPath) !== `handoff-${runKey}.md`)
    errors.push(`Synopsis filename must be handoff-${runKey}.md`);
  if (resolvedStagedPath !== `${resolvedArtifactPath}.staged`)
    errors.push(`staged path must be ${resolvedArtifactPath}.staged`);
  if (errors.length > 0) return { bytes: 0, errors };

  if (!fs.existsSync(resolvedStagedPath))
    return {
      bytes: 0,
      errors: [`Staged Synopsis does not exist: ${resolvedStagedPath}`],
    };
  const stagedStats = fs.lstatSync(resolvedStagedPath);
  if (!stagedStats.isFile())
    return {
      bytes: stagedStats.size,
      errors: [`Staged Synopsis is not a regular file: ${resolvedStagedPath}`],
    };

  fs.chmodSync(resolvedStagedPath, 0o600);
  const result = validateSynopsis({
    allowRunning: true,
    artifactPath: resolvedArtifactPath,
    runKey,
    sourcePath: resolvedStagedPath,
  });
  if (result.errors.length > 0) return result;

  const descriptor = fs.openSync(resolvedStagedPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(resolvedStagedPath, resolvedArtifactPath);
  return result;
}

function run(arguments_) {
  let parsed;
  try {
    parsed = parseArguments(arguments_);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (!parsed) {
    console.log(usage);
    return 0;
  }

  let result;
  try {
    result =
      parsed.command === "publish"
        ? publishSynopsis(parsed)
        : validateSynopsis(parsed);
  } catch (error) {
    console.error(
      `ERROR: unable to ${parsed.command} Synopsis: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    return 1;
  }

  if (parsed.command === "publish")
    console.log(`PUBLISHED: ${parsed.artifactPath} (${result.bytes} bytes)`);
  else console.log(`VALID: ${parsed.artifactPath} (${result.bytes} bytes)`);
  return 0;
}

const invokedPath = process.argv[1]
  ? fs.realpathSync(path.resolve(process.argv[1]))
  : undefined;
const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) process.exitCode = run(process.argv.slice(2));
