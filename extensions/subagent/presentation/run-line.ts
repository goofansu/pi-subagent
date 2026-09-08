/**
 * Geometric fitting for widget rows and dashboard history lists.
 *
 * Run meaning is resolved before it reaches this module. Fitting owns each
 * surface's caps, thresholds, priorities, padding, and duration reservation;
 * painters only style and join the fitted parts.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth } from "./text-width.ts";

const MAX_RUN_LABEL_WIDTH = 40;

/** Separators shared by fitting and the surface painters. */
export const RUN_STATUS_SEPARATOR = "  ";

/** Wrap the activity marker in the spaces fitting reserves around it. */
export function runActivitySeparator(marker: string): string {
  return ` ${marker} `;
}

export const RUN_ACTIVITY_SEPARATOR = runActivitySeparator("·");

/** One Run's already-resolved text, including its supplied duration. */
export interface ResolvedRunLineContent {
  readonly label: string;
  readonly status: string;
  readonly activity: string;
  readonly duration: string;
}

/** One Run line's parts, each clipped to the columns it was allotted. */
export interface FittedRunLine {
  readonly label: string;
  readonly status?: string;
  readonly activity?: string;
  /** Already right-aligned when the surface gives duration a fixed column. */
  readonly duration?: string;
  /** Blank columns between the last inline part and the duration. */
  readonly gap: number;
}

interface LabelBudget {
  readonly column?: number;
  readonly cap?: number;
}

interface StatusBudget {
  readonly column?: number;
  readonly gate?: number;
  readonly leaves?: number;
  readonly gap?: number;
}

interface ActivityBudget {
  readonly gate?: number;
  readonly needs?: number;
  readonly share?: number;
  readonly leaves?: number;
  readonly gap?: number;
}

interface DurationBudget {
  readonly column?: number;
  readonly minLineWidth?: number;
  readonly gap?: number;
  readonly yields?: boolean;
}

/** Private arithmetic configuration; callers choose a surface operation instead. */
interface RunLinePolicy {
  readonly reserved?: number;
  readonly label: LabelBudget;
  readonly status?: StatusBudget;
  readonly activity?: ActivityBudget;
  readonly duration?: DurationBudget;
  readonly padded?: boolean;
  readonly plain?: boolean;
}

interface FitPass {
  readonly line: FittedRunLine;
  readonly complete: boolean;
}

const EMPTY_LINE: FittedRunLine = { label: "", gap: 0 };

const MIN_WIDGET_LABEL_WIDTH = 7;
const MIN_WIDGET_ACTIVITY_WIDTH = 12;

/**
 * Keep a recognizable Label and useful activity ahead of elapsed time. The
 * duration retry is intentional: a clock yields whole when reserving it would
 * push activity below the width at which it still names useful work.
 */
const WIDGET_POLICY: RunLinePolicy = {
  plain: true,
  label: { cap: MAX_RUN_LABEL_WIDTH },
  status: { leaves: 1, gap: visibleWidth(RUN_STATUS_SEPARATOR) },
  activity: {
    needs: MIN_WIDGET_ACTIVITY_WIDTH,
    leaves: MIN_WIDGET_LABEL_WIDTH,
    gap: visibleWidth(RUN_ACTIVITY_SEPARATOR),
  },
  duration: { gap: visibleWidth(RUN_STATUS_SEPARATOR), yields: true },
};

const HISTORY_STATUS_GATE = 24;
const HISTORY_ACTIVITY_GATE = 50;
const HISTORY_ACTIVITY_SHARE = 0.45;
const HISTORY_ELAPSED_WIDTH = 8;
const HISTORY_ELAPSED_MIN_LINE_WIDTH = 80;

interface HistoryColumns {
  readonly label: number;
  readonly status: number;
  readonly prefix: number;
}

type HistoryRunLineContent = ResolvedRunLineContent & {
  /** The actual selection prefix the painter will draw. */
  readonly prefix: string;
};

function measuredColumn(values: readonly string[], cap: number): number {
  return Math.min(cap, Math.max(0, ...values.map(visibleWidth)));
}

/**
 * Shared history columns are padded. Status and activity retain their 24/50
 * content gates after the prefix; duration retains its 80-column row gate.
 */
function historyPolicy(columns: HistoryColumns): RunLinePolicy {
  return {
    reserved: columns.prefix,
    padded: true,
    label: { column: columns.label },
    status: {
      column: columns.status,
      gate: HISTORY_STATUS_GATE,
      gap: visibleWidth(RUN_STATUS_SEPARATOR),
    },
    activity: {
      share: HISTORY_ACTIVITY_SHARE,
      gate: HISTORY_ACTIVITY_GATE,
      gap: visibleWidth(RUN_ACTIVITY_SEPARATOR),
    },
    duration: {
      column: HISTORY_ELAPSED_WIDTH,
      minLineWidth: HISTORY_ELAPSED_MIN_LINE_WIDTH,
      gap: visibleWidth(RUN_STATUS_SEPARATOR),
    },
  };
}

/**
 * Fit already-resolved widget content into its content area.
 *
 * `contentWidth` excludes the widget's equal outer margins. The outer widget
 * renderer owns those margins and removes them exactly once.
 */
