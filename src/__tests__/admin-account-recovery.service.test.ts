import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(), replay: vi.fn(), invalidate: vi.fn(), insert: vi.fn(), commit: vi.fn(),
  password: vi.fn(), reset: vi.fn(), audit: vi.fn(), revoke: vi.fn(),
}));
vi.mock("../config/database", () => ({ default: { connect: vi.fn(async () => ({})) } }));
vi.mock("../shared/realtime/realtime-outbox-transaction", () => ({
  withRealtimeOutboxTransaction: vi.fn(async (tx, run) => run(tx)),
}));
vi.mock("../module/admin/repository/account-recovery.repository", () => ({
  lockRecoveryAccounts: mocks.lock, findRecoveryReplay: mocks.replay,
  invalidateAccountRecoveryCredentials: mocks.invalidate, insertAccountRecovery: mocks.insert, findRecoveryCommitHash: mocks.commit,
}));
vi.mock("../module/auth/repository/auth.repository", () => ({ updateUserPassword: mocks.password }));
vi.mock("../module/auth/repository/password-reset.repository", () => ({ repoInsertPasswordReset: mocks.reset }));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("../sockets/sockeServer", () => ({ revokeUserRealtimeSessions: mocks.revoke }));

import { recoverAccountBySuperadmin, type AccountRecoveryInput } from "../module/admin/services/account-recovery.service";
import { resetPasswordSchema } from "../module/auth/validators/auth.validator";

const input: AccountRecoveryInput = {
  userId: 22, actorUserId: 11, actorSessionEpoch: 3, actorFactorId: "actor-factor", actorFactorVersion: 2,
  idempotencyKey: "2649701f-9e95-4b57-9faf-0c21e90ea66d", reason: "Application perdue, identité vérifiée en personne.",
  meta: { ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/api/v1/admin/users/22/account-recovery" },
};
const actor = { id: 11, status: "Active", is_superadmin: true, session_epoch: 3, factor_id: "actor-factor", factor_version: 2 };
const target = { id: 22, status: "Active", is_superadmin: false, session_epoch: 6, factor_id: "old-factor", factor_version: 1 };

describe("administrative account recovery", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("JWT_SECRET", "test-only-administrative-account-recovery-key");
    mocks.lock.mockResolvedValue([actor,target]);
    mocks.replay.mockResolvedValue(null);
    mocks.invalidate.mockResolvedValue(2);
    mocks.insert.mockImplementation(async (_tx,row) => ({ ...row, superseded_at: null, completed_at: null, reset_usable: true }));
    mocks.revoke.mockResolvedValue(undefined);
  });

  it.each([
    { ...actor, is_superadmin: false }, { ...actor, status: "Inactive" },
    { ...actor, session_epoch: 4 }, { ...actor, factor_version: 3 }, { ...actor, factor_id: null },
  ])("rejects an unauthorized or revoked administrator before changing the target", async stale => {
    mocks.lock.mockResolvedValue([stale,target]);
    await expect(recoverAccountBySuperadmin(input)).rejects.toMatchObject({ status: 403, code: "RECOVERY_SUPERADMIN_REQUIRED" });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
  });

  it("refuses self recovery and does not reactivate a disabled target", async () => {
    await expect(recoverAccountBySuperadmin({ ...input,userId: input.actorUserId })).rejects.toMatchObject({ code: "SELF_RECOVERY_FORBIDDEN" });
    expect(mocks.lock).not.toHaveBeenCalled();
    mocks.lock.mockResolvedValue([actor,{ ...target,status: "Blocked" }]);
    await expect(recoverAccountBySuperadmin(input)).rejects.toMatchObject({ code: "RECOVERY_ACCOUNT_NOT_ACTIVE" });
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("issues a bounded reset-compatible link, stores only its hash and replays without a second reset", async () => {
    const first = await recoverAccountBySuperadmin(input);
    const token = new URL(first.reset_path!, "https://cerp.example.test").searchParams.get("token")!;
    expect(token.length).toBeLessThanOrEqual(256);
    expect(resetPasswordSchema.safeParse({ token,newPassword: "SecurityRecipeOnly!938" }).success).toBe(true);
    expect(mocks.reset).toHaveBeenCalledWith(expect.objectContaining({ token_hash: crypto.createHash("sha256").update(token).digest("hex") }));
    expect(JSON.stringify(mocks.insert.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(token);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
      details: expect.objectContaining({ mfa_reenrollment_required: true,password_invalidated: true,identity_confirmed: true }),
    }) }));
    const row = { ...mocks.insert.mock.calls[0][1],superseded_at: null,completed_at: null,reset_usable: true };
    mocks.replay.mockResolvedValue(row);
    const replay = await recoverAccountBySuperadmin(input);
    expect(replay.reset_path).toBe(first.reset_path);
    expect(replay.replayed).toBe(true);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.password).toHaveBeenCalledTimes(1);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    await expect(recoverAccountBySuperadmin({ ...input,reason: "Un autre motif avec une même clé déjà utilisée." })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it("never rediscloses a used, expired or superseded reset link", async () => {
    await recoverAccountBySuperadmin(input);
    const base = mocks.insert.mock.calls[0][1];
    for (const state of [{ reset_usable: false }, { expires_at: new Date(0) }, { superseded_at: new Date() }, { completed_at: new Date() }]) {
      mocks.replay.mockResolvedValue({ ...base,reset_usable: true,superseded_at: null,completed_at: null,...state });
      expect((await recoverAccountBySuperadmin(input)).reset_path).toBeNull();
    }
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });
});
