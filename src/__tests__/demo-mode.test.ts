import { describe, expect, it } from "vitest";

import { assertDemoDatabaseIsolation, isDemoMode } from "../config/demo-mode";
import { loginSchema } from "../module/auth/validators/auth.validator";

describe("CERP-DEMO-01 database isolation", () => {
  it("requires cerp_demo when demo mode is enabled", () => {
    expect(() => assertDemoDatabaseIsolation({ CERP_DEMO_MODE: "true", DATABASE_URL: "postgres://local/cerp_test" }))
      .toThrow(/cerp_demo/);
  });

  it("refuses a demo database outside demo mode", () => {
    expect(() => assertDemoDatabaseIsolation({ DATABASE_URL: "postgres://local/cerp_demo" }))
      .toThrow(/CERP_DEMO_MODE/);
  });

  it("keeps normal deployments unaffected", () => {
    expect(isDemoMode({ CERP_DEMO_MODE: "false" })).toBe(false);
    expect(() => assertDemoDatabaseIsolation({ DATABASE_URL: "postgres://local/cerp_test" })).not.toThrow();
  });

  it("accepts cerp_demo only while demo mode is active", () => {
    const previous = process.env.CERP_DEMO_MODE;
    process.env.CERP_DEMO_MODE = "true";
    expect(loginSchema.parse({ username: "demo", password: "secret", database: "cerp_demo" }).database).toBe("cerp_demo");
    expect(() => loginSchema.parse({ username: "demo", password: "secret", database: "cerp_test" })).toThrow();
    if (previous === undefined) delete process.env.CERP_DEMO_MODE;
    else process.env.CERP_DEMO_MODE = previous;
  });
});
