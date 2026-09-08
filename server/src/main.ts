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

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.token) {
    console.warn('[runner] ⚠ BC_TOKEN 未设置：HTTP API 无鉴权，仅建议内网使用')
  }

  const library = new WorkflowLibrary(config.workflowsFile, config.workflowsExtraDir)
  library.load()
  const workflows = library.list()
  console.log(`[runner] 工作流库: ${workflows.length} 条（${config.workflowsFile}）`)
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
  if (config.feishu.botEnabled) {
    bot = startFeishuBot(config, library, runs)
  }

  const app = buildHttpApi({
    config,
    library,
    runs,
    onLibraryChanged: () => scheduler.refresh(),
  })
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[runner] API 就绪: http://0.0.0.0:${config.port}（GET /healthz 探活）`)

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
