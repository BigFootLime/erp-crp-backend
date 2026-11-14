import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const sourceSetSha = "a".repeat(64);
const content = Buffer.from("immutable metrology recovery fixture");
const blobSha = crypto.createHash("sha256").update(content).digest("hex");
const historicalPath = (extension = "pdf") => `uploads/docs/legacy-import/${sourceSetSha}/${blobSha}.${extension}`;
const canonicalPath = (extension = "pdf") => `documents/metrologie/legacy-import/${sourceSetSha}/${blobSha}.${extension}`;
type Reference = { source_table: string; storage_column: string; row_ref: string; storage_path: string; expected_sha256: string | null; expected_size_bytes: number | null };
const reference = (storage_path = historicalPath()): Reference => ({
  source_table: "metrologie_import_source_files", storage_column: "storage_path", row_ref: "fixture-source",
  storage_path, expected_sha256: blobSha, expected_size_bytes: content.length,
});
const roots = [
  { kind: "data", source: "/mnt/data/cerp", aliases: ["/srv/cerp"], snapshot: "files/cerp" },
  { kind: "ged", source: "/mnt/data/cerp-ged/prod", snapshot: "files/cerp-ged" },
];
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) {
    const relative = path.relative(os.tmpdir(), temporaryRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(temporaryRoot).startsWith("cerp-recovery-metrology-")) throw new Error("Unexpected fixture root");
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  temporaryRoot = null;
});

async function stage(files: Array<{ file: string; contents?: Buffer }>) {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-recovery-metrology-"));
  for (const item of files) {
    const target = path.resolve(temporaryRoot, item.file);
    if (path.relative(temporaryRoot, target).startsWith("..")) throw new Error("Fixture escapes recovery root");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, item.contents ?? content);
  }
}

async function verify(references: Reference[], sourceRoots = roots) {
  if (!temporaryRoot) throw new Error("Fixture not staged");
  const refs = path.join(temporaryRoot, "references.jsonl");
  const sourceMap = path.join(temporaryRoot, "source-map.json");
  const report = path.join(temporaryRoot, "integrity.json");
  await fs.writeFile(refs, references.map((value) => JSON.stringify(value)).join("\n") + "\n");
  await fs.writeFile(sourceMap, JSON.stringify({ schema_version: 1, roots: sourceRoots }));
  let exitCode = 0;
  try {
    execFileSync(process.execPath, ["scripts/backup/recovery-set.mjs", "verify-files", "--root", temporaryRoot, "--references", refs, "--source-map", sourceMap, "--output", report], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, stdio: "pipe",
    });
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error) || error.status !== 1) throw error;
    exitCode = 1;
  }
  return { exitCode, report: JSON.parse(await fs.readFile(report, "utf8")) as { reliability: string; reference_count: number; verified_count: number; hash_verified_count: number; size_verified_count: number; failure_count: number; failures: Array<{ reason: string }> } };
}

describe("SOL-10 metrology immutable document recovery", () => {
  it("verifies the deployed application-data documents layout", async () => {
    await stage([{ file: `files/cerp/data/${canonicalPath()}` }]);
    const result = await verify([reference()]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ verified_count: 1, hash_verified_count: 1, size_verified_count: 1, failure_count: 0 });
  });
  it.each(["xlsx", "ods", "pdf", "zip"])("verifies a %s source in the canonical GED vault without a filesystem alias", async (extension) => {
    await stage([{ file: `files/cerp-ged/${canonicalPath(extension)}` }]);
    const result = await verify([reference(historicalPath(extension))]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ reliability: "VERIFIED", reference_count: 1, verified_count: 1, hash_verified_count: 1, size_verified_count: 1, failure_count: 0 });
  });

  it("keeps duplicate immutable references and verifies each against its shared blob", async () => {
    await stage([{ file: `files/cerp-ged/${canonicalPath()}` }]);
    const result = await verify([reference(), { ...reference(), row_ref: "second-source" }]);
    expect(result.report).toMatchObject({ reference_count: 2, verified_count: 2, hash_verified_count: 2, failure_count: 0 });
  });

  it.each([
    { label: "another table", source_table: "other_documents", storage_column: "storage_path" },
    { label: "a storage key", source_table: "metrologie_import_source_files", storage_column: "storage_key" },
  ])("does not apply the mapping to $label", async (scope) => {
    await stage([{ file: `files/cerp-ged/${canonicalPath()}` }]);
    const result = await verify([{ ...reference(), source_table: scope.source_table, storage_column: scope.storage_column }]);
    expect(result.exitCode).toBe(1);
    expect(result.report.failure_count).toBe(1);
  });

  it.each([
    "uploads/docs/legacy-import/../outside.pdf",
    `uploads/docs/legacy-import/${sourceSetSha}/%2e%2e.pdf`,
    `uploads/docs/legacy-import/${sourceSetSha}/${blobSha}.exe`,
    `uploads/docs/legacy-import/${sourceSetSha.toUpperCase()}/${blobSha}.pdf`,
    `uploads/docs/legacy-import/${sourceSetSha}\\${blobSha}.pdf`,
    `/${historicalPath()}`, `./${historicalPath()}`, ` ${historicalPath()}`, `${historicalPath()} `, `${historicalPath()}\n`,
  ])("rejects noncanonical legacy metadata even when a legacy fallback file exists: %s", async (storagePath) => {
    const legacyFile = storagePath.replaceAll("\\", "/").trim().replace(/^\//, "");
    await stage([{ file: `files/cerp-ged/${canonicalPath()}` }, { file: `files/cerp-ged/${legacyFile}` }]);
    const result = await verify([reference(storagePath)]);
    expect(result.exitCode).toBe(1);
    expect(result.report.failure_count).toBe(1);
  });

  it("does not substitute an old alias file for a missing canonical blob", async () => {
    await stage([{ file: `files/cerp-ged/${historicalPath()}` }]);
    const result = await verify([reference()]);
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.reason).toBe("missing");
  });

  it.each([
    { label: "size", override: { expected_size_bytes: content.length + 1 }, reason: "size_mismatch" },
    { label: "hash", override: { expected_sha256: "f".repeat(64) }, reason: "sha256_mismatch" },
  ])("still fails closed on $label mismatch", async ({ override, reason }) => {
    await stage([{ file: `files/cerp-ged/${canonicalPath()}` }]);
    const result = await verify([{ ...reference(), ...override }]);
    expect(result.exitCode).toBe(1);
    expect(result.report.failures[0]?.reason).toBe(reason);
  });

  it("does not guess a noncanonical path inside application data", async () => {
    await stage([{ file: `files/cerp/${canonicalPath()}` }]);
    expect((await verify([reference()], [roots[0]!])).exitCode).toBe(1);
  });

  it("does not map the historical namespace through an unrelated root kind", async () => {
    await stage([{ file: `files/cerp-ged/${canonicalPath()}` }]);
    expect((await verify([reference()], [{ ...roots[1]!, kind: "other" }])).exitCode).toBe(1);
  });

  it("preserves ordinary GED keys and absolute application references", async () => {
    await stage([{ file: "files/cerp-ged/blobs/proof.pdf" }, { file: "files/cerp/data/proof.pdf" }]);
    const result = await verify([
      { ...reference(), source_table: "ged_blobs", storage_column: "storage_key", storage_path: "blobs/proof.pdf" },
      { ...reference(), source_table: "other_documents", storage_path: "/srv/cerp/data/proof.pdf" },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ reference_count: 2, verified_count: 2, failure_count: 0 });
  });
});
