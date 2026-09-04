/**
 * Sentinel error thrown by the `loop-breakpoint` block to unwind out of the
 * enclosing loop body. The engine catches it at the owning loop and resumes
 * from that loop's "end" branch. Kept in its own module so `engine.ts` and
 * `executors.ts` can both import it without a circular dependency.
 *
 * @module background/workflow-engine/loop-breakpoint
 */

export class LoopBreakpointError extends Error {
  /** Target loop's `loopId`; unset means "break the innermost enclosing loop". */
  loopId?: string

  constructor(loopId?: string) {
    super('loop-breakpoint')
    this.name = 'LoopBreakpointError'
    if (loopId !== undefined) this.loopId = loopId
  }
}
