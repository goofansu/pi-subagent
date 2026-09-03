/**
 * The v2 application module: one façade, no state.
 *
 * It sits between the host and the runtime so that a Pi handler never talks to
 * the supervisor, the repository, or the store directly, and between the
 * runtime and presentation so that a runtime outcome never writes its own
 * prose. The boundary test enforces both edges.
 */

export * from "./inputs.ts";
export * from "./subagents.ts";
