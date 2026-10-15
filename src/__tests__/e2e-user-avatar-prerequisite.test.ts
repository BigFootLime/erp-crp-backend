import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("isolated user-avatar migration prerequisite", () => {
  it("applies the isolated historical column before the avatar binding migration", () => {
    const source = readFileSync(path.resolve("scripts/e2e/migrate-isolated.js"), "utf8");
    const prerequisite = readFileSync(path.resolve("db/e2e/historical-user-avatar-prerequisite.sql"), "utf8");
    const boundary = source.indexOf("if (filename === USER_AVATARS_PATCH)");
    const migration = source.indexOf("runPatch(filename, DATA_ONLY_BASELINES", boundary);

    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(migration).toBeGreaterThan(boundary);
    expect(source).toContain("HISTORICAL_USER_AVATAR_PREREQUISITE");
    expect(source).toContain("trg_operational_media_users_profile_picture");
    expect(source).toContain("fn_operational_media_sync_binding()'");
    expect(prerequisite).toContain("cerp.e2e_isolated");
    expect(prerequisite).toContain("profile_picture text");
    expect(prerequisite).not.toContain("last_login");
    expect(prerequisite).not.toContain("created_at");
  });
});
