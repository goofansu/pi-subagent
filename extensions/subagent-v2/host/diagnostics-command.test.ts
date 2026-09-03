import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiProbeCounters } from "../backend/pi/index.ts";
import { createRuntimeCounters } from "../runtime/counters.ts";
import { hostRig } from "../testing/host-rig.ts";
import {
  DIAGNOSTICS_COMMAND_NAME,
  formatSessionDiagnostics,
  NO_LIVE_SESSION,
} from "./diagnostics-command.ts";

/**
 * The one command dogfood needs.
 *
 * What makes it worth having is that it reports *every* field, zeroes
 * included: a diagnostics command that hid its zeroes would make "is this
 * counter even wired up" unanswerable, which is the question a maintainer
 * actually has when a number they expected to move has not moved.
 */

/** Run the command's handler the way the host would, and read what it said. */
async function report(
  rig: ReturnType<typeof hostRig>,
): Promise<readonly string[]> {
  const command = rig.host
    .commands()
    .find((entry) => entry.name === DIAGNOSTICS_COMMAND_NAME);
  assert.ok(command, "the diagnostics command was not registered");
  const said: string[] = [];
  await command.handler("", {
    ui: {
      notify: (message: string) => {
        said.push(message);
      },
    },
  } as never);
  return said;
}

test("the report names every runtime counter and every probe field", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const [text] = await report(rig);

  // Every field the runtime keeps, so a counter that was never wired up is
  // visible as a zero rather than as an absence.
  for (const counter of Object.keys(createRuntimeCounters().counters())) {
    assert.match(text, new RegExp(`\\b${counter}: \\d`), counter);
  }
  for (const resource of Object.keys(createRuntimeCounters().probe())) {
    assert.match(text, new RegExp(`\\b${resource}: \\d`), resource);
  }
  assert.match(text, /Runtime counters:/);
  assert.match(text, /Runtime probe:/);
});

test("between Sessions the command says there is nothing to report", async (t) => {
  const rig = hostRig(t);

  const [text] = await report(rig);

  assert.equal(text, NO_LIVE_SESSION);
});

test("a backend probe is reported beside the runtime's own", () => {
  const held = createPiProbeCounters();
  held.acquired("openSessions");
  held.acquired("liveSubscriptions");

  const text = formatSessionDiagnostics({
    counters: { lateEvents: 2 },
    probe: { liveRunFibers: 0 },
    adapterProbe: { ...held.read() },
  });

  assert.equal(
    text,
    [
      "Runtime counters:",
      "  lateEvents: 2",
      "Runtime probe:",
      "  liveRunFibers: 0",
      "Backend probe:",
      "  openSessions: 1",
      "  liveSubscriptions: 1",
      "  pendingCleanups: 0",
    ].join("\n"),
  );
});

test("a set with no probe of its own reports the two runtime blocks alone", () => {
  assert.equal(
    formatSessionDiagnostics({ counters: {}, probe: {} }),
    ["Runtime counters:", "  (none)", "Runtime probe:", "  (none)"].join("\n"),
  );
});
