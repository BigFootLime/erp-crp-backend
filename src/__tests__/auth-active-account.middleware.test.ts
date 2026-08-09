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
});
