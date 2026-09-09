/** Private process guard for the locked-SDK reproduction test. Never spawns work.
 * Kept outside extensions/, where even importing the process API is forbidden.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import type { TestContext } from "node:test";

export function denySdkExternalIO(t: TestContext) {
  const attempts: string[] = [];
  const deny = (name: string) => () => {
    attempts.push(name);
    throw new Error(`Unexpected external I/O: ${name}`);
  };
  t.mock.method(globalThis, "fetch", deny("fetch"));
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  t.mock.method(http, "request", deny("http.request"));
  t.mock.method(https, "request", deny("https.request"));
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    t.mock.method(childProcess, name, deny(name));
  }
  // Explicit memory-only construction must not discover resources or persist data.
  for (const name of [
    "readFileSync",
    "writeFileSync",
    "readdirSync",
    "mkdirSync",
    "readFile",
    "writeFile",
    "readdir",
    "mkdir",
    "open",
    "openSync",
  ] as const) {
    t.mock.method(fs, name, deny(`fs.${name}`));
  }
  for (const name of [
    "readFile",
    "writeFile",
    "readdir",
    "mkdir",
    "open",
  ] as const) {
    t.mock.method(fs.promises, name, deny(`fs.promises.${name}`));
  }
  // SDK modules use named ESM imports too, not just the mutable default objects.
  syncBuiltinESMExports();
  return {
    attempts,
    restore: () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}
