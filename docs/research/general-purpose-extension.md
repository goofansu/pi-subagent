# Making pi-subagent a general-purpose package

## Outcome

Applied in `dc61820` (skill and three specialist Profiles removed, docs and
smoke list updated) and `86095cd` (Pi packages bumped to 1.1.0). The
inventory below describes the tree before those commits.

## Evidence and conclusion

Source review, not runtime verification. Reviewed pi-subagent revision
`578b712a552e76fbc33544afdabbc6b3ecc9edfb` (1.0.5) plus the uncommitted working
tree (`package.json` modified, `skills/implement-spec/SKILL.md` deleted,
`skills/subagent-implement-spec/SKILL.md` untracked), and the installed Pi core
`node_modules/@earendil-works/pi-coding-agent` (0.86.0). Core references below
are relative to that package; repository references are relative to this
repository. No checks, smoke commands, or provider calls were run.

**Nothing in the extension's code, tests, or lint depends on the packaged skill
or on any bundled Profile by name; the only hard couplings are the `pi.skills`
manifest entry, the four-name list in `scripts/bundled-profiles-smoke.mjs`, and
two prose sentences in README and CONTEXT.** Removing the skill is a manifest
and file deletion. Reducing Profiles is a smoke-list and docs edit. The runtime
already tolerates zero bundled Profiles.

## 1. What ships today and where it is wired

The manifest declares one extension and one skill; `files` packs `agents` and
`skills` wholesale. Source: `package.json:6-11,15-22`.

The working tree only renames the skill: the diff changes the manifest path and
the frontmatter `name` (`implement-spec` to `subagent-implement-spec`); the body
is byte-identical to the deleted file. Source: `git diff` of `package.json:20`
and the `diff` of `HEAD:skills/implement-spec/SKILL.md` against
`skills/subagent-implement-spec/SKILL.md` (only line 2 differs). Pi warns on
skill name collisions and keeps the first found (core `docs/skills.md:189`),
which is the plausible motive for the prefix.

Four Profiles are bundled: `agents/general-purpose.md`, `agents/implementer.md`,
`agents/spec-reviewer.md`, `agents/standards-reviewer.md`. The production backend
set resolves them relative to the extension source
(`extensions/subagent/host/production-backends.ts:76-78`), and the catalog
merges them beneath same-name user files
(`extensions/subagent/runtime/profile-catalog.ts:81-107`).

History of prior decisions (commit subjects and bodies):

- `94ee7eb` dropped `claude-scout`: "Shipping it as a default meant every
  install carried an opinion"; `general-purpose` became the only bundled agent.
- `e3fc81c` / `fb5135f` bundled five specialists and two orchestration skills
  (`.scratch/bundled-subagent-system/spec.md:1-25`).
- `80b1342` "remove bundled workflow" deleted `implement-and-review`, removed
  the smoke script's skill assertions, and switched the loader to
  `noSkills: true` (`git show 80b1342 -- scripts/bundled-profiles-smoke.mjs`).
- `7045af0` re-added a skill (`implement-spec`) and the `skills` entry in
  `files`; `d8044aa` states the reviewers "are designed to be used for
  mattpocock/skills code-review skill".

So the repository has already oscillated once between "general runtime" and
"runtime plus my workflow". The direction asked for here repeats `94ee7eb` and
`80b1342`.

## 2. Inventory

