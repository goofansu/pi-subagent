import type { LifecycleStatus } from "./types.ts";

/** A duration for humans: tenths under a minute, then m/s, then h/m. */
export function formatDuration(milliseconds: number): string {
  const clampedMilliseconds = Math.max(0, milliseconds);
  const tenths = Math.round(clampedMilliseconds / 100);
  if (tenths < 60 * 10) return `${(tenths / 10).toFixed(1)}s`;

  const wholeSeconds = Math.round(clampedMilliseconds / 1000);
  if (wholeSeconds < 60 * 60) {
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }

  const hours = Math.floor(wholeSeconds / (60 * 60));
  const minutes = Math.floor((wholeSeconds % (60 * 60)) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * A run's lifecycle in words, with the time it took.
 *
 * Takes the projected shape rather than a `SingleResult`, so the widget, the
 * overlay and any future surface all render a status the same way from the
 * same data. This is the whole of what "what does aborted look like" means.
 */
export function runStatusGlyph(status: LifecycleStatus): string {
  switch (status) {
    case "running":
      return "⏳";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "aborted":
      return "⊘";
  }
}

/** The theme colour a status should be painted in. */
export function runStatusTone(status: LifecycleStatus): string {
  switch (status) {
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "aborted":
      return "error";
  }
}

export function formatRunStatus(run: {
  status: LifecycleStatus;
  elapsedMs: number;
}): string {
  const duration = formatDuration(run.elapsedMs);
  switch (run.status) {
    case "running":
      return `running for ${duration}`;
    case "completed":
      return `completed in ${duration}`;
    case "failed":
      return `failed after ${duration}`;
    case "aborted":
      return `aborted after ${duration}`;
  }
}
