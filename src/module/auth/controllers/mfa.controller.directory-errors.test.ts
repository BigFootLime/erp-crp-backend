import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const directory = vi.hoisted(() => ({
  call: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: {} }));
vi.mock("../../../shared-directory/site-runtime", () => ({
  sharedDirectoryClient: () => ({ call: directory.call }),
  directoryAuthenticationResult: directory.authenticate,
}));
vi.mock("../services/mfa.service", () => ({
  beginOwnMfaEnrollment: vi.fn(),
  beginMfaReplacement: vi.fn(),
  getMfaPolicyConfiguration: vi.fn(),
  getMfaStatus: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  revokeOwnMfa: vi.fn(),
  stepUpMfa: vi.fn(),
  updateMfaPolicyConfiguration: vi.fn(),
  verifyMfaChallenge: vi.fn(),
}));

import { errorHandler } from "../../../middlewares/errorHandler";
import { DirectoryClient, LOCAL_DIRECTORY_ENDPOINT } from "../../../shared-directory/client";
import { assertSessionLifetime } from "../domain/session-renewal";
import { verifyChallenge, stepUp, startEnrollment, startReplacement, recoveryCodes, revoke, updatePolicy } from "./mfa.controller";

const challengeToken = "challenge-token-directory-error-1234";
const sessionStartedAt = 1_800_000_000;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { Object.assign(req, { user: { id: 7, directory_session: `dir_${"a".repeat(64)}`, session_started_at: sessionStartedAt } }); next(); });
  instance.post("/auth/mfa/verify", verifyChallenge);
  instance.post("/auth/mfa/step-up", stepUp);
  instance.post("/auth/mfa/enrollment", startEnrollment);
  instance.post("/auth/mfa/replacement", startReplacement);
  instance.post("/auth/mfa/recovery-codes", recoveryCodes);
  instance.post("/auth/mfa/revoke", revoke);
  instance.put("/auth/mfa/policy", updatePolicy);
  instance.use(errorHandler);
  return instance;
}

function directoryFailure(code: string): Error & { code: string } {
  return Object.assign(new Error("private directory error"), { code });
}

describe("directory MFA verification through the production HTTP error handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ["MFA_CODE_INVALID", 401, "Code MFA invalide."],
    ["MFA_LOCKED", 423, "Le facteur MFA est temporairement verrouillé."],
    ["MFA_CHALLENGE_INVALID", 400, "Défi MFA invalide."],
    ["MFA_CHALLENGE_USED", 400, "Ce défi MFA a déjà été utilisé."],
    ["MFA_CHALLENGE_EXPIRED", 400, "Le défi MFA a expiré."],
    ["MFA_CHALLENGE_STALE", 400, "La session a changé. Reconnectez-vous."],
    ["MFA_FACTOR_INVALID", 400, "Le facteur MFA n'est plus actif."],
    ["MFA_ENROLLMENT_EXPIRED", 400, "L'enrôlement MFA a expiré."],
  ])("serializes approved %s failures without exposing the directory error", async (code, status, message) => {
    directory.call.mockRejectedValueOnce(directoryFailure(code));

    const response = await request(app())
      .post("/auth/mfa/verify")
      .send({ challenge_token: challengeToken, code: "123456" })
      .expect(status);

    expect(response.body).toEqual({ success: false, code, message, path: "/auth/mfa/verify" });
    expect(response.body.message).not.toContain("private directory error");
  });

  it.each(["DIRECTORY_UNAVAILABLE", "constructor"])("fails closed for directory code %s outside the allowlist", async (code) => {
    directory.call.mockRejectedValueOnce(directoryFailure(code));

    const response = await request(app())
      .post("/auth/mfa/verify")
      .send({ challenge_token: challengeToken, code: "123456" })
      .expect(500);

    expect(response.body).toEqual({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Erreur serveur.",
      path: "/auth/mfa/verify",
    });
  });

  it("keeps the successful directory MFA response unchanged", async () => {
    const success = {
      token: "opaque-session-token",
      user: { id: 7, username: "fixture-user", email: null, role: "Admin" },
    };
    directory.call.mockResolvedValueOnce({ directory_session: "private" });
    directory.authenticate.mockResolvedValueOnce(success);

    const response = await request(app())
      .post("/auth/mfa/verify")
      .send({ challenge_token: challengeToken, code: "123456" })
      .expect(200);

    expect(response.body).toEqual({ message: "Authentification renforcée validée", ...success });
    expect(directory.call).toHaveBeenCalledWith(
      "verify-mfa",
      expect.objectContaining({ input: { challenge_token: challengeToken, code: "123456" } }),
    );
  });

  it("preserves the original absolute session start after a directory step-up", async () => {
    directory.call.mockResolvedValueOnce({ directory_session: "private" });
    directory.authenticate.mockImplementationOnce(async (_pool, _result, _meta, startedAt) => ({ token: `session:${startedAt}` }));

    const response = await request(app())
      .post("/auth/mfa/step-up")
      .send({ code: "123456" })
      .expect(200);

    expect(response.body).toEqual({ token: `session:${sessionStartedAt}` });
    expect(directory.authenticate).toHaveBeenCalledWith(expect.anything(), { directory_session: "private" }, undefined, sessionStartedAt);
    let failure: unknown;
    try {
      assertSessionLifetime(sessionStartedAt, sessionStartedAt + 8 * 60 * 60);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "SESSION_MAX_AGE_REACHED" });
  });

  it.each([
    ["step-up", "MFA_CODE_INVALID", 401],
    ["step-up", "MFA_NOT_ENROLLED", 409],
    ["replacement", "MFA_LOCKED", 423],
    ["enrollment", "MFA_ALREADY_ENROLLED", 409],
    ["enrollment", "MFA_DISABLED", 409],
    ["replacement", "AUTH_INVALID", 401],
    ["recovery-codes", "MFA_CODE_INVALID", 401],
    ["revoke", "MFA_REQUIRED_BY_POLICY", 409],
    ["policy", "DIRECTORY_OWNER_REQUIRED", 403],
    ["policy", "DIRECTORY_MFA_REQUIRED", 409],
    ["step-up", "DIRECTORY_UNAVAILABLE", 503],
    ["step-up", "constructor", 500],
  ])("maps real directory transport errors for %s / %s", async (endpoint, code, expectedStatus) => {
    const upstreamStatus = code === "constructor" ? 500 : expectedStatus;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ code, message: "private authority detail" }), {
      status: upstreamStatus, headers: { "content-type": "application/json" },
    }));
    const client = new DirectoryClient(LOCAL_DIRECTORY_ENDPOINT, "cerp_test", Buffer.alloc(32, 0x42).toString("hex"));
    directory.call.mockImplementationOnce((operation, payload) => client.call(operation, payload));
    const body = endpoint === "step-up" ? { code: "123456" }
      : endpoint === "enrollment" ? { current_password: "isolated-password" }
      : endpoint === "policy" ? { current_password: "isolated-password", code: "123456", policy: "required_for_all" }
      : { current_password: "isolated-password", code: "123456" };
    const operation = endpoint === "policy" ? request(app()).put(`/auth/mfa/${endpoint}`) : request(app()).post(`/auth/mfa/${endpoint}`);
    const response = await operation.send(body).expect(expectedStatus);
    expect(response.body.code).toBe(code === "constructor" ? "INTERNAL_ERROR" : code);
    expect(JSON.stringify(response.body)).not.toContain("private authority detail");
    expect(directory.authenticate).not.toHaveBeenCalled();
  });
});
