import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const distMode = process.argv.includes("--dist");
const sourceRoot = path.resolve(distMode ? "dist" : "src");
const runtimeExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const testPathPattern = /(?:^|[\\/])__tests__(?:[\\/]|$)|\.(?:test|spec)\.[^.]+$/i;
const forbiddenImportPattern = /(?:^|[\\/.])(?:__fixtures__|fixtures|__mocks__|mocks|demo|demos)(?:[\\/.]|$)|(?:\.mock|\.fixture)(?:[\\/.]|$)/i;
const importSpecifierPattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;

function listRuntimeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listRuntimeFiles(absolute));
    else if (runtimeExtensions.has(path.extname(entry.name)) && !testPathPattern.test(absolute)) files.push(absolute);
  }
  return files;
}

function lineOf(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

const files = listRuntimeFiles(sourceRoot);
const violations = [];
for (const file of files) {
  if (distMode && forbiddenImportPattern.test(path.relative(sourceRoot, file))) {
    violations.push({ file, line: 1, specifier: "artefact de test émis dans dist" });
  }
  const content = fs.readFileSync(file, "utf8");
  for (const match of content.matchAll(importSpecifierPattern)) {
    const specifier = match[1];
    if (forbiddenImportPattern.test(specifier)) {
      violations.push({ file, line: lineOf(content, match.index ?? 0), specifier });
    }
  }
}

if (violations.length > 0) {
  console.error("Frontière données de production refusée :");
  for (const violation of violations) {
    console.error(`- ${path.relative(process.cwd(), violation.file)}:${violation.line} — import runtime interdit : ${violation.specifier}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Frontière données de production validée (${files.length} fichiers ${distMode ? "émis" : "runtime"}).`);
}