| Item | Kind | Workflow-specific? | What depends on it | Removal cost |
| --- | --- | --- | --- | --- |
| `skills/subagent-implement-spec/SKILL.md` | packaged skill | Yes: third-party `/skill:code-review` (`:11,19,59,73`), Profiles `implementer`/`spec-reviewer`/`standards-reviewer` (`:11,19,61`), `general-purpose` (`:31`), ticket/issue-tracker ledger (`:21,27`) | `package.json:19-21` only. Not in README, CONTEXT, code, tests, or smoke (`scripts/bundled-profiles-smoke.mjs:59` sets `noSkills: true`) | Delete directory; drop `pi.skills` and `"skills"` from `files` |
| `agents/general-purpose.md` | Profile | No; generic research/execution prompt (`:2-20`) | `scripts/bundled-profiles-smoke.mjs:21,113,134,140,151` (override and diagnostic checks use this name) | Keep |
| `agents/implementer.md` | Profile | Partly: generic "implement and leave uncommitted" contract, but written for a caller that reviews afterwards (`:10,38`) | `scripts/bundled-profiles-smoke.mjs:22`; README `:14-15`; test fixtures use the string only (`extensions/subagent/presentation/renderers.test.ts:99`) | Drop from smoke list and README sentence |
| `agents/spec-reviewer.md` | Profile | Yes: "Spec axis of code review" for a caller supplying a diff command and smell baseline (`:2,11-15`) | `scripts/bundled-profiles-smoke.mjs:23`; README `:14-15`; string-only fixtures in `extensions/subagent/host/notification-message.test.ts:207,220` and `extensions/subagent/presentation/agent-tool-renderers.test.ts:574,592` | Same |
| `agents/standards-reviewer.md` | Profile | Yes: "Standards axis", requires a supplied smell baseline (`:2,11-18`) | Same as above, `scripts/bundled-profiles-smoke.mjs:24` | Same |
| README "profiles for general work, implementation, specification review, and standards review" | doc | Yes | `README.md:14-15` | One-sentence edit |
| CONTEXT "five bundled specialist Profiles" | doc | Already stale (four ship) | `CONTEXT.md:588-589` | One-phrase edit |
| `.pi/skills/effect-development`, `.pi/skills/test-selection` | repo-development skills | Repo-internal, not packaged | Not in `files` (`package.json:6-11`); discovered only as project skills (core `docs/skills.md:30`) | None; keep |

The test fixtures that mention reviewer names are presentation and notification
rendering tests using arbitrary strings; none reads `agents/`. The tests that
exercise bundled discovery create their own temporary `bundled/` directory
(`extensions/subagent/runtime/profile-catalog.test.ts:24-27,110,180`) and the
host rigs write their own `agents/` directories
(`extensions/subagent/testing/host-rig.ts:263`,
`extensions/subagent/testing/pi/pi-rig.ts:152`).

## 3. Code has no Profile-name or skill coupling

- The profile loader has no name list. A missing directory yields an empty
  list rather than an error (`extensions/subagent/profiles/discovery.ts:50-61`),
  and `bundledDir` is optional (`extensions/subagent/runtime/profile-catalog.ts:75,81-85`).
- The parent prompt is built from whatever Profiles were discovered; with none
  it emits an empty `<available_agents>` block
  (`extensions/subagent/host/available-agents.ts:10-29`,
  `extensions/subagent/index.ts:197-199`). `/subagent` renders "no Profiles"
  (`extensions/subagent/host/subagent-command.ts:253-255`).
- Grep of `extensions/`, `scripts/`, `tools/`, `docs/`, `README.md`,
  `CONTEXT.md`, `AGENTS.md`, `.pi/` for `implementer|spec-reviewer|
  standards-reviewer|general-purpose|implement-spec|code-review` matches only
  the smoke script and the string-only test fixtures listed in §2.
- The extension never reads skills; the only `skill` reference in non-test code
  is a fake SDK fixture (`extensions/subagent/backend/pi/real-sdk-fixture.ts:101`).

## 4. Lint and check scripts

`npm run check` is typecheck, biome, unit tests, and conformance
(`package.json:36`). Biome includes `**` minus `.scratch` (`biome.json:9-11`)
but lints JS/TS/JSON, so deleting a Markdown skill changes nothing it checks.
`profiles:smoke` is a separate script (`package.json:37`), not part of `check`,
and it is the only place a bundled-Profile name list lives
(`scripts/bundled-profiles-smoke.mjs:20-25,33-34,106-110`).

Removing the manifest entry is therefore sufficient for correctness; the
`"skills"` entry in `files` (`package.json:8`) should go with it so `npm pack`
does not advertise an empty resource directory. Core auto-discovers a `skills/`
directory only when no `pi` manifest is present (core `docs/packages.md:160-163`),
so with the manifest kept and `skills` omitted nothing is loaded regardless.

## 5. What users can supply themselves

Pi core already gives users every slot the package would be vacating:

- Skills load from `~/.pi/agent/skills/`, `~/.agents/skills/`, project
  `.pi/skills/`, package `pi.skills`, settings, and `--skill` (core
  `docs/skills.md:21-33`). The user's own copy of the third-party review skill
  already lives at `~/.pi/agent/skills/code-review/SKILL.md`, which is what the
  packaged skill's `/skill:code-review` resolves to; that skill speaks only of
  generic "sub-agents" (its `:11,58`) and does not require pi-subagent's
  reviewer names.
