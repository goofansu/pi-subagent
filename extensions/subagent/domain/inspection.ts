import type { RunDiagnostic } from "./diagnostics.ts";
import type { RunSummary } from "./history.ts";
import type { RunId } from "./ids.ts";
import type { SubagentPhase } from "./phases.ts";
import type { RunResult } from "./result.ts";
import type { UsageSnapshot } from "./usage.ts";

/** Known runtime facts only: never discover Conversation loss by probing. */
export interface SubagentInspectionSummary {
  readonly phase: SubagentPhase;
  readonly conversationLost: boolean;
}

interface Capture {
  readonly runId: RunId;
  readonly capturedAt: number;
}
interface KnownCapture extends Capture {
  readonly summary: RunSummary;
  readonly usage: UsageSnapshot;
  readonly subagent?: SubagentInspectionSummary;
}

/** One capture, never a Result-store pin or a reference to live resources. */
export type RunInspection =
  | (Capture & { readonly outcome: "unknown Run" })
  | (KnownCapture & {
      readonly outcome: "RunNotTerminal" | "ResultExpired";
    })
  | (KnownCapture & {
      readonly outcome: "unavailable";
      readonly diagnostic?: RunDiagnostic;
    })
  | (KnownCapture & { readonly outcome: "result"; readonly result: RunResult });
