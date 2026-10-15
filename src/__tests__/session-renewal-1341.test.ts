import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../module/auth/repository/auth.repository", () => ({ findAuthenticatedAccountState: vi.fn() }));
vi.mock("../shared-directory/site-runtime", () => ({ sharedDirectoryClient: () => null }));
import { findAuthenticatedAccountState } from "../module/auth/repository/auth.repository";
import { authenticateToken } from "../module/auth/middlewares/auth.middleware";
import { renewSession } from "../module/auth/controllers/session.controller";
import { assertSessionLifetime, MAX_SESSION_SECONDS, renewSessionToken } from "../module/auth/domain/session-renewal";
import { issueSessionToken } from "../module/auth/domain/session-token";

const secret = "disposable-session-renewal-fixture-1341";
const now = Math.floor(Date.now() / 1000);
const claims = { id: 91, username: "FIXTURE", email: "fixture@example.invalid", role: "Employee", session_epoch: 7, session_started_at: now - 600, mfa: true, amr: ["pwd", "totp"], mfa_verified_at: now - 600, mfa_factor_id: "fixture-factor", mfa_factor_version: 2 };
beforeEach(() => {
  vi.stubEnv("JWT_SECRET", secret);
  vi.mocked(findAuthenticatedAccountState).mockResolvedValue({ status: "Active", session_epoch: 7, is_superadmin: false, mfa_required: true, mfa_factor_id: "fixture-factor", mfa_factor_version: 2 });
});
afterEach(() => { vi.unstubAllEnvs(); });
describe("bounded session renewal", () => {
  it("issues 15 minute tokens and never refreshes the MFA time or revocation epoch", () => {
    const decoded = jwt.verify(renewSessionToken(claims), secret) as jwt.JwtPayload;
    expect(decoded.exp! - decoded.iat!).toBe(900);
    for (const key of ["session_epoch", "session_started_at", "mfa_verified_at", "mfa_factor_version", "mfa_factor_id"]) expect(decoded[key]).toBe(claims[key as keyof typeof claims]);
    expect(decoded.amr).toEqual(["pwd", "totp"]);
  });
  it("preserves the start across a fresh MFA step-up token", () => {
    const renewed = issueSessionToken({ id: 91, username: "FIXTURE", role: "Employee", email: null }, { factorId: "fixture-factor", factorVersion: 2, verifiedAt: new Date(), method: "totp" }, undefined, claims.session_started_at);
    expect((jwt.verify(renewed.token, secret) as jwt.JwtPayload).session_started_at).toBe(claims.session_started_at);
  });
  it.each([undefined, null, -1, now + 61, now - MAX_SESSION_SECONDS, "123"])("refuses invalid or exhausted session starts: %s", start => {
    expect(() => assertSessionLifetime(start, now)).toThrow();
  });
  it("migrates the original issue time of a legacy signed token without resetting its age", () => {
    const { session_started_at: _start, ...legacy } = claims;
    const result = jwt.verify(renewSessionToken({ ...legacy, iat: now - 3600 }), secret) as jwt.JwtPayload;
    expect(result.session_started_at).toBe(now - 3600);
  });
  const app = express();
  app.post("/renew", authenticateToken, renewSession);
  it("requires authentication and live account/factor/epoch checks before renewal", async () => {
    expect((await request(app).post("/renew")).status).toBe(401);
    const token = jwt.sign(claims, secret, { expiresIn: 100 });
    const ok = await request(app).post("/renew").set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200); expect(ok.headers["cache-control"]).toBe("no-store");
    vi.mocked(findAuthenticatedAccountState).mockResolvedValueOnce({ status: "Active", session_epoch: 8, is_superadmin: false, mfa_required: true, mfa_factor_id: "fixture-factor", mfa_factor_version: 2 });
    expect((await request(app).post("/renew").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
  it("refuses a signed session older than eight hours even if its JWT expiry is later", async () => {
    const token = jwt.sign({ ...claims, session_started_at: now - MAX_SESSION_SECONDS }, secret, { expiresIn: 900 });
    expect((await request(app).post("/renew").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });
});
