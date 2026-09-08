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
 * This barrel is the module's one interface: every file in the module is
 * exported here, and every consumer outside `presentation/` enters through it
 * rather than naming a file by path. A consumer that reached a file by path
 * would be building against an implementation detail, and the next surface
 * would find a precedent for it.
 *
 * Unlike the import restriction above, that is a convention and not a checked
 * rule: no boundary rule rejects a consumer reaching past this file, so a new
 * presentation file belongs in the list below when it is written.
 */

export * from "./agent-tool-renderers.ts";
export * from "./banner.ts";
export * from "./completion-view.ts";
export * from "./dashboard-page.ts";
export * from "./dashboard-panel.ts";
export * from "./history.ts";
export * from "./inspection.ts";
export * from "./notification-text.ts";
export * from "./prose.ts";
export * from "./renderers.ts";
export * from "./result-body.ts";
export * from "./rows.ts";
export * from "./run-card.ts";
export * from "./run-line.ts";
export * from "./run-presentation.ts";
export * from "./status.ts";
export * from "./text-width.ts";
export * from "./views.ts";
