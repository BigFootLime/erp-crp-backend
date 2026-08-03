import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const testRunRoot = path.join(os.tmpdir(), "cerp-vitest", randomUUID());

// Global setup and every worker receive the same run root. The setup file adds
// a worker-specific segment before configuring CERP's writable directories.
process.env.CERP_VITEST_RUN_ROOT = testRunRoot;

export default defineConfig({
  root: repoRoot,
  server: {
    fs: {
      strict: true,
      allow: [repoRoot],
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: [
      ".claude/**",
      ".worktrees/**",
      "worktrees/**",
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "artifacts/**",
      "test-results/**",
      ".vitest-attachments/**",
    ],
    env: {
      CERP_VITEST_RUN_ROOT: testRunRoot,
    },
    setupFiles: ["src/__tests__/vitest.setup.ts"],
    globalSetup: ["src/__tests__/vitest.global-setup.ts"],
  },
});
