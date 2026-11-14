import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const guard = path.resolve("scripts/compat/check-material-referentials-backport-lifecycle.mjs");

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(status = "RETAINED") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-compat-lifecycle-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "docs", "compat"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "compat"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist", "compat"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "compat", "material-referentials-backport.lifecycle.json"), JSON.stringify({
    status,
    adapter: {
      source: "src/compat/material-referentials-backport.ts",
      compiled: "dist/compat/material-referentials-backport.js",
      required_exports: ["materialReferentialsBackportRouter", "augmentMaterialReferentialsAccessProfile"],
    },
  }));
  fs.writeFileSync(path.join(root, "src", "compat", "material-referentials-backport.ts"), "export const materialReferentialsBackportRouter = {}; export const augmentMaterialReferentialsAccessProfile = {};\n");
  fs.writeFileSync(path.join(root, "dist", "compat", "material-referentials-backport.js"), "exports.materialReferentialsBackportRouter = {}; exports.augmentMaterialReferentialsAccessProfile = {};\n");
  return root;
}

function check(root: string) {
  return spawnSync(process.execPath, [guard, "--root", root], { encoding: "utf8" });
}

describe("material referentials lifecycle build guard", () => {
  it("accepts the retained adapter and rejects an AST-missing source export", () => {
    const root = fixture();
    expect(check(root).status).toBe(0);
    fs.writeFileSync(path.join(root, "src", "compat", "material-referentials-backport.ts"), "export const materialReferentialsBackportRouter = {};\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("augmentMaterialReferentialsAccessProfile");
  });

  it("does not mistake commented exports for retained source exports", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "src", "compat", "material-referentials-backport.ts"), "export const materialReferentialsBackportRouter = {}; // export const augmentMaterialReferentialsAccessProfile = {};\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source export is missing");
  });

  it("rejects missing retained source and compiled members", () => {
    const sourceRoot = fixture();
    fs.rmSync(path.join(sourceRoot, "src", "compat", "material-referentials-backport.ts"));
    expect(check(sourceRoot).stderr).toContain("source is missing");

    const distRoot = fixture();
    fs.rmSync(path.join(distRoot, "dist", "compat", "material-referentials-backport.js"));
    expect(check(distRoot).stderr).toContain("build output is missing");
  });

  it("rejects every non-retained status even when fake evidence is supplied", () => {
    const root = fixture("RETIRED");
    const manifestPath = path.join(root, "docs", "compat", "material-referentials-backport.lifecycle.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.retirement_evidence = { target_runtime_manifest: "fake", authenticated_acceptance: "fake", review_approval: "fake" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported lifecycle status");
    const unknown = fixture("WHATEVER");
    expect(check(unknown).stderr).toContain("unsupported lifecycle status");
  });

  it("refuses an empty export inventory and commented compiled exports", () => {
    const root = fixture();
    const manifestPath = path.join(root, "docs", "compat", "material-referentials-backport.lifecycle.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.adapter.required_exports = [];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(check(root).stderr).toContain("non-empty export inventory");

    const emittedRoot = fixture();
    fs.writeFileSync(path.join(emittedRoot, "dist", "compat", "material-referentials-backport.js"), "exports.materialReferentialsBackportRouter = {}; // exports.augmentMaterialReferentialsAccessProfile = {};\n");
    expect(check(emittedRoot).stderr).toContain("compiled export is missing");
  });
});
