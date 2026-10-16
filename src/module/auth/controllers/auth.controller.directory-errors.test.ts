import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const directory = vi.hoisted(() => ({
  call: vi.fn(),
  authenticate: vi.fn(),
}));

const loginSchema = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock("../../../config/database", () => ({ default: {} }));
vi.mock("../../../shared-directory/site-runtime", () => ({
  sharedDirectoryClient: () => ({ call: directory.call }),
  directoryAuthenticationResult: directory.authenticate,
}));
vi.mock("../validators/auth.validator", () => ({
  loginSchema,
  forgotPasswordSchema: { safeParse: vi.fn() },
  resetPasswordSchema: { parse: vi.fn() },
  activateAccountSchema: { parse: vi.fn() },
}));
vi.mock("../services/auth.service", () => ({
  activateAccountWithInvitation: vi.fn(),
  loginUser: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPasswordWithToken: vi.fn(),
}));

import { errorHandler } from "../../../middlewares/errorHandler";
import { login } from "./auth.controller";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.post("/auth/login", login);
  instance.use(errorHandler);
  return instance;
}

function directoryFailure(code: string, status?: number): Error & { code: string; status?: number } {
  return Object.assign(new Error("private directory failure"), { code, ...(status === undefined ? {} : { status }) });
}

describe("Directory login through the production HTTP error handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loginSchema.parse.mockReturnValue({ username: "fixture-user", password: "fixture-password" });
  });

  it("returns the constant 401 rejection for invalid credentials", async () => {
    directory.call.mockRejectedValueOnce(directoryFailure("AUTH_INVALID", 401));

    const response = await request(app()).post("/auth/login").send({ username: "fixture-user", password: "fixture-password" }).expect(401);

    expect(response.body).toEqual({
      success: false,
      code: "AUTH_INVALID",
      message: "Identifiants invalides",
      path: "/auth/login",
    });
    expect(response.body.message).not.toContain("private directory failure");
  });

  it.each([
    ["DIRECTORY_UNAVAILABLE", 503],
    ["DIRECTORY_SIGNATURE_INVALID", 401],
    ["DIRECTORY_AUTH_RESPONSE_INVALID", undefined],
  ])("returns a constant 503 for unavailable or unsafe Directory failure %s", async (code, status) => {
    directory.call.mockRejectedValueOnce(directoryFailure(code, status));

    const response = await request(app()).post("/auth/login").send({ username: "fixture-user", password: "fixture-password" }).expect(503);

    expect(response.body).toEqual({
      success: false,
      code: "DIRECTORY_UNAVAILABLE",
      message: "Erreur serveur.",
      path: "/auth/login",
    });
  });

  it("preserves a constant 429 response from the Directory limiter", async () => {
    directory.call.mockRejectedValueOnce(directoryFailure("DIRECTORY_UNAVAILABLE", 429));

    const response = await request(app()).post("/auth/login").send({ username: "fixture-user", password: "fixture-password" }).expect(429);

    expect(response.body).toEqual({
      success: false,
      code: "TOO_MANY_ATTEMPTS",
      message: "Trop de tentatives. Réessayez plus tard.",
      path: "/auth/login",
    });
  });

  it("keeps the successful Directory MFA challenge unchanged", async () => {
    const challenge = { status: "mfa_required", challenge_token: "fixture-challenge" };
    directory.call.mockResolvedValueOnce(challenge);
    directory.authenticate.mockResolvedValueOnce(challenge);

    const response = await request(app()).post("/auth/login").send({ username: "fixture-user", password: "fixture-password" }).expect(200);

    expect(response.body).toEqual({ message: "Connexion réussie", ...challenge });
    expect(directory.call).toHaveBeenCalledWith("login", expect.objectContaining({
      input: { username: "fixture-user", password: "fixture-password" },
    }));
  });
});
