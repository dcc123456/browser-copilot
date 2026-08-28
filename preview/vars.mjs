import { readFileSync } from 'node:fs'

const ds = readFileSync('src/ui/design-system.css', 'utf8')
const th = readFileSync('src/workflow-editor/theme.css', 'utf8')
const ed = readFileSync('src/workflow-editor/editor.css', 'utf8')
const edge = readFileSync('src/workflow-editor/flow/CustomEdge.tsx', 'utf8')
const app = readFileSync('src/workflow-editor/App.tsx', 'utf8')
const icons = readFileSync('src/lib/workflow/blocks/icons.tsx', 'utf8')

// Every var(--we-*) / --bc-* / --cat-* referenced anywhere in the editor
// styles must resolve to a declaration.
function declaredVars(css) {
  const set = new Set()
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) set.add(m[1])
  return set
}
const declared = new Set([...declaredVars(ds), ...declaredVars(th)])

function referenced(css) {
  const set = new Set()
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) set.add(m[1])
  return set
}

const refs = new Set([...referenced(th), ...referenced(ed)])
// tsx inline style refs
for (const f of [edge, app, icons]) {
  for (const m of f.matchAll(/var\((--[a-z0-9-]+)/g)) refs.add(m[1])
}

let bad = 0
for (const r of [...refs].sort()) {
  if (!declared.has(r)) {
    console.log('UNRESOLVED', r)
    bad++
  }
}
console.log(bad === 0 ? `OK — all ${refs.size} referenced variables resolve` : `${bad} unresolved`)

// Edge chain specifically
for (const v of ['--we-edge', '--we-edge-selected', '--bc-icon-invert', '--cat-conditions']) {
  console.log(v, '=>', th.match(new RegExp(v + '\\s*:\\s*([^;]+);'))?.[1]?.trim() ?? ds.match(new RegExp(v + '\\s*:\\s*([^;]+);'))?.[1]?.trim() ?? 'MISSING')
}
