/**
 * What the model is told about each tool.
 *
 * This is product copy, not documentation: a description, a one-line snippet,
 * and a set of guideline bullets are what a model reads before it decides
 * whether and how to call a tool, and getting them wrong makes a correct
 * implementation behave badly. So they are ported from v1 rather than
 * rewritten, and they live in one file so a change to any of them is a change
 * to a visible product surface rather than an incidental edit inside a
 * registration call.
 *
 * Three things changed in the port, each because the v2 vocabulary changed:
 *
 * - the word v1's Profiles use for the field that names a provider is gone
 *   everywhere, per ADR-0022;
 * - `queue full` and `not steerable` are `mailbox full` and `mailbox closed`,
 *   per operation semantics section 7;
 * - the sentence about waiting rather than ending the turn is carried intact,
 *   because it is the one guideline that changes how much a model gets done
 *   per turn.
 *
 * And one thing changed after it, per
 * [ADR-0036](../../../docs/adr/0036-a-wait-delivers-the-result-it-waited-for.md):
 * the copy now states the **delivery model** in one place — a completion
 * reaches the parent on its own, so the parent's default is independent work,
 * a wait is for when nothing else remains, and a wait delivers the Result
 * directly with no duplicate notice. `agent_wait_all` is the seventh tool,
 * added because "wait for everything I started" was the barrier a model kept
 * having to spell out id by id.
 *
 * Pi documents `promptSnippet` as one line for the Available tools section, so
 * each snippet is a period-less phrase while the full contract stays in the
 * description.
 */

/**
 * The delivery model, stated once and quoted by every tool that needs it.
 *
 * A model decides what to do after `agent_start` from what it read *there*,
 * so the paragraph is in the start description as well as in the two waits':
 * a guideline about waiting that a model reads only when it is already
 * considering a wait arrives too late to change the decision.
 */
export const DELIVERY_MODEL =
  "A Run's completion or failure is delivered to you automatically once it " +
  "reaches a final status: if you are mid-turn it is queued and arrives when " +
  "the turn ends; if you are idle it starts a new turn. The delivered notice " +
  "carries the Run's output whole when it is short, and a preview with a " +
  "pointer to agent_result when it is not. Continue independent work instead " +
  "of waiting. Use agent_wait or agent_wait_all only when your next action " +
  "depends on those answers and no useful work remains meanwhile; an active " +
  "wait receives the results directly, with no duplicate notification " +
  "afterwards.";

/** Everything one registration needs to say about itself. */
export interface ToolCopy {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines?: readonly string[];
}

export const START_COPY: ToolCopy = {
  name: "agent_start",
  label: "Start subagent",
  description:
    "Create a stable Session-scoped Subagent from a Profile and immediately " +
    "start its first Run. Returns distinct Subagent and Run ids, not the " +
    "answer. Use the Run id for agent_wait, agent_result, agent_cancel, and " +
    `agent_steer. ${DELIVERY_MODEL} Do not guess at what a Run will say.`,
  promptSnippet:
    "Create a stable subagent and return its identity and first run id immediately",
};

export const RESUME_COPY: ToolCopy = {
  name: "agent_resume",
  label: "Resume subagent",
  description:
    "Immediately start a new asynchronous Run on an idle stable Subagent, " +
    "retaining only the backend's private Conversation context. Pass a " +
    "Subagent id returned by agent_start, not a Run id. Returns the new Run id " +
    "immediately, not the answer; use that Run id for wait, result, " +
    "cancellation, and steering. A Subagent with an active Run rejects resume " +
    "without queueing; lost Conversation context starts no Run and requires a " +
    "new Subagent.",
  promptSnippet:
    "Resume an idle stable subagent and return its new run id immediately",
  promptGuidelines: [
    "agent_resume takes the stable Subagent id from agent_start; agent_wait, agent_result, agent_cancel, and agent_steer take Run ids.",
    "agent_resume returns immediately with a new Run id, not the answer; its completion is delivered automatically, so continue independent work and wait only when nothing else remains.",
    "If agent_resume reports Conversation loss, start a new Subagent; no Run or provider work was started.",
  ],
};

