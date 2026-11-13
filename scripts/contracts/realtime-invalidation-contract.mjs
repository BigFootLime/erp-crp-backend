import { readFile, readdir, writeFile } from "node:fs/promises"
import { resolve, relative, sep } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const root = resolve(import.meta.dirname, "../..")
function parseArguments(args) {
  const parsed = { source: resolve(root, "src"), output: resolve(root, "contracts/realtime-invalidation.v1.json"), check: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--check") { parsed.check = true; continue }
    if (arg === "--source" || arg === "--output") {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
      parsed[arg.slice(2)] = resolve(value)
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  return parsed
}
const { source: sourceRoot, output: outputPath, check } = parseArguments(process.argv.slice(2))
const isTestFile = path => /(?:^|[\\/])[^/\\]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
const isExcludedDirectory = name => ["__tests__", "__fixtures__", "fixtures"].includes(name.toLowerCase())
const isSourceFile = path => /\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(".d.ts") && !isTestFile(path)
async function filesBelow(dir) { const entries = await readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(async entry => { const path = resolve(dir, entry.name); return entry.isDirectory() ? (isExcludedDirectory(entry.name) ? [] : filesBelow(path)) : (isSourceFile(path) ? [path] : []) }))).flat() }
function location(source, node) { const point = source.getLineAndCharacterOfPosition(node.getStart(source)); return { source: relative(root, source.fileName).split(sep).join("/"), line: point.line + 1 } }
function propertyName(node) { return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null }
function staticString(node, constants, stack = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) { let value = node.head.text; for (const span of node.templateSpans) value += "{id}" + span.literal.text; return value }
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression, constants, stack)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, constants, stack), right = staticString(node.right, constants, stack)
    if (left === null && right === null) return null
    return (left ?? "{id}") + (right ?? "{id}")
  }
  if (ts.isIdentifier(node) && constants.has(node.text) && !stack.has(node.text)) return staticString(constants.get(node.text), constants, new Set(stack).add(node.text))
  return null
}
function staticArray(node, constants, unresolved, source, resolving = new Set()) {
  if (ts.isIdentifier(node) && constants.has(node.text)) {
    if (resolving.has(node.text)) { unresolved.push({ ...location(source, node), reason: "invalidateKeys const array is cyclic" }); return [] }
    return staticArray(constants.get(node.text), constants, unresolved, source, new Set(resolving).add(node.text))
  }
  if (!ts.isArrayLiteralExpression(node)) { unresolved.push({ ...location(source, node), reason: "invalidateKeys is not a statically resolvable array" }); return [] }
  const values = []
  for (const element of node.elements) {
    if (ts.isSpreadElement(element)) { values.push(...staticArray(element.expression, constants, unresolved, source, resolving)); continue }
    const value = staticString(element, constants)
    if (value === null) unresolved.push({ ...location(source, element), reason: "invalidateKeys element is dynamic" }); else values.push(value)
  }
  return values
}
function bindingNames(name, result) {
  if (ts.isIdentifier(name)) result.add(name.text)
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, result)
}
function constantsIn(source) {
  const values = new Map(), ambiguous = new Set()
  const markAmbiguous = name => { values.delete(name); ambiguous.add(name) }
  const visit = node => {
    if (ts.isVariableDeclaration(node)) {
      const names = new Set(); bindingNames(node.name, names)
      const isConst = Boolean(node.initializer) && ts.isIdentifier(node.name) && Boolean(node.parent.flags & ts.NodeFlags.Const)
      for (const name of names) {
        if (!isConst || values.has(name) || ambiguous.has(name)) markAmbiguous(name)
        else values.set(name, node.initializer)
      }
    }
    if (ts.isParameter(node)) { const names = new Set(); bindingNames(node.name, names); for (const name of names) markAmbiguous(name) }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}
async function catalog() {
  const patterns = new Set(), unresolved = []
  for (const file of (await filesBelow(sourceRoot)).sort()) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true), constants = constantsIn(source)
    const visit = node => {
      const value = ts.isPropertyAssignment(node) && propertyName(node.name) === "invalidateKeys" ? node.initializer
        : ts.isShorthandPropertyAssignment(node) && node.name.text === "invalidateKeys" ? node.name : null
      if (value) for (const key of staticArray(value, constants, unresolved, source)) patterns.add(key)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { schema_version: "1.0.0", authority: "erp-crp-backend", contract: "realtime-invalidation-producer-catalog", generated_from: { source_root: relative(root, sourceRoot).split(sep).join("/") || ".", include: ["**/*.{ts,tsx,js,jsx,mts,mtsx,mjs,cjs}"], exclude: ["**/*.{test,spec}.{ts,tsx,js,jsx,mts,mtsx,mjs,cjs}", "**/*.d.ts", "**/{__tests__,__fixtures__,fixtures}/**"], extraction: "TypeScript AST PropertyAssignment invalidateKeys; static strings, templates normalized to {id}, uniquely named const arrays and const spreads only. Binding ambiguity, mutation, scope, and interprocedural values are unresolved.", exhaustive: unresolved.length === 0 }, key_patterns: [...patterns].sort(), unresolved_dynamic_sites: unresolved.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.reason.localeCompare(b.reason)) }
}
const rendered = `${JSON.stringify(await catalog(), null, 2)}\n`
if (check) { let existing = ""; try { existing = await readFile(outputPath, "utf8") } catch {} if (existing.replace(/\r\n/g, "\n") !== rendered) { console.error(`Realtime invalidation contract is stale: ${relative(root, outputPath)}`); process.exitCode = 1 } } else { await writeFile(outputPath, rendered, "utf8"); console.log(`Generated ${relative(root, outputPath)}`) }
