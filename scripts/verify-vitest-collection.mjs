import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcRoot = path.join(repoRoot, "src");
const configPath = path.join(repoRoot, "vitest.config.ts");
const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
const vitestCli = requireFromRepo.resolve("vitest/vitest.mjs");
const testFilePattern = /\.(?:test|spec)\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/i;

function slash(filePath) {
  return filePath.split(path.sep).join("/");
}

function isInside(baseDir, candidatePath) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(entryPath);
    }
  }
  return files;
}

function relativeProjectFile(filePath) {
  const absolutePath = path.resolve(repoRoot, filePath);
  if (!isInside(repoRoot, absolutePath)) {
    throw new Error(`Collected path escapes the checkout: ${filePath}`);
  }

  const realPath = fs.realpathSync(absolutePath);
  if (!isInside(repoRoot, realPath)) {
    throw new Error(`Collected path resolves outside the checkout: ${filePath} -> ${realPath}`);
  }
  if (!isInside(srcRoot, realPath)) {
    throw new Error(`Collected path is outside src: ${filePath}`);
  }

  return slash(path.relative(repoRoot, absolutePath));
}

function verifyRelativeImportsStayInCheckout(sourceFiles) {
  const config = ts.readConfigFile(path.join(repoRoot, "tsconfig.json"), ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  const failures = [];

  for (const sourceFile of sourceFiles) {
    if (!/\.[cm]?[jt]sx?$/i.test(sourceFile)) continue;
    const contents = fs.readFileSync(sourceFile, "utf8");
    const imports = ts.preProcessFile(contents, true, true).importedFiles;

    for (const imported of imports) {
      const specifier = imported.fileName;
      if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) continue;

      const resolved = ts.resolveModuleName(specifier, sourceFile, parsed.options, ts.sys).resolvedModule;
      if (!resolved) {
        failures.push(`${slash(path.relative(repoRoot, sourceFile))}: unresolved ${specifier}`);
        continue;
      }

      const resolvedPath = path.resolve(resolved.resolvedFileName);
      if (!isInside(repoRoot, resolvedPath)) {
        failures.push(
          `${slash(path.relative(repoRoot, sourceFile))}: ${specifier} -> ${resolvedPath}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Relative imports outside the checkout:\n${failures.join("\n")}`);
  }
}

const allSourceFiles = walkFiles(srcRoot);
const expected = allSourceFiles.filter((filePath) => testFilePattern.test(filePath)).map(relativeProjectFile).sort();

const listed = spawnSync(
  process.execPath,
  [vitestCli, "list", "--filesOnly", "--config", configPath, "--no-color"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true,
  },
);

if (listed.error) throw listed.error;
if (listed.status !== 0) {
  throw new Error(
    `Vitest collection failed with exit code ${listed.status}\n${listed.stdout}\n${listed.stderr}`,
  );
}

const collected = listed.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => testFilePattern.test(line))
  .map(relativeProjectFile)
  .sort();

const duplicateFiles = collected.filter((filePath, index) => collected[index - 1] === filePath);
if (duplicateFiles.length > 0) {
  throw new Error(`Vitest collected duplicate files:\n${[...new Set(duplicateFiles)].join("\n")}`);
}

const expectedSet = new Set(expected);
const collectedSet = new Set(collected);
const missing = expected.filter((filePath) => !collectedSet.has(filePath));
const unexpected = collected.filter((filePath) => !expectedSet.has(filePath));

if (missing.length > 0 || unexpected.length > 0) {
  const sections = [];
  if (missing.length > 0) sections.push(`Missing from Vitest:\n${missing.join("\n")}`);
  if (unexpected.length > 0) sections.push(`Unexpected in Vitest:\n${unexpected.join("\n")}`);
  throw new Error(sections.join("\n\n"));
}

verifyRelativeImportsStayInCheckout(allSourceFiles);

const manifest = `${collected.join("\n")}\n`;
const fingerprint = createHash("sha256").update(manifest).digest("hex");
const result = {
  count: collected.length,
  fingerprint,
  files: collected,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${collected.join("\n")}\n`);
  process.stdout.write(`\nVitest collection verified: ${collected.length} files\n`);
  process.stdout.write(`Manifest SHA-256: ${fingerprint}\n`);
}
