import type { RunControl } from "./run.ts";
import type { CancellationReason } from "./types.ts";

export const CONTROL_MAX_PENDING = 16;
export const CONTROL_MAX_MESSAGE_BYTES = 16 * 1024;
export const CONTROL_MAX_PENDING_BYTES = 64 * 1024;

export function isValidControlText(text: string): boolean {
  return (
    text.trim().length > 0 &&
    Buffer.byteLength(text, "utf8") <= CONTROL_MAX_MESSAGE_BYTES
  );
}

export type ControlMailboxOffer =
  | "accepted"
  | "invalid"
  | "queue full"
  | "closed";

/** The bounded, single-consumer queue passed across the executor seam. */
export interface ControlMailbox extends AsyncIterable<RunControl> {
  offer(control: RunControl): ControlMailboxOffer;
  close(): void;
}

export type ControlGateOffer =
  | "accepted"
  | "invalid"
  | "queue full"
  | "unsupported"
  | "not steerable";

export interface ControlGateState {
  supportedControls: readonly RunControl["type"][];
  closed: boolean;
  cancellationReason: CancellationReason | undefined;
}

/** Synchronous admission and closure state owned by one tracked Run. */
export interface ControlGate {
  readonly controls: AsyncIterable<RunControl>;
  offer(control: RunControl): ControlGateOffer;
  close(): void;
  cancel(reason: CancellationReason): void;
  state(): ControlGateState;
}

export function createControlMailbox(): ControlMailbox {
  const queue: Array<{ control: RunControl; bytes: number }> = [];
  const waiters: Array<(result: IteratorResult<RunControl>) => void> = [];
  let consumerCreated = false;
  let closed = false;
  let pendingBytes = 0;

  const dequeue = (): RunControl | undefined => {
    const entry = queue.shift();
    if (!entry) return undefined;
    pendingBytes -= entry.bytes;
    return entry.control;
  };

  const iterator: AsyncIterator<RunControl> = {
    next() {
      const control = dequeue();
      if (control) return Promise.resolve({ done: false, value: control });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };

  return {
    offer(control) {
      if (closed) return "closed";
      if (!isValidControlText(control.text)) return "invalid";
      const messageBytes = Buffer.byteLength(control.text, "utf8");
      if (
        queue.length >= CONTROL_MAX_PENDING ||
        pendingBytes + messageBytes > CONTROL_MAX_PENDING_BYTES
      ) {
        return "queue full";
      }
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: control });
      else {
        queue.push({ control, bytes: messageBytes });
        pendingBytes += messageBytes;
      }
      return "accepted";
    },
    close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      pendingBytes = 0;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      if (consumerCreated) {
        throw new Error("Control mailbox allows exactly one consumer");
      }
      consumerCreated = true;
      return iterator;
    },
  };
}

function closedControlStream(): AsyncIterable<RunControl> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

export function createControlGate(
  declaredControls: readonly RunControl["type"][],
): ControlGate {
  const supportedControls = Object.freeze([...declaredControls]);
  const supportsSteering = supportedControls.includes("steer");
  const mailbox = supportsSteering ? createControlMailbox() : undefined;
  let closed = false;
  let cancellationReason: CancellationReason | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    mailbox?.close();
  };

  return {
    controls: mailbox ?? closedControlStream(),
    offer(control) {
      if (closed) return "not steerable";
      if (!supportsSteering || !mailbox) return "unsupported";
      const outcome = mailbox.offer(control);
      return outcome === "closed" ? "not steerable" : outcome;
    },
    close,
    cancel(reason) {
      if (cancellationReason !== undefined) return;
      cancellationReason = reason;
      close();
    },
    state: () => ({
      supportedControls,
      closed,
      cancellationReason,
    }),
  };
}
