import type { Fact, RunEnding, RunReporter } from "./run.ts";

/** A source's transport-level result. Exit codes are translated to words by the source. */
export type SourceConclusion =
  | { status: "clean" }
  | { status: "failed"; errorMessage?: string };

export interface OneShotSink<E> {
  event(event: E): void;
  stderr(chunk: string): void;
}

export type OneShotSource<E> = (
  sink: OneShotSink<E>,
  signal: AbortSignal,
) => Promise<SourceConclusion>;

export interface Translation {
  facts?: Fact[];
  transcript?: Fact[];
  terminal?: boolean;
  errorMessage?: string;
}

export interface RunOneShotOptions<E> {
  source: OneShotSource<E>;
  translate: (event: E) => Translation | undefined;
  report: RunReporter;
  signal?: AbortSignal;
  missingAnswerMessage: string;
}

/**
 * Run a one-shot source and reduce its transport ending to the domain ending.
 * Source failures and aborts are represented as endings; a translator error is
 * deliberately allowed to escape because it is a programmer bug, not a child
 * failure.
 */
export async function runOneShot<E>({
  source,
  translate,
  report,
  signal,
  missingAnswerMessage,
}: RunOneShotOptions<E>): Promise<RunEnding> {
  let aborted = signal?.aborted ?? false;
  let terminal = false;
  let settled = false;
  let witnessedError: string | undefined;
  let translatorFailed = false;
  const onAbort = (): void => {
    aborted = true;
  };

  if (signal) {
    if (!signal.aborted)
      signal.addEventListener("abort", onAbort, { once: true });
    else aborted = true;
  }
  if (aborted) return { ending: "cancelled" };

  const sink: OneShotSink<E> = {
    event(event) {
      if (settled || aborted) return;
      let translation: Translation | undefined;
      try {
        translation = translate(event);
      } catch (error) {
        translatorFailed = true;
        throw error;
      }
      if (!translation) return;
      // Latch before reporting: a reporter callback may synchronously request
      // cancellation, but the terminal event was already witnessed.
      if (translation.terminal) terminal = true;
      if (translation.errorMessage !== undefined)
        witnessedError = translation.errorMessage;
      // Facts precede transcript replacement within one wire event.
      for (const fact of translation.facts ?? []) report.message(fact);
      if (translation.transcript !== undefined)
        report.transcript(translation.transcript);
    },
    stderr(chunk) {
      if (!settled && !aborted) report.stderr(chunk);
    },
  };

  let conclusion: SourceConclusion;
  try {
    conclusion = await source(sink, signal ?? new AbortController().signal);
  } catch (error) {
    settled = true;
    if (translatorFailed) throw error;
    if (terminal) return { ending: "answered" };
    if (aborted) return { ending: "cancelled" };
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ending: "failed",
      ...(witnessedError !== undefined
        ? { errorMessage: witnessedError }
        : { errorMessage }),
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  settled = true;
  if (terminal) return { ending: "answered" };
  if (aborted) return { ending: "cancelled" };
  if (conclusion.status === "failed") {
    return {
      ending: "failed",
      ...(witnessedError !== undefined
        ? { errorMessage: witnessedError }
        : conclusion.errorMessage !== undefined
          ? { errorMessage: conclusion.errorMessage }
          : {}),
    };
  }
  return {
    ending: "failed",
    errorMessage: witnessedError ?? missingAnswerMessage,
  };
}

export interface StreamOpenResult<E> {
  events: AsyncIterable<E>;
  stop: () => void;
}

/** Build a source for SDK/stream backends with structural abort handling. */
export function streamSource<E>(
  open: (
    signal: AbortSignal,
    sink: OneShotSink<E>,
  ) => Promise<StreamOpenResult<E> | undefined>,
): OneShotSource<E> {
  return async (sink, signal) => {
    if (signal.aborted) return { status: "clean" };
    // Yield once so an abort issued immediately after starting the protocol
    // wins before the backend's open hook can start external work.
    await Promise.resolve();
    if (signal.aborted) return { status: "clean" };
    let opened: StreamOpenResult<E> | undefined;
    let abortRequested = false;
    const stop = (): void => {
      abortRequested = true;
      opened?.stop();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      opened = await open(signal, sink);
      if (!opened || signal.aborted) {
        if (opened && (abortRequested || signal.aborted)) opened.stop();
        return { status: "clean" };
      }
      for await (const event of opened.events) sink.event(event);
      return { status: "clean" };
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}
