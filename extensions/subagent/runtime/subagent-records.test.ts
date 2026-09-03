import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fiber } from "effect";
import { Effect, Scope } from "effect";
import type { BackendAgent } from "../backend/contract.ts";
import {
  backendId,
  runId as makeRunId,
  subagentId as makeSubagentId,
  type Profile,
  type RunId,
  type SubagentContext,
  type SubagentId,
} from "../domain/index.ts";
import type { RunHandle } from "./run-scope.ts";
import {
  makeSubagentRecords,
  type SubagentRecords,
} from "./subagent-records.ts";

/**
 * The Subagent records, on their own.
 *
 * These rules used to be enforced by seven field assignments at six call
 * sites in the supervisor, which meant they held because each caller was
 * careful. Here each one is a call against the module that owns the record, so
 * a failure names the rule rather than the operation that happened to break
 * it.
 *
 * The rule the module exists to state is contributing invariant 2: **one
 * Subagent owns at most one active Run.** It has always been true of this
 * codebase, and it was true nowhere in it — `attachRun` now says so, and the
 * test below is what proves it says so rather than merely intending to.
 */

const oneSubagent = makeSubagentId("subagent-1");
const otherSubagent = makeSubagentId("subagent-2");
const oneRun = makeRunId("run-1");
const otherRun = makeRunId("run-2");

const profile: Profile = {
  name: "explore",
  description: "look around",
  backend: backendId("fake-resumable"),
  fields: {},
  systemPrompt: "",
};

const context = (id: SubagentId): SubagentContext => ({
  subagentId: id,
  cwd: "/tmp",
  childDepth: 0,
  projectTrusted: true,
});

/**
 * A BackendAgent that never runs anything.
 *
 * The records module stores this and reads nothing out of it — the whole
 * point of the record is that the supervisor, not the records, decides what
 * to ask a BackendAgent — so a stand-in with the contract's four members says
 * more here than a real adapter would.
 */
const standInAgent = (): BackendAgent => ({
  capabilities: {
    resume: true,
    steer: true,
    terminalTranscriptSnapshot: false,
  },
  admitResume: () => "admitted",
  execute: () => Effect.die("the records module never runs a Subagent"),
  close: () => Effect.void,
});

/**
 * A Run Scope stand-in carrying the one field the records read.
 *
 * `byRun` is served by an index keyed on the handle's own Run id, so that is
 * the only thing the module ever looks at. Building a real Run Scope — an
 * intake, a reducer fiber, a mailbox, a coordinator — to test a map would be
 * testing the Run Scope.
 */
const standInHandle = (runId: RunId): RunHandle =>
  ({ identity: { runId } }) as unknown as RunHandle;

/** Likewise: the records hold a fiber for `closeSubagent` and never join it. */
const standInFiber = (): Fiber.Fiber<unknown, never> =>
  ({}) as Fiber.Fiber<unknown, never>;

/**
 * A records module with a Subagent inserted for each id given.
 *
 * The Scope is real, because a Subagent Scope is the one field with a lifetime
 * and a test that faked it would be free to forget it.
 */
function withRecords(ids: readonly SubagentId[]): Promise<{
  readonly records: SubagentRecords;
  readonly scopes: readonly Scope.Closeable[];
}> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const records = makeSubagentRecords();
      const scopes: Scope.Closeable[] = [];
      for (const id of ids) {
        const scope = yield* Scope.make();
        scopes.push(scope);
        records.insert({
          id,
          profile,
          context: context(id),
          agent: standInAgent(),
          scope,
        });
      }
      return { records, scopes };
    }),
  );
}

test("an inserted Subagent is running, has no Run, and holds its own facts", async () => {
  const { records, scopes } = await withRecords([oneSubagent]);
  const record = records.get(oneSubagent);

  // Running from the instant it exists: a Subagent is created because a start
  // was admitted for it, and there is no path that makes an idle one.
  assert.equal(record?.phase, "running");
  assert.equal(record?.run, undefined);
  assert.equal(record?.runFiber, undefined);
  assert.equal(record?.conversationLost, false);
  assert.equal(record?.profile.name, "explore");
  assert.equal(record?.scope, scopes[0]);
  assert.equal(records.get(otherSubagent), undefined);
});

