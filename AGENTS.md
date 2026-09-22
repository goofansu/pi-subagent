# AGENTS.md

## Vocabulary

Use the terms in `CONTEXT.md`; they name distinct domain seams rather than synonyms.

- **Agent** — a named role defined by exactly one Profile.
- **Profile** — the Markdown configuration and prompt that define an Agent.
- **Subagent** — a stable, Session-scoped identity created from one Profile.
- **Run** — one managed goal cycle of a Subagent. Do not call it a job, task, call, or provider Turn.
- **Conversation** — provider-owned context that may span several Runs of one Subagent; it is neither a Subagent nor a Run.
- **Backend** — Pi or Claude; an **Adapter** is the integration boundary that implements one Backend.
- **Result** — the authoritative immutable terminal output of one Run.
- **Notification** — the pushed completion notice for a terminal Run; it is not the Result store.

When more precision is needed, use the definitions and historical-term mappings in `CONTEXT.md`.

## Work routing

Read the repository instructions, nearby code, and existing tests before editing. Route deeper exploration by the area being changed:

| Area | Read and inspect |
| --- | --- |
| `extensions/subagent/domain/`, `extensions/subagent/runtime/` | The matching concepts in `CONTEXT.md`, relevant `docs/adr/` decisions, and reducer/property/race tests around the behavior. |
| `extensions/subagent/backend/` | The backend contract, the affected adapter, and backend-neutral conformance scenarios. Keep provider wire vocabulary inside the adapter. |
| `extensions/subagent/application/`, `extensions/subagent/host/` | Application boundaries, session ownership, tool schemas, and end-to-end host tests. |
| `extensions/subagent/presentation/` | Presentation facts and the corresponding surface, golden, width, and rendering tests. Do not recreate domain decisions in view code. |
| `agents/`, `extensions/subagent/profiles/` | Profile format rules, discovery tests, and the packed-profile smoke path. |
| `skills/`, `.pi/skills/` | Read the skill's orchestration ownership, delegation depth, source precedence, and handoff contract. Registered package skills are end-user facing; repository development skills belong in `.pi/skills/`. |
| `.scratch/` | `docs/agents/issue-tracker.md`; preserve its map, ticket, status, and dependency conventions. |

Keep changing architectural facts in `CONTEXT.md` or an ADR rather than duplicating them in this router.

## Verification

Use the narrowest focused test while iterating, then run the required completion checks. A focused test command is:

```sh
node --import tsx --import ./extensions/subagent/suite-setup.ts --test <test-file>
```

| Change | Focused verification | Before handoff |
| --- | --- | --- |
| Domain, runtime, application, host, or presentation code | Closest affected `*.test.ts`; include property, race, or golden tests when that is the behavior being changed. | `npm run check` |
| Backend lifecycle or contract | Affected backend/contract tests and relevant conformance scenario files; run `npm run test:conformance` when the change crosses scenarios or backends. | `npm run check` |
| Bundled Profiles or profile discovery | Relevant profile/discovery tests. | `npm run profiles:smoke`, then `npm run check` |
| Skill or instruction Markdown | Inspect rendered structure, links, commands, and consistency with referenced sources. | `npm run lint`; run broader checks only when behavior or packaged code changed. |
| Provider integration or release behavior | The specifically affected live smoke command, only after the normal checks pass. | Run only when the user explicitly requests live or release verification. |

The Pi and Claude live smoke commands require configured provider environments, spend provider quota, and are intentionally excluded from `npm run check`. Never run `pi:smoke`, `pi:host-smoke`, `claude:smoke`, `claude:host-smoke`, or `release:check` as routine verification.

Report checks that could not be run and why.

## Agent skills

### Issue tracker

Local markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Effect development

Use `/effect-development` when implementation or review depends on Effect scopes, Fibers, interruption, resources, queues, Layers, Schema, or typed failures.

### Test selection

Use `/test-selection` when a change crosses test seams or the correct focused tests are unclear. It routes domain, runtime, conformance, adapter, host, presentation, profile, boundary, and live-smoke coverage.
