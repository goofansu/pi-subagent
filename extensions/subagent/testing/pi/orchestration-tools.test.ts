import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_ORCHESTRATION_TOOLS } from "../../backend/pi/index.ts";
import { SUBAGENT_TOOL_NAMES } from "../../host/tools.ts";

test("Pi children deny every delegation tool the host registers", () => {
  assert.deepEqual(
    new Set(PI_ORCHESTRATION_TOOLS),
    new Set(SUBAGENT_TOOL_NAMES),
  );
});
