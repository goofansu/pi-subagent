import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const generated = mkdtempSync(path.join(tmpdir(), "codex-protocol-check-"));
const snapshotDirectory = path.join(repository, "docs", "codex-protocol");
const snapshotFiles = ["ClientRequest.json", "ServerNotification.json"];

function requireContract(condition, message) {
  if (!condition) throw new Error(`generated Codex protocol ${message}`);
}

function methodNames(schema) {
  return new Set(
    (schema.oneOf ?? []).flatMap(
      (variant) => variant.properties?.method?.enum ?? [],
    ),
  );
}

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

  const clientRequests = JSON.parse(
    readFileSync(path.join(generated, "ClientRequest.json"), "utf8"),
  );
  const requestMethods = methodNames(clientRequests);
  for (const method of [
    "initialize",
    "thread/start",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "thread/list",
    "thread/read",
  ])
    requireContract(requestMethods.has(method), `is missing ${method}`);
  requireContract(
    clientRequests.definitions?.ThreadStartParams?.properties?.ephemeral?.type?.includes(
      "boolean",
    ),
    "thread/start no longer supports ephemeral",
  );

  const threadStart = JSON.parse(
    readFileSync(path.join(generated, "v2/ThreadStartResponse.json"), "utf8"),
  );
  const thread = threadStart.definitions?.Thread;
  requireContract(
    thread?.properties?.path?.type?.includes("null"),
    "thread/start response cannot report pathlessness",
  );
  requireContract(
    thread?.properties?.ephemeral?.type === "boolean" &&
      thread.required?.includes("ephemeral"),
    "thread/start response does not identify ephemeral threads",
  );

  const turnStart = JSON.parse(
    readFileSync(path.join(generated, "v2/TurnStartResponse.json"), "utf8"),
  );
  requireContract(
    turnStart.definitions?.Turn?.properties?.id?.type === "string",
    "turn/start response no longer carries a Turn identity",
  );

  const serverNotifications = JSON.parse(
    readFileSync(path.join(generated, "ServerNotification.json"), "utf8"),
  );
  const notificationMethods = methodNames(serverNotifications);
  for (const method of [
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/reasoning/summaryTextDelta",
    "thread/tokenUsage/updated",
    "turn/completed",
    "error",
  ])
    requireContract(notificationMethods.has(method), `is missing ${method}`);

  // The two documents that must name the pinned version, so a snapshot and the
  // prose describing it cannot drift apart. The second used to be the harness
  // definition-of-done, which the architecture note replaced at M7.
  for (const relativePath of [
    "docs/codex-protocol/README.md",
    "docs/architecture.md",
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
