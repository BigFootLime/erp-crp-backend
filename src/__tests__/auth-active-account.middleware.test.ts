import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findState: vi.fn() }));
vi.mock("../module/auth/repository/auth.repository", () => ({
  findAuthenticatedAccountState: mocks.findState,
}));

import { authenticateToken } from "../module/auth/middlewares/auth.middleware";

const secret = "sol-02-live-account-state-test";
const previousSecret = process.env.JWT_SECRET;
const app = express();
app.get("/protected", authenticateToken, (_req, res) => res.json({ ok: true }));

function token(sessionEpoch = 3) {
  return jwt.sign({ id: 9, username: "USER", email: "user@example.test", role: "Employee", session_epoch: sessionEpoch }, secret);
}

function mfaToken(sessionEpoch = 3) {
  return jwt.sign({
    id: 9,
    username: "ADMIN",
    email: "admin@example.test",
    role: "Admin",
    session_epoch: sessionEpoch,
    mfa: true,
    amr: ["pwd", "totp"],
    mfa_verified_at: Math.floor(Date.now() / 1000),
    mfa_factor_id: "8c2a19e7-65f3-4cc6-810f-262581aedfc5",
    mfa_factor_version: 2,
  }, secret);
}

describe("live authenticated account lifecycle", () => {
  beforeAll(() => { process.env.JWT_SECRET = secret; });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  beforeEach(() => mocks.findState.mockReset());

  it("rejects anonymous, inactive and stale-session requests", async () => {
    expect((await request(app).get("/protected")).status).toBe(401);
    mocks.findState.mockResolvedValueOnce({ status: "Inactive", session_epoch: 3 });
    expect((await request(app).get("/protected").set("Authorization", `Bearer ${token()}`)).status).toBe(403);
    mocks.findState.mockResolvedValueOnce({ status: "Active", session_epoch: 4 });
    expect((await request(app).get("/protected").set("Authorization", `Bearer ${token()}`)).status).toBe(401);
  });

  it("allows only an active account with the current epoch", async () => {
    mocks.findState.mockResolvedValueOnce({ status: "Active", session_epoch: 3 });
    await request(app).get("/protected").set("Authorization", `Bearer ${token()}`).expect(200, { ok: true });
  });

  it("rejects privileged legacy or stale-factor sessions and accepts the live factor", async () => {
    const state = {
      status: "Active",
      session_epoch: 3,
      is_superadmin: true,
      mfa_required: true,
      mfa_factor_id: "8c2a19e7-65f3-4cc6-810f-262581aedfc5",
      mfa_factor_version: 2,
    };
    mocks.findState.mockResolvedValueOnce(state);
    const legacy = await request(app).get("/protected").set("Authorization", `Bearer ${token()}`);
    expect(legacy.status).toBe(401);
    expect(legacy.body.code).toBe("MFA_REQUIRED");

    mocks.findState.mockResolvedValueOnce({ ...state, mfa_factor_version: 3 });
    expect((await request(app).get("/protected").set("Authorization", `Bearer ${mfaToken()}`)).status).toBe(401);

    mocks.findState.mockResolvedValueOnce(state);
    await request(app).get("/protected").set("Authorization", `Bearer ${mfaToken()}`).expect(200, { ok: true });
  });
});