export const WAIT_COPY: ToolCopy = {
  name: "agent_wait",
  label: "Wait for subagents",
  description:
    "Block until the named Runs finish and return each one's full result " +
    "directly — the same output agent_result returns — with no duplicate " +
    `completion notification afterwards. ${DELIVERY_MODEL} Waiting does ` +
    "not make a Run finish sooner. Pass every id you are waiting on in one " +
    "call. A still-running entry means the timeout expired, not that the Run " +
    "broke; that Run's completion is still delivered on its own.",
  promptSnippet:
    "Block until named runs finish and return their full results directly",
  // Guidelines from every tool are flattened into one unattributed list, so
  // each bullet has to name the tool it governs.
  promptGuidelines: [
    "After agent_start or agent_resume, continue independent work: each Run's completion is delivered to you automatically. Call agent_wait or agent_wait_all only when your next action depends on the answers and nothing else remains, rather than ending the turn.",
    "A wait delivers the results directly and suppresses their notifications, so do not call agent_result for a Run that agent_wait or agent_wait_all just returned.",
    "One agent_wait covers a whole barrier: pass every id at once, with a timeoutSeconds that comfortably exceeds the work you delegated.",
    "agent_wait returning still-running means it timed out, not that the Run failed — the completion still arrives on its own, so do not immediately call agent_wait for the same ids again.",
  ],
};

export const WAIT_ALL_COPY: ToolCopy = {
  name: "agent_wait_all",
  label: "Wait for all subagents",
  description:
    "Block until every Run in this Session that is active right now " +
    "finishes, and return each one's full result directly — the same output " +
    "agent_result returns — with no duplicate completion notification " +
    "afterwards. Takes no ids. Runs that had already finished are not " +
    `repeated; their completions were delivered on their own. ${DELIVERY_MODEL} ` +
    "A still-running entry means the timeout expired, not that the Run broke.",
  promptSnippet:
    "Block until every active run finishes and return their full results directly",
  promptGuidelines: [
    "agent_wait_all is the barrier for a fan-out: when you have started several Runs and your next step needs all of them, call it once instead of listing ids in agent_wait.",
  ],
};

export const RESULT_COPY: ToolCopy = {
  name: "agent_result",
  label: "Read subagent result",
  description:
    "Fetch a finished subagent's full output by Run id. Use it when a " +
    "completion notification previewed an output too long to include and " +
    "pointed here, or to re-read a Run you were told about earlier. Not " +
    "needed for a Run whose notice carried its output whole, nor for a Run " +
    "that agent_wait or agent_wait_all just returned: those deliver the same " +
    "output. A Run whose output was evicted to keep the store bounded still " +
    "reports its identity and status.",
  promptSnippet: "Fetch a finished subagent's full output by run id",
};

export const CANCEL_COPY: ToolCopy = {
  name: "agent_cancel",
  label: "Cancel subagents",
  description:
    "Stop Runs whose work is no longer needed by Run id; never pass a stable " +
    "Subagent id. The tool reports request admission, not terminal " +
    "cancellation: each Run stops when its execution and cleanup finish, or " +
    "settles cancelled once its cleanup outlives the cleanup budget. It keeps " +
    "whatever output it produced, still sends its own notification, and does " +
    "not close the owning Subagent.",
  promptSnippet: "Stop subagents whose work is no longer needed",
};

export const STEER_COPY: ToolCopy = {
  name: "agent_steer",
  label: "Steer subagent",
  description:
    "Send one guidance message to an active subagent Run. `accepted` means " +
    "only that the complete message synchronously entered its local bounded " +
    "mailbox. It does not mean the backend dequeued it, a provider accepted " +
    "it, or a model consumed it. A full mailbox answers `mailbox full` and a " +
    "settling or cancelled Run answers `mailbox closed`, both immediately. Do " +
    "not retry repeatedly or resend a steering message in a loop.",
  promptSnippet: "Send one guidance message to an active subagent run",
};

/** Every registration's copy, in the order the tools are registered. */
export const TOOL_COPY: readonly ToolCopy[] = [
  START_COPY,
  RESUME_COPY,
  WAIT_COPY,
  WAIT_ALL_COPY,
  RESULT_COPY,
  CANCEL_COPY,
  STEER_COPY,
];

/**
 * The `agent_start` guidelines, which name the Profiles this Session loaded.
 *
 * Built per Session rather than fixed, because the list is what tells a model
 * which specialists exist. An empty catalog says so rather than listing
 * nothing, so a Session with no Profiles does not read as a Session whose
 * specialists the model failed to notice.
 */
export function formatAgentGuidelines(
  profiles: readonly { readonly name: string; readonly description: string }[],
): readonly string[] {
  if (profiles.length === 0) return ["agent_start has no configured agents."];
  return profiles.map(
    (profile) => `agent_start ${profile.name}: ${profile.description}`,
  );
}
