import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("../repository/admin.repository", () => ({
  repoResetUserPasswordWithToken: mocks.reset,
}));

vi.mock("../../../sockets/sockeServer", () => ({
  revokeUserRealtimeSessions: mocks.revoke,
}));

import { resetUserPasswordByAdmin } from "./admin.service";

describe("admin password reset service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokes local sessions only after the durable reset resolves and keeps fan-out best-effort", async () => {
    let proveCommit!: () => void;
    const commitProof = new Promise<number>((resolve) => { proveCommit = () => resolve(7); });
    mocks.reset.mockReturnValueOnce(commitProof);
    mocks.revoke.mockRejectedValueOnce(new Error("socket runtime unavailable"));

    const pending = resetUserPasswordByAdmin({
      userId: "7",
      token: "one-use-admin-token",
      newPassword: "S3cure-password!",
    });
    await Promise.resolve();
    expect(mocks.revoke).not.toHaveBeenCalled();

    proveCommit();
    await expect(pending).resolves.toBeUndefined();
    expect(mocks.reset).toHaveBeenCalledWith(expect.objectContaining({
      userId: "7",
      rawToken: "one-use-admin-token",
      passwordHash: expect.any(String),
    }));
    expect(mocks.revoke).toHaveBeenCalledWith(7, { durable: false });
  });
});
