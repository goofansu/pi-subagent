# Tools Frontmatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support agent markdown `tools` frontmatter and pass it to nested `pi` invocations as `--tools`.

**Architecture:** Parse `tools` alongside existing `description` and `model` frontmatter into `AgentConfig`. Build subagent CLI arguments in a testable helper that appends `--tools` and the raw comma-separated value when configured.

**Tech Stack:** TypeScript, Node test runner, pi CLI.

---

### Task 1: Parse tools frontmatter

**Files:**
- Modify: `extensions/subagent/types.ts`
- Modify: `extensions/subagent/agents.ts`
- Test: `extensions/subagent/agents.test.ts`

- [ ] Add a failing test expecting `tools: read,grep,find,ls,bash` to appear as `tools: "read,grep,find,ls,bash"` in parsed config.
- [ ] Run `npm test -- extensions/subagent/agents.test.ts` and verify the test fails because `tools` is missing.
- [ ] Add `tools?: string` to `AgentConfig`, include it in the frontmatter type, and assign `frontmatter.tools`.
- [ ] Re-run `npm test -- extensions/subagent/agents.test.ts` and verify it passes.

### Task 2: Pass tools to pi CLI

**Files:**
- Modify: `extensions/subagent/runner.ts`
- Test: `extensions/subagent/runner.test.ts`

- [ ] Add a failing test for a CLI argument helper expecting `--tools` followed by `read,grep,find,ls,bash` without splitting or rewriting.
- [ ] Run `npm test -- extensions/subagent/runner.test.ts` and verify it fails because the helper does not exist.
- [ ] Extract CLI argument construction into `buildPiArgs` and append `--tools`, raw configured tools when present.
- [ ] Re-run `npm test -- extensions/subagent/runner.test.ts` and verify it passes.

### Task 3: Verify all checks

**Files:**
- Test: all project tests and typecheck

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