test("attaching a Run makes it findable by Run id, and detaching makes it unfindable", async () => {
  const { records } = await withRecords([oneSubagent]);

  records.attachRun(oneSubagent, standInHandle(oneRun));
  const owner = records.byRun(oneRun);
  records.detachRun(oneSubagent);

  assert.equal(owner?.id, oneSubagent);
  // Exactly what the linear scan answered, for the same reason: only an
  // in-flight Run has an owner. A settled one and an id nothing ever had are
  // the same answer here, because the question is "who is running this".
  assert.equal(records.byRun(oneRun), undefined);
  assert.equal(records.byRun(otherRun), undefined);
});

test("attaching a second Run to a Subagent that has one is a defect", async () => {
  const { records } = await withRecords([oneSubagent]);
  records.attachRun(oneSubagent, standInHandle(oneRun));

  // Not a silent overwrite. An overwrite would leave the first Run's handle
  // unreachable while its fiber was still settling, which is a lost Run — so
  // this is the one place invariant 2 is asserted rather than assumed.
  assert.throws(
    () => records.attachRun(oneSubagent, standInHandle(otherRun)),
    /already has an active Run/,
  );
  assert.equal(records.byRun(oneRun)?.id, oneSubagent);
  assert.equal(records.byRun(otherRun), undefined);
});

test("a Subagent whose Run detaches goes idle, and one that was closed stays closed", async () => {
  const { records } = await withRecords([oneSubagent, otherSubagent]);
  records.attachRun(oneSubagent, standInHandle(oneRun));
  records.attachRun(otherSubagent, standInHandle(otherRun));
  records.attachFiber(oneSubagent, standInFiber());

  records.detachRun(oneSubagent);
  // Closed first, then the Run ends: the ordering `closeSubagent` depends on,
  // because a late settlement must never move a closed Subagent back to idle.
  records.markClosed(otherSubagent);
  records.detachRun(otherSubagent);

  assert.equal(records.get(oneSubagent)?.phase, "idle");
  assert.equal(records.get(oneSubagent)?.run, undefined);
  assert.equal(records.get(oneSubagent)?.runFiber, undefined);
  assert.equal(records.get(otherSubagent)?.phase, "closed");
});

test("a detached Subagent can take another Run, which is what resume does", async () => {
  const { records } = await withRecords([oneSubagent]);

  records.attachRun(oneSubagent, standInHandle(oneRun));
  records.detachRun(oneSubagent);
  records.attachRun(oneSubagent, standInHandle(otherRun));

  assert.equal(records.get(oneSubagent)?.phase, "running");
  assert.equal(records.byRun(otherRun)?.id, oneSubagent);
  assert.equal(records.byRun(oneRun), undefined);
});

test("markClosed is true for the first caller only", async () => {
  const { records } = await withRecords([oneSubagent]);

  assert.equal(records.markClosed(oneSubagent), true);
  assert.equal(records.markClosed(oneSubagent), false);
  assert.equal(records.markClosed(oneSubagent), false);
  // Shutdown and an explicit close can reach the same Subagent, and the
  // caller that gets `true` is the one that cancels its Run and closes its
  // Scope. A second `true` would close a Scope twice.
  assert.equal(records.markClosed(otherSubagent), false);
});

test("a lost conversation is recorded on the record, so a later resume is honest", async () => {
  const { records } = await withRecords([oneSubagent]);

  assert.equal(records.get(oneSubagent)?.conversationLost, false);
  records.markConversationLost(oneSubagent);
  records.markConversationLost(oneSubagent);

  assert.equal(records.get(oneSubagent)?.conversationLost, true);
});

test("all preserves insertion order, which is what shutdown reverses", async () => {
  const third = makeSubagentId("subagent-3");
  const { records } = await withRecords([oneSubagent, otherSubagent, third]);

  const order = records.all().map((record) => record.id);
  records.clear();

  assert.deepEqual(order, [oneSubagent, otherSubagent, third]);
  // Shutdown closes the newest Subagent first, which is what closing the
  // Session Scope would do on its own — so the order this returns is load
  // bearing rather than incidental.
  assert.deepEqual(records.all(), []);
  assert.equal(records.get(oneSubagent), undefined);
});

test("a Run detaching after the records were cleared changes nothing", async () => {
  const { records } = await withRecords([oneSubagent]);
  records.attachRun(oneSubagent, standInHandle(oneRun));

  records.clear();
  // Shutdown clears the records, and a Run fiber whose finalizer is still in
  // flight will call this afterwards. It is the reason a mutation of an
  // unknown Subagent is quiet rather than a defect.
  records.detachRun(oneSubagent);
  records.markConversationLost(oneSubagent);

  assert.equal(records.byRun(oneRun), undefined);
  assert.equal(records.get(oneSubagent), undefined);
});
