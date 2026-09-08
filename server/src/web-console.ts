/**
 * Mounts the Web console SPA on the runner's Fastify instance.
 *
 * When `server/web/dist` exists (run `pnpm --dir server build`), the built
 * assets are served statically with an SPA fallback for client-side routes.
 * Without a build, `/` serves a short hint page; the API is unaffected.
 *
 * @module server/web-console
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import { serverRoot } from './config'
import type { FastifyInstance } from 'fastify'

const UNBUILT_CONSOLE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Browser Copilot Runner</title></head>
<body style="font-family:system-ui;background:#111418;color:#d7dbe0;max-width:640px;margin:15vh auto;padding:0 24px;line-height:1.7">
<h2>Web 控制台尚未构建</h2>
<p>HTTP API 已正常运行，但静态控制台缺失。在服务器上执行：</p>
<pre style="background:#1c2026;padding:12px;border-radius:8px">pnpm install
pnpm --dir server build</pre>
<p>然后重启进程，刷新本页即可进入控制台。API 用法见 <code>docs/server.md</code>。</p>
</body></html>`

/** Mounts the console; returns true when the built SPA is being served. */
export async function mountConsole(app: FastifyInstance): Promise<boolean> {
  const webDist = join(serverRoot(), 'web', 'dist')
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })
    // SPA fallback: client-side routes (e.g. /workflows) get the shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' })
      return reply.sendFile('index.html')
    })
    return true
  }
  app.get('/', async () => UNBUILT_CONSOLE_HTML)
  return false
}
