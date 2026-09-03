/**
 * The depth contract, as the Pi adapter names it.
 *
 * The key and the reader moved to `backend/depth.ts` at M5, when a second
 * adapter needed them: the Depth constraint binds every backend, so one shared
 * constant is what keeps a Bash-launched grandchild reading the same variable
 * whichever backend spawned its parent. This module re-exports them so the Pi
 * adapter's own surface is unchanged.
 */

export {
  DEPTH_ENV_KEY,
  type DepthEnvironment,
  readChildDepth,
} from "../depth.ts";
