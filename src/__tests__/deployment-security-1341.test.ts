import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { assertDeploymentSecurity, sessionSignOptions, sessionVerifyOptions } from "../config/deployment-security";
const fixture: NodeJS.ProcessEnv = {
  CERP_DEPLOYMENT_PROFILE: "customer", NODE_ENV: "production",
  CERP_INSTALLATION_ID: "11111111-1111-4111-8111-111111111111", CERP_ENTERPRISE_ID: "22222222-2222-4222-8222-222222222222",
  JWT_SECRET: "fixture-only-do-not-deploy-jwt-key-1341", MFA_ROOT_KEY: "fixture-present",
  AUTH_RATE_LIMIT_HASH_KEY: "fixture-only-do-not-deploy-rate-key-1341", CORS_ORIGINS: "https://erp.example.invalid,app://cerp",
};
describe("customer deployment security", () => {
  it("also rejects insufficient internal signing keys instead of checking only customer instances", () => {
    expect(() => assertDeploymentSecurity({ NODE_ENV: "production", JWT_SECRET: "short" })).toThrow("JWT_SECRET");
    expect(() => assertDeploymentSecurity({ NODE_ENV: "development" })).toThrow("JWT_SECRET");
    expect(() => assertDeploymentSecurity({ NODE_ENV: "production", JWT_SECRET: fixture.JWT_SECRET })).not.toThrow();
    expect(() => assertDeploymentSecurity({ NODE_ENV: "test" })).not.toThrow();
  });
  it("issues short internal sessions while accepting existing HS256 signatures", () => {
    expect(sessionSignOptions({})).toEqual({ algorithm: "HS256", expiresIn: "15m" });
    const token = jwt.sign({ id: 1 }, fixture.JWT_SECRET!);
    expect(jwt.verify(token, fixture.JWT_SECRET!, sessionVerifyOptions({}))).toHaveProperty("id", 1);
  });
  it("binds commercial access to installation and enterprise even if keys are accidentally reused", () => {
    const token = jwt.sign({ id: 1 }, fixture.JWT_SECRET!, sessionSignOptions(fixture));
    const decoded = jwt.verify(token, fixture.JWT_SECRET!, sessionVerifyOptions(fixture)) as jwt.JwtPayload;
    expect(decoded.exp! - decoded.iat!).toBe(900);
    expect(() => jwt.verify(token, fixture.JWT_SECRET!, sessionVerifyOptions({ ...fixture, CERP_ENTERPRISE_ID: "33333333-3333-4333-8333-333333333333" }))).toThrow();
    expect(() => jwt.verify(token, fixture.JWT_SECRET!, sessionVerifyOptions({ ...fixture, CERP_INSTALLATION_ID: "44444444-4444-4444-8444-444444444444" }))).toThrow();
    expect(() => jwt.verify(jwt.sign({ id: 1 }, fixture.JWT_SECRET!), fixture.JWT_SECRET!, sessionVerifyOptions(fixture))).toThrow();
  });
  it("rejects incomplete, permissive or cleartext customer configurations without printing secrets", () => {
    expect(() => assertDeploymentSecurity(fixture)).not.toThrow();
    for (const override of [
      { NODE_ENV: "development" }, { JWT_SECRET: "short" }, { MFA_ROOT_KEY: "" },
      { CERP_ENTERPRISE_ID: "invalid" }, { CERP_MODULE_ACCESS_GATE_DISABLED: "1" },
      { AUTH_RATE_LIMIT_ENABLED: "false" }, { CORS_ORIGINS: "http://erp.example.invalid" },
      { CORS_ORIGINS: "https://erp.example.invalid/path" }, { CORS_ORIGINS: "" },
    ]) expect(() => assertDeploymentSecurity({ ...fixture, ...override })).toThrow();
  });
});
