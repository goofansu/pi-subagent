# 22. v2 terminology and the Profile backend field

Date: 2026-09-02

## Status

Accepted for the v2 tree. This ADR supersedes no earlier decision. It is
vocabulary and configuration for `extensions/subagent/` only; v1 is frozen
and keeps every name it has.

It carries forward the consequences of:

- [ADR-0007](0007-harness-seam-with-neutral-facts.md) — a named backend
  validates its own Profile fields, translates its own wire format, and never
  lets a provider type cross the seam. v2 renames the seam but keeps the rule.
- [ADR-0013](0013-stable-subagent-identity.md) — a Subagent is a stable
  Session-scoped identity above sequential Runs, with three states and two
  distinct identity kinds. v2 keeps the model and gives its identities the
  names `SubagentId` and `RunId`.
- [ADR-0014](0014-controlled-agent-resume.md) — resume is neutral atomic
  admission that never exposes a provider continuation token. v2 keeps it.
- [ADR-0019](0019-backend-neutral-managed-release.md) — one shared,
  capability-aware conformance surface across every production backend, plus
  authenticated live gates. v2 keeps both.
- [ADR-0020](0020-run-settlement-through-harness-conformance.md) — a Run settles
  exactly once and each adapter owns its own ordering and Ending derivation.
  v2 keeps this; [ADR-0025](0025-v2-terminal-settlement.md) restates it in v2
  vocabulary.

## Context

v1 calls a backend a **Harness**. The word does double duty: it is v1's
integration seam *and* the name Pi uses for its own native abstraction. Building
v2 with the same word would make it impossible to say, in one sentence, whether
"the harness" means our adapter or Pi's `AgentHarness`.

v2 also needs to name things v1 has no word for: the retained native
conversation object that lives for a Subagent's whole life, and the distinction
between a public Run and the adapter-internal attempts that may implement it.

Separately, Profiles name their backend with the frontmatter field `harness:`.
Carrying that name into v2 would carry the ambiguity into every Profile and
every diagnostic.

## Decision

### Vocabulary

v2 uses exactly these words, from the first line of code:

- **backend** — the identity of one named provider integration, such as Pi or
  Claude. `BackendId` is its type.
- **adapter** — the integration boundary that implements one backend. Provider
  wire objects never cross it.
- **BackendAgent** — the adapter-owned retained native conversation, session, or
  process. It is owned by exactly one Subagent Scope and lives as long as that
  Subagent.
- **SubagentId** — the stable logical specialist the product exposes.
- **RunId** — one public `start` or `resume` operation.
- **Attempt** — adapter-internal vocabulary for native execution details and
  retries. It is not a core product type and never appears in a core signature.
- **AgentHarness** — reserved for Pi's own native abstraction. v2 never uses it
  for anything of ours. `Harness`, `Executor`, `Dispatcher`, `Registry`, and
  `Subagent manager` are v1-only names, scheduled for deletion with v1 at M7.

### The Profile backend field

v2 Profile parsing understands exactly three generic things: `description`,
`backend` (default `pi`), and the body. Every other frontmatter field is handed
to the named backend for validation, and a field the backend does not recognize
is a diagnostic.

`backend` is the **only** field v2 understands for naming a backend. The
migration is a **documented configuration rename**, not a deprecated alias:

- The values are unchanged. `harness: claude` becomes `backend: claude`.
- A Profile that still uses the old name fails v2 validation as an
  **unrecognized field** — the same diagnostic any unknown frontmatter key gets.
  v2 never special-cases it, and never spells it.
- The old field name appears **nowhere** in the v2 tree: not in code, not in
  tests, not in a documentation string. This is enforced from M0 by
  `extensions/subagent/boundaries.test.ts`, which is the only file in v2
  permitted to spell it and which excludes itself from its own scan. The
  check removes the reserved `AgentHarness` identifier before scanning, so
  reserving that name and banning the field name do not contradict each
  other.
- **No migration tool is written.** The rename is a one-line edit, and a tool
  that rewrites user Profiles is a larger risk than the edit it saves.
- **v1 continues to read its field unchanged.** v1 is frozen; nothing about this
  decision touches it.

Profile authors are told what to do in the README's "Upgrading from 1.x"
section, which spells the rename out.

## Consequences

A Profile written for v1 does not load in v2 until its author renames one field.
That is a deliberate, visible break rather than a silent alias that would keep
the ambiguous word alive in v2 configuration for the rest of the product's life.
During the migration both implementations exist, so an author who runs both must
keep the field their current process expects — which is precisely why the
package manifest exposes only v1 and v2 is opted into per process.

Refusing an alias means v2 cannot accept a Profile that a user has not yet
migrated, so the diagnostic has to be good: an unrecognized-field diagnostic
that names the field and the Profile is enough for the author to find the
rename, which the README spells out where a 1.x reader first looks.

Reserving `AgentHarness` costs a rename in every ported adapter, and buys the
ability to say "the Pi adapter's BackendAgent wraps Pi's AgentHarness" without
ambiguity. The Pi API-risk spike confirmed that the abstraction Pi exposes today
is `AgentSession`; because the whole handle sits behind the adapter, a later Pi
rename is an adapter-internal change and this ADR does not need revisiting.
