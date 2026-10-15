import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { verifyChallenge } from "./mfa.controller";

const challengeToken = "challenge-token-directory-error-1234";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.post("/auth/mfa/verify", verifyChallenge);
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
});
