import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertRetainedReleaseEvidence } from "./codex-retained-release-contract.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const protocolOutput = execFileSync(
  process.execPath,
  [path.join(repository, "scripts", "check-codex-protocol.mjs")],
  { cwd: repository, encoding: "utf8" },
);
if (!protocolOutput.includes("CODEX_PROTOCOL_CHECK_PASS"))
  throw new Error("pinned Codex protocol check did not pass");

const cliVersion = execFileSync("codex", ["--version"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const evidence = readFileSync(
  path.join(repository, "docs", "codex-desktop-coexistence-release.md"),
  "utf8",
);
const record = assertRetainedReleaseEvidence(evidence, cliVersion);
const smokeLogPath = path.isAbsolute(record.smokeLog)
  ? record.smokeLog
  : path.join(repository, record.smokeLog);
const smokeLog = readFileSync(smokeLogPath, "utf8");
// The v2 runtime gate's own lines, verbatim. A log that does not carry them
// is a log of some other run, and the point of reading the log at all is that
// a record's `PASS` is a human's summary of it.
for (const required of [
  "V2_CODEX_LIVE_SMOKE_PASS",
  "the retained root is neither listed nor readable by a second App Server",
  "no App Server child remains after closure",
]) {
  if (!smokeLog.includes(required))
    throw new Error(
      `retained smoke log is missing required evidence: ${required}`,
    );
}
// Either the descendants that were observed are gone, or none was observed
// and the gate said so. An unexercised check must never read as a passing one.
if (
  !smokeLog.includes(
    "all observed App Server descendants are gone after closure",
  ) &&
  !smokeLog.includes(
    "no persistent App Server descendants were observed before closure",
  )
)
  throw new Error("retained smoke log is missing descendant cleanup evidence");
console.log(`CODEX_RETAINED_RELEASE_CHECK_PASS — ${cliVersion}`);
