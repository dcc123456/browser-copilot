/**
 * The server runner entry point: config → workflow library → browser pool →
 * run service → scheduler → HTTP API → (optional) Feishu bot.
 *
 * Auth is mandatory by default: a token must be configured (BC_TOKEN or
 * `config.json`) or the process refuses to boot. `BC_ALLOW_UNAUTHENTICATED=1`
 * is the explicit, loud escape hatch for trusted local development — it is
 * never the default, so an internet-reachable runner cannot start open by
 * accident.
 *
 * @module server/main
 */

import { loadConfig } from './config'
import { WorkflowLibrary } from './workflow-library'
import { BrowserPool } from './browser-pool'
import { RunService } from './run-service'
import { buildHttpApi } from './http-api'
import { Scheduler } from './scheduler'
import { startFeishuBot, type FeishuBot } from './feishu-bot'
import { mountConsole } from './web-console'
import { logger } from './observability'

/** True when the operator explicitly opted out of authentication. */
function allowUnauthenticated(): boolean {
  return process.env['BC_ALLOW_UNAUTHENTICATED'] === '1'
}

async function main(): Promise<void> {
  const config = loadConfig()

  if (!config.token && !allowUnauthenticated()) {
    throw new Error(
      'Refusing to start without an API token: set BC_TOKEN (or "token" in config.json) to a strong secret. ' +
        'To run an unauthenticated server for trusted local development only, set BC_ALLOW_UNAUTHENTICATED=1.',
    )
  }

  const library = new WorkflowLibrary(config.workflowsFile, config.workflowsExtraDir)
  library.load()
  const workflows = library.list()
  const cycles = library.allCycles()
  if (cycles.length > 0) {
    logger.warn(
      `[runner] ⚠ 检测到工作流循环引用（运行时会被引擎拦截）: ${cycles.map((c) => c.join('→')).join('; ')}`,
    )
  }
  for (const workflow of workflows) {
    const missing = library.missingFor(workflow.id)
    if (missing.length > 0) {
      logger.warn(
        `[runner] ⚠ 「${workflow.name}」缺少子工作流: ${missing.join(', ')}（复制时需一并带上）`,
      )
    }
  }

  const pool = new BrowserPool(config)
  const runs = new RunService(config, pool, library)
  const scheduler = new Scheduler(config, library, runs)
  scheduler.refresh()

  let bot: FeishuBot | null = null
  // (Re)starts the Feishu long connection from the CURRENT config — called at
  // boot and after every Web-console config change.
  const ensureBot = (): void => {
    bot?.stop()
    bot = config.feishu.botEnabled ? startFeishuBot(config, library, runs) : null
  }
  ensureBot()

  const app = buildHttpApi({
    config,
    library,
    runs,
    onLibraryChanged: () => scheduler.refresh(),
    onConfigChanged: () => ensureBot(),
    feishuConnected: () => bot?.connected() ?? false,
    schedulesOverview: () => scheduler.scheduleOverview(),
  })

  // Mount the built console SPA; without it, serve a build hint at `/`.
  const consoleBuilt = await mountConsole(app)

  await app.listen({ port: config.port, host: '0.0.0.0' })

  // One startup summary, written once the port is actually bound. First-run
  // gaps (no token / empty library) are surfaced as pointers INTO the console,
  // since the whole setup can be completed there.
  logger.info(`[runner] API 就绪: http://0.0.0.0:${config.port}（GET /healthz 探活）`)
  if (consoleBuilt) {
    logger.info(`[runner] Web 控制台: http://127.0.0.1:${config.port}/`)
  } else {
    logger.info('[runner] Web 控制台未构建（pnpm --dir server build 后重启生效）；API 正常')
  }
  if (!config.token) {
    logger.warn(
      '[runner] ⚠ BC_ALLOW_UNAUTHENTICATED=1：HTTP API 无鉴权，仅限受信本地开发使用；请勿暴露到公网',
    )
  }
  if (workflows.length === 0) {
    logger.info(
      '[runner] 工作流库为空：在控制台「工作流」页导入 workflows.json，或放入工作流文件后重启',
    )
  } else {
    logger.info(`[runner] 工作流库: ${workflows.length} 条`)
  }

  const shutdown = async (): Promise<void> => {
    logger.info('[runner] shutting down…')
    scheduler.stop()
    bot?.stop()
    await pool.close().catch(() => {})
    await app.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  logger.fatal({ err: error }, '[runner] fatal')
  process.exit(1)
})
