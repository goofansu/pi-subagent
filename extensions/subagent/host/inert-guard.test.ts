import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPTH_ENV_KEY, withChildResourceLoad } from "../backend/pi/index.ts";
import { installSubagentV2 } from "../index.ts";
import { hostRig, startedIds } from "../testing/host-rig.ts";
import { piRigRequest, withPiSession } from "../testing/pi/pi-rig.ts";
import { createStandInHost } from "../testing/stand-in-host.ts";
import { createPiBackendSet } from "./pi-backends.ts";
import { SUBAGENT_TOOL_NAMES } from "./tools.ts";

/**
 * Inert inside a child, and honest about how deep it is.
 *
 * Two different guards, and both matter. The **registration** guard is what
 * stops a child's model from ever seeing the delegation tools: a model shown
 * six tools will try to use them, and being refused six times is worse than
 * never being offered. The **admission** guard is the backstop for a direct
 * call, and until M4 it was unreachable because the host reported a constant
 * depth of zero.
 *
 * Both facts come from the backend set, because only a backend knows how a
 * child of its own processes reports itself. The boundary test proves the host
 * imports no adapter module to find out.
 */

test("a process the backend set calls a child registers nothing at all", () => {
  const host = createStandInHost();
  const rig = hostRig({ after: () => {} }, { childLoad: true });

  const installation = installSubagentV2(host.pi, {
    agentDir: rig.agentsDir,
    backendSet: () => ({
      backends: [],
      profiles: [],
      isChildLoad: () => true,
      childDepth: () => 0,
    }),
  });

  assert.deepEqual(host.tools(), []);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.renderers(), []);
  assert.deepEqual(host.subscribed(), []);
  assert.deepEqual(installation.profiles(), []);
  assert.equal(installation.widget(), undefined);
});

test("a process the backend set reports as nested registers nothing at all", () => {
  const host = createStandInHost();

  installSubagentV2(host.pi, {
    agentDir: "/nowhere",
    backendSet: () => ({
      backends: [],
      profiles: [],
      isChildLoad: () => false,
      childDepth: () => 1,
    }),
  });

  assert.deepEqual(host.tools(), []);
  assert.deepEqual(host.subscribed(), []);
});

test("a parent process registers everything", () => {
  const host = createStandInHost();

  installSubagentV2(host.pi, {
    agentDir: "/nowhere",
    backendSet: () => ({
      backends: [],
      profiles: [],
      isChildLoad: () => false,
      childDepth: () => 0,
    }),
  });

  assert.deepEqual(
    host.tools().map((tool) => tool.name),
    [...SUBAGENT_TOOL_NAMES],
  );
});

// ── What the Pi set actually answers ─────────────────────────────────────────

test("the Pi set says this is a child's load only inside the discriminator", () => {
  const outside = createPiBackendSet().set;
  assert.equal(outside.isChildLoad(), false);

  withChildResourceLoad(() => {
    // Built inside the load chain a child's resource discovery runs in, which
    // is the window where the extensions override has not been applied yet.
    assert.equal(createPiBackendSet().set.isChildLoad(), true);
  });

  assert.equal(outside.isChildLoad(), false);
});

test("the Pi set reads the depth a parent put in the environment", (t) => {
  const before = process.env[DEPTH_ENV_KEY];
  t.after(() => {
    if (before === undefined) delete process.env[DEPTH_ENV_KEY];
    else process.env[DEPTH_ENV_KEY] = before;
  });

  delete process.env[DEPTH_ENV_KEY];
  assert.equal(createPiBackendSet().set.childDepth(), 0);

  process.env[DEPTH_ENV_KEY] = "1";
  assert.equal(createPiBackendSet().set.childDepth(), 1);
});

test("the Pi set supplies one backend and no Profiles of its own", () => {
  const set = createPiBackendSet().set;

  assert.equal(set.backends.length, 1);
  assert.equal(set.backends[0]?.id, "pi");
  // A Pi Profile is the user's own specialist. Inventing one here would put a
  // specialist nobody wrote into every Session's `/agents` list.
  assert.deepEqual(set.profiles, []);
});

// ── Admission enforces the depth ─────────────────────────────────────────────

test("a start already at the maximum depth is refused by admission", async () => {
  // The registration guard means a real child never reaches this, which is
  // the point of having both: this is the backstop for a direct call, and
  // until the host read the real depth it was unreachable and therefore
  // untested. A Session at depth one would ask for a Run at depth two.
  const { value } = await withPiSession({}, (rig) =>
    rig.supervisor.start(piRigRequest({ childDepth: 2 })),
  );

  assert.equal(value.outcome, "delegation-depth exceeded");
  if (value.outcome !== "delegation-depth exceeded") return;
  assert.equal(value.depth, 2);
});

test("a start from a parent process is admitted", async (t) => {
  const rig = hostRig(t);
  await rig.host.sessionStart();
  t.after(() => rig.installation.handle.release());

  const started = startedIds(
    await rig.text("agent_start", {
      agent: "explore",
      description: "look around",
      prompt: "have a look",
    }),
  );

  assert.match(started.runId, /run-/);
});
