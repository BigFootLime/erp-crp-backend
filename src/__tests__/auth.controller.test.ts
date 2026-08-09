import { Request, Response } from "express";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../module/auth/validators/auth.validator", () => ({
  loginSchema: { parse: vi.fn() },
  forgotPasswordSchema: { safeParse: vi.fn() },
  resetPasswordSchema: { parse: vi.fn() },
}));
vi.mock("../module/auth/services/auth.service", () => ({
  loginUser: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPasswordWithToken: vi.fn(),
}));

import { forgotPassword, login } from "../module/auth/controllers/auth.controller";
import * as mockedLoginValidator from "../module/auth/validators/auth.validator";
import * as mockedAuthService from "../module/auth/services/auth.service";

const mockedLoginParse = mockedLoginValidator.loginSchema.parse as unknown as ReturnType<typeof vi.fn>;
const mockedForgotSafeParse = mockedLoginValidator.forgotPasswordSchema.safeParse as unknown as ReturnType<typeof vi.fn>;
const mockedLoginUser = mockedAuthService.loginUser as unknown as ReturnType<typeof vi.fn>;
const mockedRequestPasswordReset = mockedAuthService.requestPasswordReset as unknown as ReturnType<typeof vi.fn>;

describe("auth.controller.ts", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: ReturnType<typeof vi.fn>;
  let statusMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn(() => ({ json: jsonMock }));
    req = { body: {}, headers: {} };
    res = { status: statusMock } as Response;
    vi.clearAllMocks();
  });

  test("login renvoie un token si les identifiants sont valides", async () => {
    mockedLoginParse.mockReturnValue({ username: "admin", password: "secret" });
    mockedLoginUser.mockResolvedValue({
      token: "fake-jwt",
      user: { id: 1, username: "admin" },
    });

    await login(req as Request, res as Response, vi.fn());

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      message: "Connexion réussie",
      token: "fake-jwt",
      user: { id: 1, username: "admin" },
    });
  });

  test("forgot-password garde le message générique quand le limiteur supprime l’action", async () => {
    vi.useFakeTimers();
    mockedForgotSafeParse.mockReturnValue({
      success: true,
      data: { usernameOrEmail: "person@example.test" },
    });
    req = {
      body: { usernameOrEmail: "person@example.test" },
      headers: {},
      authRateLimit: { suppressAction: true, reason: "blocked" },
      originalUrl: "/api/v1/auth/forgot-password",
    };

    const pending = forgotPassword(req as Request, res as Response, vi.fn());
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(mockedRequestPasswordReset).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      message: "Si ce compte existe, un lien de réinitialisation a été envoyé.",
    });
    vi.useRealTimers();
  });
});
