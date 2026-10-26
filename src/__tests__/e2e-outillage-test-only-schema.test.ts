import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATOR = path.join(ROOT, "scripts", "e2e", "migrate-isolated.js");

function runMigrator(environment: Record<string, string>) {
  return spawnSync(process.execPath, [MIGRATOR], {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
}

describe("isolated outillage supplier schema", () => {
  it("refuses non-isolated or remote targets before opening a database connection", () => {
    const withoutIsolation = runMigrator({
      CERP_E2E_ISOLATED: "",
      DATABASE_URL: "postgresql://fixture@203.0.113.10/cerp_test",
    });
    expect(withoutIsolation.status).toBe(1);
    expect(withoutIsolation.stderr).toContain("CERP_E2E_ISOLATED=1 is required");

    const remoteTarget = runMigrator({
      CERP_E2E_ISOLATED: "1",
      DATABASE_URL: "postgresql://fixture@203.0.113.10/cerp_test",
    });
    expect(remoteTarget.status).toBe(1);
    expect(remoteTarget.stderr).toContain("database host must be loopback");
    expect(remoteTarget.stderr).not.toContain("ECONNREFUSED");

    const productionTarget = runMigrator({
      CERP_E2E_ISOLATED: "1",
      DATABASE_URL: "postgresql://fixture@127.0.0.1/cerp_prod",
    });
    expect(productionTarget.status).toBe(1);
    expect(productionTarget.stderr).toContain("database name must be cerp_test");
    expect(productionTarget.stderr).not.toContain("ECONNREFUSED");
  });
});
