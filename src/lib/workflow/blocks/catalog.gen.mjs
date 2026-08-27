/**
 * Catalog generator (run manually): extracts Automa's `tasks` block directory
 * and `categories` metadata from the Automa checkout and emits `catalog.ts`.
 *
 * Usage (from the browser-copilot repo root):
 *   node src/lib/workflow/blocks/catalog.gen.mjs
 *
 * The script is deliberately dependency-free: it slices the two plain-data
 * exports out of Automa's `src/utils/shared.js`, turns the module into a
 * temporary ESM file, and dynamically imports it. The extracted values are
 * plain JSON-serializable data (strings, numbers, booleans, arrays, objects).
 *
 * @module catalog.gen
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Keep in sync with cloud-blocks.ts (plain copy — this script has no TS loader). */
const CLOUD_BLOCK_IDS = [
  'ai-workflow',
  'block-package',
  'google-sheets',
  'google-sheets-drive',
  'google-drive',
]
const isCloudBlock = (id) => CLOUD_BLOCK_IDS.includes(id)

// Automa checkout lives alongside browser-copilot in the workspace.
const AUTOMA_SHARED =
  process.env.AUTOMA_SHARED ??
  'D:/works/deep-seek-workspace/automa/src/utils/shared.js'

/**
 * Extract a top-level `export const <name> = { ... };` object literal from
 * source text. Brace-matches from the first `{` after the declaration so
 * nested objects/functions inside the value don't confuse the slice.
 */
