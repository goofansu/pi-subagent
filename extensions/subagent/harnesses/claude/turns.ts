import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type ClaudeTurnCounter = {
  countFor(message: SDKMessage): number;
};

/**
 * Return the nonnegative additive provider-turn delta for each Claude event.
 * Retractions are deliberately ignored because an emitted Fact cannot retract
 * an earlier additive delta; terminal totals therefore catch up but never lower
 * provisional accounting.
 */
export function createClaudeTurnCounter(): ClaudeTurnCounter {
  const seenRootMessageIds = new Set<string>();
  let emittedTurns = 0;

  return {
    countFor(message) {
      if (message.type === "assistant") {
        const messageId = message.message.id;
        if (
          message.parent_tool_use_id != null ||
          typeof messageId !== "string" ||
          seenRootMessageIds.has(messageId)
        ) {
          return 0;
        }

        seenRootMessageIds.add(messageId);
        emittedTurns += 1;
        return 1;
      }

      if (message.type !== "result") return 0;

      const reportedTurns = message.num_turns;
      if (
        !Number.isFinite(reportedTurns) ||
        !Number.isInteger(reportedTurns) ||
        reportedTurns < 0 ||
        reportedTurns <= emittedTurns
      ) {
        return 0;
      }

      const delta = reportedTurns - emittedTurns;
      emittedTurns = reportedTurns;
      return delta;
    },
  };
}
