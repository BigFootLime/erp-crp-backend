import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomBytes: vi.fn(() => Buffer.alloc(32, 1)),
    randomUUID: vi.fn(() => "11111111-1111-1111-1111-111111111111"),
  };
});

const dbClient = {
  query: vi.fn(async () => ({ rows: [] })),
  release: vi.fn(),
};

vi.mock("../config/database", () => ({
  default: {
    connect: vi.fn(async () => dbClient),
  },
}));

vi.mock("../module/auth/repository/auth.repository", () => ({
  findUserByUsernameOrEmail: vi.fn(),
  updateUserPassword: vi.fn(),
}));

vi.mock("../module/auth/repository/password-reset.repository", () => ({
  repoCleanupExpiredPasswordResets: vi.fn(),
  repoDeleteActivePasswordResetsForUser: vi.fn(),
  repoInsertPasswordReset: vi.fn(async () => ({ id: "11111111-1111-1111-1111-111111111111" })),
  repoGetPasswordResetForUpdate: vi.fn(),
  repoMarkPasswordResetUsed: vi.fn(),
  repoDeleteOtherActivePasswordResetsForUser: vi.fn(),
}));

vi.mock("../module/auth/services/password-reset-email.service", () => ({
  sendPasswordResetEmail: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: vi.fn(async () => ({ id: "audit-1", created_at: new Date().toISOString() })),
}));

import { requestPasswordReset, resetPasswordWithToken } from "../module/auth/services/auth.service";
import { resetPasswordSchema } from "../module/auth/validators/auth.validator";

import * as authRepo from "../module/auth/repository/auth.repository";
import * as resetRepo from "../module/auth/repository/password-reset.repository";
import * as resetEmail from "../module/auth/services/password-reset-email.service";
import * as auditRepo from "../module/audit-logs/repository/audit-logs.repository";

describe("password reset service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "https://erp.example.com";
  });

  it("requestPasswordReset does nothing when user not found", async () => {
    (authRepo.findUserByUsernameOrEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await requestPasswordReset("nope@example.com", {
      ip: "127.0.0.1",
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
    });

    expect(resetRepo.repoInsertPasswordReset).not.toHaveBeenCalled();
    expect(resetEmail.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(auditRepo.repoInsertAuditLog).not.toHaveBeenCalled();
  });

  it("requestPasswordReset inserts a hashed token and sends an email", async () => {
    (authRepo.findUserByUsernameOrEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 1,
      username: "ADMIN",
      email: "admin@example.com",
      password: "hash",
    });

    await requestPasswordReset("admin@example.com", {
      ip: "127.0.0.1",
      user_agent: "ua",
      device_type: "desktop",
      os: "Linux",
      browser: "Chrome",
    });

    expect(resetRepo.repoCleanupExpiredPasswordResets).toHaveBeenCalled();
    expect(resetRepo.repoDeleteActivePasswordResetsForUser).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 1, tx: expect.any(Object) })
    );
    expect(resetRepo.repoInsertPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
        user_id: 1,
        token_hash: expect.stringMatching(/^[a-f0-9]{64}$/i),
        tx: expect.any(Object),
      })
    );

    expect(resetEmail.sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.com",
        username: "ADMIN",
        resetUrl: expect.stringMatching(/^https:\/\/erp\.example\.com\/reset-password\?token=/),
        expiresMinutes: 15,
      })
    );

    expect(auditRepo.repoInsertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 1,
        body: expect.objectContaining({
          event_type: "ACTION",
          action: "AUTH_PASSWORD_RESET_REQUESTED",
        }),
      })
    );
  });

  it("requestPasswordReset invalidates previous active tokens (multiple requests)", async () => {
    (authRepo.findUserByUsernameOrEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      username: "ADMIN",
      email: "admin@example.com",
      password: "hash",
    });

    await requestPasswordReset("admin@example.com", {
      ip: "127.0.0.1",
      user_agent: "ua",
      device_type: "desktop",
      os: "Linux",
      browser: "Chrome",
    });
    await requestPasswordReset("admin@example.com", {
      ip: "127.0.0.1",
      user_agent: "ua",
      device_type: "desktop",
      os: "Linux",
      browser: "Chrome",
    });

    expect(resetRepo.repoDeleteActivePasswordResetsForUser).toHaveBeenCalledTimes(2);
    expect(resetRepo.repoInsertPasswordReset).toHaveBeenCalledTimes(2);
  });

  it("resetPasswordWithToken throws a generic error when token invalid/expired/used", async () => {
    (resetRepo.repoGetPasswordResetForUpdate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(
      resetPasswordWithToken("bad-token", "P@ssw0rd-OK", {
        ip: "127.0.0.1",
        user_agent: null,
        device_type: null,
        os: null,
        browser: null,
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "RESET_TOKEN_INVALID",
      message: "Lien invalide ou expiré",
    });
  });

  it("resetPasswordWithToken updates password and consumes token", async () => {
    (resetRepo.repoGetPasswordResetForUpdate as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "22222222-2222-2222-2222-222222222222",
      user_id: 7,
    });

    await resetPasswordWithToken("good-token", "P@ssw0rd-OK", {
      ip: "127.0.0.1",
      user_agent: "ua",
      device_type: "desktop",
      os: "Linux",
      browser: "Chrome",
    });

    expect(authRepo.updateUserPassword).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, passwordHash: expect.any(String), tx: expect.any(Object) })
    );
    expect(resetRepo.repoMarkPasswordResetUsed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "22222222-2222-2222-2222-222222222222", tx: expect.any(Object) })
    );
    expect(resetRepo.repoDeleteOtherActivePasswordResetsForUser).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 7, keep_id: "22222222-2222-2222-2222-222222222222", tx: expect.any(Object) })
    );
    expect(auditRepo.repoInsertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 7,
        body: expect.objectContaining({ action: "AUTH_PASSWORD_RESET_COMPLETED" }),
      })
    );
  });

  it("resetPasswordSchema rejects weak passwords", () => {
    expect(() =>
      resetPasswordSchema.parse({
        token: "anything",
        newPassword: "weakpass",
      })
    ).toThrow();
  });
});
