/**
 * Structured logging for the runner.
 *
 * One pino instance is built here and shared by every module that needs to
 * emit a line: the HTTP layer, the boot sequence, and — through the Fastify
 * instance — the request lifecycle. Construction lives in this leaf module so
 * that `http-api.ts` and `main.ts` can both import the logger without a
 * circular dependency (main owns the server; the server must not own main).
 *
 * Configuration:
 *  - `BC_LOG_LEVEL` sets the level (default `info`).
 *  - `BC_LOG_PRETTY=1` or `NODE_ENV=development` switches to human-readable
 *    output, but ONLY when the optional `pino-pretty` transport is actually
 *    installed. The production image ships JSON logs and must not crash at
 *    boot because a dev-only formatter is missing.
 *  - Under `NODE_ENV=test` the default level is `silent`, so unit runs stay
 *    readable; a test that wants output can still set `BC_LOG_LEVEL`.
 *
 * @module server/observability
 */

import { createRequire } from 'node:module'
import pino, { type Logger } from 'pino'

const require = createRequire(import.meta.url)

/** True when the optional pretty transport can actually be resolved. */
function hasPrettyTransport(): boolean {
  try {
    require.resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

function resolveLevel(): string {
  const explicit = process.env['BC_LOG_LEVEL']
  if (explicit && explicit.length > 0) return explicit
  if (process.env['NODE_ENV'] === 'test') return 'silent'
  return 'info'
}

function wantsPretty(): boolean {
  if (process.env['BC_LOG_PRETTY'] === '1') return true
  return process.env['NODE_ENV'] === 'development'
}

function createLogger(): Logger {
  const level = resolveLevel()
  if (wantsPretty() && hasPrettyTransport()) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    })
  }
  return pino({ level })
}

/** The process-wide logger. Import this instead of `console`. */
export const logger: Logger = createLogger()

export type { Logger }

// --- Unified error sink ------------------------------------------------------

/**
 * Pluggable error sink (enterprise hardening). Every caught error worth
 * reporting goes through {@link reportError}; with no sink installed it only
 * logs, so a deployment without an APM stays dependency-free.
 * `setErrorReporter` installs a real sink (Sentry, OpenTelemetry, …).
 */
export type ErrorReporter = (error: unknown, context?: Record<string, unknown>) => void

let reporter: ErrorReporter | undefined

/** Installs (or clears, with `undefined`) the process-wide error sink. */
export function setErrorReporter(next: ErrorReporter | undefined): void {
  reporter = next
}

/**
 * Reports an error through the installed sink and ALWAYS logs it locally, so
 * enabling/disabling the sink can never hide a failure from the operator. A
 * broken sink is swallowed — it must not take down its caller.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  const err =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error
  logger.error({ err, ...(context ?? {}) }, 'error reported')
  try {
    reporter?.(error, context)
  } catch {
    /* sink failures are non-fatal */
  }
}
