/**
 * `ResultStore`: the authoritative home of every terminal Run's output.
 *
 * Three properties make this store different from a map, and each one exists
 * because of a way the obvious implementation goes wrong:
 *
 * - **Commit is idempotent by Run id.** The settlement path may be retried,
 *   and a store that took the second commit would let one Run have two
 *   results. A second commit of the same result returns the stored one and
 *   counts a duplicate; a *different* result under the same id is a defect —
 *   the first one stands and the store says so.
 * - **Capacity is reserved at admission, not discovered at settlement.** A Run
 *   whose result could never be stored must be rejected before it starts, not
 *   after it has spent a provider's quota. `reserve` is what makes
 *   `at capacity` an honest answer.
 * - **A result is pinned until everyone who was promised it has read it.**
 *   Eviction is oldest-first, and without pins the oldest could be the one a
 *   waiter registered at settlement is about to read.
 *
 * Results are held **encoded**, and `read` decodes. That costs a pass on every
 * read and buys two things: the round trip is exercised constantly rather than
 * in one test, and a value that could not be encoded never enters the store,
 * so provider vocabulary cannot be persisted by accident.
 */

import { Context, Effect, Layer, Ref, Schema } from "effect";
import {
  boundResultToBytes,
  byteLength,
  EXACT_KEYS,
  type RunDiagnostic,
  type RunId,
  RunResult,
  runDiagnostic,
  type SubagentId,
  type TerminalRunPhase,
} from "../domain/index.ts";
import type { RuntimeCounters } from "./counters.ts";
import type { RuntimePolicy } from "./policy.ts";

const encodeResult = Schema.encodeUnknownSync(RunResult);
const decodeResult = Schema.decodeUnknownResult(RunResult, EXACT_KEYS);

/**
 * Who is still holding a result open.
 *
 * Three named holders rather than a count, so a release cannot be attributed
 * to the wrong one and a double release cannot free a pin twice.
 */
export const PIN_HOLDERS = ["publication", "waiters", "delivery"] as const;

export type PinHolder = (typeof PIN_HOLDERS)[number];

/**
 * One entry, which outlives its output.
 *
 * Eviction removes the output and keeps the entry, because operation semantics
 * section 8 says a spent identifier and a wrong identifier are different
 * mistakes and get different answers. Without the entry there would be nothing
 * to answer `ResultExpired` with.
 */
interface StoredEntry {
  readonly runId: RunId;
  readonly subagentId: SubagentId;
  readonly status: TerminalRunPhase;
  /** Encoded JSON. Absent once evicted. */
  readonly encoded?: string;
  readonly bytes: number;
  /** Commit order, so eviction can take the oldest without reading a clock. */
  readonly sequence: number;
  readonly pins: ReadonlySet<PinHolder>;
  /** Whether this stored form has already counted as unreadable. */
  readonly unreadableObserved?: boolean;
}

export type ResultRead =
  | { readonly outcome: "result"; readonly result: RunResult }
  | {
      readonly outcome: "ResultExpired";
      readonly runId: RunId;
      readonly subagentId: SubagentId;
      readonly status: TerminalRunPhase;
    }
  | { readonly outcome: "unknown Run"; readonly runId: RunId }
  /**
   * A stored value that will not decode.
   *
   * A visible defect rather than an empty result: the alternative is a caller
   * being told a Run produced nothing when what actually happened is that the
   * store and the schema disagree.
   */
  | {
      readonly outcome: "defect";
      readonly runId: RunId;
      readonly diagnostic: RunDiagnostic;
    };

export interface ResultStoreEncodingFailure {
  readonly _tag: "ResultStoreEncodingFailure";
  readonly diagnostic: RunDiagnostic;
}

/** Fault-injection seam around the schema encoder; production uses `encode`. */
export type ResultEncoder = (
  result: RunResult,
  encode: (result: RunResult) => unknown,
) => unknown;

