#!/usr/bin/env node
/**
 * Packages a built extension variant into a loadable zip.
 *
 * Usage: node scripts/build-zip.mjs <ocr|no-ocr>   (run `pnpm build` /
 * `pnpm build:no-ocr` first — see the `package` script, which builds and zips
 * BOTH release variants in one go.)
 *
 *   ocr     full build from dist/          → releases/browser-copilot-<version>-ocr.zip
 *   no-ocr  lite build from dist-no-ocr/   → releases/browser-copilot-<version>-no-ocr.zip
 *
 * The zip has the built files at its root (manifest.json, icons/, assets/…),
 * not under a dist/ folder, because Chrome's "Load unpacked" and the resulting
 * release both expect manifest.json at the archive root. Source maps are
 * pruned here as a belt-and-braces measure; the build itself is already
 * minified and map-free (see vite.config.ts) to keep the download small. The
 * no-ocr variant additionally prunes the vendored tesseract/ assets — the
 * no-ocr build strips them too (strip-ocr-assets plugin), so finding them
 * here would mean the build flag wiring broke; that failure must be loud.
 *
 * No third-party archiver is required: this uses the system `zip` on macOS/Linux
 * and PowerShell's Compress-Archive on Windows.
 */
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const variant = process.argv[2]
if (variant !== 'ocr' && variant !== 'no-ocr') {
  console.error('Usage: node scripts/build-zip.mjs <ocr|no-ocr>')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, variant === 'ocr' ? 'dist' : 'dist-no-ocr')
const releasesDir = join(root, 'releases')

if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error(
    `${variant === 'ocr' ? 'dist' : 'dist-no-ocr'}/manifest.json not found. ` +
      (variant === 'ocr'
        ? 'Run `pnpm build` first.'
        : 'Run `pnpm build:no-ocr` first (or `pnpm package` for both variants).'),
  )
  process.exit(1)
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const zipName = `browser-copilot-${version}-${variant}.zip`
const zipPath = join(releasesDir, zipName)

mkdirSync(releasesDir, { recursive: true })
rmSync(zipPath, { force: true })

// Stage a clean copy of dist without source maps (and without the Tesseract
// assets for the lite variant), so the zip never depends on archiver-specific
// exclude flags.
const stage = join(tmpdir(), `browser-copilot-pkg-${variant}-${process.pid}`)
rmSync(stage, { recursive: true, force: true })
cpSync(distDir, stage, { recursive: true })
const prune = (dir, test) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (test(full)) rmSync(full, { recursive: true, force: true })
      else prune(full, test)
    } else if (test(full)) {
      rmSync(full)
    }
  }
}
prune(stage, (full) => full.endsWith('.map'))
if (variant === 'no-ocr') {
  if (existsSync(join(stage, 'tesseract'))) {
    console.error(
      'dist-no-ocr/tesseract exists but the no-ocr build should have stripped it — ' +
        'check the strip-ocr-assets plugin in vite.config.ts.',
    )
    process.exit(1)
  }
}

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
