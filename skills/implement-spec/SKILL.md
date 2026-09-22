---
name: implement-spec
description: Deliver an entire specification rather than an isolated change, using sequential implementers, per-ticket validation, and final whole-spec Spec and Standards reviews.
disable-model-invocation: true
---

# Implement a specification

Deliver the supplied specification on one branch. Use one implementation checkout and one implementation writer at a time. Tickets determine dependency order; they do not require parallel worktrees.

The main agent owns scope, ticket state, Git operations, and completion decisions. Delegate implementation to `implementer` and bounded investigation to `general-purpose`. Invoke `/skill:code-review` from the main agent for independent Spec and Standards reviews after all tickets are implemented; ticket completion uses local validation rather than dual reviews. Keep delegation at one level; do not ask an implementer to run the review skill.

Communicate through source paths, ticket references, commit hashes, and concise decisions. Include enough scope in each handoff to distinguish the current ticket from the whole specification. Do not assume any source template or generating skill.

## 1. Establish scope and checkout

Read the full specification, associated tickets, repository instructions, and applicable domain documentation. Honor the user's source precedence. Identify every required behavior, constraint, and required check. Verify that tickets collectively cover the specification; report uncovered requirements or contradictory scope instead of silently dropping them. If there are no tickets, treat the specification as one unit.

Before implementation, locate and read `/skill:code-review` and confirm that the `implementer`, `spec-reviewer`, and `standards-reviewer` Profiles are available. If the skill or any required Profile is unavailable, pause before starting tickets and report what is missing. Apply the invocation overrides in §5 when using the review skill.

Build the dependency graph and validate that all blockers exist and there are no cycles. Record each ticket as pending, active, blocked, or complete in a compact progress ledger. Follow the repository's issue-tracker conventions when updating actual tickets. A runnable ticket has all prerequisites complete. No frontier with unfinished tickets is a blocker, not completion.

Use a clean checkout on the user's requested branch, or create one implementation branch from the agreed starting point. Record its starting commit as the fixed review base. On an existing feature branch, resolve and record the intended PR base/merge-base so final review includes earlier feature work. Do not move this base after ticket commits.

If unrelated changes are present, preserve them and use one isolated checkout or obtain a clean starting point. Never stash, discard, or commit someone else's work merely to satisfy this workflow. This runtime starts Subagents in the Session's working directory: run the orchestration Session in the selected checkout before delegating. Changing a shell's directory or mentioning another path in a prompt does not rebind a Subagent. If the Session cannot move, report the selected checkout and resume this workflow from a Session there. Use absolute source and notes paths when they live outside that checkout. No per-ticket branches or worktrees are needed.

Keep the ledger and research notes outside the implementation diff unless they are intended deliverables. Record ticket assignments, prerequisite commits, check results, review dispositions, and successful commit hashes so the workflow can resume without guessing.

## 2. Investigate when needed

Use `general-purpose` for concrete questions about unfamiliar code, test seams, or conflicting evidence. Independent investigations may run in parallel, but ask them to inspect only. If persistent notes help, explicitly authorize a notes file outside the implementation diff and pass its path onward. Resolve investigation results before implementation when they affect its contract.

## 3. Implement one runnable ticket

Choose one unblocked ticket, using ticket order to break ties unless the user specifies a priority. Mark it active. Start an `implementer` with:

- the ticket's full source and the parent specification;
- the exact ticket scope and applicable shared constraints;
- prerequisite commit hashes and relevant investigation pointers;
- the selected checkout and focused tests to run during implementation, with repository completion checks reserved for the main agent in §4; and
- an instruction to leave all work uncommitted, including new files.

Keep its Subagent ID for revisions. Resume the same implementer within this ticket; start a fresh implementer for the next ticket with the committed prerequisites as context. If conversation state is unavailable, start a replacement with the sources, current changes, and outstanding findings.

No other agent edits the implementation checkout while this Run is active. A completed Run is only a signal to inspect its report. Unmet criteria, missing evidence, or failing checks go back to the implementer. A requirement decision that cannot be resolved from the sources pauses the workflow with the work preserved.

## 4. Validate and commit the ticket

After the implementer stops, inspect its report, `git diff HEAD`, and the full contents of in-scope untracked files identified by `git status --short --untracked-files=all`. On each validation round, account for every ticket criterion and applicable shared constraint across the entire current ticket scope, using the changes and check evidence. Return missing implementation, unmet criteria, or failing checks to the same implementer. If the same blocker survives two consecutive revision rounds without progress, report the stalemate and preserve the work rather than looping indefinitely.

