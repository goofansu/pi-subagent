---
name: implement-spec
description: Implement a specification and its ticket graph on one branch using sequential implementers, independent Spec and Standards reviews, and a final whole-spec review. Use when delivering an entire specification rather than one isolated coding change.
disable-model-invocation: true
---

# Implement a specification

Deliver the supplied specification on one branch. Use one implementation checkout and one implementation writer at a time. Tickets determine dependency order; they do not require parallel worktrees.

The main agent owns scope, ticket state, Git operations, and completion decisions. Delegate implementation to `implementer` and bounded investigation to `general-purpose`. Invoke `/skill:code-review` from the main agent for independent Spec and Standards reviews. Keep delegation at one level; do not ask an implementer to run the review skill.

Communicate through source paths, ticket references, commit hashes, and concise decisions. Include enough scope in each handoff to distinguish the current ticket from the whole specification. Do not assume any source template or generating skill.

## 1. Establish scope and checkout

Read the full specification, associated tickets, repository instructions, and applicable domain documentation. Honor the user's source precedence. Identify every required behavior, constraint, and required check. Verify that tickets collectively cover the specification; report uncovered requirements or contradictory scope instead of silently dropping them. If there are no tickets, treat the specification as one unit.

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
- the selected checkout and required checks; and
- an instruction to leave all work uncommitted, including new files.

Keep its Subagent ID for revisions. Resume the same implementer within this ticket; start a fresh implementer for the next ticket with the committed prerequisites as context. If conversation state is unavailable, start a replacement with the sources, current changes, and outstanding findings.

No other agent edits the implementation checkout while this Run is active. A completed Run is only a signal to inspect its report. Unmet criteria, missing evidence, or failing checks go back to the implementer. A requirement decision that cannot be resolved from the sources pauses the workflow with the work preserved.

## 4. Review the uncommitted ticket

After the implementer stops, invoke `/skill:code-review` with an explicit scope override: review `git diff HEAD` plus the full contents of all in-scope untracked files identified by `git status --short --untracked-files=all`. Supply the checkout, ticket and parent specification sources, prerequisite commits, and implementer's report. State that only this ticket's behavior and applicable shared constraints are required now. On re-review, also supply the prior findings and implementer's responses, separated by axis.

For this invocation, the supplied scope and requirement sources replace the review skill's default committed-only diff and source-discovery steps. Enumerate the exact additional file paths, state exclusions, and pass this boundary to both reviewers. No new commits is valid for a ticket review; use prerequisite commits for orientation. An empty tracked diff with new files is not empty scope. The review skill still owns standards discovery, its smell baseline, parallel `spec-reviewer` and `standards-reviewer` delegation, and separate reports. Use fresh reviewers each round and pass each only its own axis's prior findings and responses. Keep the checkout stable until it returns; no implementation or Git mutations run concurrently. Missing-input, failed, skipped, or incomplete review results do not satisfy this workflow's two-axis review requirement.

If the skill reports an empty scope, verify whether the ticket was already satisfied by prerequisite commits. Record that evidence explicitly; do not manufacture a commit or label an empty review clean. Otherwise return the missing implementation to the implementer.

## 5. Resolve findings, validate, and commit

Spec blocking findings and Standards hard violations block acceptance. Non-blocking findings and smell judgement calls require a recorded disposition but do not automatically block. Keep the axes separate; neither report cancels the other's findings.

Resume the implementer with the actionable findings, their axes, and resolution conditions. Pass supported disagreements to `/skill:code-review` for reassessment. After any code revision, invoke it again with the same uncommitted scope override over the entire current ticket scope, not only the latest fix. If the same blocker survives two consecutive revision rounds without progress, report the stalemate and preserve the work rather than looping indefinitely.

A ticket is accepted when every criterion is accounted for, required checks pass, and neither axis has unresolved blocking findings. Literal `clean` is not required when only accepted non-blocking findings remain. Run required repository checks on the exact candidate before committing; serialize checks that share mutable fixtures or build outputs.

Stage only reviewed files, including reviewed new files, inspect the staged diff, and commit the ticket with hooks enabled. If checks or hooks modify code, re-review that changed candidate. A failed commit does not complete the ticket. Record the successful commit hash and confirm the checkout is clean before marking the ticket complete and unlocking dependents. For an already-satisfied ticket, record its prerequisite evidence instead of an empty commit.

Repeat from step 3. If a blocker prevents further progress, leave the branch and uncommitted work intact and report what is complete and what remains. Do not start another ticket on top of unresolved changes.

## 6. Review the entire specification

Once every ticket is complete, run the full required integration checks. Require a clean working tree, then invoke `/skill:code-review`, supplying `git diff <recorded-base-sha> HEAD` as the exact diff command, `git log <recorded-base-sha>..HEAD --oneline` for orientation, and the whole specification and all relevant tickets as the acceptance boundary.

This review covers cross-ticket interactions, omissions, and scope creep across the final branch. Do not substitute the last ticket's diff or move the base to HEAD. If the skill reports an empty aggregate scope, explicitly explain whether the specification was already implemented; do not present an empty diff as a successful implementation review.

If fixes are needed, use one implementer for a bounded whole-spec revision. Invoke `/skill:code-review` with an explicit scope override: `git diff <recorded-base-sha>` plus the full contents of in-scope untracked files from `git status --short --untracked-files=all`, with the whole-spec acceptance boundary and prior findings and responses. Pass this boundary to both reviewers instead of the skill's default committed-only diff. This reviews earlier commits together with uncommitted fixes and new files. Run required checks, resolve findings using the same loop, and commit accepted fixes. Invoke the skill again on the committed diff against the unchanged base before declaring completion.

## 7. Deliver

Report completed tickets and commits, required checks, both review outcomes, accepted non-blocking risks, and any unresolved work. Report the branch and checkout location. If a PR is part of the user's request, create or update it and mark it ready only after final checks and review pass. Otherwise hand back the reviewed branch. Preserve any checkout containing unresolved work; clean up temporary resources only when their useful work is safely retained.
