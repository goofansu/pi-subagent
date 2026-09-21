/**
 * In-process meaning accumulated from translated Pi readings for one Run.
 *
 * Translation has already consumed Pi wire shapes before a reading arrives
 * here. This fold performs no I/O, owns no resource lifetime, and never settles
 * a Run: it synchronously returns ordered Observations and terminal reports for
 * execution and core Arbitration to publish and settle later.
 */
import {
  answeredEnding,
  failedEnding,
  type RunDiagnostic,
  type RunEnding,
  type RunObservation,
  type TerminalReconciliation,
  type TranscriptItem,
  type UsageDelta,
} from "../../domain/index.ts";
import {
  confined,
  PI_BACKEND_FAILURE_CATEGORY,
  PI_TERMINAL_ABORT_DESCRIPTION,
  PI_TERMINAL_FAILURE_DESCRIPTION,
  type PiRunReading,
  type PiTranslatedMessage,
} from "./translate.ts";

export const MISSING_TERMINAL_EVENT_MESSAGE =
  "the Pi session finished without a terminal event carrying its messages";
export const PROMPT_REJECTED_CATEGORY = "Pi prompt failed";
export const RECOVERY_FAILED_CATEGORY = "Pi recovery failed";

export interface PiRunEvidenceOptions {
  readonly goal: string;
  readonly baseline: readonly PiTranslatedMessage[];
}

/** The normal report execution can publish after the native prompt returns. */
export interface PiRunFinishReport {
  readonly observations: readonly RunObservation[];
  readonly bundle: {
    readonly ending: RunEnding;
    readonly reconciliation?: TerminalReconciliation;
  };
}

/** The synchronous, total interface of one Run's Pi evidence fold. */
export interface PiRunEvidence {
  readonly read: (reading: PiRunReading) => readonly RunObservation[];
  /** Calling this freezes and returns the normal decision synchronously. */
  readonly promptReturned: (
    outcome: "resolved" | "rejected",
  ) => PiRunFinishReport;
}

type TerminalOutcome = "answered" | "incomplete" | "failed" | "aborted";

interface TerminalEvidence {
  readonly outcome: TerminalOutcome;
  readonly reconciliation: TerminalReconciliation;
}

interface CurrentGeneration {
  terminal?: TerminalEvidence;
  recovery?: "active" | "succeeded" | "failed" | "aborted";
  recoveryDiagnosticObserved: boolean;
  responseDiagnosticObserved: boolean;
}

const requiresRecovery = (terminal: TerminalEvidence): boolean =>
  terminal.outcome === "failed" || terminal.outcome === "incomplete";

function subtractBaseline(
  messages: readonly PiTranslatedMessage[],
  baseline: readonly PiTranslatedMessage[],
): readonly PiTranslatedMessage[] {
  const remaining = new Map<string, number>();
  for (const message of baseline) {
    remaining.set(
      message.semanticIdentity,
      (remaining.get(message.semanticIdentity) ?? 0) + 1,
    );
  }
  return messages.filter((message) => {
    const count = remaining.get(message.semanticIdentity) ?? 0;
    if (count === 0) return true;
    remaining.set(message.semanticIdentity, count - 1);
    return false;
  });
}

function omitInitialGoal(
  messages: readonly PiTranslatedMessage[],
  goal: string,
): readonly PiTranslatedMessage[] {
  let omitted = false;
  return messages.filter((message) => {
    if (!omitted && message.goalText === goal) {
      omitted = true;
      return false;
    }
    return true;
  });
}

/** Counted restatement heals accounting but never replaces transcript history. */
function restateObserved(
  observed: readonly PiTranslatedMessage[],
  terminal: readonly PiTranslatedMessage[],
): PiTranslatedMessage[] {
  const replacements = new Map<string, PiTranslatedMessage[]>();
  for (const message of terminal) {
    const matches = replacements.get(message.semanticIdentity) ?? [];
    matches.push(message);
    replacements.set(message.semanticIdentity, matches);
  }
  return observed.map((message) => {
    const matches = replacements.get(message.semanticIdentity);
    return matches?.shift() ?? message;
  });
}

interface MutableUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function addUsage(
  total: MutableUsageTotals,
  usage: UsageDelta | undefined,
): void {
  if (usage === undefined) return;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.cost += usage.cost ?? 0;
}

function snapshot(
  messages: readonly PiTranslatedMessage[],
): TerminalReconciliation {
  const transcript: TranscriptItem[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let turns = 0;
  let context: TerminalReconciliation["context"];
  let model: string | undefined;
  let finalOutput: string | undefined;
  for (const message of messages) {
    const facts = message.facts;
    if (facts === undefined) continue;
    transcript.push({
      role: facts.role,
      parts: facts.parts,
      ...(facts.model === undefined ? {} : { model: facts.model }),
    });
    addUsage(usage, facts.usage);
    if (facts.context !== undefined) context = facts.context;
    if (facts.model !== undefined) model = facts.model;
    if (facts.role !== "assistant") continue;
    turns += 1;
    const answer = facts.parts
      .filter((part) => part.kind === "text")
      .map((part) => (part.kind === "text" ? part.text : ""))
      .join("");
    if (answer.trim() !== "") finalOutput = answer;
  }
  return {
    transcript,
    usage,
    turns,
    ...(finalOutput === undefined ? {} : { finalOutput }),
    ...(context === undefined ? {} : { context }),
    ...(model === undefined ? {} : { model }),
  };
}

function terminalEvidence(
  messages: readonly PiTranslatedMessage[],
): TerminalEvidence {
  let outcome: TerminalOutcome = "answered";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const assistantOutcome = messages[index].assistantOutcome;
    if (assistantOutcome === undefined) continue;
    outcome = assistantOutcome;
    break;
  }
  return { outcome, reconciliation: snapshot(messages) };
}

