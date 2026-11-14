import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const rootArgument = process.argv.indexOf("--root");
const root = path.resolve(rootArgument >= 0 ? process.argv[rootArgument + 1] : ".");
const manifestPath = path.join(root, "docs", "compat", "material-referentials-backport.lifecycle.json");

function fail(message) {
  console.error(`material referentials lifecycle refused: ${message}`);
  process.exit(1);
}

function sourceExports(content, fileName) {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return new Set(source.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }));
}

function emittedExports(content, fileName) {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Set();
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === "exports") found.add(node.left.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

if (!fs.existsSync(manifestPath)) fail("lifecycle manifest is missing");

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch {
  fail("lifecycle manifest is invalid JSON");
}

if (manifest.status !== "RETAINED") {
  fail(`unsupported lifecycle status: ${String(manifest.status)}; retirement requires a future reviewed implementation with recorded native, runtime, acceptance, and source-pair evidence`);
}

const sourceLocation = manifest.adapter?.source;
const compiledLocation = manifest.adapter?.compiled;
const requiredExports = manifest.adapter?.required_exports;
if (!Array.isArray(requiredExports) || requiredExports.length === 0
  || requiredExports.some((name) => typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/.test(name))) {
  fail("retained adapter requires a non-empty export inventory");
}
if (typeof sourceLocation !== "string" || !fs.existsSync(path.join(root, sourceLocation))) fail(`required retained adapter source is missing: ${sourceLocation}`);
if (typeof compiledLocation !== "string" || !fs.existsSync(path.join(root, compiledLocation))) fail(`required retained adapter build output is missing: ${compiledLocation}`);

const declared = sourceExports(fs.readFileSync(path.join(root, sourceLocation), "utf8"), sourceLocation);
const emitted = emittedExports(fs.readFileSync(path.join(root, compiledLocation), "utf8"), compiledLocation);
for (const exported of requiredExports) {
  if (!declared.has(exported)) fail(`required retained adapter source export is missing: ${exported}`);
  if (!emitted.has(exported)) fail(`required retained adapter compiled export is missing: ${exported}`);
}
