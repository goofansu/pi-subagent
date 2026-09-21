import type { ResultLink, RunDiagnostic, RunResult } from "../domain/index.ts";
import { formatByteCount } from "./final-output-section.ts";

/** One diagnostic with its stable category. */
export function formatDiagnosticLine(diagnostic: RunDiagnostic): string {
  return `${diagnostic.category}: ${diagnostic.message}`;
}

/** One backend-neutral link and its target. */
export function formatResultLinkLine(link: ResultLink): string {
  return `${link.label} (${link.kind}): ${link.target}`;
}

/** What bounding removed outside the separately owned final-output section. */
export function formatTruncation(
  result: Pick<RunResult, "truncation">,
): string | undefined {
  const dropped: string[] = [];
  const { truncation } = result;
  if (truncation.droppedTranscriptItems > 0) {
    dropped.push(`${truncation.droppedTranscriptItems} transcript items`);
  }
  if (truncation.droppedToolEntries > 0) {
    dropped.push(`${truncation.droppedToolEntries} tool entries`);
  }
  if (truncation.droppedDiagnostics > 0) {
    dropped.push(`${truncation.droppedDiagnostics} diagnostics`);
  }
  if (truncation.droppedLinks > 0) {
    dropped.push(`${truncation.droppedLinks} links`);
  }
  if (truncation.truncatedTranscriptBytes > 0) {
    dropped.push(
      `${formatByteCount(truncation.truncatedTranscriptBytes)} bytes of transcript text`,
    );
  }
  if (truncation.truncatedToolOutputBytes > 0) {
    dropped.push(
      `${formatByteCount(truncation.truncatedToolOutputBytes)} bytes of tool output`,
    );
  }
  return dropped.length > 0
    ? `Dropped to stay within bounds: ${dropped.join(", ")}.`
    : undefined;
}
