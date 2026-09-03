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
 * Pi documents `promptSnippet` as one line for the Available tools section, so
 * each snippet is a period-less phrase while the full contract stays in the
 * description.
 */

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
    "agent_steer; a completion notification arrives when the Run finishes. Do " +
    "not guess at what it will say.",
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
    "agent_resume returns immediately with a new Run id, not the answer; continue independent work and use agent_wait when only that Run remains.",
    "If agent_resume reports Conversation loss, start a new Subagent; no Run or provider work was started.",
  ],
};

export const WAIT_COPY: ToolCopy = {
  name: "agent_wait",
  label: "Wait for subagents",
  description:
    "Block until named Runs finish by Run id and return lifecycle state: " +
    "identity and status, never output. Waiting does not make a Run finish " +
    "sooner, and the completion notification arrives either way — but holding " +
    "the turn keeps the answer in front of you, so wait here whenever the " +
    "Run's answer is the only thing left to do. Pass every id you are waiting " +
    "on in one call. A still-running result means the timeout expired, not " +
    "that the Run broke.",
  promptSnippet:
    "Block until named runs finish and return lifecycle state only, never output",
  // Guidelines from every tool are flattened into one unattributed list, so
  // each bullet has to name the tool it governs.
  promptGuidelines: [
    "After agent_start or agent_resume, do the work that does not depend on the Run first; when only the Run's answer is left, call agent_wait instead of ending the turn.",
    "One agent_wait covers a whole barrier: pass every id at once, with a timeoutSeconds that comfortably exceeds the work you delegated.",
    "agent_wait returning still-running means it timed out, not that the Run failed — the notification still arrives on its own, so do not immediately call agent_wait for the same ids again.",
  ],
};

export const RESULT_COPY: ToolCopy = {
  name: "agent_result",
  label: "Read subagent result",
  description:
    "Fetch a finished subagent's full output by Run id. Use it when a " +
    "notification points to the result, or to re-read a Run you were told " +
    "about earlier. A Run whose output was evicted to keep the store bounded " +
    "still reports its identity and status.",
  promptSnippet: "Fetch a finished subagent's full output by run id",
};

export const CANCEL_COPY: ToolCopy = {
  name: "agent_cancel",
  label: "Cancel subagents",
  description:
    "Stop Runs whose work is no longer needed by Run id; never pass a stable " +
    "Subagent id. The tool reports request admission, not terminal " +
    "cancellation: each Run stops when its execution and cleanup finish. " +
    "Partial output remains available through agent_result once cancellation " +
    "settles, and cancellation does not close the owning Subagent.",
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
