/**
 * The Claude adapter.
 *
 * Everything Claude-specific in v2 is behind this directory: the SDK's
 * `query` function, its frame union, its options bag, the streamed input
 * message, the conversation identity, and the steering correlation. The
 * boundary test enforces it in both directions — no `@anthropic-ai/*` import
 * appears outside, and nothing outside the composition root imports anything
 * from here.
 */

export {
  CLAUDE_CAPABILITIES,
  type ClaudeOpenOptions,
  createClaudeBackendAgent,
  openClaudeBackendAgent,
} from "./agent.ts";
export {
  CLAUDE_BACKEND_ID,
  type ClaudeBackendHandle,
  type ClaudeBackendOptions,
  createClaudeBackend,
} from "./backend.ts";
export {
  CLAUDE_ATTACHMENT_FAILED_MESSAGE,
  CLOSED_BEFORE_EXECUTION_MESSAGE,
  CONTROL_NOT_DELIVERED_CATEGORY,
  MISSING_CLAUDE_RESULT_MESSAGE,
  QUERY_FAILED_CATEGORY,
  QUERY_START_CATEGORY,
  RESULT_ERROR_CATEGORY,
  SDK_STDERR_CATEGORY,
} from "./execution.ts";
export {
  type ClaudeInput,
  type ClaudeInputPriority,
  claudeInputMessage,
  createClaudeInput,
} from "./input.ts";
export {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_THINKING_BUDGETS,
  claudeThinking,
  createClaudeOptions,
} from "./options.ts";
export {
  type ClaudeNativeProbe,
  type ClaudeProbeCounters,
  claudeProbeIsClear,
  createClaudeProbeCounters,
} from "./probe.ts";
export {
  CLAUDE_DISPLAY_NAME,
  CLAUDE_MODEL_ALIASES,
  isClaudeModelAlias,
  modelProblem,
  resolveClaudeModel,
  validateClaudeProfile,
} from "./profile.ts";
export type {
  ClaudeQuery,
  ClaudeQueryLoader,
  ClaudeQueryStream,
  Options as ClaudeOptions,
  SDKMessage as ClaudeFrame,
  SDKUserMessage as ClaudeInputMessage,
} from "./query.ts";
export {
  CLAUDE_DIAGNOSTIC_REDACTED,
  CLAUDE_IDENTITY_PATTERN,
  type ClaudeFrameKind,
  type ClaudeFrameReading,
  type ClaudeTranslator,
  claudeContextGauge,
  claudeCumulativeUsage,
  claudeUsageDelta,
  confined,
  createClaudeTranslator,
  isClaudeIdentity,
  readClaudeFrame,
} from "./translate.ts";
