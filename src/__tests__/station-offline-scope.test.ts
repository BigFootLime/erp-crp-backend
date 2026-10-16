import { describe, expect, it } from "vitest";
import { readStationOfflineInstallationId, resolveStationOfflineScope, stationOfflineScope } from "../config/station-offline-scope";

describe("station offline scope (#1358)", () => {
  const installationId = "11111111-1111-4111-8111-111111111111";
  it("accepts a stable UUID independently of deployment profile", () => {
    expect(readStationOfflineInstallationId({ CERP_DEPLOYMENT_PROFILE: "internal", CERP_INSTALLATION_ID: installationId } as NodeJS.ProcessEnv)).toBe(installationId);
    expect(readStationOfflineInstallationId({ CERP_INSTALLATION_ID: "not-a-uuid" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("uses the actual connected database and verified device in an opaque v2 scope", async () => {
    const query = { query: async <T>() => ({ rows: [{ database: "cerp_prod" }] as T[] }) };
    const scope = await resolveStationOfflineScope(query, "22222222-2222-4222-8222-222222222222", { CERP_INSTALLATION_ID: installationId } as NodeJS.ProcessEnv);
    expect(scope).toMatch(/^v2\.[A-Za-z0-9_-]{43}$/);
    expect(scope).not.toContain("cerp_prod");
    expect(scope).not.toBe(stationOfflineScope({ installationId, database: "cerp_test", deviceId: "22222222-2222-4222-8222-222222222222" }));
    expect(scope).not.toBe(stationOfflineScope({ installationId: "33333333-3333-4333-8333-333333333333", database: "cerp_prod", deviceId: "22222222-2222-4222-8222-222222222222" }));
    expect(scope).not.toBe(stationOfflineScope({ installationId, database: "cerp_prod", deviceId: "44444444-4444-4444-8444-444444444444" }));
  });
  it("omits scope without a valid installation identity without querying the database", async () => {
    let queried = false;
    const scope = await resolveStationOfflineScope({ query: async <T>() => { queried = true; return { rows: [] as T[] }; } }, "22222222-2222-4222-8222-222222222222", {});
    expect(scope).toBeNull();
    expect(queried).toBe(false);
  });
});
