# Display Profile Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display a subagent profile's explicitly configured effort in the run usage line and omit it when unconfigured.

**Architecture:** Carry the validated optional `Effort` value on `SingleResult`, assigning it before the first progress emission. Pass that value into the existing pure usage formatter, which appends `effort:<level>` after the model.

**Tech Stack:** TypeScript, Node.js test runner, Pi extension rendering APIs, Biome, TypeScript compiler

## Global Constraints

- Display the profile's configured effort, not a backend-confirmed effective value.
- Render the value as `effort:<level>` after the model.
- Profiles and persisted results without effort must retain their current output and behavior.
- Do not add backend-specific effort reporting.

---

### Task 1: Carry and render profile effort

**Files:**
- Modify: `extensions/subagent/types.ts:45-75`
- Modify: `extensions/subagent/runner.ts:80-90`
- Modify: `extensions/subagent/formatting.ts:41-59`
- Modify: `extensions/subagent/render.ts:147,175`
- Test: `extensions/subagent/formatting.test.ts:37-56`
- Test: `extensions/subagent/dispatch.test.ts:310-340`

**Interfaces:**
- Consumes: existing `Effort`, `AgentConfig.effort`, `SingleResult`, and `formatUsageStats`.
- Produces: optional `SingleResult.effort?: Effort` and `formatUsageStats(usage: UsageStats, model?: string, effort?: Effort): string`.

- [ ] **Step 1: Write failing formatter tests**

Import `Effort` in `formatting.ts`, then first add tests without implementing formatting behavior:

```ts
test("formatUsageStats appends configured effort after the model", () => {
  assert.equal(
    formatUsageStats(usage({ turns: 1 }), "openai/gpt-5.6-sol", "high"),
    "1 turn openai/gpt-5.6-sol effort:high",
  );
});

test("formatUsageStats omits effort when it is not configured", () => {
  assert.equal(
    formatUsageStats(usage({ turns: 1 }), "openai/gpt-5.6-sol"),
    "1 turn openai/gpt-5.6-sol",
  );
});
```

Temporarily extend the function signature so the test compiles, but do not append effort yet:

```ts
export function formatUsageStats(
  usage: UsageStats,
  model?: string,
  _effort?: Effort,
): string {
```

- [ ] **Step 2: Run formatter tests and verify the new behavior fails**

Run:

```bash
node --import tsx --test extensions/subagent/formatting.test.ts
```

Expected: the configured-effort test fails because actual output lacks `effort:high`; the omission test and existing tests pass.

- [ ] **Step 3: Implement minimal formatter behavior**

Replace `_effort` with `effort` and append it after the model:

```ts
export function formatUsageStats(
  usage: UsageStats,
  model?: string,
  effort?: Effort,
): string {
  // existing usage parts remain unchanged
  if (model) parts.push(model);
  if (effort) parts.push(`effort:${effort}`);
  return parts.join(" ");
}
```

Update both calls in `extensions/subagent/render.ts`:

```ts
const usageStr = formatUsageStats(r.usage, r.model, r.effort);
```

- [ ] **Step 4: Run formatter tests and verify they pass**

Run:

```bash
node --import tsx --test extensions/subagent/formatting.test.ts
```

Expected: all formatting tests pass.

- [ ] **Step 5: Write failing result propagation assertions**

Add `effort?: Effort` to `SingleResult` only so the assertions compile:

```ts
/** Explicit reasoning effort configured by the profile. */
effort?: Effort;
```

In `runSubagent forwards progress updates carrying the running result`, configure effort and assert both the first update and final result carry it:

```ts
config: agent({ harness: "claude", effort: "high" }),
```

```ts
assert.equal(updates[0].details.results[0].effort, "high");
assert.equal(reported.effort, "high");
```

Add a separate omission test:

```ts
test("runSubagent omits effort when the profile does not configure it", async () => {
  const pi = recordingBackend("pi");
  const result = await runSubagent({
    config: agent({ harness: "pi" }),
    description: "task",
    prompt: "do it",
    registry: createBackendRegistry([pi.backend]),
  });

  assert.equal(result.effort, undefined);
  assert.equal("effort" in result, false);
});
```

- [ ] **Step 6: Run propagation tests and verify they fail**

Run:

```bash
node --import tsx --test extensions/subagent/dispatch.test.ts
```

Expected: the configured-effort assertion fails because `runSubagent` has not copied profile effort; the omission test passes.

- [ ] **Step 7: Copy configured effort before the initial progress update**

Immediately after result creation in `runSubagent`, conditionally assign the profile value so absent effort does not create an own property:

```ts
const result = createEmptyResult(config.name, description, harness);
if (config.effort) result.effort = config.effort;
result.cwd = cwd;
```

No persistence migration is needed: `PersistedSingleResult` derives from `SingleResult`, and the new field is optional, so old records remain structurally compatible.

- [ ] **Step 8: Run focused and full verification**

Run:

```bash
node --import tsx --test extensions/subagent/formatting.test.ts extensions/subagent/dispatch.test.ts
npm test
npm run typecheck
npm run lint:check
```

Expected: every command exits zero with all tests passing and no type or lint errors.

- [ ] **Step 9: Commit the implementation**

```bash
git add extensions/subagent/types.ts extensions/subagent/runner.ts extensions/subagent/formatting.ts extensions/subagent/render.ts extensions/subagent/formatting.test.ts extensions/subagent/dispatch.test.ts
git commit -m "feat(subagent): display configured effort"
```
