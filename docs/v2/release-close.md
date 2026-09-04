# The 2.0 close: soak, evidence, and the stable release

**Status: in progress since 2026-09-04.** E1, E3 and E4 are PASS; E0 and E2
remain before E5–E7, which wait on E2.
**Precondition, met:** [the Phase C gate](../v2-simplify/phase-c-exit-gate.md)
closed on 2026-09-04 with one item outstanding and named — item 14, the six
credentialed live lanes, which need credentials the closing environment did
not have. The soak must run on the build that ships, and Phase C changes the
widget's row lifetime and one model-facing sentence, so a soak day logged
before it closed would have been a day on a different build. Phase C's item 14
is closed by this phase's E7: `release:check` runs the same six lanes on the
release commit, and their markers are recorded in both gates.
**What closing it unlocks:** `2.0.0`, without the release-candidate marker;
the simplification programme's close; and a recorded decision on each Phase D
item, made on numbers.

## Why this is the next phase, and Phase D is not

[The v2 roadmap](roadmap.md) delivered the rewrite and left three things
outstanding, none of them code: the six live gates on the cutover build, the
Codex Desktop coexistence record, and the release-candidate soak.
[The simplification roadmap](../v2-simplify/roadmap.md) has planned Phases A
through C and holds Phase D "on evidence only". The evidence Phase D waits for
comes from the soak, and [the soak record](soak.md) has been open since
2026-09-03 with an empty log — the M4 window accumulated nothing, and the
cutover window has accumulated nothing. A plan that skipped to Phase D would
be planning on evidence that does not exist; a plan that lists the three
outstanding items again without asking why the soak has not been written would
leave them outstanding.

So this phase does two things. It closes the release, which is mostly human
work with a cadence. And it fixes the reason the soak log is empty: the tally
is a manual log of things the maintainer did, written after the fact, and
nothing makes writing it cheaper than not writing it. Pi's session logs already
record every `agent_*` tool call with its arguments and its timestamp, so the
tally is computed from them and the maintainer writes only what the logs cannot
know — the probe readings at shutdown, and anything that went wrong.

## What this phase delivers

