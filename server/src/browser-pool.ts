/**
 * Browser pool for the server runner.
 *
 * Every run executes inside its own browser context:
 * - `fresh` (default): a throwaway incognito context — no cookies, storage or
 *   cache leak between runs;
 * - `persistent:<name>`: a real profile directory kept on disk
 *   (`<dataDir>/profiles/<name>`), so logins survive between runs. Playwright
 *   models a persistent profile as its own browser instance
 *   (`launchPersistentContext`); each profile runs ONE run at a time (a second
 *   run on the same profile waits for its turn).
 *
 * `mode: 'cdp'` connects to a remote Chromium (browserless, a sidecar
 * container, `chrome --remote-debugging-port`) via `connectOverCDP`. Fresh
 * contexts work there; persistent profiles are a local-mode feature and fall
 * back to fresh with a warning.
 *
 * @module server/browser-pool
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
} from 'playwright'
import type { RunnerConfig } from './config'

/**
 * Proxy settings for a run context. Structurally identical to Playwright's
 * `ProxySettings` (which this playwright build does not export at top level),
 * so it passes straight into `newContext({ proxy })`.
 */
export interface ProxySettings {
  server: string
  bypass?: string
  username?: string
  password?: string
}

/** Everything a run needs from the pool; the driver works on top of it. */
export interface RunSession {
  /** The context every page of this run lives in. */
  readonly context: BrowserContext
  kind: 'fresh' | 'persistent'
  profile?: string
  /** Downloads are auto-saved here (the run's artifacts directory). */
  artifactsDir?: string
}

interface AcquireOptions {
  profile?: string
  proxy?: ProxySettings
  artifactsDir?: string
}

/** Serializes access to a persistent profile (one run at a time). */
class Mutex {
  private waiters: (() => void)[] = []
  private locked = false

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.locked = false
  }
}

const DESKTOP_CONTEXT: BrowserContextOptions = {
  acceptDownloads: true,
  // A desktop-ish viewport: sites serve the same layout the extension sees,
  // and in-page scroll/viewport math stays realistic.
  viewport: { width: 1280, height: 800 },
}

export class BrowserPool {
  private localBrowser: Browser | null = null
  /** Second instance, launched with a per-context proxy placeholder so runs
   * may request their own proxy (a Chromium requirement). Created lazily. */
  private localProxyBrowser: Browser | null = null
  private cdpBrowser: Browser | null = null
  private persistent = new Map<string, BrowserContext>()
  private persistentLocks = new Map<string, Mutex>()
  private closed = false

  constructor(private readonly config: RunnerConfig) {}

  /**
   * Acquires a session for one run. `profile` selects a persistent profile
   * (any name, e.g. `"shopping"`); `proxy` applies to fresh contexts (local
   * mode). The caller MUST call {@link release} exactly once.
   */
  async acquire(opts: AcquireOptions = {}): Promise<RunSession> {
    if (this.closed) throw new Error('Browser pool is closed')
    const profile = opts.profile?.trim()

    if (profile && this.config.browser.mode === 'cdp') {
      // Persistent profiles need a local profile directory — over CDP the
      // browser (and its profiles) belong to the remote host.
      console.warn(
        `[runner] profile "${profile}" requested in cdp mode; persistent profiles are local-mode only, using a fresh context.`,
      )
    } else if (profile) {
      return this.acquirePersistent(profile, opts)
    }

    const context = await this.newFreshContext(opts.proxy)
    // A fresh context starts with ZERO pages; give the run one blank page so
    // navigation blocks ("open-url" targets the CURRENT tab) work immediately,
    // mirroring the extension where a run always has the user's active tab.
    await context.newPage().catch(() => {})
    return {
      context,
      kind: 'fresh',
      ...(opts.artifactsDir ? { artifactsDir: opts.artifactsDir } : {}),
    }
  }

  private async newFreshContext(proxy?: ProxySettings): Promise<BrowserContext> {
    if (this.config.browser.mode === 'cdp') {
      const browser = await this.connectCdp()
      return browser.newContext(DESKTOP_CONTEXT)
    }
    if (proxy) {
      const browser = await this.ensureLocal(true)
      return browser.newContext({ ...DESKTOP_CONTEXT, proxy })
    }
    const browser = await this.ensureLocal(false)
    return browser.newContext(DESKTOP_CONTEXT)
  }

  private async ensureLocal(perContextProxy: boolean): Promise<Browser> {
    if (perContextProxy) {
      if (!this.localProxyBrowser) {
        this.localProxyBrowser = await chromium.launch({
          headless: this.config.browser.headless,
          // Chromium only honors per-context proxies when the browser itself
          // launches with this placeholder server.
          proxy: { server: 'http://per-context' },
        })
      }
      return this.localProxyBrowser
    }
    if (!this.localBrowser) {
      this.localBrowser = await chromium.launch({ headless: this.config.browser.headless })
    }
    return this.localBrowser
  }

  private async connectCdp(): Promise<Browser> {
    if (!this.cdpBrowser) {
      this.cdpBrowser = await chromium.connectOverCDP(this.config.browser.cdpEndpoint, {
        timeout: 30_000,
      })
    }
    return this.cdpBrowser
  }

  /**
   * Persistent-profile acquisition. The profile's mutex is taken HERE and
   * released in {@link release} — the run owns the profile for its duration.
   */
  private async acquirePersistent(profile: string, opts: AcquireOptions): Promise<RunSession> {
    let lock = this.persistentLocks.get(profile)
    if (!lock) {
      lock = new Mutex()
      this.persistentLocks.set(profile, lock)
    }
    await lock.acquire()
    try {
      let context = this.persistent.get(profile)
      if (!context) {
        const dir = join(this.config.dataDir, 'profiles', profile)
        mkdirSync(dir, { recursive: true })
        context = await chromium.launchPersistentContext(dir, {
          headless: this.config.browser.headless,
          acceptDownloads: true,
          viewport: { width: 1280, height: 800 },
          ...(opts.proxy ? { proxy: opts.proxy } : {}),
        })
        context.on('close', () => {
          // Crashed / manually closed: forget it so the next run relaunches.
          this.persistent.delete(profile)
        })
        this.persistent.set(profile, context)
      }
      return {
        context,
        kind: 'persistent',
        profile,
        ...(opts.artifactsDir ? { artifactsDir: opts.artifactsDir } : {}),
      }
    } catch (error) {
      // Do not hold the profile hostage when launch failed.
      this.persistentLocks.get(profile)?.release()
      throw error
    }
  }

  /**
   * Releases a session. Fresh contexts close (state is throwaway); persistent
   * contexts stay warm for the next run on that profile.
   */
  async release(session: RunSession): Promise<void> {
    if (session.kind === 'fresh') {
      try {
        await session.context.close()
      } catch {
        /* already gone */
      }
      return
    }
    const profile = session.profile ?? 'default'
    this.persistentLocks.get(profile)?.release()
  }

  /** Shuts everything down (server stop). */
  async close(): Promise<void> {
    this.closed = true
    for (const context of this.persistent.values()) {
      await context.close().catch(() => {})
    }
    this.persistent.clear()
    for (const browser of [this.localBrowser, this.localProxyBrowser, this.cdpBrowser]) {
      await browser?.close().catch(() => {})
    }
    this.localBrowser = this.localProxyBrowser = this.cdpBrowser = null
  }
}
