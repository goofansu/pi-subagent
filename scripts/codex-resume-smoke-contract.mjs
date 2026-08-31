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
 * Recognize an exact marker token while allowing harmless response prose and
 * repetition. Adjacent token characters are deliberately rejected.
 */
export function recallsExactMarker(output, marker) {
  if (
    typeof output !== "string" ||
    typeof marker !== "string" ||
    marker.length === 0
  )
    return false;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = output.match(
    new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"),
  );
  return (matches?.length ?? 0) >= 1;
}

/**
 * Prevent the private-thread proof from passing against a broken or empty
 * stored-thread API: one separately listed thread must first be readable.
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
 * Validate the real resume smoke's captured JSON-RPC transcript without
 * launching Codex. Returns only provider-private evidence used by the smoke.
 */
export function assertRetainedProtocolLifecycle(trace) {
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
    method("initialized").length === 1,
    "expected exactly one initialized notification",
  );
  requireCondition(
    method("thread/start").length === 1,
    "expected exactly one thread/start request",
  );
  requireCondition(
    method("thread/resume").length === 0,
    "thread/resume must never be requested",
  );
  requireCondition(
    method("turn/start").length === 2,
    "expected exactly two turn/start requests",
  );

  const initialize = method("initialize")[0];
  const initializeResponse = responseFor(inbound, initialize);
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
  const threadResponse = responseFor(inbound, threadStart);
  const thread = threadResponse?.result?.thread;
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
    turnStarts.every((request) => request.params?.threadId === thread.id),
    "both turn/start requests must use the root thread",
  );
  const turnIds = turnStarts.map((request) => {
    const response = responseFor(inbound, request);
    const turnId = response?.result?.turn?.id;
    requireCondition(
      typeof turnId === "string" && turnId.length > 0,
      "each turn/start must return a turn id",
    );
    return turnId;
  });
  requireCondition(
    new Set(turnIds).size === 2,
    "the two provider Turn ids must be distinct",
  );

  const completions = inbound.filter(
    (message) =>
      isRecord(message) &&
      message.method === "turn/completed" &&
      message.params?.threadId === thread.id,
  );
  requireCondition(
    completions.length === 2,
    "expected exactly two retained-root turn/completed notifications",
  );
  requireCondition(
    completions.every((message) =>
      turnIds.includes(message.params?.turn?.id),
    ) &&
      turnIds.every(
        (turnId) =>
          completions.filter((message) => message.params?.turn?.id === turnId)
            .length === 1,
      ),
    "completion identities must match the root thread and each provider Turn",
  );

  const providerIdentities = new Set();
  collectProviderIdentities(inbound, providerIdentities, undefined);
  collectProviderIdentities(outbound, providerIdentities, undefined);
  return {
    codexHome,
    threadId: thread.id,
    turnIds,
    providerIdentities,
  };
}
