/**
 * The server runner entry point: config → workflow library → browser pool →
 * run service → scheduler → HTTP API → (optional) Feishu bot.
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

async function main(): Promise<void> {
  const config = loadConfig()

  const library = new WorkflowLibrary(config.workflowsFile, config.workflowsExtraDir)
  library.load()
  const workflows = library.list()
  const cycles = library.allCycles()
  if (cycles.length > 0) {
    console.warn(`[runner] ⚠ 检测到工作流循环引用（运行时会被引擎拦截）: ${cycles.map((c) => c.join('→')).join('; ')}`)
  }
  for (const workflow of workflows) {
    const missing = library.missingFor(workflow.id)
    if (missing.length > 0) {
      console.warn(`[runner] ⚠ 「${workflow.name}」缺少子工作流: ${missing.join(', ')}（复制时需一并带上）`)
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
  console.log(`[runner] API 就绪: http://0.0.0.0:${config.port}（GET /healthz 探活）`)
  if (consoleBuilt) {
    console.log(`[runner] Web 控制台: http://127.0.0.1:${config.port}/`)
  } else {
    console.log(`[runner] Web 控制台未构建（pnpm --dir server build 后重启生效）；API 正常`)
  }
  if (!config.token) {
    console.warn(
      consoleBuilt
        ? '[runner] ⚠ API Token 未设置：HTTP API 无鉴权（仅限内网）。打开控制台 → 设置 → 安全，填写 Token 保存即可'
        : '[runner] ⚠ API Token 未设置：HTTP API 无鉴权（仅限内网）。设置 BC_TOKEN 环境变量或编辑 server/config.json 后重启',
    )
  }
  if (workflows.length === 0) {
    console.log('[runner] 工作流库为空：在控制台「工作流」页导入 workflows.json，或放入工作流文件后重启')
  } else {
    console.log(`[runner] 工作流库: ${workflows.length} 条`)
  }

  const shutdown = async (): Promise<void> => {
    console.log('[runner] shutting down…')
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
  console.error('[runner] fatal:', error)
  process.exit(1)
})
