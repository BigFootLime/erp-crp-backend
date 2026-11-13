import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

type FixtureEnvironment = Record<string, string | undefined>;
type FixtureExports = {
  assertFixtureEnvironment: (env: FixtureEnvironment) => URL;
};

const require = createRequire(import.meta.url);
const { assertFixtureEnvironment } = require("../../scripts/e2e/seed-access-scope-1592.cjs") as FixtureExports;

function isolatedFixtureEnvironment(overrides: FixtureEnvironment = {}): FixtureEnvironment {
  return {
    CERP_E2E_ISOLATED: "1",
    CERP_E2E_ACCESS_SCOPE_FIXTURE: "1",
    E2E_PASSWORD: "fixture-password-only",
    CERP_E2E_DB_PORT: "55432",
    DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:55432/cerp_test",
    ...overrides,
  };
}

describe("#1506 isolated access-scope fixture environment guard", () => {
  it("accepts only an explicit local cerp_test target with matching isolated port", () => {
    const url = assertFixtureEnvironment(isolatedFixtureEnvironment());

    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("55432");
    expect(url.pathname).toBe("/cerp_test");
  });

  it.each([
    ["isolated-run flag", { CERP_E2E_ISOLATED: "0" }],
    ["fixture opt-in flag", { CERP_E2E_ACCESS_SCOPE_FIXTURE: "0" }],
    ["fixture password", { E2E_PASSWORD: undefined }],
  ] as const)("requires the %s before any fixture target is accepted", (_name, overrides) => {
    expect(() => assertFixtureEnvironment(isolatedFixtureEnvironment(overrides))).toThrow(
      /CERP_E2E_ISOLATED=1 and CERP_E2E_ACCESS_SCOPE_FIXTURE=1 are required|E2E_PASSWORD is required/,
    );
  });

  it.each([
    ["a remote host", { DATABASE_URL: "postgres://fixture:fixture@db.invalid:55432/cerp_test" }],
    ["another database", { DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:55432/cerp_prod" }],
    ["an implicit database port", { DATABASE_URL: "postgres://fixture:fixture@127.0.0.1/cerp_test" }],
    ["a port that differs from CERP_E2E_DB_PORT", { DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:55433/cerp_test" }],
    ["shared Directory mode", { CERP_SHARED_DIRECTORY_ENABLED: "true" }],
  ] as const)("rejects %s", (_name, overrides) => {
    expect(() => assertFixtureEnvironment(isolatedFixtureEnvironment(overrides))).toThrow();
  });
});
