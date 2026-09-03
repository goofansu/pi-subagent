// The deterministic half of the Codex live gate.
//
// Everything here is a pure assertion over evidence the live gate collected:
// the JSON-RPC transcript its recording spawn captured, and what a second App
// Server answered when asked about the retained root. It launches nothing,
// spends no quota, and is exercised by `codex-smoke-contract.test.mjs` in
// the ordinary lane — which is the point. A release proof whose reasoning
// lives inside a 500-line credentialed script is a proof nobody can check
// without spending money on it.
//
// The v1 resume smoke carried the same assertions against v1's manager. This
// is their home now; the reasoning is unchanged, and where the shape differs
// it is because this gate drives more than two Turns and more than one root.

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Codex retained lifecycle: ${message}`);
}

function responseFor(inbound, request) {
  return inbound.find(
    (message) =>
      isRecord(message) && message.id === request.id && "result" in message,
  );
}

function providerEntityKind(key) {
  if (key === "thread" || key === "threads") return "thread";
  if (key === "turn" || key === "turns") return "turn";
  if (key === "item" || key === "items") return "item";
  return undefined;
}

const providerIdentityFields = [
  "clientUserMessageId",
  "expectedTurnId",
  "correlationId",
  "conversationId",
  "requestId",
  "threadId",
  "turnId",
  "itemId",
  "sessionId",
  "clientId",
];
const providerIdentityFieldNames = new Set(providerIdentityFields);
const publicProviderIdentityFieldPattern = new RegExp(
  `"(?:${providerIdentityFields.join("|")})"\\s*:`,
);

/** Match exact provider-identity keys without rejecting neutral local *Id keys. */
export function containsProviderIdentityFieldName(serializedPublicRecord) {
  return (
    typeof serializedPublicRecord === "string" &&
    publicProviderIdentityFieldPattern.test(serializedPublicRecord)
  );
}

function collectProviderIdentities(value, identities, entityKind) {
  if (Array.isArray(value)) {
    for (const entry of value)
      collectProviderIdentities(entry, identities, entityKind);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      entry.trim().length > 0 &&
      (providerIdentityFieldNames.has(key) ||
        (key === "id" && entityKind !== undefined))
    )
      identities.add(entry);
    collectProviderIdentities(entry, identities, providerEntityKind(key));
  }
}

/**
 * Prevent the nondiscoverability proof from passing against a broken or empty
 * stored-thread API.
 *
 * The trap this closes is the one that matters: "a second App Server could not
 * read our root" is worthless evidence if that App Server could not read
 * *anything*. So one separately listed ordinary thread must be readable first,
 * and only then does the root's absence from the listing and its rejected read
 * mean what the release claims.
 */
export function assertStoredThreadInspection(observation) {
  const listedThreadIds = Array.isArray(observation?.listedThreadIds)
    ? observation.listedThreadIds
    : [];
  requireCondition(
    listedThreadIds.length > 0,
    "no stored thread was available for the positive control",
  );
  requireCondition(
    typeof observation?.controlThreadId === "string" &&
      observation.controlThreadId !== observation.privateThreadId &&
      listedThreadIds.includes(observation.controlThreadId),
    "positive-control thread was not a separately listed stored thread",
  );
  requireCondition(
    observation.controlReadThreadId === observation.controlThreadId,
    "positive-control thread/read did not return the listed thread",
  );
  requireCondition(
    !listedThreadIds.includes(observation.privateThreadId),
    "the private root appeared in the stored-thread listing",
  );
  requireCondition(
    observation.privateReadRejected === true,
    "stored thread/read did not reject the private root",
  );
}

/**
 * Read one App Server's captured transcript as a retained-root lifecycle.
 *
 * The gate drives several Subagents through one Session, and each Subagent
 * is one App Server with one root thread — so the shape asserted here is *per
 * transcript*: exactly one `initialize`, exactly one `thread/start`, that
 * thread ephemeral and pathless, no `thread/resume` ever, and every
 * `turn/start` on the one root with a distinct Turn id answered and a matching
 * `turn/completed`. How many Turns there were is the gate's business, not
 * this module's; that a second Turn happened on the *same* root without a
 * resume request is the claim.
 *
 * Returns the provider-private evidence the gate needs and cannot get
 * anywhere else: the Codex home, the root id, its Turn ids, and every
 * provider identity that crossed the wire — the last so the gate can prove
 * none of them reached a public record.
 */
export function readRetainedRootLifecycle(trace) {
  const outbound = Array.isArray(trace?.outbound) ? trace.outbound : [];
  const inbound = Array.isArray(trace?.inbound) ? trace.inbound : [];
  const requests = outbound.filter(
    (message) => isRecord(message) && typeof message.method === "string",
  );
  const method = (name) =>
    requests.filter((request) => request.method === name);

  requireCondition(
    method("initialize").length === 1,
    "expected exactly one initialize request",
  );
  requireCondition(
    method("thread/start").length === 1,
    "expected exactly one thread/start request",
  );
  requireCondition(
    method("thread/resume").length === 0,
    "thread/resume must never be requested",
  );

  const initializeResponse = responseFor(inbound, method("initialize")[0]);
  const codexHome = initializeResponse?.result?.codexHome;
  requireCondition(
    typeof codexHome === "string" && codexHome.length > 0,
    "initialize must report the Codex home",
  );

  const threadStart = method("thread/start")[0];
  requireCondition(
    threadStart.params?.ephemeral === true,
    "thread/start must request ephemeral: true",
  );
  const thread = responseFor(inbound, threadStart)?.result?.thread;
  requireCondition(isRecord(thread), "thread/start must return a thread");
  requireCondition(
    typeof thread.id === "string" && thread.id.length > 0,
    "thread/start must return a thread id",
  );
  requireCondition(
    thread.ephemeral === true,
    "thread/start response must report an ephemeral thread",
  );
  requireCondition(
    thread.path === null,
    "thread/start response path must be null",
  );

  const turnStarts = method("turn/start");
  requireCondition(
    turnStarts.length >= 1,
    "expected at least one turn/start request",
  );
  requireCondition(
    turnStarts.every((request) => request.params?.threadId === thread.id),
    "every turn/start must use the root thread",
  );
  const turnIds = turnStarts.map((request) => {
    const turnId = responseFor(inbound, request)?.result?.turn?.id;
    requireCondition(
      typeof turnId === "string" && turnId.length > 0,
      "each turn/start must return a turn id",
    );
    return turnId;
  });
  requireCondition(
    new Set(turnIds).size === turnIds.length,
    "the provider Turn ids must be distinct",
  );

  const completions = inbound.filter(
    (message) =>
      isRecord(message) &&
      message.method === "turn/completed" &&
      message.params?.threadId === thread.id,
  );
  requireCondition(
    completions.every((message) => turnIds.includes(message.params?.turn?.id)),
    "every completion must name the root thread and one of its Turns",
  );

  const providerIdentities = new Set();
  collectProviderIdentities(inbound, providerIdentities, undefined);
  collectProviderIdentities(outbound, providerIdentities, undefined);
  return { codexHome, threadId: thread.id, turnIds, providerIdentities };
}

/**
 * Read every captured transcript, and require at least one retained root that
 * carried more than one Turn.
 *
 * "More than one Turn on one root, with no resume request" is what resume
 * *means* for a backend with no `thread/resume` and no stored rollout, so a
 * gate where every root saw exactly one Turn has not exercised the thing it
 * exists to prove — however many Subagents it opened.
 */
export function readRetainedRoots(traces) {
  requireCondition(
    Array.isArray(traces) && traces.length > 0,
    "no App Server transcript was captured",
  );
  const roots = traces.map(readRetainedRootLifecycle);
  requireCondition(
    roots.some((root) => root.turnIds.length >= 2),
    "no retained root carried a second Turn, so resume was never exercised",
  );
  return roots;
}
