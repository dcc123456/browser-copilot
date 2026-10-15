#!/usr/bin/env node
/**
 * Packages a built extension variant into a loadable archive.
 *
 * Usage: node scripts/build-zip.mjs <ocr|no-ocr|firefox>   (run `pnpm build` /
 * `pnpm build:no-ocr` / `pnpm build:firefox` first — see the `package` script,
 * which builds and packages ALL release variants in one go.)
 *
 *   ocr     full build from dist/             → releases/browser-copilot-<version>-ocr.zip
 *   no-ocr  lite build from dist-no-ocr/      → releases/browser-copilot-<version>-no-ocr.zip
 *   firefox Firefox 128+ from dist-firefox/   → releases/browser-copilot-<version>-firefox.xpi
 *
 * The Chrome variants stay `.zip` (they are loaded from an unpacked folder),
 * while Firefox ships as `.xpi` — the same archive bytes under the extension
 * name Firefox's install flows expect (install-from-file on Developer
 * Edition / Nightly / ESR, and any future AMO submission).
 *
 * The archive has the built files at its root (manifest.json, icons/,
 * assets/…), not under a dist/ folder, because every install flow expects
 * manifest.json at the archive root. Source maps are pruned here as a
 * belt-and-braces measure; the build itself is already minified and map-free
 * (see vite.config.ts) to keep the download small.
 *
 * Loud failures guard the wiring:
 * - no-ocr and firefox must not ship the vendored tesseract/ assets (both
 *   builds strip them — strip-ocr-assets in vite.config.ts, rmSync in
 *   build-firefox.ts), so finding them here means a build flag broke.
 * - the firefox manifest must carry browser_specific_settings.gecko.id;
 *   without it the package would be a Chrome manifest mislabelled as the
 *   Firefox one.
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

// Dist folder and prerequisite build command per variant.
const VARIANTS = {
  ocr: { dist: 'dist', build: 'pnpm build' },
  'no-ocr': { dist: 'dist-no-ocr', build: 'pnpm build:no-ocr' },
  firefox: { dist: 'dist-firefox', build: 'pnpm build:firefox' },
}

const variant = process.argv[2]
const spec = VARIANTS[variant]
if (!spec) {
  console.error('Usage: node scripts/build-zip.mjs <ocr|no-ocr|firefox>')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(root, spec.dist)
const releasesDir = join(root, 'releases')

if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error(
    `${spec.dist}/manifest.json not found. ` +
      `Run \`${spec.build}\` first (or \`pnpm package\` for all variants).`,
  )
  process.exit(1)
}

if (variant === 'firefox') {
  // A Chrome-shaped manifest here means the two assemblers got crossed; the
  // zip would fail in Firefox, so fail packaging instead of shipping it.
  const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'))
  if (!manifest.browser_specific_settings?.gecko?.id) {
    console.error(
      'dist-firefox/manifest.json has no browser_specific_settings.gecko.id — ' +
        'check scripts/manifest-firefox.ts.',
    )
    process.exit(1)
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const extension = variant === 'firefox' ? 'xpi' : 'zip'
const archivePath = join(releasesDir, `browser-copilot-${version}-${variant}.${extension}`)

mkdirSync(releasesDir, { recursive: true })
rmSync(archivePath, { force: true })

// Stage a clean copy of dist without source maps, so the zip never depends on
// archiver-specific exclude flags.
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
if ((variant === 'no-ocr' || variant === 'firefox') && existsSync(join(stage, 'tesseract'))) {
  console.error(
    `${spec.dist}/tesseract exists but the ${variant} build should not ship it — ` +
      (variant === 'no-ocr'
        ? 'check the strip-ocr-assets plugin in vite.config.ts.'
        : 'check the tesseract rmSync in scripts/build-firefox.ts.'),
  )
  process.exit(1)
}

if (process.platform === 'win32') {
  // Compress-Archive wants paths with backslashes and a wildcard so the zip
  // holds the files, not a wrapping folder.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${archivePath}' -Force`,
    ],
    { stdio: 'inherit' },
  )
} else {
  execFileSync('zip', ['-X', '-q', '-r', archivePath, '.'], { cwd: stage, stdio: 'inherit' })
}

rmSync(stage, { recursive: true, force: true })
console.log(`Wrote ${archivePath}`)
