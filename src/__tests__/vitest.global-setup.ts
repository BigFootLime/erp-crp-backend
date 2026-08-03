import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export default function setup() {
  const testRunRoot = process.env.CERP_VITEST_RUN_ROOT;
  if (!testRunRoot) {
    throw new Error("CERP_VITEST_RUN_ROOT must be set by vitest.config.ts");
  }

  const vitestTempRoot = path.resolve(os.tmpdir(), "cerp-vitest");
  const relative = path.relative(vitestTempRoot, path.resolve(testRunRoot));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing Vitest cleanup outside ${vitestTempRoot}`);
  }

  return async () => {
    await fs.rm(testRunRoot, { recursive: true, force: true });
  };
}
