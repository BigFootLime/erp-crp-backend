// Opt-in full-schema transaction suite; never runs against an operational DB.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const url = new URL(
  process.env.DATABASE_URL || "postgresql://localhost/unused",
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/cerp_1069_test"
)
  throw new Error(
    "Use the dedicated local cerp_1069_test database with its fully migrated schema.",
  );
const result = spawnSync(
  process.execPath,
  [
    require.resolve("vitest/vitest.mjs"),
    "run",
    "src/module/receptions/repository/receipt-processing.postgres.test.ts",
  ],
  {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, CERP_RECEIPT_PG_TEST: "1" },
  },
);
process.exitCode = result.status ?? 1;