function extractExportedObject(source, name) {
  const decl = `export const ${name} =`
  const start = source.indexOf(decl)
  if (start === -1) throw new Error(`could not find "${decl}" in shared.js`)
  const openBrace = source.indexOf('{', start)
  if (openBrace === -1) throw new Error(`could not find opening brace for ${name}`)
  let depth = 0
  let inStr = null
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i]
    const prev = source[i - 1]
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return source.slice(openBrace, i + 1)
      }
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`)
}

async function importObject(objectLiteral, exportName) {
  const dir = mkdtempSync(join(tmpdir(), 'automa-catalog-'))
  const file = join(dir, `${exportName}.mjs`)
  writeFileSync(file, `const ${exportName} = ${objectLiteral};\nexport { ${exportName} };\n`)
  const mod = await import(pathToFileURL(file).href)
  return mod[exportName]
}

/** Tailwind color class fragment -> hex (the palette Automa uses). */
const TAILWIND_HEX = {
  // 200
  'green-200': '#bbf7d0',
  'orange-200': '#fed7aa',
  'yellow-200': '#fef08a',
  'red-200': '#fecaca',
  'lime-200': '#d9f99d',
  'blue-200': '#bfdbfe',
  'cyan-200': '#a5f3fc',
  // 300
  'green-300': '#86efac',
  'orange-300': '#fdba74',
  'yellow-300': '#fde047',
  'red-300': '#fca5a5',
  'lime-300': '#bef264',
  'blue-300': '#93c5fd',
  'cyan-300': '#67e8f9',
}

function tailwindToHex(classText) {
  for (const [cls, hex] of Object.entries(TAILWIND_HEX)) {
    if (classText.includes(cls)) return hex
  }
  return '#e5e7eb' // gray-200 fallback
}

function buildCategoryMeta(categories) {
  const meta = {}
  for (const [id, cat] of Object.entries(categories)) {
    meta[id] = {
      name: cat.name,
      light: {
        bg: tailwindToHex(cat.color ?? ''),
        border: tailwindToHex(cat.border ?? ''),
      },
      dark: {
        // Automa dark mode uses the *-300 shade for bg.
        bg: tailwindToHex((cat.color ?? '').replace(/200/g, '300')),
        border: tailwindToHex((cat.border ?? '').replace(/200/g, '300')),
      },
    }
  }
  return meta
}

const KEEP_FIELDS = [
  'name',
  'description',
  'icon',
  'component',
  'editComponent',
  'category',
  'inputs',
  'outputs',
  'allowedInputs',
  'maxConnection',
  'disableEdit',
  'tag',
  'refDataKeys',
  'data',
]

/**
 * Automa registers a handful of Material Design icons as inline SVG paths in
 * its v-remixicon plugin (src/lib/vRemixicon.js). RemixIcon has no equivalent,
 * so rewrite those icon names to the same `path:<d>` form the BlockIcon
 * component already understands — keeping the rendered glyph identical.
 */
const MDI_PATH_ICONS = {
  mdiRegex:
    'M16,16.92C15.67,16.97 15.34,17 15,17C14.66,17 14.33,16.97 14,16.92V13.41L11.5,15.89C11,15.5 10.5,15 10.11,14.5L12.59,12H9.08C9.03,11.67 9,11.34 9,11C9,10.66 9.03,10.33 9.08,10H12.59L10.11,7.5C10.3,7.25 10.5,7 10.76,6.76V6.76C11,6.5 11.25,6.3 11.5,6.11L14,8.59V5.08C14.33,5.03 14.66,5 15,5C15.34,5 15.67,5.03 16,5.08V8.59L18.5,6.11C19,6.5 19.5,7 19.89,7.5L17.41,10H20.92C20.97,10.33 21,10.66 21,11C21,11.34 20.97,11.67 20.92,12H17.41L19.89,14.5C19.7,14.75 19.5,15 19.24,15.24V15.24C19,15.5 18.75,15.7 18.5,15.89L16,13.41V16.92H16V16.92M5,19A2,2 0 0,1 7,17A2,2 0 0,1 9,19A2,2 0 0,1 7,21A2,2 0 0,1 5,19H5Z',
  mdiCookieOutline:
    'M20.87 10.5C20.6 10 20 10 20 10H18V9C18 8 17 8 17 8H15V7C15 6 14 6 14 6H13V4C13 3 12 3 12 3C7.03 3 3 7.03 3 12C3 16.97 7.03 21 12 21C16.97 21 21 16.97 21 12C21 11.5 20.96 11 20.87 10.5M11.32 18.96C12 18.82 12.5 18.22 12.5 17.5C12.5 16.67 11.83 16 11 16S9.5 16.67 9.5 17.5C9.5 18 9.76 18.47 10.16 18.74C7.54 18.04 5.5 15.81 5.09 13.12C5 12.61 5 12.11 5 11.62C5.07 12.39 5.71 13 6.5 13C7.33 13 8 12.33 8 11.5S7.33 10 6.5 10C5.82 10 5.25 10.46 5.07 11.08C5.47 8 7.91 5.5 11 5.07V6.5C11 7.33 11.67 8 12.5 8H13V8.5C13 9.33 13.67 10 14.5 10H16V10.5C16 11.33 16.67 12 17.5 12H19C19 16.08 15.5 19.36 11.32 18.96M9.5 9C8.67 9 8 8.33 8 7.5S8.67 6 9.5 6 11 6.67 11 7.5 10.33 9 9.5 9M13 12.5C13 13.33 12.33 14 11.5 14S10 13.33 10 12.5 10.67 11 11.5 11 13 11.67 13 12.5M18 14.5C18 15.33 17.33 16 16.5 16S15 15.33 15 14.5 15.67 13 16.5 13 18 13.67 18 14.5Z',
  mdiGoogleSheet:
    'M19,11V9H11V5H9V9H5V11H9V19H11V11H19M19,3C19.5,3 20,3.2 20.39,3.61C20.8,4 21,4.5 21,5V19C21,19.5 20.8,20 20.39,20.39C20,20.8 19.5,21 19,21H5C4.5,21 4,20.8 3.61,20.39C3.2,20 3,19.5 3,19V5C3,4.5 3.2,4 3.61,3.61C4,3.2 4.5,3 5,3H19Z',
  mdiCursorDefaultClickOutline:
    'M11.5,11L17.88,16.37L17,16.55L16.36,16.67C15.73,16.8 15.37,17.5 15.65,18.07L15.92,18.65L17.28,21.59L15.86,22.25L14.5,19.32L14.24,18.74C13.97,18.15 13.22,17.97 12.72,18.38L12.21,18.78L11.5,19.35V11M10.76,8.69A0.76,0.76 0 0,0 10,9.45V20.9C10,21.32 10.34,21.66 10.76,21.66C10.95,21.66 11.11,21.6 11.24,21.5L13.15,19.95L14.81,23.57C14.94,23.84 15.21,24 15.5,24C15.61,24 15.72,24 15.83,23.92L18.59,22.64C18.97,22.46 19.15,22 18.95,21.63L17.28,18L19.69,17.55C19.85,17.5 20,17.43 20.12,17.29C20.39,16.97 20.35,16.5 20,16.21L11.26,8.86L11.25,8.87C11.12,8.76 10.95,8.69 10.76,8.69M15,10V8H20V10H15M13.83,4.76L16.66,1.93L18.07,3.34L15.24,6.17L13.83,4.76M10,0H12V5H10V0M3.93,14.66L6.76,11.83L8.17,13.24L5.34,16.07L3.93,14.66M3.93,3.34L5.34,1.93L8.17,4.76L6.76,6.17L3.93,3.34M7,10H2V8H7V10',
}

function buildCatalog(tasks) {
  const entries = []
  for (const [id, block] of Object.entries(tasks)) {
    const entry = { id }
    for (const field of KEEP_FIELDS) {
      if (block[field] !== undefined) entry[field] = block[field]
    }
    // Normalize fields Automa leaves undefined so the TS type stays strict.
    entry.description = entry.description ?? ''
    entry.inputs = entry.inputs ?? 1
    entry.outputs = entry.outputs ?? 1
    if (entry.icon && MDI_PATH_ICONS[entry.icon]) {
      entry.icon = `path:${MDI_PATH_ICONS[entry.icon]}`
    }
    entry.cloud = isCloudBlock(id)
    entries.push(entry)
  }
  return entries
}

async function main() {
  const source = readFileSync(AUTOMA_SHARED, 'utf8')
  const tasksLiteral = extractExportedObject(source, 'tasks')
  const categoriesLiteral = extractExportedObject(source, 'categories')
  const tasks = await importObject(tasksLiteral, 'tasks')
  const categories = await importObject(categoriesLiteral, 'categories')

  const catalog = buildCatalog(tasks)
  const categoryMeta = buildCategoryMeta(categories)

  const local = catalog.filter((b) => !b.cloud)
  const cloud = catalog.filter((b) => b.cloud)
  const byCategory = {}
  for (const b of local) byCategory[b.category] = (byCategory[b.category] ?? 0) + 1

  const missingForm = local
    .filter((b) => !b.disableEdit && !b.editComponent)
    .map((b) => b.id)
  const badIcon = local.filter(
    (b) => !b.icon || (!b.icon.startsWith('ri') && !b.icon.startsWith('path:') && !b.icon.startsWith('http')),
  )

  const out = `/**
 * AUTO-GENERATED by src/lib/workflow/blocks/catalog.gen.mjs - do not edit by hand.
 * Source: automa/src/utils/shared.js (tasks + categories).
 * Re-run \`node src/lib/workflow/blocks/catalog.gen.mjs\` after updating Automa.
 *
 * @module lib/workflow/blocks/catalog
 */

import type { BlockCatalogEntry, AutomaCategory, CategoryMeta } from './types'

export const CATEGORY_META: Record<AutomaCategory, CategoryMeta> = ${JSON.stringify(
    categoryMeta,
    null,
    2,
  )}

export const BLOCK_CATALOG: BlockCatalogEntry[] = ${JSON.stringify(catalog, null, 2)}
`

  writeFileSync(join(HERE, 'catalog.ts'), out)

  console.log(`catalog.ts written: ${catalog.length} blocks total`)
  console.log(`  local (palette): ${local.length}`)
  console.log(`  cloud (hidden):   ${cloud.length} -> ${cloud.map((b) => b.id).join(', ')}`)
  console.log('  local by category:', JSON.stringify(byCategory))
  if (missingForm.length) console.log('  WARN editable blocks without editComponent:', missingForm.join(', '))
  if (badIcon.length) console.log('  WARN blocks with unusual icon:', badIcon.map((b) => `${b.id}(${b.icon})`).join(', '))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
