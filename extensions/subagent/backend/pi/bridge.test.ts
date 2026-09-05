import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option } from "effect";
import { bridgeOverflowObservations } from "../native-bridge.ts";
import { createCallbackBridge } from "./bridge.ts";

test("a refused offer closes the bridge and preserves the overflow policy", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const bridge = yield* createCallbackBridge(1);
      const first = { kind: "activity" as const, activity: "first" };
      const refused = { kind: "activity" as const, activity: "refused" };

      assert.equal(bridge.offer(first), true);
      assert.equal(bridge.offer(refused), false);
      assert.equal(bridge.accepting(), false);
      assert.equal(bridge.overflowed(), true);

      const queued = yield* bridge.poll;
      const empty = yield* bridge.poll;
      return {
        queued: Option.getOrUndefined(queued),
        empty: Option.isNone(empty),
        policy: bridge.takeOverflowPolicy(),
        policyAfterTake: bridge.takeOverflowPolicy(),
      };
    }),
  );

  assert.deepEqual(result.queued, {
    kind: "activity",
    activity: "first",
  });
  assert.equal(result.empty, true);
  assert.deepEqual(result.policy, bridgeOverflowObservations());
  assert.deepEqual(result.policyAfterTake, []);
});
