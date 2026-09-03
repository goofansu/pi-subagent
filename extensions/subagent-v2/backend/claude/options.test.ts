import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendId,
  type Profile,
  type SubagentContext,
  subagentId,
} from "../../domain/index.ts";
import { DEPTH_ENV_KEY } from "../depth.ts";
import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_THINKING_BUDGETS,
  claudeThinking,
  createClaudeOptions,
} from "./options.ts";

/**
 * The native policy a Claude child runs under, which is v1's.
 *
 * Everything here is a pure function of a fixture Profile and a fixture
 * Subagent context, so none of it reaches the SDK, the filesystem, or a model.
 * What it checks is the set of decisions v1 arrived at by running children for
 * real — the inheritance, the depth key, the two forbidden tools, the bypass,
 * and the system prompt rule — because each of them is a thing a user would
 * notice if it changed.
 */

function profile(
  fields: Record<string, unknown> = {},
  systemPrompt = "Review carefully.",
): Profile {
  return {
    name: "reviewer",
    description: "The reviewing specialist",
    backend: backendId("claude"),
    fields,
    systemPrompt,
  };
}

const SUBAGENT: SubagentContext = {
  subagentId: subagentId("sa-1"),
  cwd: "/work",
  childDepth: 1,
  projectTrusted: true,
};

const ENVIRONMENT = { PATH: "/usr/bin", HOME: "/home/reviewer" };

function options(
  fields: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof createClaudeOptions>[0]> = {},
) {
  return createClaudeOptions({
    profile: profile(fields),
    subagent: SUBAGENT,
    abort: new AbortController(),
    env: ENVIRONMENT,
    ...overrides,
  });
}

test("the working directory is the Subagent's, fixed for its life", () => {
  assert.equal(options().cwd, "/work");
});

test("the family alias is passed through, and no alias leaves the SDK's default", () => {
  assert.equal(options({}, { model: "sonnet" }).model, "sonnet");
  assert.equal("model" in options(), false);
});

test("each effort buys its own thinking budget", () => {
  for (const [effort, budgetTokens] of Object.entries(
    CLAUDE_THINKING_BUDGETS,
  )) {
    assert.deepEqual(
      claudeThinking(effort),
      { type: "enabled", budgetTokens },
      effort,
    );
  }
});

test("effort off disables extended thinking rather than buying nothing", () => {
  assert.deepEqual(claudeThinking("off"), { type: "disabled" });
});

test("no effort leaves the SDK's own thinking default", () => {
  assert.equal(claudeThinking(undefined), undefined);
});

test("an effort the table does not hold defaults to the high budget", () => {
  assert.deepEqual(claudeThinking("enormous"), {
    type: "enabled",
    budgetTokens: CLAUDE_THINKING_BUDGETS.high,
  });
});

test("the SDK's own effort parameter carries only the values it accepts", () => {
  assert.equal(options({}, { effort: "xhigh" }).effort, "xhigh");
  // `minimal` and `off` are on the shared scale and not on the SDK's, so they
  // reach the thinking budget and nothing else.
  assert.equal("effort" in options({}, { effort: "minimal" }), false);
  assert.equal("effort" in options({}, { effort: "off" }), false);
});

test("Agent and Task are always disallowed, whatever the Profile's tools says", () => {
  assert.deepEqual(options().disallowedTools, [...CLAUDE_DISALLOWED_TOOLS]);
  assert.deepEqual(options({ tools: "Read, Bash" }).disallowedTools, [
    ...CLAUDE_DISALLOWED_TOOLS,
  ]);
});

test("permissions are bypassed with the explicit skip flag", () => {
  const built = options();

  assert.equal(built.permissionMode, "bypassPermissions");
  assert.equal(built.allowDangerouslySkipPermissions, true);
});

test("the Profile's tools narrow the built-in set, and an empty list is kept", () => {
  assert.deepEqual(options({ tools: "Read, Bash" }).tools, ["Read", "Bash"]);
  // A comma alone is an explicitly empty allowlist: it disables tools
  // rather than restoring the SDK's defaults.
  assert.deepEqual(options({ tools: "   ,  " }).tools, []);
  // No list at all leaves the SDK's defaults, which is not the same request.
  assert.equal("tools" in options(), false);
});

test("the child environment is the operator's, plus the depth key", () => {
  const env = options().env;

  assert.equal(env?.PATH, "/usr/bin");
  assert.equal(env?.HOME, "/home/reviewer");
  assert.equal(env?.[DEPTH_ENV_KEY], "1");
});

test("building the options does not mutate the process environment", () => {
  const before = process.env[DEPTH_ENV_KEY];

  options({}, { subagent: { ...SUBAGENT, childDepth: 7 } });

  assert.equal(process.env[DEPTH_ENV_KEY], before);
});

test("the system prompt is the Claude Code preset with the Profile's appended", () => {
  assert.deepEqual(options().systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: "Review carefully.",
  });
});

test("a Profile that opted out replaces the preset instead of appending", () => {
  assert.equal(
    options({ appendSystemPrompt: false }).systemPrompt,
    "Review carefully.",
  );
});

test("setting sources and MCP servers are absent, so the operator's environment is inherited", () => {
  const built = options();

  // ADR-0008: omitting both is what makes the SDK load the operator's own
  // settings and expose their MCP servers and connectors to the child.
  assert.equal("settingSources" in built, false);
  assert.equal("mcpServers" in built, false);
});

test("a resumed Run carries the retained identity and a first Run carries none", () => {
  assert.equal(options({}, { resume: "an-identity" }).resume, "an-identity");
  assert.equal("resume" in options(), false);
});

test("the abort controller is the one the execution handed in", () => {
  const abort = new AbortController();

  assert.equal(options({}, { abort }).abortController, abort);
});
