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

export type ControlSourceOffer =
  | "accepted"
  | "invalid"
  | "queue full"
  | "closed";

/** One admitted Control. Acknowledgement releases its pending budget once. */
export interface ControlAdmission {
  readonly control: RunControl;
  acknowledge(): void;
}

/** The synchronous, single-consumer Control source passed to an executor. */
export interface ControlSource {
  subscribe(
    onAdmission: (admission: ControlAdmission) => void,
    onClose?: () => void,
  ): () => void;
}

export interface ControlSourceOwner {
  readonly controls: ControlSource;
  offer(control: RunControl): ControlSourceOffer;
  close(): void;
}

/** Create one bounded source and its core-owned admission side. */
export function createControlSource(): ControlSourceOwner {
  const pending = new Set<ControlAdmission>();
  const queued: ControlAdmission[] = [];
  let subscriberCreated = false;
  let onAdmission: ((admission: ControlAdmission) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  let pendingBytes = 0;

  const discard = (admission: ControlAdmission, bytes: number): void => {
    if (!pending.delete(admission)) return;
    pendingBytes -= bytes;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    pending.clear();
    pendingBytes = 0;
    const notifyClose = onClose;
    onAdmission = undefined;
    onClose = undefined;
    notifyClose?.();
  };
  const deliverQueued = (): void => {
    while (!closed && onAdmission) {
      const admission = queued.shift();
      if (!admission) return;
      onAdmission(admission);
    }
  };

  return {
    controls: {
      subscribe(subscriber, closeSubscriber) {
        if (subscriberCreated) {
          throw new Error("Control source allows exactly one consumer");
        }
        subscriberCreated = true;
        if (closed) {
          closeSubscriber?.();
          return () => {};
        }
        onAdmission = subscriber;
        onClose = closeSubscriber;
        deliverQueued();
        let unsubscribed = false;
        return () => {
          if (unsubscribed) return;
          unsubscribed = true;
          close();
        };
      },
    },
    offer(control) {
      if (closed) return "closed";
      if (!isValidControlText(control.text)) return "invalid";
      const messageBytes = Buffer.byteLength(control.text, "utf8");
      if (
        pending.size >= CONTROL_MAX_PENDING ||
        pendingBytes + messageBytes > CONTROL_MAX_PENDING_BYTES
      ) {
        return "queue full";
      }
      let acknowledged = false;
      const admission: ControlAdmission = {
        control,
        acknowledge() {
          if (acknowledged) return;
          acknowledged = true;
          discard(admission, messageBytes);
        },
      };
      pending.add(admission);
      pendingBytes += messageBytes;
      queued.push(admission);
      deliverQueued();
      return "accepted";
    },
    close,
  };
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
  readonly controls: ControlSource;
  offer(control: RunControl): ControlGateOffer;
  close(): void;
  cancel(reason: CancellationReason): void;
  state(): ControlGateState;
}

function closedControlSource(): ControlSource {
  let subscriberCreated = false;
  return {
    subscribe(_onAdmission, onClose) {
      if (subscriberCreated) {
        throw new Error("Control source allows exactly one consumer");
      }
      subscriberCreated = true;
      onClose?.();
      return () => {};
    },
  };
}

export function createControlGate(
  declaredControls: readonly RunControl["type"][],
): ControlGate {
  const supportedControls = Object.freeze([...declaredControls]);
  const supportsSteering = supportedControls.includes("steer");
  const source = supportsSteering ? createControlSource() : undefined;
  let closed = false;
  let cancellationReason: CancellationReason | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    source?.close();
  };

  return {
    controls: source?.controls ?? closedControlSource(),
    offer(control) {
      if (closed) return "not steerable";
      if (!supportsSteering || !source) return "unsupported";
      const outcome = source.offer(control);
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
