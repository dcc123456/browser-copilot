#!/usr/bin/env node
/**
 * Packages the built extension into a loadable zip.
 *
 * The zip has the built files at its root (manifest.json, icons/, assets/…),
 * not under a dist/ folder, because Chrome's "Load unpacked" and the resulting
 * release both expect manifest.json at the archive root. Source maps are
 * omitted to keep the download small; the minify setting is off, so the shipped
 * JS is still readable enough to debug against the published source.
 *
 * No third-party archiver is required: this uses the system `zip` on macOS/Linux
 * and PowerShell's Compress-Archive on Windows. Run `pnpm build` first.
 * Output: releases/browser-copilot-<version>.zip
 */
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, 'dist')
const releasesDir = join(root, 'releases')

if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error('dist/manifest.json not found. Run `pnpm build` first.')
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const zipName = `browser-copilot-${version}.zip`
const zipPath = join(releasesDir, zipName)

mkdirSync(releasesDir, { recursive: true })
rmSync(zipPath, { force: true })

// Stage a clean copy of dist without source maps, so the zip never depends on
// archiver-specific exclude flags.
const stage = join(tmpdir(), `browser-copilot-pkg-${process.pid}`)
rmSync(stage, { recursive: true, force: true })
cpSync(distDir, stage, { recursive: true })
const pruneMaps = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) pruneMaps(full)
    else if (full.endsWith('.map')) rmSync(full)
  }
}
pruneMaps(stage)

if (process.platform === 'win32') {
  // Compress-Archive wants paths with backslashes and a wildcard so the zip
  // holds the files, not a wrapping folder.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  )
} else {
  execFileSync('zip', ['-X', '-q', '-r', zipPath, '.'], { cwd: stage, stdio: 'inherit' })
}

rmSync(stage, { recursive: true, force: true })
console.log(`Wrote ${zipPath}`)
