import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = path.resolve(process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : ".");
const base = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "225deca00dffc00b8087d036adfe441a9321c9ea";
const negative = process.argv.includes("--negative-controls");
const facadeRelative = "src/module/stock/repository/stock.repository.ts";
const ownerRelative = "src/module/stock/repository/stock-article-lifecycle.repository.ts";
const facadePath = path.join(root, facadeRelative);
const ownerPath = path.join(root, ownerRelative);

function fail(message) { throw new Error(`stock article lifecycle extraction refused: ${message}`); }
function source(file, kind = ts.ScriptKind.TS) { return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind); }
function isExported(statement) { return !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword); }
function names(statement) {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) return [statement.name.text];
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  return [];
}
function publicExports(file) {
  const result = [];
  for (const statement of file.statements) {
    if ((ts.isExportDeclaration(statement) || ts.isImportDeclaration(statement)) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) result.push(`${element.name.text}:${element.propertyName?.text ?? element.name.text}`);
    } else if (isExported(statement)) {
      for (const name of names(statement)) result.push(`${name}:${name}`);
    }
  }
  return result.sort();
}
function baseFile(relative) {
  return ts.createSourceFile(relative, execFileSync("git", ["show", `${base}:${relative}`], { cwd: root, encoding: "utf8" }), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declarationMap(file) {
  const result = new Map();
  for (const statement of file.statements) for (const name of names(statement)) result.set(name, statement.getText(file));
  return result;
}
function moduleEdges(filePath, sourceRoot, compiled = false) {
  const found = [];
  const file = source(filePath, compiled ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const add = (literal, kind) => {
    if (!literal || !ts.isStringLiteralLike(literal)) fail(`unresolved ${kind} in ${path.relative(root, filePath)}`);
    if (!literal.text.startsWith(".")) return;
    const candidate = path.resolve(path.dirname(filePath), literal.text);
    const suffixes = compiled ? [".js", "/index.js"] : [".ts", "/index.ts"];
    const target = suffixes.map((suffix) => candidate.endsWith(suffix) ? candidate : candidate + suffix).find(fs.existsSync);
    if (!target) fail(`unresolved ${kind} target ${literal.text} in ${path.relative(root, filePath)}`);
    found.push(path.normalize(target));
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, "import");
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, "export");
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") add(node.arguments[0], "require");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], "dynamic import");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.filter((edge) => edge.startsWith(sourceRoot));
}
function reachesFacade(start, sourceRoot, facade) {
  const seen = new Set();
  const visit = (file) => {
    if (file === facade) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return moduleEdges(file, sourceRoot, file.endsWith(".js")).some(visit);
  };
  return visit(start);
}

try {
  const baseFacade = baseFile(facadeRelative);
  const facade = source(facadePath);
  const owner = source(ownerPath);
  const beforeApi = publicExports(baseFacade);
  const afterApi = publicExports(facade);
  if (beforeApi.length !== 106) fail(`base public facade inventory changed: expected 106, got ${beforeApi.length}`);
  if (JSON.stringify(beforeApi) !== JSON.stringify(afterApi)) fail("facade public export names or aliases differ from base");

  const baseDeclarations = declarationMap(baseFacade);
  const ownerDeclarations = declarationMap(owner);
  const moved = [...ownerDeclarations.keys()].filter((name) => baseDeclarations.has(name));
  if (moved.length < 20) fail(`too few base declarations moved (${moved.length})`);
  for (const name of moved) if (baseDeclarations.get(name) !== ownerDeclarations.get(name)) fail(`moved declaration differs from base: ${name}`);

  const sourceRoot = path.join(root, "src");
  if (reachesFacade(ownerPath, sourceRoot, path.normalize(facadePath))) fail("owner has a source dependency back to its facade");

  const compiledOwner = path.join(root, "dist/module/stock/repository/stock-article-lifecycle.repository.js");
  const compiledFacade = path.join(root, "dist/module/stock/repository/stock.repository.js");
  if (!fs.existsSync(compiledOwner) || !fs.existsSync(compiledFacade)) fail("compiled owner or facade is missing; build before certification");
  const distRoot = path.join(root, "dist");
  if (reachesFacade(compiledOwner, distRoot, path.normalize(compiledFacade))) fail("owner has a compiled dependency back to its facade");

  if (negative) {
    const injected = path.join(root, "src/module/stock/repository/.lifecycle-negative.ts");
    fs.writeFileSync(injected, 'import "./stock.repository"; export const negative = true;\n');
    try {
      if (!reachesFacade(injected, sourceRoot, path.normalize(facadePath))) fail("negative source backedge was not detected");
    } finally { fs.unlinkSync(injected); }
  }
  console.log(JSON.stringify({ result: "PASS", base, publicFacadeExports: beforeApi.length, exactMovedDeclarations: moved.length, sourceFacadeBackedges: 0, compiledFacadeBackedges: 0, negativeControls: negative ? "PASS" : "NOT_RUN" }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
