/**
 * The v2 presentation module: pure prose and row formatting.
 *
 * Everything a user or a model reads about a Run is written here, from the
 * domain's own vocabulary and nothing else. This module folds no backend
 * events, holds no lifecycle state, reads no clock, and names no service — it
 * imports the domain and Pi's TUI primitives, and the boundary test rejects a
 * presentation file that imports anything more.
 *
 * That rule is what makes the presentation layer testable with exact strings
 * and what keeps state out of it: v1's dispatcher ended up owning presentation
 * state because presentation could reach the thing that owned lifecycle.
 *
 * This barrel is the module's one interface: it names what the host, the
 * application façade, and the entry point may read. Every other name in the
 * module is implementation, reachable by siblings and colocated tests but not
 * by consumers outside `presentation/`. The boundary test enforces that seam.
 */

export { agentToolRenderers } from "./agent-tool-renderers.ts";

export type { DashboardIdentity } from "./banner.ts";

export {
  type DashboardKey,
  type DashboardPageChrome,
  type DashboardPageEvent,
  emptyDashboardPage,
  reduceDashboardPage,
} from "./dashboard-page.ts";

export { formatNotificationText } from "./notification-text.ts";

export {
  formatCancelOutcomes,
  formatInvalidProfilesWarning,
  formatNoActiveRuns,
  formatResultRejection,
  formatResumeOutcome,
  formatSessionNotReady,
  formatStartOutcome,
  formatSteerOutcome,
  formatToolInputRejected,
  formatWaitOutcomes,
} from "./prose.ts";

export { contentText, formatNotificationSummary } from "./renderers.ts";

export {
  formatRowSummary,
  type RenderableTheme,
  renderRunRows,
  widgetSummary,
} from "./rows.ts";

export { formatResult } from "./run-card.ts";

export {
  cancelToolRowFacts,
  encodeToolRowFacts,
  noActiveWaitAllToolRowFacts,
  resultToolRowFacts,
  resumeToolRowFacts,
  startToolRowFacts,
  steerToolRowFacts,
  type ToolRowFacts,
  waitAllToolRowFacts,
  waitToolRowFacts,
} from "./tool-row-facts.ts";

export {
  type HandoffStatus,
  handoffEndedBadly,
  type RunRowView,
} from "./views.ts";