export function fitWidgetRunLine(
  content: ResolvedRunLineContent,
  contentWidth: number,
): FittedRunLine {
  return fitRunLine(content, WIDGET_POLICY, contentWidth);
}

/**
 * Fit a dashboard history list, measuring shared columns from the supplied
 * resolved rows. Status/activity gates measure content after the selection
 * prefix, preserving their established full-row transitions at 26/52 columns;
 * the duration gate continues to measure the full row width.
 */
export function fitHistoryRunLines(
  contents: readonly HistoryRunLineContent[],
  width: number,
): readonly FittedRunLine[] {
  const columns = {
    label: measuredColumn(
      contents.map((content) => content.label),
      MAX_RUN_LABEL_WIDTH,
    ),
    status: measuredColumn(
      contents.map((content) => content.status),
      Number.POSITIVE_INFINITY,
    ),
    prefix: measuredColumn(
      contents.map((content) => content.prefix),
      Number.POSITIVE_INFINITY,
    ),
  };
  const policy = historyPolicy(columns);
  return contents.map((content) => fitRunLine(content, policy, width));
}

function fitRunLine(
  parts: ResolvedRunLineContent,
  policy: RunLinePolicy,
  width: number,
): FittedRunLine {
  const pass = fitPass(parts, policy, width, policy.duration !== undefined);
  return pass.complete || !policy.duration?.yields
    ? pass.line
    : fitPass(parts, policy, width, false).line;
}

function fitPass(
  parts: ResolvedRunLineContent,
  policy: RunLinePolicy,
  width: number,
  allowDuration: boolean,
): FitPass {
  const fit = (text: string, columns: number) =>
    fitToWidth(text, columns, {
      pad: policy.padded ?? false,
      plain: policy.plain ?? false,
    });
  const columns = Math.max(0, width - (policy.reserved ?? 0));

  const duration = policy.duration;
  const durationColumn = duration?.column ?? visibleWidth(parts.duration);
  const durationGap = duration?.gap ?? 0;
  const showDuration =
    allowDuration &&
    duration !== undefined &&
    durationColumn > 0 &&
    width >= (duration.minLineWidth ?? 0);
  const available = columns - (showDuration ? durationColumn + durationGap : 0);
  if (available <= 0) return { line: EMPTY_LINE, complete: false };

  const status = policy.status;
  const statusColumn = status?.column ?? visibleWidth(parts.status);
  const statusGap = status?.gap ?? 0;
  const showStatus =
    status !== undefined &&
    statusColumn > 0 &&
    available >= (status.gate ?? 0) &&
    (status.leaves === undefined ||
      available - statusColumn - statusGap >= status.leaves);

  const activity = policy.activity;
  const activityGap = activity?.gap ?? 0;
  let showActivity =
    (status === undefined || showStatus) &&
    activity !== undefined &&
    available >= (activity.gate ?? 0);

  const labelWant =
    policy.label.column ??
    visibleWidth(fitToWidth(parts.label, policy.label.cap ?? available));
  const beside =
    available - (showStatus ? statusColumn + statusGap : 0) - activityGap;

  let labelColumns = 0;
  let activityColumns = 0;
  if (showActivity && activity !== undefined) {
    const room = Math.max(0, beside);
    const held =
      activity.share !== undefined
        ? Math.floor(available * activity.share)
        : Math.min(activity.needs ?? 0, visibleWidth(parts.activity));
    labelColumns = Math.min(
      labelWant,
      Math.max(activity.leaves ?? 0, room - held),
    );
    activityColumns = Math.max(0, room - labelColumns);
    if (activity.needs !== undefined && activityColumns < held) {
      showActivity = false;
    }
  }
  if (!showActivity) {
    labelColumns = Math.min(labelWant, Math.max(0, beside + activityGap));
  }

  const label = labelColumns > 0 ? fit(parts.label, labelColumns) : "";
  const fittedStatus = showStatus ? fit(parts.status, statusColumn) : undefined;
  const fittedActivity =
    showActivity && activityColumns > 0
      ? fit(parts.activity, activityColumns)
      : undefined;
  // An unpadded part can consume less than its allotment when clipping stops
  // before a wide grapheme, so spacing is based on the actual fitted text.
  const inline =
    visibleWidth(label) +
    (fittedStatus === undefined ? 0 : statusGap + visibleWidth(fittedStatus)) +
    (fittedActivity === undefined
      ? 0
      : activityGap + visibleWidth(fittedActivity));
  const fittedDuration = showDuration
    ? fitToWidth(parts.duration, durationColumn)
    : undefined;

  return {
    line: {
      label,
      ...(fittedStatus === undefined || fittedStatus === ""
        ? {}
        : { status: fittedStatus }),
      ...(fittedActivity === undefined || fittedActivity === ""
        ? {}
        : { activity: fittedActivity }),
      ...(fittedDuration === undefined
        ? {}
        : {
            duration:
              " ".repeat(
                Math.max(0, durationColumn - visibleWidth(fittedDuration)),
              ) + fittedDuration,
          }),
      gap: showDuration ? Math.max(0, columns - inline - durationColumn) : 0,
    },
    complete:
      label !== "" &&
      (status === undefined || showStatus) &&
      (activity === undefined || showActivity),
  };
}
