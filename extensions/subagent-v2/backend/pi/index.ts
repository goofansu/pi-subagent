/**
 * The Pi adapter.
 *
 * Everything Pi-specific in v2 is behind this directory: the SDK's session
 * types, its event shapes, the resource loader, the child-load discriminator,
 * and the depth environment variable. The boundary test enforces it in both
 * directions — no Pi session symbol appears outside, and nothing outside the
 * composition root imports anything from here.
 */

export {
  CHILD_SHUTDOWN_BUDGET_MILLIS,
  openPiBackendAgent,
  PI_CAPABILITIES,
  type PiOpenOptions,
} from "./agent.ts";
export {
  createPiBackend,
  PI_BACKEND_ID,
  type PiBackendHandle,
  type PiBackendOptions,
} from "./backend.ts";
export { isChildResourceLoad, withChildResourceLoad } from "./child-load.ts";
export {
  DEPTH_ENV_KEY,
  type DepthEnvironment,
  readChildDepth,
} from "./depth.ts";
export {
  CLOSED_BEFORE_EXECUTION_MESSAGE,
  MISSING_TERMINAL_EVENT_MESSAGE,
} from "./execution.ts";
export {
  createPiSessionOptions,
  depthSpawnHook,
  filterChildExtensions,
  OWN_PACKAGE_NAME,
  PI_ORCHESTRATION_TOOLS,
  packageNameForPath,
  unknownModelMessage,
} from "./options.ts";
export {
  createPiProbeCounters,
  type PiNativeProbe,
  type PiProbeCounters,
  piProbeIsClear,
} from "./probe.ts";
export {
  catalogueSummary,
  MAX_CATALOGUE_DIAGNOSTIC_CHARS,
  modelProblem,
  PI_DISPLAY_NAME,
  type PiModelChoice,
  resolvePiModel,
  validatePiProfile,
} from "./profile.ts";
export type {
  PiSession,
  PiSessionEvent,
  PiSessionFactory,
  PiSessionOptions,
  PiSessionOptionsFactory,
} from "./session.ts";
