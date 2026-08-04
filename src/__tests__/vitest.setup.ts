import fs from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

function assertInside(baseDir: string, candidatePath: string) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing Vitest storage outside ${baseDir}`);
  }
}

const testRunRoot = process.env.CERP_VITEST_RUN_ROOT;
if (!testRunRoot) {
  throw new Error("CERP_VITEST_RUN_ROOT must be set by vitest.config.ts");
}

const vitestTempRoot = path.join(os.tmpdir(), "cerp-vitest");
assertInside(vitestTempRoot, testRunRoot);

const workerIdentity = [
  process.env.VITEST_POOL_ID,
  process.env.VITEST_WORKER_ID,
  String(process.pid),
]
  .filter(Boolean)
  .join("-")
  .replace(/[^a-zA-Z0-9_-]/g, "_");

const workerRoot = path.join(testRunRoot, `worker-${workerIdentity}`);
const storageRoot = path.join(workerRoot, "storage");
nodeFs.mkdirSync(path.join(storageRoot, "tmp"), { recursive: true, mode: 0o700 });
nodeFs.chmodSync(workerRoot, 0o700);
nodeFs.chmodSync(storageRoot, 0o700);
nodeFs.chmodSync(path.join(storageRoot, "tmp"), 0o700);

Object.assign(process.env, {
  CERP_ROOT: workerRoot,
  CERP_STORAGE_ROOT: storageRoot,
  CERP_DOCUMENTS_ROOT: path.join(storageRoot, "documents"),
  CERP_TMP_ROOT: path.join(storageRoot, "tmp"),
  CERP_GENERATED_ROOT: path.join(storageRoot, "generated"),
  CERP_INBOUND_ROOT: path.join(storageRoot, "inbound"),
  CERP_EXPORTS_ROOT: path.join(storageRoot, "exports"),
  CERP_PDF_PREVIEW_DIR: path.join(storageRoot, "generated", "pdf-preview"),
  CERP_VITEST_WORKER_ROOT: workerRoot,
});

afterAll(async () => {
  await fs.rm(workerRoot, { recursive: true, force: true });
});
