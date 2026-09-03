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
 */

export * from "./details.ts";
export * from "./notification-text.ts";
export * from "./prose.ts";
export * from "./renderers.ts";
export * from "./result-body.ts";
export * from "./rows.ts";
export * from "./run-card.ts";
export * from "./status.ts";
export * from "./views.ts";
