const fs = require("node:fs");
const path = require("node:path");

/**
 * Remove only the repository's generated dist directory.
 * @param {string} repositoryRoot
 */
function cleanBuildOutput(repositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const buildOutput = path.resolve(resolvedRoot, "dist");
  if (path.dirname(buildOutput) !== resolvedRoot || path.basename(buildOutput) !== "dist") {
    throw new Error(`Refusing to clean unexpected build output: ${buildOutput}`);
  }
  fs.rmSync(buildOutput, { recursive: true, force: true });
  return buildOutput;
}

if (require.main === module) {
  const repositoryRoot = path.resolve(__dirname, "..", "..");
  const removed = cleanBuildOutput(repositoryRoot);
  process.stdout.write(`Build output cleaned: ${removed}\n`);
}

module.exports = { cleanBuildOutput };