export type CommitOutcome =
  | { readonly outcome: "stored"; readonly result: RunResult }
  /** The same result was already there. Nothing changed. */
  | { readonly outcome: "duplicate"; readonly result: RunResult }
  /**
   * A *different* result arrived under an id that already has one. The first
   * one stands, because a settled Run's result is immutable.
   */
  | {
      readonly outcome: "conflict";
      readonly result: RunResult;
      readonly diagnostic: RunDiagnostic;
    };

interface StoreState {
  readonly entries: ReadonlyMap<RunId, StoredEntry>;
  readonly reservations: ReadonlyMap<RunId, number>;
  readonly sequence: number;
}

const EMPTY_STATE: StoreState = {
  entries: new Map(),
  reservations: new Map(),
  sequence: 0,
};

/** Reserved plus stored, which is what the budget is measured against. */
function committedBytes(state: StoreState): number {
  let total = 0;
  for (const size of state.reservations.values()) total += size;
  for (const entry of state.entries.values()) total += entry.bytes;
  return total;
}

/**
 * Free space by evicting the oldest unpinned output, never the newest.
 *
 * "Never the newest" is a rule about the *just committed* result specifically:
 * a store that evicted what it had just been given would make committing
 * pointless. It falls out of the pin the commit itself takes.
 */
function evict(
  state: StoreState,
  budget: number,
  counters: RuntimeCounters,
): StoreState {
  let current = state;
  while (committedBytes(current) > budget) {
    const candidates = [...current.entries.values()]
      .filter((entry) => entry.encoded !== undefined && entry.pins.size === 0)
      .sort((left, right) => left.sequence - right.sequence);
    const oldest = candidates[0];
    if (!oldest) break;
    const entries = new Map(current.entries);
    const { encoded: _dropped, ...kept } = oldest;
    entries.set(oldest.runId, { ...kept, bytes: 0 });
    current = { ...current, entries };
    counters.count("evictions");
  }
  return current;
}

