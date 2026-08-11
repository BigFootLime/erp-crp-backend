import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/repo-paths";

type CleanBuildOutput = (repositoryRoot: string) => string;
const require = createRequire(import.meta.url);
const { cleanBuildOutput } = require("../../scripts/build/clean-dist.js") as {
  cleanBuildOutput: CleanBuildOutput;
};

describe("backend build output cleanup", () => {
  it("removes stale emitted files while preserving siblings", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-build-clean-"));
    const dist = path.join(temporaryRoot, "dist");
    const sibling = path.join(temporaryRoot, "keep.txt");
    try {
      fs.mkdirSync(path.join(dist, "module", "__fixtures__"), { recursive: true });
      fs.writeFileSync(path.join(dist, "module", "__fixtures__", "stale.js"), "fixture");
      fs.writeFileSync(sibling, "keep");

      expect(cleanBuildOutput(temporaryRoot)).toBe(dist);
      expect(fs.existsSync(dist)).toBe(false);
      expect(fs.readFileSync(sibling, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("runs the cleanup before TypeScript compilation", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: { build: string };
    };
    expect(packageJson.scripts.build).toMatch(/clean-dist\.js && tsc -p tsconfig\.json/);
  });
});
