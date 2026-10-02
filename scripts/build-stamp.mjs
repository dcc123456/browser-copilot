#!/usr/bin/env node
/**
 * The build fingerprint of the SOURCE, and the record of which build the browser
 * is actually running.
 *
 * `selftest.mjs` only needs a reload when the loaded code is older than the
 * source it just rebuilt, and nothing over the bridge used to tell it what the
 * service worker loaded. So vite stamps the compiled bundles with a hash of the
 * sources (`__BUILD_STAMP__`), the extension reports that stamp on `tools.list`,
 * and the harness compares the two — which answers the one question worth
 * asking: is the code in the browser the code on my disk.
 *
 * The stamp hashes the SOURCE, not `dist/`: hashing build output would be
 * circular (the stamp lives inside the output), and a rebuild of unchanged
 * sources must not owe the browser a reload.
 *
 * Recording each pickup in `tmp/selftest-loaded-build.stamp` lets a later run
 * answer "nothing to pick up" without asking the browser at all.
 *
 *   node scripts/build-stamp.mjs            # print the source stamp
 *   node scripts/build-stamp.mjs --write    # record it as the loaded build
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Inputs whose content is what the extension actually runs. */
const SOURCE_DIRS = ['src']
const SOURCE_FILES = ['manifest.config.ts', 'vite.config.ts']

function walkSync(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const key = `${prefix}${entry.name}`
    if (entry.isDirectory()) walkSync(path.join(dir, entry.name), `${key}/`, out)
    else out.push(key)
  }
}

/**
 * Hash of the sources the next build compiles. Synchronous because vite reads
 * `define` inside a synchronous config function.
 */
export function sourceFingerprintSync(cwd = process.cwd()) {
  try {
    const hash = createHash('sha256')
    const keys = []
    for (const dir of SOURCE_DIRS) walkSync(path.join(cwd, dir), `${dir}/`, keys)
    keys.push(...SOURCE_FILES)
    keys.sort()
    for (const key of keys) {
      const text = readFileSync(path.join(cwd, key), 'utf8')
      hash.update(key).update('\0').update(text).update('\0')
    }
    return hash.digest('hex').slice(0, 16)
  } catch {
    // Nothing to hash: no caller may then claim a build is loaded.
    return ''
  }
}

/**
 * Hash of the built `dist/` — what the browser WOULD load if it reloaded now.
 * Only the filenames enter the hash: vite content-names every asset, so the set
 * of names changes exactly when the code changes.
 */
export async function buildFingerprint(cwd = process.cwd()) {
  const dist = path.join(cwd, 'dist')
  try {
    const manifest = await readFile(path.join(dist, 'manifest.json'), 'utf8')
    const files = []
    const walk = async (dir, prefix) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}`)
        else files.push(`${prefix}${entry.name}`)
      }
    }
    await walk(dist, '')
    files.sort()
    return createHash('sha256').update(manifest).update(files.join('\n')).digest('hex').slice(0, 16)
  } catch {
    // No dist/ at all: nothing to compare, so no caller may claim a build is
    // loaded.
    return ''
  }
}

export function stampFile(cwd = process.cwd()) {
  return path.join(cwd, 'tmp', 'selftest-loaded-build.stamp')
}

export async function readLoadedStamp(cwd = process.cwd()) {
  return readFile(stampFile(cwd), 'utf8')
    .then((text) => text.trim())
    .catch(() => '')
}

export async function writeLoadedStamp(fingerprint, cwd = process.cwd()) {
  if (!fingerprint) return false
  await mkdir(path.dirname(stampFile(cwd)), { recursive: true })
  await writeFile(stampFile(cwd), `${fingerprint}\n`, 'utf8')
  return true
}

/**
 * The source stamp the LAST SUCCESSFUL build baked into `dist/`.
 *
 * A reload picks up `dist/`, not the sources on disk, so a round that skipped the
 * build cannot pick up code newer than that record — reloading would only put the
 * SAME old build back, and the reload wait would spend its whole budget thrashing
 * the browser. This file is how the harness knows.
 */
export function builtStampFile(cwd = process.cwd()) {
  return path.join(cwd, 'tmp', 'selftest-built-build.stamp')
}

export async function readBuiltStamp(cwd = process.cwd()) {
  return readFile(builtStampFile(cwd), 'utf8')
    .then((text) => text.trim())
    .catch(() => '')
}

export async function writeBuiltStamp(fingerprint, cwd = process.cwd()) {
  if (!fingerprint) return false
  await mkdir(path.dirname(builtStampFile(cwd)), { recursive: true })
  await writeFile(builtStampFile(cwd), `${fingerprint}\n`, 'utf8')
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const stamp = sourceFingerprintSync()
  if (!stamp) {
    console.error('build-stamp: no sources to hash — is this the repo root?')
    process.exit(1)
  }
  if (process.argv.includes('--write')) {
    await writeLoadedStamp(stamp)
    console.log(`recorded build ${stamp} as loaded`)
  } else {
    const loaded = await readLoadedStamp()
    console.log(`src: ${stamp}`)
    console.log(`recorded as loaded: ${loaded || '(none)'}`)
    console.log(
      loaded === stamp ? 'MATCH — the browser runs this build' : 'DRIFT — a reload is owed',
    )
  }
}