As the main agent, run the required repository checks on the exact candidate and require them to pass before committing; serialize checks that share mutable fixtures or build outputs. Stage only in-scope files, including new files, inspect the staged diff, and commit the ticket with hooks enabled. If checks or hooks modify code, repeat ticket validation on the changed candidate before marking the ticket complete, even if the commit succeeded. Commit any remaining validated changes with hooks enabled. A failed commit does not complete the ticket.

Record the successful commit hash and confirm the checkout is clean before marking the ticket complete and unlocking dependents. Here, complete means implemented and locally validated; whole-spec acceptance remains pending the final dual review. For an already-satisfied ticket, record its prerequisite evidence instead of an empty commit.

Repeat from §3. If a blocker prevents further progress, leave the branch and uncommitted work intact and report what is complete and what remains. Do not start another ticket on top of unresolved changes.

## 5. Review the entire specification

Once every ticket is complete, run the full required integration checks. Route failures through the whole-spec revision sequence below and require checks to pass before review. Require a clean working tree for the initial committed review, then invoke `/skill:code-review`, supplying `git diff <recorded-base-sha> HEAD` as the exact diff command, `git log <recorded-base-sha>..HEAD --oneline` for orientation, and the whole specification and all relevant tickets as the acceptance boundary.

This review covers every ticket's behavior and shared constraints, cross-ticket interactions, omissions, and scope creep across the final branch. For every invocation, override the review skill's default diff and source discovery with the exact command and requirement sources supplied here, including any enumerated untracked files. Use the `spec-reviewer` and `standards-reviewer` Profiles for its two parallel reviewers. Follow the skill for standards discovery, its smell baseline, and separate reports. Use fresh reviewers each round and pass each only its own axis's prior findings and responses. Keep the checkout stable until review returns. Missing-input, failed, skipped, or incomplete review results do not satisfy the two-axis requirement.

Ask each axis to report coverage gaps explicitly rather than treating a truncated or partial review as clean. If the aggregate scope exceeds reviewer capacity, pause acceptance and agree a bounded review plan covering all requirements, changed files, and cross-ticket interactions. Keep this review at the whole-spec stage; late findings may require revising already-committed tickets and their dependents.

Spec blocking findings and Standards hard violations block acceptance. Non-blocking findings and smell judgement calls require a recorded disposition but do not automatically block. Keep the axes separate; neither report cancels the other's findings. Literal `clean` is not required when only accepted non-blocking findings remain.

Do not substitute the last ticket's diff or move the base to HEAD. If the skill reports an empty aggregate scope, explicitly explain whether the specification was already implemented; do not present an empty diff as a successful implementation review.

When both reviews are complete, required checks pass, and all findings are resolved or accepted as non-blocking, proceed directly to §6 if no revisions are needed.

If integration checks fail or review fixes are needed, start one implementer for a bounded whole-spec revision, supplying the specification, relevant tickets, check failures or actionable findings separated by axis, and resolution conditions. Require it to leave changes uncommitted. Resume that same implementer for subsequent revisions, using the replacement procedure in §3 if its Conversation is unavailable. Wait until its Run stops, inspect its report and changes, then run the required checks as the main agent and require them to pass before review.

Then invoke `/skill:code-review` with an explicit scope override: `git diff <recorded-base-sha>` plus the full contents of in-scope untracked files from `git status --short --untracked-files=all`, with the whole-spec acceptance boundary and prior findings and responses. Enumerate the exact additional file paths and exclusions, and pass this boundary to both reviewers instead of the skill's default committed-only diff. This reviews earlier commits together with uncommitted fixes and new files, not only the latest fix. Pass supported disagreements for reassessment, keeping each axis's findings and responses separate. Repeat the revision/check/review sequence until neither axis has unresolved blocking findings. If the same blocker survives two consecutive revision rounds without progress, report the stalemate and preserve the work.

If the revision sequence produced uncommitted fixes, once both axes have no unresolved blocking findings and required checks pass, stage only reviewed, in-scope files, including new files. Inspect the staged diff and confirm the candidate to be committed matches the reviewed candidate, then commit with hooks enabled. If checks or hooks modify code, validate and re-review the changed candidate. Record the successful commit hash and confirm the checkout is clean; an unchanged reviewed candidate needs no duplicate review merely because it was committed. Unexpected out-of-scope changes are a blocker to resolve or preserve separately, not a reason to include them in the commit. After accepted revisions are committed and the checkout is clean, proceed to §6.

## 6. Deliver

Report completed tickets and commits, required checks, both review outcomes, accepted non-blocking risks, and any unresolved work. Report the branch and checkout location. If a PR is part of the user's request, create or update it and mark it ready only after final checks and review pass. Otherwise hand back the reviewed branch. Preserve any checkout containing unresolved work; clean up temporary resources only when their useful work is safely retained.
