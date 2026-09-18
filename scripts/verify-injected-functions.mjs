/**
 * Guards the one hard constraint of `chrome.scripting.executeScript({ func })`:
 * only the function's SOURCE is serialised, so any reference to a module-scope
 * binding becomes a `ReferenceError` once the page evaluates it.
 *
 * Nothing else catches this. `tsc` is happy (the module scope really does
 * exist at the call site), the bundler is happy, and a unit test that merely
 * CALLS the injected function is happy too — because in the test the module
 * scope is still in reach. Only running the function inside a real page
 * exposes it. This script catches it statically, at every injection site at
 * once, so a future edit cannot quietly break one.
 *
 * For each `executeScript({ func: X })` it resolves X to its real body —
 * following imports and unwrapping `as unknown as …` casts — then checks every
 * VALUE reference inside that body. Each one must resolve either to a
 * declaration inside the body itself or to a `.d.ts` global (`document`,
 * `chrome`, `Set`, …). Anything that resolves into `src/` is a bug: that
 * binding does not exist in the page.
 *
 * Usage: node scripts/verify-injected-functions.mjs
 * Exits 1 when a violation is found, so it can gate a build.
 */
import ts from 'typescript'
import { relative } from 'node:path'

const ROOT = process.cwd()

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json')
if (!configPath) {
  console.error('verify-injected-functions: tsconfig.json not found')
  process.exit(2)
}
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  process.exit(2)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()

const isTypeNode = (node) =>
  node.kind >= ts.SyntaxKind.FirstTypeNode && node.kind <= ts.SyntaxKind.LastTypeNode

/** Walks a subtree, skipping type positions (they are never evaluated). */
function walk(node, visit) {
  if (isTypeNode(node)) return
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** Strips the casts people write to satisfy `func`'s signature. */
function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** True for identifiers in expression position (so `a.b`'s `b` is excluded). */
function isValueReference(id) {
  const parent = id.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false
  if (ts.isQualifiedName(parent) && parent.right === id) return false
  // Destructuring RENAMES: in `const { selector: initial } = args` the
  // `selector` half is a property key, not a reference to a binding — it
  // resolves to the interface's property declaration, which lives in a .ts
  // file and would otherwise be reported as a module-scope capture.
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false
  if (ts.isNamespaceImport(parent) || ts.isImportClause(parent)) return false
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) return false
  if (ts.isMethodSignature(parent) || ts.isPropertySignature(parent)) return false
  return true
}

function resolveAlias(symbol) {
  if (!symbol) return undefined
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

/**
 * Resolves a `func:` initialiser to the function whose SOURCE gets serialised.
 * An identifier is followed to its declaration, through re-exports.
 */
function resolveFunction(initializer) {
  const node = unwrap(initializer)
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return { body: node, name: '<inline>' }
  }
  if (!ts.isIdentifier(node)) return null
  const target = resolveAlias(checker.getSymbolAtLocation(node))
  if (!target) return null
  for (const decl of target.declarations ?? []) {
    if (ts.isFunctionDeclaration(decl) && decl.body) return { body: decl, name: target.getName() }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer)
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        return { body: init, name: target.getName() }
      }
    }
  }
  return null
}

/** Where a binding lives, relative to the function being serialised. */
function origin(id, body) {
  const target = resolveAlias(checker.getSymbolAtLocation(id))
  const decls = target?.declarations ?? []
  if (decls.length === 0) return 'unresolved'
  if (decls.every((d) => d.getSourceFile().isDeclarationFile)) return 'global'
  // The file check is load-bearing, not a formality: positions are per-file
  // character offsets, so a declaration in ANOTHER file can easily fall inside
  // this function's numeric range. Without it, every cross-file reference —
  // i.e. the whole point of this check — reads as "local" and is skipped.
  const file = body.getSourceFile()
  const start = body.getStart()
  const end = body.getEnd()
  if (
    decls.every((d) => d.getSourceFile() === file && d.getStart() >= start && d.getEnd() <= end)
  ) {
    return 'local'
  }
  return 'module'
}

const where = (node) => {
  const file = node.getSourceFile()
  const { line } = file.getLineAndCharacterOfPosition(node.getStart())
  return `${relative(ROOT, file.fileName).replace(/\\/g, '/')}:${line + 1}`
}

const functions = new Map()
const sites = []
const unresolved = []

for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile) continue
  if (!/[/\\]src[/\\]/.test(file.fileName)) continue
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'executeScript') return
    const [options] = node.arguments
    if (!options || !ts.isObjectLiteralExpression(options)) return
    const prop = options.properties.find(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'func',
    )
    if (!prop) return
    const initializer = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer
    const resolved = resolveFunction(initializer)
    if (!resolved) {
      unresolved.push(where(initializer))
      return
    }
    sites.push(where(node))
    if (!functions.has(resolved.body)) functions.set(resolved.body, resolved)
  })
}

const violations = []
for (const { body, name } of functions.values()) {
  const seen = new Set()
  walk(body, (node) => {
    if (!ts.isIdentifier(node) || !isValueReference(node)) return
    if (origin(node, body) !== 'module') return
    const key = `${name}:${node.text}`
    if (seen.has(key)) return
    seen.add(key)
    const target = resolveAlias(checker.getSymbolAtLocation(node))
    const decl = target?.declarations?.[0]
    violations.push({
      name,
      at: where(node),
      identifier: node.text,
      declaredAt: decl ? where(decl) : '(unknown)',
    })
  })
}

console.log(`injected functions: ${functions.size} distinct, ${sites.length} call site(s) checked`)
if (unresolved.length > 0) {
  // Not a failure: `func` is sometimes chosen at run time (e.g. a parameter
  // that is either an inline arrow or a named function). Such a site cannot be
  // verified statically, and failing here would only train people to ignore
  // the check.
  console.log(`\nnote: the func: value at ${unresolved.length} site(s) is not statically`)
  console.log('resolvable, so it was not checked:')
  for (const at of unresolved) console.log(`    ${at}`)
}

if (violations.length === 0) {
  console.log('\nOK - every injected function is self-contained')
  process.exit(0)
}

console.log(`\nFAIL - ${violations.length} module-scope reference(s) in injected code`)
console.log('These bindings do not exist in the page: executeScript serialises the')
console.log("function's source only, so each one is a ReferenceError at run time.\n")
for (const v of violations) {
  console.log(`  ${v.at}  ${v.name} -> ${v.identifier}`)
  console.log(`      declared at ${v.declaredAt}`)
}
process.exit(1)
