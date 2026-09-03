# Profile migration: naming your backend in v2

**Who this is for:** anyone who has written a subagent Profile.
**What you have to do:** rename one frontmatter field. Nothing else changes.
**When:** before you run a Profile under v2. v1 is unaffected and needs no edit.

## The change

v1 Profiles name their backend with the frontmatter field `harness:`. v2
Profiles name it with `backend:`.

The values are identical — `pi`, `claude`, `codex` — and the default is still
`pi`, so a Profile that never named a backend needs no edit at all.

```diff
 ---
 description: Implements approved plans and verifies changes
-harness: pi
+backend: pi
 model: openai-codex/gpt-5.6-sol
 effort: high
 tools: read, grep, find, ls
 appendSystemPrompt: true
 ---
```

Every other field — `description`, `model`, `effort`, `tools`,
`appendSystemPrompt`, and the prompt body — is unchanged, and each backend still
validates its own fields exactly as it does today.

## Why

v1's word for a backend, `Harness`, is also the name Pi uses for its own native
abstraction. Keeping it would make it impossible to say in one sentence whether
"the harness" means our integration boundary or Pi's. v2 therefore says
**backend** for Pi, Claude, or Codex, and **adapter** for the code that
integrates one. See
[ADR-0022](../adr/0022-v2-terminology-and-backend-field.md).

## What happens if you don't

v2 understands `description`, `backend`, and the body generically, and hands
every other frontmatter field to the named backend for validation. A field the
backend does not recognize is a diagnostic.

So a Profile still using the old field name **fails v2 validation as an
unrecognized field**, and its backend falls back to the default `pi`. You will
see the diagnostic at session start, naming the field and the Profile file.

There is deliberately **no alias**. v2 does not accept the old name in any form,
and the old name appears nowhere in the v2 tree — a check enforces that on every
pull request. An alias would keep the ambiguous word alive in configuration for
the rest of the product's life, in exchange for saving a one-line edit.

## Running both during the migration

v1 and v2 are never loaded into the same Pi process:

- An installed package exposes **only v1**. Installing or updating the package
  changes nothing about how your Profiles are read.
- v2 is opted into per Pi process by launching Pi with every extension disabled
  and only the v2 entry point loaded:

  ```bash
  pi --offline -np -nc -ns -ne -e extensions/subagent/index.ts
  ```

  or `make dev` from a checkout.

If you are switching between the two, keep the field the process you are
launching expects. Once v2 becomes the only implementation (milestone M7), only
`backend:` is read.

## No migration tool

None is provided. The change is a one-line edit per Profile, and a tool that
rewrites files in your agents directory is a larger risk than the edit it would
save.
