---
name: herdr-implement-spec
description: Implement a specification in Herdr.
disable-model-invocation: true
---

You have been provided a specification. It should have tickets associated with it, describing how to implement it.

The goal is a single branch implementing the entire specification, handed back ready to review.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

**Ticket agents** are Herdr pi agents, each a main agent in its own worktree and pane, prompted with `/skill:implement-and-review <ticket>`, each ticket being that agent's specification. You orchestrate them; they implement, review, and commit their own ticket.

**Worktrees:** use `/skill:herdr` for their entire lifecycle.

Communication to and from ticket agents should be sparse. Communicate primarily through **context pointers**: to the specification, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

Ticket agents run unfocused, so the user keeps their pane and every ticket on the frontier runs at once, for **maximum concurrency**.

## Steps

1. Read the specification and its tickets. Read enough to understand the task graph.

2. (optional) Use an **exploration subagent** to conduct any exploration required by the tickets - relevant codebase files or external documentation. Ensure the exploration subagent can save files - it should save its markdown notes in a directory outside the repo, so every ticket agent can be pointed at them. This lets ticket agents focus on implementation rather than exploration.

3. Create the **integration branch** off main in a dedicated **integration worktree**. Keep the current workspace's branch and working tree unchanged. Every ticket's work lands in the integration worktree; run integration merges and checks there.

4. Work the frontier until every ticket is merged:
   - Start a ticket agent for each frontier ticket not yet started, all of them at once. Each gets a worktree cut from the current tip of the integration branch. Cutting from the current tip is what carries a blocker's merged work into the ticket that depends on it.
   - Every prompt starts with `/skill:implement-and-review`, then the ticket and pointers to the specification and the exploration notes: `/skill:implement-and-review <ticket> against <specification>, notes in <notes-dir>`.
   - Wait on the agents. A settled agent has stopped, which is a signal to look rather than proof of success: it may have ended clean, or stopped on a specification gap or a review stalemate. Read its final report, and answer or surface anything it is blocked on.
   - As each ticket finishes green, merge its branch into the integration branch, then remove its worktree and delete the ticket branch. Merge one at a time; the other ticket agents keep running.
   - Every merge grows the frontier. Start the newly-ready tickets straight away rather than waiting for the rest of the round.

5. When a ticket agent fails, or its work will not merge, stop that part of the graph: report it, leave the tickets it blocks unstarted, and keep working the rest of the frontier.

6. Once all tickets are complete, run /skill:code-review in the integration worktree. Fix everything it raises with a single pi agent started in that worktree.

7. Report every ticket and whether it merged, plus anything left unstarted and why. Leave the integration branch and its worktree ready for review, and report their name and path. Leave no ticket branches or worktrees behind.
