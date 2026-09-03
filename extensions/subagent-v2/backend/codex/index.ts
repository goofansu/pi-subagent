/**
 * The Codex adapter.
 *
 * Everything Codex-specific in v2 is behind this directory: the child process,
 * the App Server's JSON-RPC framing, its request and notification shapes, the
 * root thread and turn identities, the Subagent-scoped reader, and the
 * steering correlation. The boundary test enforces it in both directions — no
 * `node:child_process` import and no App Server protocol symbol appears
 * outside, and nothing outside the composition root imports anything from
 * here.
 */

export {
  CODEX_CAPABILITIES,
  type CodexOpenOptions,
  openCodexBackendAgent,
} from "./agent.ts";
export {
  CODEX_BACKEND_ID,
  type CodexBackendHandle,
  type CodexBackendOptions,
  createCodexBackend,
} from "./backend.ts";
export {
  CLOSED_BEFORE_EXECUTION_MESSAGE,
  CODEX_MALFORMED_FRAME_CATEGORY,
  CODEX_STDERR_CATEGORY,
  CODEX_STEER_NOT_DELIVERED_CATEGORY,
  CODEX_STEER_REFUSED_CATEGORY,
  CODEX_TRANSPORT_LOST_CATEGORY,
  CODEX_TURN_FAILED_CATEGORY,
  CODEX_TURN_START_CATEGORY,
  MISSING_CODEX_ANSWER_MESSAGE,
} from "./execution.ts";
export {
  type CodexAdapterTally,
  type CodexNativeProbe,
  codexProbeIsClear,
  createCodexProbeCounters,
} from "./probe.ts";
export {
  CODEX_ARGUMENTS,
  CODEX_COMMAND,
  CODEX_STDIO_UNAVAILABLE,
  type CodexChildProcess,
  type CodexProcessExit,
  type CodexSignal,
  type CodexSpawn,
  type CodexSpawnRequest,
  codexChildEnvironment,
  codexSpawnRequest,
  spawnCodexAppServer,
} from "./process.ts";
export {
  CODEX_DISPLAY_NAME,
  CODEX_EFFORT_NONE,
  CODEX_PROFILE_FIELDS,
  type CodexModelChoice,
  codexEffort,
  codexTurnInput,
  resolveCodexModel,
  validateCodexProfile,
} from "./profile.ts";
export {
  CODEX_APPROVAL_POLICY,
  CODEX_CLIENT_INFO,
  CODEX_COMMAND_STATUSES,
  CODEX_COMMENTARY_PHASE,
  CODEX_NOTIFICATION_METHODS,
  CODEX_SANDBOX,
  CODEX_TURN_STATUSES,
  type CodexItem,
  type CodexNotification,
  type CodexNotificationMethod,
  type CodexParams,
  type CodexTokenBreakdown,
  type CodexTurnStatus,
  codexEchoedText,
  decodeCodexItem,
  initializeParams,
  isCodexInitializeResult,
  readCodexNotification,
  readCodexThreadId,
  readCodexTurnId,
  threadStartParams,
  turnInterruptParams,
  turnStartParams,
  turnSteerParams,
} from "./protocol.ts";
export {
  type CodexReader,
  type CodexRoute,
  type CodexRouter,
  codexFrameTurnId,
  createCodexReader,
} from "./reader.ts";
export {
  ACTIVITY_LIMIT,
  CODEX_COMMAND_TOOL_NAME,
  CODEX_DIAGNOSTIC_REDACTED,
  CODEX_FILE_CHANGE_TOOL_NAME,
  CODEX_PROVIDER_ERROR_CATEGORY,
  CODEX_TURN_ERROR_CATEGORY,
  CODEX_USAGE_COUNTERS,
  CODEX_WEB_SEARCH_TOOL_NAME,
  type CodexTranslation,
  type CodexTranslator,
  codexCommandOf,
  codexContextGauge,
  codexItemActivity,
  codexMessagePreview,
  codexToolName,
  codexUsageDelta,
  codexUsageReset,
  confined,
  confinedControl,
  confinedLoss,
  createCodexTranslator,
  redactCodexIdentities,
  ZERO_CODEX_USAGE,
} from "./translate.ts";
export {
  CODEX_ESCALATION_MILLIS,
  CODEX_MAX_LINE_LENGTH,
  CODEX_METHOD_NOT_SUPPORTED,
  CODEX_REQUEST_BUDGET_MILLIS,
  type CodexFrame,
  type CodexRequestOutcome,
  type CodexTransport,
  startCodexTransport,
} from "./transport.ts";
