---
name: herdr-implement-spec
description: Implement a specification in Herdr.
disable-model-invocation: true
---

You have been provided a specification. It should have tickets associated with it, describing how to implement it.

The goal is the set of **delivery branches** the specification calls for, each completed in its own **delivery worktree**. Every ticket is assigned to exactly one delivery branch. Each delivery branch has one **handoff**: a **local merge** into its base, which is the default when no PR was requested, or a **PR handoff** when the specification or user requests one. Usually one integration branch collects all tickets; a specification may instead call for one branch per PR, or a mix.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

**Ticket agents** are Herdr pi agents, each a main agent in its own worktree and pane, prompted with `/skill:implement-and-review <ticket>`, each ticket being that agent's specification. You orchestrate them; they implement, review, and commit their own ticket.

Before the first ticket-agent fan-out, execute the `artifact-handoff` skill. Its fan-in completion criterion gates merges and temporary worktree teardown.

**Worktrees:** use `/herdr` for their entire lifecycle.

Communication to and from ticket agents should be sparse. Communicate primarily through **context pointers**: to the specification, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

Ticket agents run unfocused, so the user keeps their pane and every ticket on the frontier runs at once, for **maximum concurrency**.

## Steps

1. Read the specification and its tickets. Read enough to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, so every ticket agent can be pointed at them. This lets ticket agents focus on implementation rather than exploration.

3. Determine the **delivery topology** from the specification and tickets before starting work: every delivery branch, its base, its assigned tickets, and its handoff. Record who opens each requested PR; you own that handoff unless the specification assigns it elsewhere. Resolve any ambiguity before creating worktrees. Create or check out every delivery branch in a dedicated delivery worktree; a stacked PR starts from the delivery branch beneath it. Keep the current workspace's branch and working tree unchanged while tickets run. Complete `artifact-handoff` preparation for every ticket before starting the frontier.

4. Work the frontier until every ticket is merged into its delivery branch:
   - Before starting a newly-ready ticket, ensure its delivery branch contains every completed blocker. Blockers assigned to that delivery branch are already present. For a blocker on another delivery branch, first merge that branch's tip into this ticket's delivery branch.
   - Start a ticket agent for each frontier ticket not yet started, all of them at once. Each gets its own temporary branch and worktree cut from the current tip of its delivery branch. Cutting from that tip carries the merged blocker work into the ticket.
   - Every prompt starts with `/skill:implement-and-review`, then the ticket and context pointers, followed by the assignment produced by `artifact-handoff`: `/skill:implement-and-review <ticket> against <specification>, notes in <notes-dir>, <artifact-assignment>`.
   - Wait on the agents. A settled agent has stopped, which is a signal to inspect rather than proof of success: it may have ended clean, or stopped on a specification gap or review stalemate. Apply `artifact-handoff`'s bounded fan-in.
   - As each ticket finishes green, verify its recorded checks, merge its branch into its delivery branch, then remove its temporary worktree and delete its temporary branch. A ticket is green only when the agent stopped successfully and its artifact handoff is a verified pass. Merge into any one delivery branch one ticket at a time; the other ticket agents keep running.
   - Every merge grows the frontier. Start the newly-ready tickets straight away rather than waiting for the rest of the round.

5. When a ticket agent fails, or its work will not merge into its delivery branch, stop that part of the graph: report it, leave the tickets it blocks unstarted, and keep working the rest of the frontier. A stopped delivery line does not stop the others. Finalize a delivery branch only after all of its tickets land.

6. After every ticket has either landed, failed, or been left unstarted behind a failure, finalize each completed delivery branch. Run `/skill:code-review` in its delivery worktree and fix everything raised with a single pi agent started there, then perform its recorded handoff:
   - **Local merge:** merge the delivery branch into its recorded base and verify the result there. If the base is checked out in the current workspace, require a clean tree and use it only for this final merge. After a successful merge, remove the delivery worktree and branch.
   - **PR handoff:** when you own it, push the delivery branch and open or update its PR against the recorded base. Otherwise, leave the branch ready and report who owns the handoff. Preserve the delivery branch and worktree as the PR head.

7. Include the `artifact-handoff` completion report, every ticket and which delivery branch contains it, plus anything left unstarted and why. Report every delivery branch and the result of its delivery handoff: the local base and merge commit, or the worktree path and PR when applicable. Ticket branches and worktrees are temporary: none remain at the end. Successfully local-merged delivery branches and worktrees are temporary too. PR delivery branches and worktrees are final: preserve every one.