const makeStore = (
  policy: RuntimePolicy,
  counters: RuntimeCounters,
  resultEncoder: ResultEncoder,
) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(EMPTY_STATE);

    /**
     * Take the room one result could need.
     *
     * Reserving the maximum rather than the eventual size is the whole point:
     * the eventual size is not known until the Run has finished, and by then
     * refusing to store it would be too late for anyone.
     */
    const reserve = (runId: RunId): Effect.Effect<boolean> =>
      Ref.modify(state, (current) => {
        if (current.reservations.has(runId)) return [true, current];
        const wanted = policy.maxResultBytes;
        const take = (state: StoreState): [boolean, StoreState] => {
          const reservations = new Map(state.reservations);
          reservations.set(runId, wanted);
          return [true, { ...state, reservations }];
        };
        if (policy.resultStoreBytes - committedBytes(current) >= wanted) {
          return take(current);
        }
        // Not enough room, so make some: evict the oldest *unpinned* stored
        // output until one reservation fits.
        //
        // The alternative was to refuse, on the grounds that a stored result
        // is one somebody may still ask for. That reasoning does not survive
        // being run for long: nothing else in a Session ever frees a stored
        // result, so a Session whose history grew to just inside the budget
        // would answer `at capacity` to every later start, permanently, with
        // unpinned results sitting there that nobody was going to read. A
        // capacity answer is about how much is happening *now*; a Session's
        // own history is not a reason to refuse the next Run, and an evicted
        // result already has an honest public outcome of its own.
        //
        // Pins are still absolute, and that is what keeps this from being a
        // way around the budget: a result being delivered or read is not
        // evictable, so a store whose every entry is pinned still refuses.
        const freed = evict(
          current,
          policy.resultStoreBytes - wanted,
          counters,
        );
        return policy.resultStoreBytes - committedBytes(freed) >= wanted
          ? take(freed)
          : [false, freed];
      });

    const release = (runId: RunId): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        if (!current.reservations.has(runId)) return current;
        const reservations = new Map(current.reservations);
        reservations.delete(runId);
        return { ...current, reservations };
      });

    const commit = (
      result: RunResult,
    ): Effect.Effect<CommitOutcome, ResultStoreEncodingFailure> =>
      Effect.try({
        // Bounding happens outside the atomic update because it encodes, and
        // a `Ref.modify` should not do arbitrary work. The result is already
        // immutable, so nothing can change underneath.
        try: () => {
          const bounded = boundResultToBytes(result, policy.maxResultBytes);
          const encoded = JSON.stringify(
            resultEncoder(bounded.result, encodeResult),
          );
          if (encoded === undefined)
            throw new Error("encoder returned undefined");
          return {
            bounded: bounded.result,
            encoded,
            bytes: byteLength(encoded),
          };
        },
        catch: (): ResultStoreEncodingFailure => ({
          _tag: "ResultStoreEncodingFailure",
          diagnostic: runDiagnostic(
            "other",
            "the Result could not be encoded for storage",
          ),
        }),
      }).pipe(
        Effect.flatMap(({ bounded, encoded, bytes }) =>
          Ref.modify(state, (current) => {
            const existing = current.entries.get(bounded.runId);
            if (existing) {
              // Once output was evicted there are no bytes left to compare.
              // The id proves this is a re-commit, and immutability means it is
              // a duplicate rather than evidence of a conflicting value.
              const same =
                existing.encoded === undefined || existing.encoded === encoded;
              counters.count(same ? "duplicateCommits" : "conflictingCommits");
              const stored =
                existing.encoded === undefined
                  ? bounded
                  : (readEntry(existing) ?? bounded);
              const outcome: CommitOutcome = same
                ? { outcome: "duplicate", result: stored }
                : {
                    outcome: "conflict",
                    result: stored,
                    diagnostic: runDiagnostic(
                      "other",
                      `a second, different result was committed for ${bounded.runId}`,
                    ),
                  };
              return [outcome, current];
            }

            const sequence = current.sequence + 1;
            const entries = new Map(current.entries);
            entries.set(bounded.runId, {
              runId: bounded.runId,
              subagentId: bounded.subagentId,
              status: bounded.status,
              encoded,
              bytes,
              sequence,
              // Pinned by every holder at once. Each releases when it is done,
              // and only then can eviction reach this result.
              pins: new Set(PIN_HOLDERS),
            });
            const reservations = new Map(current.reservations);
            reservations.delete(bounded.runId);
            const stored = evict(
              { ...current, entries, reservations, sequence },
              policy.resultStoreBytes,
              counters,
            );
            return [
              { outcome: "stored", result: bounded } as CommitOutcome,
              stored,
            ];
          }),
        ),
      );

    /**
     * Keep the terminal identity when even the failed fallback cannot encode.
     *
     * This is the same representation eviction leaves behind: metadata only,
     * never an unencoded Result. Recording is idempotent and cannot replace
     * output that a successful commit already stored.
     */
    const recordOutputGone = (result: RunResult): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        if (current.entries.has(result.runId)) return current;
        const sequence = current.sequence + 1;
        const entries = new Map(current.entries);
        entries.set(result.runId, {
          runId: result.runId,
          subagentId: result.subagentId,
          status: result.status,
          bytes: 0,
          sequence,
          pins: new Set(),
        });
        const reservations = new Map(current.reservations);
        reservations.delete(result.runId);
        counters.count("unreadableResults");
        return { ...current, entries, reservations, sequence };
      });

    const releasePin = (runId: RunId, holder: PinHolder): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        const entry = current.entries.get(runId);
        if (!entry?.pins.has(holder)) return current;
        const pins = new Set(entry.pins);
        pins.delete(holder);
        const entries = new Map(current.entries);
        entries.set(runId, { ...entry, pins });
        // Releasing a pin can put the store back inside its budget's reach,
        // so this is the other moment eviction becomes possible.
        return evict(
          { ...current, entries },
          policy.resultStoreBytes,
          counters,
        );
      });

    const read = (runId: RunId): Effect.Effect<ResultRead> =>
      Effect.gen(function* () {
        const observed = yield* Ref.modify(state, (current) => {
          const entry = current.entries.get(runId);
          if (!entry) {
            return [
              {
                read: { outcome: "unknown Run", runId } as ResultRead,
                countUnreadable: false,
              },
              current,
            ];
          }
          if (entry.encoded === undefined) {
            return [
              {
                read: {
                  outcome: "ResultExpired",
                  runId,
                  subagentId: entry.subagentId,
                  status: entry.status,
                } as ResultRead,
                countUnreadable: false,
              },
              current,
            ];
          }
          const decoded = readEntry(entry);
          if (decoded) {
            return [
              {
                read: { outcome: "result", result: decoded } as ResultRead,
                countUnreadable: false,
              },
              current,
            ];
          }

          const read: ResultRead = {
            outcome: "defect",
            runId,
            diagnostic: runDiagnostic(
              "other",
              `the stored result for ${runId} does not decode`,
            ),
          };
          if (entry.unreadableObserved) {
            return [{ read, countUnreadable: false }, current];
          }
          const entries = new Map(current.entries);
          entries.set(runId, { ...entry, unreadableObserved: true });
          return [
            { read, countUnreadable: true },
            { ...current, entries },
          ];
        });
        if (observed.countUnreadable) counters.count("unreadableResults");
        return observed.read;
      });

    return {
      reserve,
      release,
      commit,
      recordOutputGone,
      releasePin,
      read,

      /** Whether an id has an entry at all, evicted or not. */
      has: (runId: RunId): Effect.Effect<boolean> =>
        Effect.map(Ref.get(state), (current) => current.entries.has(runId)),

      /**
       * Every entry that still holds its output, oldest first.
       *
       * An evicted entry is deliberately not in this list: it is still
       * addressable by id, but there is nothing left to read, and a delivery
       * sweep that treated it as deliverable would announce a Run whose
       * preview it cannot build.
       */
      stored: (): Effect.Effect<readonly RunId[]> =>
        Effect.map(Ref.get(state), (current) =>
          [...current.entries.values()]
            .filter((entry) => entry.encoded !== undefined)
            .sort((left, right) => left.sequence - right.sequence)
            .map((entry) => entry.runId),
        ),

      pinsOf: (runId: RunId): Effect.Effect<readonly PinHolder[]> =>
        Effect.map(Ref.get(state), (current) => [
          ...(current.entries.get(runId)?.pins ?? []),
        ]),

      /** Reserved plus stored. A test asserts this never exceeds the budget. */
      accountedBytes: (): Effect.Effect<number> =>
        Effect.map(Ref.get(state), committedBytes),

      /**
       * Forget everything, at shutdown.
       *
       * The next Session's model did not start these Runs and has no context
       * in which to act on their answers. Operation semantics section 5.
       */
      clear: (): Effect.Effect<void> => Ref.set(state, EMPTY_STATE),
    };
  });

/** Decode one entry, or `undefined` if the stored form is not readable. */
function readEntry(entry: StoredEntry): RunResult | undefined {
  if (entry.encoded === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.encoded);
  } catch {
    return undefined;
  }
  const decoded = decodeResult(parsed);
  return decoded._tag === "Success" ? decoded.success : undefined;
}

export type ResultStoreApi = Effect.Success<ReturnType<typeof makeStore>>;

export class ResultStore extends Context.Service<ResultStore, ResultStoreApi>()(
  "pi-subagent/runtime/ResultStore",
) {
  static layerOf(
    policy: RuntimePolicy,
    counters: RuntimeCounters,
    resultEncoder: ResultEncoder = (result, encode) => encode(result),
  ): Layer.Layer<ResultStore> {
    return Layer.effect(
      ResultStore,
      Effect.map(makeStore(policy, counters, resultEncoder), (api) =>
        ResultStore.of(api),
      ),
    );
  }
}
