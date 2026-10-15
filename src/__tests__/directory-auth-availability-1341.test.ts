import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  findState: vi.fn(),
}));

vi.mock("../shared-directory/site-runtime", () => ({
  sharedDirectoryClient: () => ({ enabled: true }),
  validateSiteDirectoryToken: mocks.validate,
}));
vi.mock("../module/auth/repository/auth.repository", () => ({
  findAuthenticatedAccountState: mocks.findState,
}));

import { authenticateToken } from "../module/auth/middlewares/auth.middleware";

const secret = "directory-auth-availability-fixture-1341";
const app = express();
app.get("/protected", authenticateToken, (_req, res) => res.json({ ok: true }));

function token() {
  return jwt.sign({
    id: 91,
    username: "FIXTURE",
    email: "fixture@example.invalid",
    role: "Employee",
    session_epoch: 4,
    directory_session: "dir_fixture",
    directory_profile_id: "f2f4ec1c-45ca-44e8-a9df-21d00c5d7e34",
    directory_global_epoch: 2,
    directory_membership_version: 3,
    mfa_factor_id: "d2cc719f-a5df-484d-874a-7b7d5d9a4f32",
    mfa_factor_version: 1,
  }, secret, { expiresIn: 60 });
}

describe("directory authentication availability boundary (#1341)", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", secret);
    mocks.validate.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    [Object.assign(new Error("lock wait"), { code: "55P03" }), "database_lock_timeout"],
    [Object.assign(new Error("query cancelled"), { code: "57014" }), "database_query_timeout"],
    [Object.assign(new Error("directory unavailable"), { status: 503, code: "DIRECTORY_UNAVAILABLE" }), "directory_unavailable"],
    [Object.assign(new Error("call rejected"), { status: 401, code: "DIRECTORY_CALL_REJECTED" }), "directory_unavailable"],
    [Object.assign(new Error("call replayed"), { status: 403, code: "DIRECTORY_CALL_REPLAYED" }), "directory_unavailable"],
    [Object.assign(new Error("unexpected authority response"), { status: 401, code: "DIRECTORY_UNKNOWN" }), "directory_unavailable"],
    [new Error("pool acquisition failed"), "directory_unavailable"],
  ])("keeps a valid session when directory validation has a transient failure", async (error, reason) => {
    mocks.validate.mockRejectedValueOnce(error);

    const response = await request(app).get("/protected").set("Authorization", `Bearer ${token()}`);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("DIRECTORY_UNAVAILABLE");
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ type: "directory_auth_failure", reason, status: 503 }));
  });

  it("returns 401 only when the directory explicitly rejects the session", async () => {
    mocks.validate.mockRejectedValueOnce(new Error("DIRECTORY_SESSION_STALE"));

    const response = await request(app).get("/protected").set("Authorization", `Bearer ${token()}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("MFA_REQUIRED");
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ type: "directory_auth_failure", reason: "directory_session_rejected", status: 401 }));
  });

  it("accepts a valid JWT after the directory validates it", async () => {
    mocks.validate.mockResolvedValueOnce({ username: "FIXTURE", email: "fixture@example.invalid", role: "Employee", roles: ["Employee"] });

    await request(app).get("/protected").set("Authorization", `Bearer ${token()}`).expect(200, { ok: true });
  });

  it("does not ask the directory to validate a JWT that fails signature verification", async () => {
    const invalidToken = jwt.sign({ id: 91, username: "FIXTURE", email: "fixture@example.invalid", role: "Employee" }, "other-secret", { expiresIn: 60 });

    await request(app).get("/protected").set("Authorization", `Bearer ${invalidToken}`).expect(401);
    expect(mocks.validate).not.toHaveBeenCalled();
  });
});
