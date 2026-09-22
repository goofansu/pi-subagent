# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read selectively

`CONTEXT.md` is the vocabulary and architecture source of truth, not ambient context that must always be loaded in full.

1. Read its opening explanation and the definitions for the concepts named by the task.
2. Search for those concepts and read the surrounding product or architecture sections.
3. Read ADRs in `docs/adr/` that touch the affected boundary or decision.
4. Read all of `CONTEXT.md` only for cross-cutting design work, vocabulary audits, or work whose boundary is still unknown after targeted exploration.

For a narrow presentation, script, profile, or documentation change, stop once the relevant definitions, integration boundary, and decisions are clear. If a search exposes an unfamiliar project term, follow its definition before continuing rather than loading unrelated sections.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── extensions/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
