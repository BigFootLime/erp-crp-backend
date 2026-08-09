import { beforeEach, describe, expect, it, vi } from "vitest";

const { hashPassword, repoProvisionUser } = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  repoProvisionUser: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  default: { hash: hashPassword },
}));

vi.mock("../module/admin/repository/admin.repository", () => ({
  repoProvisionUser,
}));

import {
  buildProvisioningRequestHash,
  createUserByAdmin,
} from "../module/admin/services/admin.service";

const body = {
  username: "COMPTE.INTERNE",
  password: "Initial1!Password",
  name: "Compte",
  surname: "Interne",
  email: "compte.interne@example.test",
  role: "Employee" as const,
  roles: ["Employee"] as ["Employee"],
  country: "France",
  status: "Inactive" as const,
};

describe("administrative user provisioning service", () => {
  beforeEach(() => {
    hashPassword.mockReset().mockResolvedValue("bcrypt-hash");
    repoProvisionUser.mockReset().mockResolvedValue({
      user: { id: 42, status: "Inactive" },
      replayed: false,
    });
  });

  it("never forwards the clear-text password to the repository", async () => {
    await createUserByAdmin({
      ...body,
      actorUserId: 7,
      idempotencyKey: "7eb84d7e-9df1-4ee7-a8e9-3ee6c85b2bee",
    });

    expect(hashPassword).toHaveBeenCalledWith(body.password, 12);
    expect(repoProvisionUser).toHaveBeenCalledOnce();
    const persisted = repoProvisionUser.mock.calls[0]?.[0];
    expect(persisted).not.toHaveProperty("password");
    expect(persisted).toMatchObject({
      passwordHash: "bcrypt-hash",
      actorUserId: 7,
      status: "Inactive",
    });
  });

  it("uses a deterministic non-secret request fingerprint", () => {
    const first = buildProvisioningRequestHash(body);
    const sameAccountWithAnotherInitialPassword = buildProvisioningRequestHash({
      ...body,
      password: "Another2!Password",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(sameAccountWithAnotherInitialPassword).toBe(first);
    expect(first).not.toContain(body.password);
  });
});
