/**
 * The supervisor's records: what it knows about each Subagent it owns, and the
 * only writer of any of it.
 *
 * **Not a registry.** The glossary lists *Registry* as a retired 1.x term for
 * `SubagentRuns`, which held live-display Runs and handed out write access to
 * them; the `RunRepository` replaced it and hands out none. The
 * historical-terms section exists so that a plan written in the old words is
 * still readable, and giving a new module a retired word would make that
 * section lie. The glossary already calls these the supervisor's records.
 *
 * **What one record is.** A Subagent is a stable logical specialist: a fixed
 * Profile, a retained BackendAgent, and a Scope that owns it for the
 * Subagent's whole life. Those four facts never change. What changes is where
 * the Subagent is — running or idle or closed — which Run it currently has,
 * which fiber is settling that Run, and whether its Conversation is gone.
 *
 * **Why the module is the only writer.** Contributing invariant 2 says one
 * Subagent owns at most one active Run. Before this module that was true
 * because seven assignments at six call sites each got it right, which is a
 * property held by care rather than by construction. Here `attachRun` asserts
 * it where the record lives: a second Run attached to a Subagent that has one
 * is a defect, because an overwrite would leave the first Run's handle
 * unreachable while its fiber was still settling. The assertion states a
 * property that already holds — it fires on no path that exists — which is
 * exactly why it is worth writing down.
 *
 * The public record type makes every changing field `readonly`, so a caller
 * that assigns one fails to compile rather than failing a review. The values
 * handed out are the live records rather than copies, so a caller that read a
 * record before the module attached a Run reads the attachment.
 *
 * [ADR-0034](../../../docs/adr/0034-supervisor-mechanisms-admission-lease-and-subagent-records.md)
 * is the decision.
 */

import type { Fiber, Scope } from "effect";
import type { BackendAgent } from "../backend/contract.ts";
import type {
  Profile,
  RunId,
  SubagentContext,
  SubagentId,
  SubagentPhase,
} from "../domain/index.ts";
import type { RunHandle } from "./run-scope.ts";

/** The four facts a Subagent is created from, and never changes. */
export interface SubagentFacts {
  readonly id: SubagentId;
  readonly profile: Profile;
  readonly context: SubagentContext;
  readonly agent: BackendAgent;
  readonly scope: Scope.Closeable;
}

/** One Subagent: a fixed Profile, a retained BackendAgent, and a scope. */
export interface SubagentRecord extends SubagentFacts {
  readonly phase: SubagentPhase;
  /**
   * Whether this Subagent's Conversation is gone.
   *
   * Tracked here as well as in the adapter because cleanup escalation is a
   * *core* decision: when a finalizer outlives its budget the core closes the
   * BackendAgent out from under it, and a later resume has to report that
   * honestly rather than discovering it at the provider.
   */
  readonly conversationLost: boolean;
  /** The Run currently in flight, if any. */
  readonly run?: RunHandle;
  /** The fiber settling that Run, so a close can wait for it. */
  readonly runFiber?: Fiber.Fiber<unknown, never>;
}

export interface SubagentRecords {
  /**
   * Take a Subagent's fixed facts and start its record.
   *
   * A Subagent exists because a start was admitted for it, so the record
   * begins `running`; nothing here creates an idle Subagent.
   */
  readonly insert: (facts: SubagentFacts) => SubagentRecord;
  readonly get: (id: SubagentId) => SubagentRecord | undefined;
  /** The Subagent whose Run this is, if that Run is in flight right now. */
  readonly byRun: (runId: RunId) => SubagentRecord | undefined;
  /** The Subagent is running this Run. A second one is a defect. */
  readonly attachRun: (id: SubagentId, handle: RunHandle) => void;
  readonly attachFiber: (
    id: SubagentId,
    fiber: Fiber.Fiber<unknown, never>,
  ) => void;
  /** The Run is over: idle, unless the Subagent was closed meanwhile. */
  readonly detachRun: (id: SubagentId) => void;
  readonly markConversationLost: (id: SubagentId) => void;
  /** True for the first caller only; a closed Subagent admits nothing. */
  readonly markClosed: (id: SubagentId) => boolean;
  /** In insertion order, which is the order shutdown reverses. */
  readonly all: () => readonly SubagentRecord[];
  readonly clear: () => void;
}

/** The same record, from the inside, where the changing fields are writable. */
interface MutableRecord extends SubagentFacts {
  phase: SubagentPhase;
  conversationLost: boolean;
  run?: RunHandle;
  runFiber?: Fiber.Fiber<unknown, never>;
}

export function makeSubagentRecords(): SubagentRecords {
  /** Insertion-ordered, because `Map` is and shutdown depends on it. */
  const records = new Map<SubagentId, MutableRecord>();
  /**
   * Run id to owner, maintained by `attachRun` and `detachRun`.
   *
   * This replaces a linear scan over every record the Session ever created,
   * and answers the same question for the same reason: a Run has an owner for
   * exactly as long as it is in flight, so an entry exists for exactly that
   * long. A settled Run and an id nothing ever had get one answer, which is
   * what the scan gave them too.
   */
  const owners = new Map<RunId, SubagentId>();

  return {
    insert: (facts) => {
      const record: MutableRecord = {
        ...facts,
        phase: "running",
        conversationLost: false,
      };
      records.set(facts.id, record);
      return record;
    },
    get: (id) => records.get(id),
    byRun: (runId) => {
      const owner = owners.get(runId);
      return owner === undefined ? undefined : records.get(owner);
    },
    attachRun: (id, handle) => {
      // Quiet for a Subagent this module does not have, as every mutation
      // below is: shutdown clears the records while a Run fiber's finalizer
      // may still be in flight, and that finalizer detaches.
      const record = records.get(id);
      if (!record) return;
      if (record.run !== undefined) {
        throw new Error(
          `${id} already has an active Run (${record.run.identity.runId}); a Subagent owns at most one`,
        );
      }
      record.run = handle;
      record.phase = "running";
      owners.set(handle.identity.runId, id);
    },
    attachFiber: (id, fiber) => {
      const record = records.get(id);
      if (record) record.runFiber = fiber;
    },
    detachRun: (id) => {
      const record = records.get(id);
      if (!record) return;
      const runId = record.run?.identity.runId;
      if (runId !== undefined) owners.delete(runId);
      record.run = undefined;
      record.runFiber = undefined;
      // A Subagent closed while its Run was settling stays closed. From the
      // instant it was marked it admits no new Run, and a late settlement
      // must not be able to hand it back.
      record.phase = record.phase === "closed" ? "closed" : "idle";
    },
    markConversationLost: (id) => {
      const record = records.get(id);
      if (record) record.conversationLost = true;
    },
    markClosed: (id) => {
      const record = records.get(id);
      if (!record || record.phase === "closed") return false;
      record.phase = "closed";
      return true;
    },
    all: () => [...records.values()],
    clear: () => {
      records.clear();
      owners.clear();
    },
  };
}
