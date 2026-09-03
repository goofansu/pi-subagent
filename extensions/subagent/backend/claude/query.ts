/**
 * The one place the Claude SDK's own types are named, and the loader.
 *
 * Everything the adapter needs from `@anthropic-ai/claude-agent-sdk` enters
 * through this module: the streamed input message, the frame union, the
 * options bag, and the two operations the adapter performs on a live Query.
 * The rest of the adapter is written against these aliases, so an SDK that
 * renames or re-shapes a type changes this file first — and nothing outside
 * `backend/claude/` can name any of them at all, which the boundary test
 * checks.
 *
 * The Query is deliberately narrowed to {@link ClaudeQueryStream}: the SDK's
 * own `Query` carries a dozen control methods, and the adapter drives exactly
 * two of them — iterate, and close. Naming the slice rather than the whole
 * interface is what lets a stand-in be a drop-in without implementing control
 * requests the adapter never sends, and it documents the surface the seam
 * actually depends on.
 *
 * The loader is a **dynamic import**, exactly as v1's is, and that is not an
 * accident of style. A missing or broken SDK has to be `backend unavailable`
 * rather than a module-load crash that takes the whole extension with it, and
 * a static import would be resolved when this file is first reached — which is
 * when the composition root builds the backend set, long before any Profile
 * has asked for Claude.
 */

import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type { Options, SDKMessage, SDKUserMessage };

/**
 * The slice of one live Query the adapter drives.
 *
 * Iterating it is the Run's only event channel — there is no session-level
 * subscription to attach or release — and closing it is half of what
 * cancellation does. The SDK's `Query` satisfies this, so the real thing is a
 * drop-in and so is a stand-in.
 */
export interface ClaudeQueryStream extends AsyncIterable<SDKMessage> {
  readonly close: () => void;
}

/** One streaming Query, as the adapter calls it. */
export type ClaudeQuery = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => ClaudeQueryStream;

/**
 * How the query function is obtained.
 *
 * The injection point for the whole adapter: a test supplies a scriptable
 * stand-in here and nothing in the adapter branches on whether it is under
 * test.
 */
export type ClaudeQueryLoader = () => Promise<ClaudeQuery>;

/** Load the real thing. */
export const loadClaudeQuery: ClaudeQueryLoader = async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query;
};