| # | Item | Owner | What closes it |
| --- | --- | --- | --- |
| E0 | The last code lands before the first soak day. | agent | An empty description is refused at admission (closes [#3](https://github.com/goofansu/pi-subagent/issues/3)); the tally script's expected result sentences are cross-checked against the prose module in `check`; the sink's rule for new state is written where the state lives. Nothing under `extensions/` changes after this until the tag. |
| E1 | The soak tally is computed from Pi's session logs, not remembered. | agent | `scripts/soak-tally.mjs`; `soak.md`'s tally section generated; a shutdown entry is three lines. |
| E2 | The soak is run on the Phase C build. | human | Five distinct days; every operation on every backend at least three times; a probe reading at every shutdown; the hand-off block read at every shutdown. |
| E3 | The Codex Desktop coexistence record exists for the pinned CLI. | human | One evidence block with PASS at every required checkpoint; `npm run codex:retained-release:check` green. |
| E4 | The end-state test is run, as written. | agent | A fresh agent's plans for the two requests in the simplification roadmap §7, recorded here, with any deviation a finding. |
| E5 | The Phase D decision is made on the soak's numbers. | agent, human sign-off | Each Phase D item marked *scheduled* (with the ADR as the next phase's first ticket) or *deferred* (with the re-read date), in the simplification roadmap, by its decision rule. |
| E6 | The simplification programme closes. | agent | The roadmap's §8 document split: banners on the historical documents, the change-surface method into the contributor rules, status lines. |
| E7 | `2.0.0` ships. | agent, human for the tag | Version bumped; the compatibility matrix marked frozen at 2.0; the README's install and rollback notes current; `npm run release:check` green on the tagged commit; the v2 roadmap's items 10 and 12 given their final wording. |

### E0. The last code, before the soak

Added 2026-09-04 from the post-Phase-C review, which found three things worth
doing and one thing worth checking. The check passed: the ADR, the sink's own
comments and the semantics document all say a push for a consumed Run is
*accepted and not sent* and call the outcome a hand-off, never a message sent,
so no wording moves. The three that are done are done now because each touches
`extensions/` or its tests, and the soak record's rule is that a change landing
after a soak day makes that day a day on a different build.

- **An empty description is refused.** `boundRunLabel("")` and
  `boundRunLabel("   ")` both return `""`, and the schema's description field
  has no minimum, so a notice can read `Subagent "" completed in 12.4s.` and a
  collapsed line `explore ·  · completed in 12.4s`. The label is the first
  thing a parent reads in a notice, so an empty one is not a papercut. It is
  refused with a typed outcome at the same place the label is bounded, in the
  `Cannot start <agent>: …` family the surface already uses and the resume
  family's equivalent — refusal rather than a generated label, because there
  is nothing to shorten and a generated name would hide a caller error the
  model can fix in one round trip. This fixes the end-state test's finding 5
  before the soak instead of carrying it; the commit closes
  [#3](https://github.com/goofansu/pi-subagent/issues/3).
- **The tally script's prose list is cross-checked in `check`.** The script
  reads Run and Subagent ids out of the tool result's sentences and fails
  loudly if they change — at tally time, days after the change. A test in the
  extension tree imports the script's expected openings and the prose module
  and asserts they agree, so a reword fails `npm run check` at reword time.
  The new refusal sentence above is the first thing this test has to cover.
- **The sink's rule for new state is written where the state lives.** The push
  sink now owns unlanded, lost, landed, exhausted and consumed, plus eight
  counts, and is where notification features will accumulate. Its header
  comment gains the rule: a new state is added only if it changes whether a
  hand-off is unresolved, resolved, or failed; anything else — batching
  metadata, envelope membership — lives beside the sink, not in it.

### E1. The soak tally, computed

Pi writes one JSONL file per Session under its sessions directory, with a
`session` header carrying the start time and the working directory, and a
`toolCall` entry per tool call carrying the tool's name and its arguments. An
`agent_start` call carries the Profile name; a Profile's file names its backend.
That is everything the tally's operation rows need: operation, backend, day.

`scripts/soak-tally.mjs <since-date>` reads every Session started on or after
the date, maps each `agent_start`, `agent_resume`, `agent_steer`, and
`agent_cancel` to a backend through the Profile files, counts occurrences and
distinct days per backend, counts Sessions as shutdowns and a second Session in
the same working directory on the same day as a switch, and prints the three
tables in the record's format. `agent_resume` names a Subagent id rather than a
Profile, so the script resolves it through the `agent_start` that produced it
in the same Session; a resume it cannot resolve is counted under *unknown* and
listed, so the tally never silently drops one.

What the script cannot know stays manual and gets small: a shutdown entry is
the date, the backend set that was live, and the paste, from which the probes,
the health line's classes, and the hand-off block — including
`consumedBeforeLanding` — are read. The record's *Reading the probes* section
becomes *Writing a shutdown entry* and says exactly that.

**The paste is of two commands, not one.** This plan said
`/subagent diagnostics`, and building E1 found that command does not carry
everything Phase D's rules read: the runtime counters, the runtime probe, the
hand-off block and the adapter probes are its, but the health line and the Run
summary belong to bare `/subagent`. The terminal-compaction rule reads the Run
summary and the envelope rule reads `consumedBeforeLanding`, so an entry with
only one of the two blocks cannot answer both. A shutdown entry therefore
pastes `/subagent` and `/subagent diagnostics`, which is still one action at
one moment.

The script is tooling for a process, not product: it lives in `scripts/`, is
not in `check`, and is not an operator command. It reads Pi's on-disk format,
which is Pi's to change; when it changes, the script fails loudly on a field it
cannot find rather than printing a smaller number.

### E2. The soak, run

Five distinct days on the Phase C build, with each of `agent_start`,
`agent_resume`, `agent_steer`, `agent_cancel` at least three times per backend
and at least three shutdowns and one switch per backend. The exit criteria in
[the soak record](soak.md) are unchanged. Two readings are added to every
shutdown entry because Phase D depends on them: the hand-off block and the
bare `/subagent` health line. A `ResultExpired` answer from `agent_result` for
a Run whose notice landed in the same Session is a severity-3 entry and is
Phase D's second decision rule firing.

### E3. The coexistence record

The procedure in [the coexistence document](../codex-desktop-coexistence-release.md)
is complete and has never been run. It needs Codex Desktop open beside a live
Session and one maintainer hour. It is human-only and has no substitute, and
`npm run release:check` cannot pass without it.

### E4. The end-state test

[The simplification roadmap §7](../v2-simplify/roadmap.md#7-the-end-state-test)
hands a new contributor two requests and reads their plan. Run it literally: a
fresh agent with no conversation context, the repository, and each request in
turn; record both plans here verbatim. The roadmap says what each plan should
and should not list. A plan that lists a module the roadmap says it should not
is a finding for E5 or for a 2.0.x fix, not a reason to soften the test.

### E5. The Phase D decision

Each Phase D item has a decision rule in
[the simplification roadmap](../v2-simplify/roadmap.md#phase-d--long-session-concerns-on-evidence-only).
When the soak's five days are logged, apply each rule to the log and mark the
item *scheduled* or *deferred* in the roadmap with the reading that decided it.
A scheduled item's ADR is the first ticket of the phase that implements it,
which is the Phase B and Phase C discipline. A deferred item names the date or
the release at which its rule is read again.

### E6. The programme close

[The simplification roadmap §8](../v2-simplify/roadmap.md#8-when-the-programme-closes)
names the split. Each historical document gains a one-line banner naming the
permanent document that supersedes it; the change-surface *method* moves into
the contributor rules and the measurements stay where they are as history;
the notification semantics document's §1 before/after tables and §8 are marked
historical while §2–§6 stay the text the matrix cites; the roadmap's status
line reads closed. Nothing is deleted.

### E7. The release

`package.json` to `2.0.0`. The compatibility matrix's status reads frozen at
2.0, with the rule that a cell changes only with a **[2.x change]** marker and
a ledger row. The README's install line is the tagged release and its rollback
paragraph names `#v1.0.0` as the previous major. `npm run release:check` — the
deterministic gate, all six live lanes, the retained-release check — is green
on the commit that is tagged `v2.0.0`. The six lane markers close
[the Phase C gate's item 14](../v2-simplify/phase-c-exit-gate.md) as well as
this gate's item 7, and are recorded in both. The v2 roadmap's item 10 reads
met with the soak's closing tally; item 12 stays *not met* by its own measure
and points at the change-surface table as what is true instead. Each finding
this phase marked *carried to a 2.0.x issue* has an issue before the release
commit, so a carry is a link and not a sentence. The tag and the push are the
maintainer's.

## Sequencing

```text
Phase C gate closes
        │
        ├── E0 last code before the soak    (agent, first: nothing under extensions/ moves after it)
        ├── E1 soak tally script            (agent, first: the soak needs it on day one)
        ├── E4 end-state test               (agent, any time after C)
        ├── E3 coexistence record           (human, any one hour)
        │
        ▼
E2 soak: five distinct days on the Phase C build    (human)
        │
        ▼
E5 Phase D decision, on the tally and the shutdown entries
        │
        ├── E6 programme close
        ▼
E7 release: release:check green → tag v2.0.0
```

E0 and E1 go first: E0 because the soak is of the build that ships and the
build is not final until it lands, E1 because the first soak day should be
counted by the script, not reconstructed. E3 and E4 have no dependency and fill idle time. Nothing in E5
through E7 starts before the tally is full: a Phase D decision on three days is
the thing this phase exists to stop doing.

## The gate

Verified item by item; each reads PASS, OPEN, or NOT MET with its evidence.

### 0. The last code landed before the first soak day

An empty or whitespace-only description is refused at start and resume with a
typed outcome in the existing refusal family, and no notice or collapsed line
can carry an empty label; [#3](https://github.com/goofansu/pi-subagent/issues/3)
is closed by the commit. A test under `extensions/` asserts the tally script's
expected result openings against what `presentation/prose.ts` produces, and
the new refusal is in the list. The push sink's header states the rule for
adding state. The commit that lands these is the last commit to touch
`extensions/` before `v2.0.0`, and the soak's first entry is dated after it.

**Status:** PASS (2026-09-04), commit `7511a88` — the last commit to touch
`extensions/` before the tag.

- **The refusal.** `empty label` is a new outcome on both `StartOutcome` and
  `ResumeOutcome`, added to
  [operation semantics §2](operation-semantics.md#2-start-and-resume-admission-are-atomic)
  first, since the unions are transcribed from it and a test reads both. It is
  decided in `application/subagents.ts` where the label is bounded, before the
  supervisor is reached, so nothing is reserved and no identifier is spent:
  `agent_start refuses an empty description, and spends no identifier doing it`
  refuses `""`, `"   "` and `"\n\t "` and then requires the next start to be
  the Session's *first* Run and Subagent, and `agent_resume refuses an empty
  description, and the Subagent stays resumable` resumes for real afterwards.
  The sentences are `presentation/prose.ts`'s, in the two families the surface
  already uses — proven by `a start and a resume refuse an empty description in
  their own family's words`.
- **The schemas.** `T1: both description fields say the field is never empty`,
  and the existing `T1` now reads the clause whole.
- **The matrix.** `agent_start` and `agent_resume` each gained an **Empty
  description** row with its proof, and the **The Run label** cell states both
  ends of the bound and what each does. Marked **[2.0 close]**, which is before
  the matrix freezes at E7. Neither presentation ledger gains a row: the v2
  ledger is a closed one-time v1-versus-v2 comparison and v1 had no lower bound
  to compare against, and the simplification ledger records what that programme
  changed.
- **The cross-check.** `extensions/subagent/soak-tally-openings.test.ts` reads
  `scripts/soak-tally.mjs`'s `RESULT_PROSE` and this tree's formatters in both
  directions, over one sample of every outcome built from each union's own name
  list — so an outcome added to either operation fails here as well as failing
  to compile. It lives at the tree root rather than beside the prose, for the
  reason `packaging.test.ts` does: it asserts an agreement between this
  extension and the repository around it, and a presentation file may name only
  the domain and Pi. Shown to fail both ways before it was kept: rewording
  `Started ` to `Launched ` in `presentation/prose.ts` failed both directions,
  and adding an opening the tree does not produce failed the second. Its third
  test is a property of the script alone — that its started and refused
  openings stay distinguishable, so a refusal can never be mistaken for a start
  and searched for ids — and no edit to either side fails it.

  What the test holds is the **opening**, not the sentence: the script reads
  families, so rewording a refusal's body passes here, and should. What fails is
  a change to an opening, which is the change that would stop the script
  resolving ids.
- **The impossibility is enforced rather than argued.** That no Run can carry an
  empty label rests on `labelledRequest` being the only door, and nothing
  fenced that. `label-bound.test.ts` now reads the tree and requires
  `application/subagents.ts` to be the only production caller of
  `supervisor.start`, `supervisor.resume` and `boundRunLabel`. A second caller
  would have taken the property away silently.
- **The checker can see the edge the cross-check adds.** That test imports the
  script through a computed specifier, because the script is plain Node with no
  types on purpose. `tools/import-specifiers.ts` drops a computed edge — the
  only honest thing a specifier reader can do — and every boundary rule is a
  rule about specifiers, so one such line anywhere would let any of them be
  broken with the suite still green. It was the only computed `import()` in the
  tree. Boundary rule 22 now bans the form, with a named allow-list of one and
  the reason beside it; `hasComputedImport` is what finds one, with its own
  tests and a fixture that rejects a production file and a test file alike.
- **Precedence.** The refusal happens before admission, so it outranks
  `shutting down`: a shutting-down Session answers a call with no description
  with `empty label`. Both start nothing, so what changes is which sentence a
  caller reads. Recorded in operation semantics §2 and in the matrix's **During
  shutdown** cell.
- **The sink.** `host/push-sink.ts`'s header carries the rule: a new state
  earns its place only if it changes whether a hand-off is unresolved,
  resolved, or failed, with batching metadata as the named example that does
  not, and Phase D's envelope named as the mechanism that therefore sits above
  the sink rather than inside it.
- `npm run check` green on the commit: 1300 tests, 0 failures, 8 skipped;
  conformance 191; `CODEX_PROTOCOL_CHECK_PASS — codex-cli 0.153.0`.

### 1. The tally is generated and the entry is small

`scripts/soak-tally.mjs` prints the three tables from Pi's session logs; a
resume it cannot resolve is listed, not dropped; a format change fails loudly.
`soak.md`'s tally section says it is generated and by what; its shutdown entry
is date, live backends, and the paste.

**Status:** PASS (2026-09-04).

- The script is [`scripts/soak-tally.mjs`](../../scripts/soak-tally.mjs): no
  dependencies, in neither `check` nor `release:check`, and not an operator
  command. `node scripts/soak-tally.mjs 2026-08-31` reads the maintainer's own
  Sessions from the release-candidate window and prints the three tables, an
  unattributed list of five starts naming Profiles no longer on disk, and
  `Sessions read: 80`. Those Sessions are not soak evidence — wrong build —
  but they are what the script was developed against, and the `<since-date>`
  is what will keep them out of the soak's tally.
- Attribution, the unattributable id, the switch, and the format-change failure
  are covered by [`scripts/soak-tally.test.mjs`](../../scripts/soak-tally.test.mjs)
  on the two synthetic Sessions under `scripts/fixtures/soak-tally/`. Eight
  tests; `npm run check` green.
- [`soak.md`](soak.md)'s tally section names the command that generates the
  tables and carries a **Last pasted** line; its *Reading the probes at each
  shutdown* section is now *Writing a shutdown entry* with the three-line form.
- One decision the plan did not settle: a switch is counted under the backends
  the Session that was switched *to* had open, not under the union of it and
  the Session before it. The record calls a switch a property of one Session,
  and the union would let a backend record more switches than it ever had
  Sessions. The other side of the switch is already counted as the earlier
  Session's shutdown.
- One place the plan and the ticket disagreed: this document said an
  unresolvable resume is "counted under *unknown* and listed", and the ticket
  said it "appears in the *unattributed* list … and in no table". The ticket
  won. An `unknown` row in a per-backend table would be a fourth backend that
  does not exist, and the exit gate reads those tables per backend; the list is
  where a reader is meant to look, and `soak.md` now says a long one is a
  reason to distrust the tables above it.
- **The result prose is a format too, and it is checked.** The code review's
  spec axis found that ids are read out of the tool result's sentences, so a
  reworded `Started …` would have left every later resume, steer and cancel
  unresolvable — arriving in the record as a smaller tally rather than as an
  error, which is the one failure the script exists to refuse. A start's or a
  resume's result must now open with one of the sentences
  `presentation/prose.ts` actually produces, and one that says a Run started
  must carry its ids; anything else throws with the file, the line, and where
  to go and look. Writing the check found a real gap in the list — a start
  refused with `Unknown agent: …` opens with neither `Started ` nor
  `Cannot start ` and is not an error result — which is the check earning its
  place on the first run. Covered by `a result whose wording has changed fails
  loudly, naming the file and the line`.

### 2. The soak's exit criteria are met

Every operation on every backend at least three times across at least five
distinct days on the Phase C build; every shutdown entry reads zero on every
probe or a defect explains why; no open severity-1 or -2 defect; every
severity-3 fixed or marked intentional. The tally in the record equals the
script's output on the closing day.

**Status:** OPEN.

### 3. The coexistence record passes

One evidence block for the pinned Codex CLI with PASS at every required
checkpoint; `npm run codex:retained-release:check` exits 0.

**Status:** PASS (2026-09-04).

The maintainer ran `CODEX_DESKTOP_COEXISTENCE_PROBE=1 npm run codex:smoke`
from this repository with a Codex Desktop conversation open on the same
project, and answered a Desktop prompt at each of the four checkpoints: before,
at the retained-idle pause, at the active-Turn-2 pause with the overlap
observed rather than inferred, and after cleanup. All four passed and no stray
or corrupted thread appeared. The record is the `2026-09-04 — codex-cli
0.153.0` block in [the coexistence document](../codex-desktop-coexistence-release.md);
the gate's log is
[`codex-coexistence-evidence/2026-09-04-codex-cli-0.153.0-smoke.txt`](../codex-coexistence-evidence/2026-09-04-codex-cli-0.153.0-smoke.txt),
carrying `CODEX_LIVE_SMOKE_PASS`, the nondiscoverability line against the
same Codex home, and descendant cleanup for both Sessions.
`npm run codex:retained-release:check` reports
`CODEX_RETAINED_RELEASE_CHECK_PASS — codex-cli 0.153.0`.

### 4. The end-state test is recorded

Both plans recorded verbatim below, with the roadmap's should and should-not
lists checked against each.

**Status:** PASS (2026-09-04).

Two fresh Claude Opus 5 agents, one request each, no conversation context and no
knowledge of the lists their plans would be checked against, reading the tree at
`eca109b`. Both plans are recorded in full under [The end-state test, as
recorded](#the-end-state-test-as-recorded), each followed by §7's should-list and
should-not-list checked line by line. Both pass: every should-line appears in its
plan, and no should-not module appears in either. The repository was unchanged by
the run.

**No should-not module appeared, so this item names no violation.** Five findings
came out of the test beside it, listed at the end of that section: the second
request had already been granted by Phase A, so half the test measured navigation
rather than change; `change-recipes.md`'s *Add a backend* recipe names
`runtime/composition.ts` as expected to change when it does not, and
`change-surface.md`'s R5 rows repeat the error; `host/production-backends.test.ts`
uses `"gemini"` as its example of a backend that does not exist; a fourth backend
owning a process would relax the `node:child_process` fence; and an empty
description produces `Subagent "" completed in …`. The second is fixed here, in
`change-recipes.md`; the fifth is carried to
[#3](https://github.com/goofansu/pi-subagent/issues/3) for 2.0.x; the rest are
recorded, not actioned.

### 5. Every Phase D item has a recorded decision

Three items, each *scheduled* or *deferred* in the roadmap, each with the
reading from the soak that decided it and, if deferred, the date of the next
reading.

**Status:** OPEN.

### 6. The programme's documents are split

Banners on every historical document; the change-surface method in the
contributor rules; the simplification roadmap's status reads closed.

**Status:** OPEN.

### 7. `release:check` is green on the tagged commit

`npm run release:check` exit 0 on the commit tagged `v2.0.0`, run after the
last code change, with the six lane markers and the retained-release marker
recorded here and the six lane markers recorded in the Phase C gate's item 14.

**Status:** OPEN.

### 8. The contracts are frozen and the roadmaps are final

The matrix's status reads frozen at 2.0 with the change rule; the README's
install and rollback paragraphs are current; the v2 roadmap's items 10 and 12
carry their final wording. Every finding marked *carried to a 2.0.x issue* in
this document — at this writing, the empty-label notice (end-state finding 5)
— links to an open issue.

**Status:** OPEN. Finding 5 is linked to
[#3](https://github.com/goofansu/pi-subagent/issues/3), which E0 fixes before
the soak rather than carrying to 2.0.x; the remaining contract and roadmap
work waits on E2 as sequenced above.

## Risks

| Risk | Mitigation |
| --- | --- |
| The soak log stays empty a third time | E1 removes the writing; what remains is one pasted block per shutdown. If a day's usage happened and no entry exists, the script still counts the operations, and the gate says which shutdown readings are missing. |
| The soak finds a severity-2 defect after Phase C closed | The fix lands, has a test, and the soak restarts its day count on the fixed build. The record already says a fix that landed after the last day has not been soaked. |
| Phase D gets scheduled on a feeling | E5 applies written rules to written numbers, and the rules were written before the numbers existed. |
| The coexistence record never gets its hour | It is on the critical path of `release:check` and this document says so; it cannot be waived by an agent, only performed by a person. |
| Pi's session format changes under the script | The script fails on a missing field rather than undercounting, and it is tooling outside `check`, so the product is unaffected. |

## The end-state test, as recorded

**Run 2026-09-04.** Two fresh agents, one request each. Neither was given the
other's request, neither was given any conversation context, and neither was
told anything about the simplification programme or that its plan would be
checked against a list. Both were Claude Opus 5, run as Claude Code
`general-purpose` subagents, reading the repository at `eca109b`.

`eca109b` is the tree that ships. The last commit to touch `extensions/` before
it is `4f4b13c`, which settled the Phase C code review; everything after that is
this phase's tooling and documents. So the tree each agent read is the Phase C
tree for every purpose this test has.

Each was told: produce a plan naming the files it would touch, say for each
whether it would create or modify it and in one line what the change is, list
separately anything it considered and decided *not* to touch, and edit nothing.
Nothing in the repository changed — `git status` was clean before the two agents
started and clean after both had reported.

The two plans follow verbatim, including their own heading levels, which are the
agents' and not this document's.

---

### Request 1 — "Add `gemini` as a backend that supports resume and steering."

# Plan: add `gemini` as a fourth backend with resume and steering

## Framing, and one thing found before planning

This exact request is already written into the repository. `docs/v2-simplify/roadmap.md` section 7, "The end-state test", quotes the sentence verbatim and states what a plan for it should and should not contain. Separately, `docs/v2-simplify/change-surface.md` carries a representative change "R5 — add a fourth backend that supports resume and steering", with a target of **zero generic-lifecycle modules and eight to twelve production modules in total**, and a written module list checked against the "Add a backend" recipe in `docs/v2-simplify/change-recipes.md`. The obligations a new backend owes are enumerated in `docs/contributing.md` under "Adding a backend". The plan below follows those three documents rather than inventing a shape, and it comes to eleven new production modules plus one modified one.

There is also a small naming collision to know about up front: `extensions/subagent/host/production-backends.test.ts` currently uses the literal string `"gemini"` as its example of a backend that does not exist, to prove that an unknown name is a diagnostic rather than a crash. That fixture has to be renamed to some other non-existent backend, or the test starts asserting the opposite of what it means.

## The decision that must be settled before any code is written

The request names two capabilities, `resume` and `steer`, and the second is not currently known to be available.

The intended provider surface is the Gemini command-line tool run in its Agent Client Protocol mode (`gemini --experimental-acp`, also spelled `--acp`), which speaks JSON-RPC 2.0 over standard input and output. That makes it a close structural twin of the existing Codex adapter, which drives `codex app-server` the same way, and it means the ownership model the repository already assumes — one child process and one conversation held for the life of a Subagent, one provider turn per Run — transfers directly.

Resume is straightforward under that model: a second prompt on the retained session, exactly as the Codex adapter issues a second turn on its retained root thread. The protocol's `loadSession` method is not needed and should not be used, for the same reason ADR-0021 rejected a stored rollout for Codex.

Steering is the open question. The published Agent Client Protocol method set is `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, and `unstable_setSessionModel`. There is no documented method for delivering guidance to a turn that is already running, and no documented statement that a second prompt may overlap an active one. Codex has `turn/steer` with an `expectedTurnId`, and the Claude adapter has a client-owned input stream; the Gemini adapter has no known equivalent.

So the first deliverable is a spike, following the precedent of the three existing ones in `docs/v2/spikes/`. It must answer one question against a real installation: can a client deliver a message into a turn that is already in progress, and does the agent echo it back in a way that correlates to what was sent? The repository's rule, stated in `backend/codex/execution.ts` and enforced by the conformance suite, is that guidance becomes a user entry in the transcript only when the provider confirms it — "a transcript showing guidance the model never saw is the one lie this seam must not tell."

The spike has three possible verdicts, and each changes the plan below:

- **Mid-turn guidance exists and is confirmed.** The plan proceeds as written, and the backend declares `steer: true`.
- **Guidance can only be queued for the next turn.** Declaring `steer: true` would be a lie at the seam. The honest answer is `steer: false`, the six steering scenarios in the conformance suite skip because the declared capability drives them, and the delivered backend does not satisfy the request as worded. That is a finding to take back, not something to paper over in the adapter.
- **The protocol mode is unusable for this purpose.** Reconsider the provider surface before writing an adapter.

Everything below assumes the first verdict.

## Files to create

### The adapter — `extensions/subagent/backend/gemini/`

Eleven production modules, mirroring the Codex adapter's eleven, because the provider shape is the same one.

| File | Create/Modify | The change |
| --- | --- | --- |
| `extensions/subagent/backend/gemini/index.ts` | Create | The adapter's only public surface: the factory, the backend id, the options type, and the probe, which is all the composition root may name. |
| `extensions/subagent/backend/gemini/backend.ts` | Create | The `Backend` contract member: the id `gemini`, `validateProfile`, and `open`, returning a handle that also carries the probe and the tally. |
| `extensions/subagent/backend/gemini/agent.ts` | Create | The Subagent-scoped `BackendAgent`: it declares the capabilities, owns the retained process and session, answers `admitResume` synchronously from its own state with no provider call, and closes idempotently. |
| `extensions/subagent/backend/gemini/execution.ts` | Create | One Run as one prompt turn: it consumes the control feed serially, races the turn's completion against process loss, and returns a `TerminalBundle` without ever settling its own Run. |
| `extensions/subagent/backend/gemini/translate.ts` | Create | Turns the agent's session-update notifications into domain observations, redacting provider identities and bounding every text field. |
| `extensions/subagent/backend/gemini/profile.ts` | Create | Profile validation: which of the four shared fields Gemini can express, its own model rule, and how the Profile's prompt is composed into the first turn. |
| `extensions/subagent/backend/gemini/probe.ts` | Create | What the adapter is still holding — live processes, reader fibers, pending requests, retained sessions, guidance in flight — plus the tally of opens, closes, and misrouted frames. |
| `extensions/subagent/backend/gemini/process.ts` | Create | Spawns the command-line tool behind a narrow interface of about nine members, so a test double is a drop-in and no production line branches on being under test. |
| `extensions/subagent/backend/gemini/transport.ts` | Create | The JSON-RPC framing over the child's streams, with a per-request time budget, a line-length bound, and the graceful-then-`SIGTERM`-then-`SIGKILL` shutdown ladder. |
| `extensions/subagent/backend/gemini/protocol.ts` | Create | The protocol's request parameters and notification shapes, with decoders, so no provider wire object crosses the adapter boundary. |
| `extensions/subagent/backend/gemini/reader.ts` | Create | The Subagent-scoped reader that owns the child's output stream for the agent's whole life and routes each frame to the Run that owns it. |

Four adapter-local test files alongside them, matching what the Codex adapter has: `profile.test.ts`, `protocol.test.ts`, `transport.test.ts`, and `translate.test.ts`.

### The test doubles and the conformance lane — `extensions/subagent/testing/`

| File | Create/Modify | The change |
| --- | --- | --- |
| `extensions/subagent/testing/gemini/stand-in-acp-agent.ts` | Create | A scriptable fake agent that speaks the real protocol over the same narrow process interface, so the production adapter runs with no credentials, no quota, and no real time passing. |
| `extensions/subagent/testing/gemini/stand-in-acp-agent.test.ts` | Create | Tests the double itself, because a double nobody checks is a double that quietly stops matching the provider. |
| `extensions/subagent/testing/gemini/conformance-rig.ts` | Create | Exports `geminiConformanceRig()` and `geminiConformanceSkips()`; builds the real adapter with the stand-in injected, and supplies one fixture for each of the thirty-seven shared scenarios. |
| `extensions/subagent/testing/gemini/gemini-rig.ts` | Create | The Session wiring for the backend's own non-conformance tests, following `testing/codex/codex-rig.ts`. |
| `extensions/subagent/testing/gemini/gemini-backend.test.ts` | Create | The adapter's own behaviour: what opening does, that a resumed turn runs on the retained session, that guidance becomes a user entry only on confirmation, and that a dead process loses the conversation permanently. |
| `extensions/subagent/testing/conformance-gemini.test.ts` | Create | Roughly thirty lines of boilerplate: assert the skip list is empty and then hand the rig to `runBackendConformance`. |

### The live gate and the written record

| File | Create/Modify | The change |
| --- | --- | --- |
| `scripts/gemini-live-smoke.mjs` | Create | The credentialed runtime gate: drives a real Session over the real adapter through start, resume, steer, cancel, timeout, and shutdown, reads every probe after the Session scope closes, and prints one exact success marker. |
| `docs/v2/spikes/gemini-backend-api-risk.md` | Create | The spike's verdict, in the form the three existing spike documents use, section by section for open, run, resume, steer, cancel, loss, close, and usage. |
| `docs/adr/0036-<gemini-posture-and-retention>.md` | Create | The trust posture, environment inheritance, and conversation-retention model, following ADR-0009 and ADR-0021; and, if the boundary rule below is widened, the record of what property that gives up. |

The highest existing decision record is `0035`, and the directory has no index or template file, so `0036` is the next number. Whether this is one record or two is a judgement call: the precedent is one per surprising property, not one per backend. If the boundary rule for spawning child processes is widened, `docs/contributing.md` makes a record mandatory rather than optional — it requires one for "any relaxation of a boundary rule".

## Files to modify

### Production code — one file

| File | Create/Modify | The change |
| --- | --- | --- |
| `extensions/subagent/host/production-backends.ts` | Modify | Construct the Gemini backend, add it to the set's backend list, add a `gemini` key to the options type, and add its probe block. |

That is the whole production cost outside the adapter directory, and it is the claim the seam is measured by.

### Tests and fences

| File | Create/Modify | The change |
| --- | --- | --- |
| `extensions/subagent/boundaries.test.ts` | Modify | Add the adapter and testing directory roots to both graph builders, add a named list of the test files allowed to import the adapter, add the two-directional confinement rule copied from the Codex one, and add a negative fixture for each new rule. |
| `extensions/subagent/host/production-backends.test.ts` | Modify | Extend the three assertions that spell the backend set out by hand, rename the `"gemini"` unknown-backend fixture to some other non-existent name, and add an end-to-end test for a Profile naming `gemini`. |

Two existing fences need real thought rather than mechanical extension, and both belong in the decision record:

The first is the rule that only the Codex adapter may import `node:child_process`, whose stated property is "the one backend that owns an operating-system process owns all of it". A Gemini adapter that spawns the command-line tool makes that property false. Widening the rule to admit a second directory is the honest move, but `docs/contributing.md` says that if a rule is in your way you must name the property you are giving up — here, that a single directory owns every process the extension starts.

The second is the provider software-development-kit deny list, currently the prefixes `@anthropic-ai/` and `@openai/`. If the adapter drives the command-line tool as a subprocess it imports no such package and none of this is needed for correctness; adding `@google/` to the deny list anyway is one line and one fixture, and it keeps the fence ahead of the next contributor rather than behind them.

### Lanes and gates

| File | Create/Modify | The change |
| --- | --- | --- |
| `package.json` | Modify | Add `gemini:smoke` and `gemini:host-smoke`, add the new conformance test file to the explicit `test:conformance` list, which does not glob, and add both gates to `release:check`. |
| `Makefile` | Modify | Add a `smoke-gemini` target, add it to `.PHONY`, and correct the two comments that say "all three real adapters" and "one target per backend". |
| `scripts/pi-host-live-smoke.mjs` | Modify | Add `gemini` to the allowed-backend set on line 32, and add a branch to the model-selection chain on lines 55 to 60 if Gemini has its own model-name vocabulary. The rest of the script is already backend-agnostic. |
| `scripts/soak-tally.mjs` | Modify | Add `gemini` to the hard-coded `KNOWN_BACKENDS` list, so the soak's per-backend table exists even before anyone has run one. |
| `scripts/soak-tally.test.mjs` | Modify | Extend the backend list its fixture builds over. |

### Documentation kept current

| File | Create/Modify | The change |
| --- | --- | --- |
| `README.md` | Modify | Add a fourth column to "What each backend reads" and "Model and effort resolution", a fourth row to "What each backend retains", the backend name to the opening sentence, and the new gate to "Release verification" — where the counts "six live gates" and "seven credentialed gates" both move. |
| `docs/v2/compatibility-matrix.md` | Modify | Add a Gemini column to all twenty-three per-backend tables, in both the expected-outcome and the proof tables, with every proof cell citing a test that exists. This is by far the largest single piece of writing in the change. |
| `CONTEXT.md` | Modify | Extend the `Backend` glossary entry, add a `Gemini adapter` entry beside the three existing ones, and fix the `Claude adapter` entry, which says "the other two adapters". |
| `docs/architecture.md` | Modify | Update the one-sentence description, the adapter list in the map diagram, the count in section 9, and section 10's rule arithmetic, which explains that the table has nineteen rows because three confinement rules say one thing about three adapters. |
| `docs/contributing.md` | Modify | Update the rule count under "The boundary rules" if a rule is added, and record the widened process rule. |
| `docs/debugging.md` | Modify | Add a fourth bullet under "Each backend's probe" and update the live-gate list and its count. |
| `docs/v2/soak.md` | Modify | Add a Gemini tally table and a "what to watch for" section, since the exit criteria are per backend. This document is currently open. |
| `docs/v2-simplify/change-surface.md` | Modify | Append a new measured reading for R5. Do not rewrite the recorded ones — the existing block is a dated measurement and the document's own convention is to add rather than replace. |
| `docs/v2-simplify/change-recipes.md` | Modify | Correct the "Add a backend" recipe, which lists `runtime/composition.ts` under "expected to change". It does not change; see below. The document's own header says a recipe that misnames a file is a bug in the document. |

## Files considered and deliberately not touched

The absences are the point of the exercise, so each is given its reason.

**`extensions/subagent/runtime/composition.ts` — no change, despite the recipe saying otherwise.** The "Add a backend" recipe names it under registration, but the module takes a list of backends and knows none of them by name; the backend set is a plain value handed in from the host. The measured R5 entry in `change-surface.md` agrees and says so explicitly. The recipe is simply stale here, which is why it appears in the modify list above as a documentation correction rather than a code change.

**`extensions/subagent/domain/ids.ts` — no change.** `BackendId` is a branded string with a deliberate comment saying it is not an enumeration, so a new backend name needs no central registration. `DEFAULT_BACKEND_ID` stays `pi`.

**`extensions/subagent/domain/profile.ts` — no change.** The Profile parser understands only `description`, `backend`, and the body. It does not check the backend name against a list; an unknown one becomes a diagnostic downstream in `backend/catalog.ts`, which is a map lookup and also needs no change.

**`extensions/subagent/backend/contract.ts` — no change, and this is the load-bearing absence.** `BackendCapabilities` already has `resume` and `steer` as declared booleans, `ResumeAdmission` already has its three answers, and `ControlFeed` already delivers guidance serially. The request asks for two capabilities the contract was built to express. If any of this needed widening, the seam would be wrong and the work should stop.

**`extensions/subagent/backend/profile-fields.ts` — no change expected.** The four shared Profile fields are `model`, `effort`, `tools`, and `appendSystemPrompt`, and a backend narrows that set rather than adding to it. A field only Gemini understands belongs in `backend/gemini/profile.ts`. Only a genuinely fifth shared field would touch this module, and there should not be one.

**Everything under `extensions/subagent/runtime/` — no change.** Not the supervisor, the repository, the result store, delivery, admission, arbitration, the subagent records, or the waiter ledger. None of them can name a backend and the confinement rules are what say so. A supervisor branch on a backend's name is the specific outcome the roadmap's end-state test says a plan must not contain.

**Everything under `extensions/subagent/domain/` — no change.** No new Run phase, no new observation kind, no new snapshot or projection field, no new Result field. If Gemini needed one, the correct response would be to widen it for all backends with its own decision record, not to add it for this one.

**Everything under `extensions/subagent/presentation/` — no change.** The one place a backend is named is a comment in `renderers.ts` explaining why cost is not displayed, since the Codex server reports no cost and the other two do. That comment becomes worth revisiting only if Gemini reports cost, which is a display question to settle after the spike, not a prerequisite.

**`extensions/subagent/host/tools.ts`, `tool-schemas.ts`, `tool-copy.ts`, `agents-command.ts`, `diagnostics-command.ts`, `widget.ts`, `session.ts`, and `index.ts` — no change.** The tool descriptions the model reads are backend-neutral prose. The diagnostics command's `AdapterProbe` is a `Record<string, CountBlock>` keyed by whatever the set supplies, so a fourth probe block appears in the report with no code change at all. The entry point calls `createProductionBackendSet()` with no arguments.

**`extensions/subagent/host/pi-backends.ts` and `host/demo-backends.ts` — no change.** These are a milestone-era single-backend set used by one live script and one guard test, and a two-fake demo set used by tests. Neither is the production composition root.

**`extensions/subagent/packaging.test.ts` — no change.** Despite naming Codex in a comment, it asserts only on the manifest, the version, the pinned Effect release, and two strings in the README. It says nothing about which backends exist.

**`extensions/subagent/backend/depth.ts` — no change.** The delegation-depth environment variable is deliberately shared across every backend, so that a shell-launched grandchild reads the same key whichever adapter spawned its parent. The Gemini adapter reads and sets the existing key rather than introducing a second one.

**`extensions/subagent/backend/native-bridge.ts` — no change expected.** It exists for providers that hand an adapter a plain callback with no way to apply back-pressure. A protocol read from a stream can be awaited, so the Gemini adapter should not need it — the same as Codex.

**`extensions/subagent/presentation/rows.test.ts`, `presentation/notification-text.test.ts`, and `host/agents-command.test.ts` — no change.** Each maps over a list of backend names, but each is generic over its own list rather than asserting that exactly three exist. Adding a fourth entry would produce more test cases without testing anything new.

**Everything Codex-specific in `scripts/` — no change.** That is `check-codex-protocol.mjs`, `check-codex-retained-release.mjs`, `codex-smoke-contract.mjs`, `codex-retained-release-contract.mjs`, and their tests, along with `.agents/skills/codex-upgrade/SKILL.md`. These pin one command-line tool's protocol schema byte for byte and record human evidence about coexisting with a desktop application. The *pattern* in `codex-smoke-contract.mjs` — lifting the deterministic reasoning out of a credentialed script into a module that can be tested without spending money — is worth copying if the Gemini gate grows a comparable claim. Nothing in the content transfers.

**All thirty-five existing decision records, the milestone exit gates `m0` through `m7`, the three phase exit gates, `docs/v2/freeze.md`, `docs/v2/deletion-ledger.md`, `docs/v2/v1-inventory.md`, `docs/v2/presentation-ledger.md`, `docs/v2-simplify/presentation-ledger.md`, `docs/v2/cutover-blockers.md`, `docs/v2/m4-live-findings.md`, and the three existing spike documents — no change.** These are dated records. The rule in `docs/contributing.md` is that a decision record is never rewritten; a superseded one gains a status note pointing forward. Several of them contain sentences like "Pi, Claude, and Codex", and those sentences were true when they were written and stay as they are.

**`docs/v2-simplify/freeze.md` — no change.** Its rows are keyed to invariants rather than to backends, and the relevant one, F7, names the capability set rather than enumerating the adapters.

**`docs/v2/operation-semantics.md` — no change.** It is genuinely backend-neutral and enumerates no backends.

**`biome.json`, `tsconfig.json`, `tools/`, and `.husky/` — no change.** None of them enumerates a backend. The one mention in `biome.json` excludes the vendored Codex protocol schema from linting, which is about that pinned file rather than about the set of backends.

## Order of work, and the gates each step must pass

1. Run the spike and write `docs/v2/spikes/gemini-backend-api-risk.md`. If steering has no confirmed mechanism, stop and report that before writing an adapter.
2. Write the decision record covering the trust posture, environment inheritance, and conversation retention, and the boundary-rule relaxation if one is needed. The repository's convention is that the record comes first.
3. Build the adapter directory and the test double together, with the double injected through the adapter's own spawn point rather than through a test-only branch.
4. Wire the conformance rig and get all thirty-seven scenarios passing with an empty skip list. A skip that a declared capability does not drive means the backend is not finished.
5. Add the boundary rules and their deliberately-violating fixtures, then extend the production backend set and its tests.
6. Write the live gate and add both lanes to the build files.
7. Write the documentation, with the compatibility matrix last, so that every proof cell can cite a test that already exists and passes.

`npm run check` — typecheck, lint, the deterministic suite, the conformance suite, and the pinned protocol check — must pass at every commit. The two credentialed gates stay out of it and join `npm run release:check`.

Sources: [Gemini CLI ACP mode documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md), [ACP Mode | Gemini CLI](https://geminicli.com/docs/cli/acp-mode/), [Gemini CLI - ACP Agent | Zed](https://zed.dev/acp/agent/gemini-cli)

---

#### Checked against §7, line by line

§7 says the plan **should** list four things.

| §7's line | What the plan says | Verdict |
| --- | --- | --- |
| `backend/gemini/*` | Eleven production modules under `extensions/subagent/backend/gemini/`, plus four adapter-local test files. | Listed. |
| The backend set and composition registration | `host/production-backends.ts`, one file, called "the whole production cost outside the adapter directory". `runtime/composition.ts` is listed as **not** changing, with the reason that it takes a list of backends and names none. | Listed, and sharpened — see finding 2. |
| A conformance adapter | `testing/gemini/conformance-rig.ts` and `testing/conformance-gemini.test.ts`, with the rule that a non-empty skip list means the backend is not finished. | Listed. |
| A live gate | `scripts/gemini-live-smoke.mjs`, the `gemini:smoke` and `gemini:host-smoke` lanes in `package.json`, and a `smoke-gemini` target in the `Makefile`. | Listed. |

§7 says the plan **should not** list five things.

| §7's line | What the plan says | Verdict |
| --- | --- | --- |
| A new Run phase | Absent. `domain/` is named under "deliberately not touched" with "no new Run phase" spelled out. | Not listed. |
| New `ResultStore` logic | Absent. The result store is named among the runtime modules that do not change. | Not listed. |
| New delivery logic | Absent. Delivery is named among the runtime modules that do not change. | Not listed. |
| New widget semantics | Absent. `host/widget.ts` is named among the host modules that do not change. | Not listed. |
| A supervisor branch on the backend's name | Absent, and the plan names it as the specific outcome the end-state test forbids. | Not listed. |

**Verdict: PASS.** Every should-line appears; no should-not module appears. The
plan reached one file of production code outside the adapter directory, which is
the number `change-surface.md`'s R5 row targets.

---

### Request 2 — "Show the task label in the completion notification."

# Plan: show the task label in the completion notification

## Outcome first

**No code change is required. This is already implemented, end to end, and covered by tests.** In this repository the thing the request calls the "task label" is called the **Label** — `CONTEXT.md` lines 46-60 define it as the Run's one-line description, the value a caller passes as `description` to `agent_start` or `agent_resume`. It already appears on both faces of the completion notification.

The two faces, and where each one prints it:

1. **The expanded notice text** — the sentence the model reads. `/Users/james/code/pi-subagent/extensions/subagent/presentation/notification-text.ts` line 71 builds the header as `Subagent "<label>" completed in 12.4s.` The label is the first thing in the notice, ahead of every identifier, and that ordering was deliberate: the module's own header comment explains that a parent running several subagents reads the label to know *which* delegation finished, and reads an identifier only when it is about to make a tool call.

2. **The collapsed transcript line** — what a human sees in the conversation before expanding. `/Users/james/code/pi-subagent/extensions/subagent/presentation/renderers.ts`, function `formatNotificationSummary` at line 304, renders `<agent> · <label> · <verb> in <duration>`, fitting the label to the live terminal width and capping it at 48 columns (`MAX_NOTICE_LABEL_WIDTH`, line 267).

The supporting plumbing is likewise in place. The domain value `RunNotification` carries a `label` field, set in `toRunNotification` at `/Users/james/code/pi-subagent/extensions/subagent/domain/notification.ts` line 219 by re-applying the one-line, 200-byte bound to the stored Result's `description`. The host message payload carries it too, at `/Users/james/code/pi-subagent/extensions/subagent/host/notification-message.ts` line 95, so the renderer never has to parse it back out of the prose.

This was decided and landed in ADR-0033, at `/Users/james/code/pi-subagent/docs/adr/0033-notification-vocabulary-pointer-and-label-bound.md`, and shipped in commit `2d6269f`, whose subject is literally "a bounded Run label, from admission to the notice header".

## Files I would create or modify

None.

If I were asked to do this work as stated, the correct deliverable is a verification rather than a patch. I would run the two existing test lanes and report that they pass:

- `/Users/james/code/pi-subagent/extensions/subagent/presentation/notification-text.test.ts` — tests `N-1`, `N-2` and `N-8` each assert the exact header string `Subagent "look around" completed in 12.4s.`, so the label's presence in the notice text is pinned by golden.
- `/Users/james/code/pi-subagent/extensions/subagent/presentation/renderers.test.ts` — roughly ten cases around lines 290-460 exercise `formatNotificationSummary`, including how the label is truncated and how it drops out entirely on a terminal too narrow to hold it.

## Files I considered and decided not to touch

These are the ones where the decision was not obvious, and why it went the way it did.

**`/Users/james/code/pi-subagent/extensions/subagent/presentation/completion-view.ts`** — this looked like the natural place to add a label, because it is the single view that the notice, the widget's settled row, and the result card all derive from. It already has a `label` field, and `completionViewOfNotification` populates it. Adding anything here would duplicate what exists.

**`/Users/james/code/pi-subagent/extensions/subagent/application/subagents.ts`** — the `labelled` helper at line 81 is where a caller's `description` becomes the Run's bounded label, before admission. This is the single point where the bound is applied, by design: ADR-0033 rejected applying it later, in the domain's `toRunResult`, on the grounds that three downstream surfaces would then each have to re-apply it. Nothing needs to change here, and changing it would be the wrong place regardless.

**`/Users/james/code/pi-subagent/extensions/subagent/host/tool-schemas.ts`** — lines 81-82 and 91-92 already describe the `description` field to the model as "Label for this specific Run", with the byte bound spelled out. A model reading the schema already knows the field is what will be shown.

**`/Users/james/code/pi-subagent/extensions/subagent/runtime/delivery.ts`** — the push path. I checked it because a notice that is stored, lost, and re-pushed could in principle lose fields on the way. It cannot: the notice is reconstructed from the stored Result through `toRunNotification`, which sets the label every time.

**`/Users/james/code/pi-subagent/CONTEXT.md`** — its Notification entry, around line 129, already states that the notice "opens with the Run's **Label**". The documentation and the code agree, so there is nothing to correct.

## One genuinely open edge, if the request meant something narrower

There is a single case where the label is present but reads badly, and it is the only thing I found that could be called a gap. The `description` field is declared as a plain required string in the tool schemas, with no minimum length, and `boundRunLabel` (at `/Users/james/code/pi-subagent/extensions/subagent/domain/result.ts` line 56) shortens but never substitutes. So a caller that passes an empty description produces a notice whose header reads `Subagent "" completed in 12.4s.` and whose collapsed line reads `explore ·  · completed in 12.4s` with a hollow middle segment.

I would not fix that under this request, because it is a different request — it is about a missing label rather than a hidden one, and the fix is a policy decision about what an empty label should fall back to, not a display change. If someone confirms that is what was actually meant, the change would be one file: modify `/Users/james/code/pi-subagent/extensions/subagent/domain/result.ts` so that `boundRunLabel` returns a fixed placeholder for an empty or whitespace-only description, keeping the substitution in the same single place the bound already lives.

---

#### Checked against §7, line by line

This plan answers "already done", so what the check measures is where the agent
*located* the behaviour rather than what it would edit. §7's lists still read
against it, because the modules it names are the modules it says hold the label.

§7 says the plan **should** list three things.

| §7's line | What the plan says | Verdict |
| --- | --- | --- |
| `domain/notification.ts` | Named, at line 219, as where `toRunNotification` sets `label` by re-applying the bound to the stored Result's description. | Listed. |
| `presentation/notification-text.ts` | Named, at line 71, as where the label opens the notice sentence, with the header comment's reason quoted. | Listed. |
| The presentation tests | `presentation/notification-text.test.ts` (goldens `N-1`, `N-2`, `N-8`) and `presentation/renderers.test.ts` (the collapsed line and its truncation). | Listed. |

§7 says the plan **should not** list three things.

| §7's line | What the plan says | Verdict |
| --- | --- | --- |
| The supervisor | Absent. Not named anywhere in the plan. | Not listed. |
| A backend | Absent. No adapter is named. | Not listed. |
| The store | Absent. `runtime/delivery.ts` is named, but only under "considered and not touched", and delivery is not the store. | Not listed. |

The plan also reaches two modules §7 does not mention — `presentation/renderers.ts`
and `host/notification-message.ts` — as the collapsed transcript line's half of the
notice. Both are exactly what [the change recipe *Add a field to the completion
notice*](../v2-simplify/change-recipes.md) lists for a field the collapsed summary
shows, so they are the recipe's cost rather than a leak.

**Verdict: PASS**, with the qualification in finding 1.

---

### Findings

No module from either should-not list appeared in either plan, so gate item 4's
should-not clause is empty. Five things the test turned up are recorded here
instead, each with what happens to it.

**1. The second request had already been granted, so half the test measured
navigation rather than change.** The label reached the notice in Phase A's A2 and
[ADR-0033](../adr/0033-notification-vocabulary-pointer-and-label-bound.md); §7
was written before Phase A ran. The agent found it in the two modules §7 names,
which is the result the test wanted, but no plan for a change was produced and so
nothing about the cost of making one was measured. This is a limit on what this
half of the test proves, not a defect. **No action** — rewriting §7 now would be
choosing the question after seeing the answer.

**2. `change-recipes.md`'s *Add a backend* recipe names a file that does not
change.** It lists `runtime/composition.ts` under **Expected to change**, for
registration. The module takes `readonly Backend[]` and names no backend;
`grep` for `pi`, `claude` or `codex` in it returns nothing, and registration is
`host/production-backends.ts` alone. `change-surface.md`'s R5 target row and its
measured row carry the same error. `change-recipes.md` is on §8's *permanent,
kept current* list and its own header says a recipe that misnames a file is a bug
in the document, so this is a live defect rather than history. **Fixed here** —
the recipe now names `host/production-backends.ts` alone and says why the other
module does not change. `change-surface.md`'s two R5 rows were left alone at
first, as a dated measurement that its own convention says to add to rather
than rewrite — then corrected, because they are not a superseded reading. That
document's own R5 section already reads **Nothing generic.** `runtime/
composition.ts` does not move: it takes a list of backends and knows none of
them by name, and names `host/production-backends.ts` as the one module outside
the adapter tree. The summary rows contradicted the detail beneath them, which
is a transcription error rather than an earlier measurement, so both now say
what the section says.

**3. `host/production-backends.test.ts` uses `"gemini"` as its example of a
backend that does not exist** (lines 171–177, `reason: "unknown backend
'gemini'"`). Adding the backend would make that test assert the opposite of what
it means. Harmless today. **Recorded so that whoever adds a fourth backend is not
surprised by it.**

**4. A fourth backend that owns a process would relax a boundary rule.**
`boundaries.test.ts` fences `node:child_process` to the Codex adapter, with the
message "only the Codex adapter may spawn a child process", and its stated
property is that the one backend owning an operating-system process owns all of
it. A Gemini adapter driving `gemini --experimental-acp` makes that false. §7's
should-not list is about modules and does not cover fences, so this is not a
should-not violation — but it is a real cost of the fourth backend that the
end-state test does not price, and `contributing.md` already requires the
relaxation to name the property it gives up. **Recorded as context; no action
before someone actually adds a backend.**

**5. An empty description produces an empty label in the notice.** Verified
directly: `boundRunLabel("")` and `boundRunLabel("   ")` both return `""`
(`domain/result.ts`), and `description` is declared in the tool schemas as a
plain required string with no minimum, so a notice can read `Subagent ""
completed in 12.4s.` and a collapsed line can read `explore ·  · completed in
12.4s`. Severity 4, a papercut, found by reading rather than by use.
**Fixed before the soak by [E0](#e0-the-last-code-before-the-soak) rather than
carried**, since the label is the first thing a parent reads in a notice and
the soak would otherwise run on a build with a known empty one:
[#3](https://github.com/goofansu/pi-subagent/issues/3) is closed by that
commit, and [gate item 0](#0-the-last-code-landed-before-the-first-soak-day)
records the evidence. It was not a soak defect — no soak Session produced one —
and it is not a Phase D item.