function runWideEvidence(
  terminalMessages: readonly PiTranslatedMessage[],
  observedMessages: readonly PiTranslatedMessage[],
): TerminalEvidence {
  const frame = terminalEvidence(terminalMessages);
  const wholeRun = snapshot(observedMessages);
  return {
    outcome: frame.outcome,
    reconciliation: {
      ...(frame.reconciliation.finalOutput === undefined
        ? {}
        : { finalOutput: frame.reconciliation.finalOutput }),
      ...(wholeRun.usage === undefined ? {} : { usage: wholeRun.usage }),
      ...(wholeRun.turns === undefined ? {} : { turns: wholeRun.turns }),
      ...(frame.reconciliation.context === undefined
        ? {}
        : { context: frame.reconciliation.context }),
      ...(frame.reconciliation.model === undefined
        ? {}
        : { model: frame.reconciliation.model }),
    },
  };
}

function finishFor(
  outcome: "resolved" | "rejected",
  current: CurrentGeneration,
): PiRunFinishReport {
  const terminal = current.terminal;
  if (terminal !== undefined) {
    const recoveryFailed =
      requiresRecovery(terminal) && current.recovery === "failed";
    const description = recoveryFailed
      ? RECOVERY_FAILED_CATEGORY
      : terminal.outcome === "failed"
        ? PI_TERMINAL_FAILURE_DESCRIPTION
        : terminal.outcome === "incomplete"
          ? PI_TERMINAL_ABORT_DESCRIPTION
          : undefined;
    const alreadyObserved = recoveryFailed
      ? current.recoveryDiagnosticObserved
      : current.responseDiagnosticObserved;
    const diagnostic =
      description === undefined || alreadyObserved
        ? undefined
        : confined(description);
    const ending = recoveryFailed
      ? failedEnding(confined(RECOVERY_FAILED_CATEGORY).message)
      : terminal.outcome === "answered"
        ? answeredEnding()
        : terminal.outcome === "failed"
          ? failedEnding(confined(PI_TERMINAL_FAILURE_DESCRIPTION).message)
          : failedEnding(confined(PI_TERMINAL_ABORT_DESCRIPTION).message);
    return {
      observations:
        diagnostic === undefined ? [] : [{ kind: "diagnostic", diagnostic }],
      bundle: { ending, reconciliation: terminal.reconciliation },
    };
  }
  if (outcome === "rejected") {
    const diagnostic = confined(PROMPT_REJECTED_CATEGORY);
    return {
      observations: [{ kind: "diagnostic", diagnostic }],
      bundle: { ending: failedEnding(diagnostic.message) },
    };
  }
  return {
    observations: [],
    bundle: { ending: failedEnding(MISSING_TERMINAL_EVENT_MESSAGE) },
  };
}

export function createPiRunEvidence(
  options: PiRunEvidenceOptions,
): PiRunEvidence {
  let current: CurrentGeneration = {
    recoveryDiagnosticObserved: false,
    responseDiagnosticObserved: false,
  };
  let observedMessages: PiTranslatedMessage[] = [];
  let goalOmitted = false;
  let frozen: PiRunFinishReport | undefined;
  const seen = new WeakSet<PiTranslatedMessage>();

  return {
    read: (reading) => {
      switch (reading.kind) {
        case "message": {
          const message = reading.message;
          if (!goalOmitted && message.goalText === options.goal) {
            goalOmitted = true;
            return [];
          }
          if (seen.has(message)) return [];
          seen.add(message);
          observedMessages.push(message);
          if (
            message.observations.some(
              (observation) =>
                observation.kind === "diagnostic" &&
                observation.diagnostic.category === PI_BACKEND_FAILURE_CATEGORY,
            )
          ) {
            current.responseDiagnosticObserved = true;
          }
          return message.observations;
        }
        case "activity":
          return [reading.observation];
        case "tool":
          return reading.observations;
        case "execution-start":
          current = {
            recoveryDiagnosticObserved: false,
            responseDiagnosticObserved: false,
          };
          return [];
        case "recovery-start":
          current.recovery = "active";
          return [];
        case "recovery-end": {
          current.recovery = reading.outcome;
          if (
            reading.outcome !== "failed" ||
            current.terminal === undefined ||
            !requiresRecovery(current.terminal) ||
            current.recoveryDiagnosticObserved
          ) {
            return [];
          }
          const diagnostic: RunDiagnostic = confined(RECOVERY_FAILED_CATEGORY);
          current.recoveryDiagnosticObserved = true;
          return [{ kind: "diagnostic", diagnostic }];
        }
        case "terminal": {
          const messages = omitInitialGoal(
            subtractBaseline(reading.messages, options.baseline),
            options.goal,
          );
          observedMessages = restateObserved(observedMessages, messages);
          current.terminal = runWideEvidence(messages, observedMessages);
          return [];
        }
        case "final-settled":
        case "other":
          return [];
      }
    },
    promptReturned: (outcome) => {
      frozen ??= finishFor(outcome, current);
      return frozen;
    },
  };
}
