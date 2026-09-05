/**
 * The v2 domain module: plain TypeScript, no runtime, no SDK.
 *
 * Everything the product means by a Subagent, a Run, an observation, a
 * settlement, and a usage figure is defined here as data and pure functions.
 * The backend contract, the supervisor, and the host all depend on this
 * module; it depends on nothing.
 */

export * from "./bounding.ts";
export * from "./decoding.ts";
export * from "./diagnostics.ts";
export * from "./endings.ts";
export * from "./ids.ts";
export * from "./links.ts";
export * from "./notification.ts";
export * from "./observations.ts";
export * from "./outcomes.ts";
export * from "./phases.ts";
export * from "./profile.ts";
export * from "./projection.ts";
export {
  RECONCILED_FIELDS,
  type ReconciledField,
  type ReconcileOutcome,
  reconcileRun,
  reconciliationDifference,
} from "./reconcile-run.ts";
export * from "./reconciliation.ts";
export * from "./reduce-run.ts";
export * from "./result.ts";
export * from "./result-bounding.ts";
export * from "./subagent-context.ts";
export * from "./transcript.ts";
export * from "./usage.ts";
