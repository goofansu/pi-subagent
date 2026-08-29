import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const generated = mkdtempSync(path.join(tmpdir(), "codex-protocol-check-"));
const snapshotDirectory = path.join(repository, "docs", "codex-protocol");
const snapshotFiles = ["ClientRequest.json", "ServerNotification.json"];

try {
  const version = execFileSync("codex", ["--version"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  execFileSync(
    "codex",
    ["app-server", "generate-json-schema", "--out", generated],
    { cwd: repository, stdio: "inherit" },
  );

  const drift = snapshotFiles.filter(
    (file) =>
      !readFileSync(path.join(generated, file)).equals(
        readFileSync(path.join(snapshotDirectory, file)),
      ),
  );
  if (drift.length > 0) {
    throw new Error(
      `generated Codex protocol differs from the vendored snapshot: ${drift.join(", ")}`,
    );
  }

  for (const relativePath of [
    "docs/codex-protocol/README.md",
    "docs/harness-definition-of-done.md",
  ]) {
    const contents = readFileSync(path.join(repository, relativePath), "utf8");
    if (!contents.includes(version)) {
      throw new Error(`${relativePath} is not pinned to ${version}`);
    }
  }
  console.log(`CODEX_PROTOCOL_CHECK_PASS — ${version}`);
} finally {
  rmSync(generated, { recursive: true, force: true });
}
