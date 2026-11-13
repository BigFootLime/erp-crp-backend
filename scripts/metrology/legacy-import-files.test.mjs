import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  businessSourceFiles, containedRegularFile, prepareSourceVault, verifySourceFiles,
} from "./legacy-import-files.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const source = (relativePath, value) => ({ relativePath, sha256: digest(value), sizeBytes: Buffer.byteLength(value) });
const manifest = entries => ({ sourceSet: { files: entries }, attachments: { business: [] } });

async function temp(prefix) { return mkdtemp(path.join(os.tmpdir(), prefix)); }

test("business inventory keeps two distinct paths with identical bytes", () => {
  const same = digest("same");
  const files = businessSourceFiles({
    sourceSet: { files: [{ relativePath: "PC-01/a.xlsx", sha256: same, sizeBytes: 4 }] },
    attachments: { business: [{ sourceRelativePath: "PC-02/a.pdf", sha256: same, bytes: 4 }] },
  });
  assert.deepEqual(files.map(file => file.relativePath), ["PC-01/a.xlsx", "PC-02/a.pdf"]);
  assert.equal(files[0].sha256, files[1].sha256);
});

test("rejects traversal and verifies source bytes", async () => {
  assert.throws(() => businessSourceFiles(manifest([source("../escape.xlsx", "x")])), /traversal/);
  const root = await temp("metrology-source-");
  await mkdir(path.join(root, "PC-01"));
  await writeFile(path.join(root, "PC-01", "control.xlsx"), "actual");
  const expected = source("PC-01/control.xlsx", "expected");
  await assert.rejects(verifySourceFiles(root, [expected]), /source bytes differ/);
});

test("refuses symlinked source paths", async (context) => {
  const root = await temp("metrology-source-");
  const outside = await temp("metrology-outside-");
  await writeFile(path.join(outside, "outside.xlsx"), "outside");
  try {
    await symlink(path.join(outside, "outside.xlsx"), path.join(root, "linked.xlsx"));
  } catch (error) {
    context.skip("Creating symlinks is unavailable on this Windows host: " + error.code);
    return;
  }
  await assert.rejects(containedRegularFile(root, "linked.xlsx"), /symbolic source links forbidden/);
});

test("vault is content addressed, scans each digest once, and rejects tampering", async () => {
  const sourceRoot = await temp("metrology-source-");
  const docsRoot = await temp("metrology-docs-");
  await mkdir(path.join(sourceRoot, "one"));
  await mkdir(path.join(sourceRoot, "two"));
  await writeFile(path.join(sourceRoot, "one", "same.pdf"), "pdf!");
  await writeFile(path.join(sourceRoot, "two", "same.pdf"), "pdf!");
  const files = [
    { ...source("one/same.pdf", "pdf!"), mimeType: "application/pdf" },
    { ...source("two/same.pdf", "pdf!"), mimeType: "application/pdf" },
  ];
  let scans = 0;
  const clean = async () => { scans += 1; return { status: "clean", mode: "enforce", provider: "clamdscan" }; };
  const set = digest("source-set");
  const results = await prepareSourceVault({ sourceRoot, docsRoot, files, sourceSetSha256: set, scan: clean });
  assert.equal(results.length, 2);
  assert.equal(scans, 1);
  assert.equal(results[0].storagePath, results[1].storagePath);
  assert.match(results[0].storagePath, /^uploads\/docs\/metrologie\/legacy-import\//);
  await writeFile(results[0].physicalPath, "evil");
  await assert.rejects(prepareSourceVault({ sourceRoot, docsRoot, files, sourceSetSha256: set, scan: clean }), /vault copy integrity failure/);
});

test("requires an enforced clean scanner verdict", async () => {
  const sourceRoot = await temp("metrology-source-");
  const docsRoot = await temp("metrology-docs-");
  await writeFile(path.join(sourceRoot, "scan.pdf"), "pdf!");
  const files = [{ ...source("scan.pdf", "pdf!"), mimeType: "application/pdf" }];
  const set = digest("scan-set");
  for (const verdict of [
    { status: "clean", mode: "monitor", provider: "clamdscan" },
    { status: "unavailable", mode: "enforce", provider: "clamdscan" },
    { status: "clean", mode: "enforce", provider: "none" },
  ]) {
    await assert.rejects(prepareSourceVault({ sourceRoot, docsRoot, files, sourceSetSha256: set, scan: async () => verdict }), /CLEAN antivirus/);
  }
});
