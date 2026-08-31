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
for (const required of [
  "CODEX_RESUME_LIVE_SMOKE_PASS",
  "Session shutdown closes retained App Server stdio",
  "the retained App Server is gone after Session shutdown",
]) {
  if (!smokeLog.includes(required))
    throw new Error(
      `retained smoke log is missing required evidence: ${required}`,
    );
}
if (
  !smokeLog.includes(
    "all observed App Server descendants are gone after Session shutdown",
  ) &&
  !smokeLog.includes(
    "no persistent App Server descendants were observed after thread start",
  )
)
  throw new Error("retained smoke log is missing descendant cleanup evidence");
console.log(`CODEX_RETAINED_RELEASE_CHECK_PASS — ${cliVersion}`);
