import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId } from "../domain/index.ts";
import { formatAvailableAgents } from "./available-agents.ts";

test("available agents expose routing metadata, not execution configuration", () => {
  const prompt = formatAvailableAgents([
    {
      name: "review&report",
      description: 'Reviews <changes> when a caller says "done".',
      backend: backendId("claude"),
      fields: { model: "opus", tools: ["read"] },
      systemPrompt: "Secret specialist instructions.",
    },
  ]);

  assert.equal(
    prompt,
    [
      "The following agents are available for delegated tasks.",
      "Use agent_start when a task matches an agent's description.",
      "",
      "<available_agents>",
      "  <agent>",
      "    <name>review&amp;report</name>",
      "    <description>Reviews &lt;changes&gt; when a caller says &quot;done&quot;.</description>",
      "  </agent>",
      "</available_agents>",
    ].join("\n"),
  );
  assert.doesNotMatch(prompt, /opus|tools|Secret|backend/);
});
