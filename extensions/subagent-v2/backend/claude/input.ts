/**
 * The client-owned input stream one Run's Query reads from.
 *
 * Claude is the backend whose steering is not a method call. Guidance reaches
 * a live Query by being *pushed into the same async iterable the prompt came
 * from*, which means the input channel has to stay open for as long as the Run
 * might still be steered — and has to close when the Run is semantically done,
 * because a Query whose input never closes never ends.
 *
 * So the stream is **Run-scoped and client-owned**: the execution creates it,
 * pushes the prompt into it, pushes each admitted Control into it, and closes
 * it. The SDK only iterates it. That ownership is what makes ADR-0018's
 * ordering the adapter's own property rather than something hoped for from the
 * provider.
 *
 * Two behaviours are load-bearing:
 *
 * - **A push into a closed stream is refused rather than dropped.** `push`
 *   answers whether the message was taken, so the execution can record a
 *   bounded `control` diagnostic instead of letting the transcript claim
 *   guidance the model never saw.
 * - **Closing wakes the iterator.** A Query blocked on `next()` when the Run
 *   completes has to be told the input is finished, or the Query hangs and the
 *   Run's scope closes on a live subprocess.
 *
 * There is no buffer bound here, and that is deliberate rather than an
 * oversight: everything that enters this stream has already passed the Control
 * mailbox's own bound, and only one Control is ever in flight at a time.
 */

import type { SDKUserMessage } from "./query.ts";

/** How urgently the provider should take one pushed message. */
export type ClaudeInputPriority = NonNullable<SDKUserMessage["priority"]>;

/** One message the client pushes, as the SDK's streamed user message. */
export function claudeInputMessage(
  text: string,
  uuid: string,
  priority?: ClaudeInputPriority,
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: uuid as NonNullable<SDKUserMessage["uuid"]>,
    ...(priority === undefined ? {} : { priority }),
  };
}

export interface ClaudeInput extends AsyncIterable<SDKUserMessage> {
  /** Take one message, or answer `false` because the stream has closed. */
  readonly push: (message: SDKUserMessage) => boolean;
  readonly close: () => void;
  readonly isClosed: () => boolean;
}

export function createClaudeInput(): ClaudeInput {
  const queued: SDKUserMessage[] = [];
  let waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  let closed = false;

  const push = (message: SDKUserMessage): boolean => {
    if (closed) return false;
    const waiting = waiter;
    if (waiting) {
      waiter = undefined;
      waiting({ done: false, value: message });
      return true;
    }
    queued.push(message);
    return true;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    const waiting = waiter;
    waiter = undefined;
    waiting?.({ done: true, value: undefined });
  };

  return {
    push,
    close,
    isClosed: () => closed,
    [Symbol.asyncIterator]: (): AsyncIterator<SDKUserMessage> => ({
      next: () => {
        const next = queued.shift();
        if (next) return Promise.resolve({ done: false, value: next });
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          waiter = resolve;
        });
      },
      // The SDK abandoning the iterator closes the stream, so a Query that
      // stops reading cannot leave the execution pushing into nothing.
      return: () => {
        close();
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
}