- Profiles load from `~/.pi/agent/agents/` or `$PI_CODING_AGENT_DIR/agents/`
  and a same-name file replaces a bundled one entirely (`README.md:53-57,84`;
  `CONTEXT.md:26-29`). Project-scope Profiles are deliberately not read
  (`extensions/subagent/profiles/discovery.ts:22-33`), so a user who wants
  reviewers per repository cannot use `.pi/agents/`; they go in the user dir.
- Package consumers can also filter a package's skills to `[]` in settings
  without the package changing (core `docs/packages.md:190-216`), which is the
  workaround available today but not a reason to keep shipping the skill.

## 6. Recommended minimal shape

1. Remove the skill entirely: delete `skills/subagent-implement-spec/`, drop
   `pi.skills` (`package.json:19-21`) and `"skills"` from `files`
   (`package.json:8`). Keep the `pi.extensions` entry. This finishes the
   `80b1342` direction instead of the half-step currently in the working tree.
2. Keep `agents/general-purpose.md` as the single bundled Profile. It is the
   one the smoke script's override and diagnostic checks are built around
   (`scripts/bundled-profiles-smoke.mjs:111-153`), and shipping zero Profiles
   would leave the parent prompt with an empty agent list on install.
3. Remove `implementer`, `spec-reviewer`, `standards-reviewer` from `agents/`
   and from the smoke name list (`scripts/bundled-profiles-smoke.mjs:20-25`),
   leaving `names = ["general-purpose"]`. The loop at `:33-34` and `:106-110`
   then still proves packing and prompt exposure.
4. Docs: rewrite `README.md:14-15` to "The package includes a `general-purpose`
   Profile; add your own in `~/.pi/agent/agents/`" and point at the existing
   "Agent profile format" section (`README.md:53`). Correct `CONTEXT.md:588-589`
   ("five bundled specialist Profiles") to the actual count.
5. Optionally move the three removed Profiles and the skill to a user-level
   directory or a separate package; both can be reinstated without code
   changes because the loader is name-agnostic (§3).

Verification after the change: `npm run profiles:smoke` (the Profile row in
AGENTS.md's table), then `npm run check`. Neither was run for this note.

## 7. Alternative: keep reviewers as generic examples

Both reviewer prompts are already caller-agnostic in wording ("expect no
particular headings, template, artifact type, or generating workflow",
`agents/spec-reviewer.md:17`; empty standards list accepted,
`agents/standards-reviewer.md:18`). What makes them workflow-specific is the
input contract they demand (exact diff command, commit list, smell baseline;
`agents/spec-reviewer.md:11-15`, `agents/standards-reviewer.md:11-16`), which
only the removed skill or the third-party review skill supplies. Kept without
that caller they are unusable by a bare `agent_start`, so keeping them means
keeping the opinion `94ee7eb` chose to drop. If kept, the only required change
is the README sentence; the smoke list can stay as is.

## Open decisions

1. Zero or one bundled Profile. Recommendation here is one (`general-purpose`);
   zero works at runtime (§3) but weakens the install experience and the smoke
   script's override checks would need a different fixture name.
2. Where the removed workflow goes: user directory (`~/.pi/agent/skills/`,
   `~/.pi/agent/agents/`), a second npm package with its own `pi` manifest, or
   nowhere. The skill is coupled to `/skill:code-review` and `.scratch`
   ticket conventions (`skills/subagent-implement-spec/SKILL.md:19,21`;
   `docs/agents/issue-tracker.md:1-11`), so a separate package would still
   carry those dependencies.
3. The working-tree rename. If the skill is removed, revert `package.json:20`
   to the committed path and delete the untracked directory rather than
   committing the rename first. If the user wants a transitional release, the
   rename plus a README note is a smaller commit, but it does not make the
   package general-purpose.
4. Whether `implementer` is general enough to keep. Its contract is
   "implement, run checks, leave uncommitted" (`agents/implementer.md:2,38`),
   which is a common delegation shape and has no review-skill dependency, so
   it is the one specialist that could stay without an orchestrating skill.
