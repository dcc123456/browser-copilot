/**
 * Sentinel error thrown by the `loop-breakpoint` block to unwind out of the
 * enclosing loop body. The engine catches it at the owning loop and re-enters
 * the loop for the next item, or leaves the loop entirely when `clearLoop` is
 * set (Automa's "Stop loop"). Kept in its own module so `engine.ts` and
 * `executors.ts` can both import it without a circular dependency.
 *
 * @module background/workflow-engine/loop-breakpoint
 */

export class LoopBreakpointError extends Error {
  /** Target loop's `loopId`; unset means "break the innermost enclosing loop". */
  loopId?: string
  /** Automa's `clearLoop`: finish the loop now instead of skipping one item. */
  clearLoop: boolean
  /** The breakpoint node that threw, so its out-edge can carry the loop exit. */
  nodeId?: string

  constructor(loopId?: string, clearLoop = false, nodeId?: string) {
    super('loop-breakpoint')
    this.name = 'LoopBreakpointError'
    if (loopId !== undefined) this.loopId = loopId
    this.clearLoop = clearLoop
    if (nodeId !== undefined) this.nodeId = nodeId
  }
}
