/**
 * Breakpoint step debugging for workflow runs (Automa's `testingMode`).
 *
 * Automa pauses its worker before a block carrying `$breakpoint` and exposes
 * Resume / Next / Stop. The engine knows nothing about that UI: it awaits one
 * optional hook per node, and every pause lives here. Keeping the pause state
 * machine chrome-free means it can be unit-tested and reused by any host (the
 * extension's run path supplies status lines and the run board; tests supply
 * stubs).
 *
 * Semantics:
 * - a breakpoint pauses BEFORE the marked block executes;
 * - `resume` continues, pausing again only at the next breakpoint;
 * - `next` forces one pause before the successor block (the current block
 *   runs while "frozen" from the user's point of view — exactly Automa's step);
 * - `stop` and the pause deadline both call {@link DebugSessionOptions.onStop};
 *   the host cancels the run's controller, which settles the held hook through
 *   the abort listener.
 *
 * A paused run cannot survive MV3 service-worker eviction, so the deadline is
 * an upper bound on how long it may sit idle, not a persistence mechanism.
 *
 * @module background/workflow-debugger
 */

/** Default upper bound for one pause; comfortably inside `keepalive`'s cap. */
export const DEFAULT_PAUSE_TIMEOUT_MS = 8 * 60 * 1000

/** What the engine reports before entering one node. */
export interface DebugHookInfo {
  nodeId: string
  blockId: string
  variables: Record<string, unknown>
  breakpoint: boolean
  signal: AbortSignal
}

/** One suspended run, as reported to the host. */
export interface DebugPauseInfo {
  nodeId: string
  blockId: string
  /** Clone of the run variables at the pause, safe to keep after resuming. */
  variables: Record<string, unknown>
  at: number
}

export type DebugControlAction = 'resume' | 'next' | 'stop'

export interface DebugSessionOptions {
  /** The run's signal; aborting settles any held pause (a cancelled run). */
  signal: AbortSignal
  onPause: (pause: DebugPauseInfo) => void
  /** Called when a pause is released by resume / next (not by stop/abort). */
  onResume?: (pause: DebugPauseInfo) => void
  /** Stop button or pause deadline: the host must abort the run's controller. */
  onStop: (reason: 'stop' | 'timeout') => void
  pauseTimeoutMs?: number
}

export interface DebugSession {
  /** Pass as `WorkflowRunOptions.onBeforeNode`. */
  hook: (info: DebugHookInfo) => void | Promise<void>
  /** Answers a paused run; false when nothing is paused or the session ended. */
  control: (action: DebugControlAction) => boolean
  /** The current pause, or null when running. */
  paused: () => DebugPauseInfo | null
  /** Settles a held pause without callbacks and detaches every listener. */
  dispose: () => void
}

/** Structural clone with a plain-object fallback for non-serializable values. */
function cloneVariables(variables: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(variables ?? {})) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function createDebugSession(options: DebugSessionOptions): DebugSession {
  const { signal, onPause, onResume, onStop } = options
  const pauseTimeoutMs = Math.max(1000, options.pauseTimeoutMs ?? DEFAULT_PAUSE_TIMEOUT_MS)
  let disposed = false
  let stopped = false
  let forceNext = false
  let pause: DebugPauseInfo | null = null
  let settlePause: (() => void) | null = null
  let deadline: ReturnType<typeof setTimeout> | undefined

  const clearDeadline = (): void => {
    if (deadline !== undefined) {
      clearTimeout(deadline)
      deadline = undefined
    }
  }

  const release = (): void => {
    clearDeadline()
    pause = null
    const settle = settlePause
    settlePause = null
    settle?.()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    // A cancelled / stopped run must not leave the engine waiting on a resume.
    signal.removeEventListener('abort', dispose)
    release()
  }
  signal.addEventListener('abort', dispose, { once: true })

  const stop = (reason: 'stop' | 'timeout'): void => {
    if (stopped || disposed) return
    stopped = true
    // Wake the engine first: the host's abort then unwinds an already-settled
    // hook instead of racing it.
    release()
    onStop(reason)
    dispose()
  }

  async function hook(info: DebugHookInfo): Promise<void> {
    if (disposed || stopped || signal.aborted) return
    const shouldPause = info.breakpoint || forceNext
    if (!shouldPause) return
    forceNext = false
    const current: DebugPauseInfo = {
      nodeId: info.nodeId,
      blockId: info.blockId,
      variables: cloneVariables(info.variables),
      at: Date.now(),
    }
    pause = current
    onPause(current)
    deadline = setTimeout(() => stop('timeout'), pauseTimeoutMs)
    await new Promise<void>((resolve) => {
      settlePause = resolve
    })
  }

  function control(action: DebugControlAction): boolean {
    if (disposed) return false
    if (action === 'stop') {
      // Not paused: there is nothing to release; the host still cancels.
      if (!pause) return false
      stop('stop')
      return true
    }
    if (!pause) return false
    if (action === 'next') forceNext = true
    const released = pause
    release()
    onResume?.(released)
    return true
  }

  return {
    hook,
    control,
    paused: () => pause,
    dispose,
  }
}
