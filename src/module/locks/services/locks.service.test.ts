import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAccessProfile: vi.fn(),
  repoAcquireLock: vi.fn(),
  repoExpireLocks: vi.fn(),
  repoGetActiveLock: vi.fn(),
  repoReleaseLock: vi.fn(),
}));

vi.mock("../../access-control/services/access-control.service", () => ({
  resolveAccessProfile: mocks.resolveAccessProfile,
}));

vi.mock("../repository/locks.repository", () => ({
  repoAcquireLock: mocks.repoAcquireLock,
  repoExpireLocks: mocks.repoExpireLocks,
  repoGetActiveLock: mocks.repoGetActiveLock,
  repoReleaseLock: mocks.repoReleaseLock,
}));

import { svcAcquireLock, svcHeartbeatLock, svcReleaseLock } from "./locks.service";

const LOCK = {
  id: "11111111-1111-4111-8111-111111111111",
  entityType: "OF",
  entityId: "42",
  lockedBy: { id: 7, name: "authorized" },
  lockedAt: "2026-08-04T14:20:00.000Z",
  expiresAt: "2026-08-04T14:30:00.000Z",
};

function profile(allowed: boolean) {
  return {
    is_superadmin: false,
    modules: [{
      module_key: "production",
      label: "Production",
      nav_page_keys: [],
      allowed,
      source: "OVERRIDE" as const,
    }],
  };
}

describe("HTTP entity-lock ACL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reveal, create, heartbeat, release, or block a lock for a denied account", async () => {
    mocks.resolveAccessProfile.mockImplementation(async (userId: number) => profile(userId === 7));
    mocks.repoAcquireLock.mockResolvedValue({ entityExists: true, acquired: true, lock: LOCK });

    for (const operation of [
      () => svcAcquireLock({ entity_type: "OF", entity_id: "42", user_id: 9 }),
      () => svcHeartbeatLock({ entity_type: "OF", entity_id: "42", user_id: 9 }),
      () => svcReleaseLock({ entity_type: "OF", entity_id: "42", user_id: 9 }),
    ]) {
      const error = await operation().catch((cause) => cause);
      expect(error).toMatchObject({ status: 403, code: "FORBIDDEN", message: "Accès interdit" });
      expect(JSON.stringify(error)).not.toContain("lockedBy");
      expect(JSON.stringify(error)).not.toContain("authorized");
    }

    expect(mocks.repoAcquireLock).not.toHaveBeenCalled();
    expect(mocks.repoGetActiveLock).not.toHaveBeenCalled();
    expect(mocks.repoReleaseLock).not.toHaveBeenCalled();

    await expect(svcAcquireLock({ entity_type: "OF", entity_id: "42", user_id: 7 }))
      .resolves.toEqual({ ok: true, lock: LOCK });
    expect(mocks.repoAcquireLock).toHaveBeenCalledOnce();
  });

  it("fails closed while authorization is unavailable and performs no lock query", async () => {
    mocks.resolveAccessProfile.mockRejectedValue(new Error("database unavailable"));

    await expect(svcAcquireLock({ entity_type: "OF", entity_id: "42", user_id: 7 }))
      .rejects.toMatchObject({ status: 503, code: "LOCK_AUTHORIZATION_UNAVAILABLE" });
    expect(mocks.repoAcquireLock).not.toHaveBeenCalled();
    expect(mocks.repoGetActiveLock).not.toHaveBeenCalled();
  });

  it("checks canonical entity existence in the repository before reporting success", async () => {
    mocks.resolveAccessProfile.mockResolvedValue(profile(true));
    mocks.repoAcquireLock.mockResolvedValue({ entityExists: false, acquired: false, lock: null });

    await expect(svcAcquireLock({ entity_type: "OF", entity_id: "42", user_id: 7 }))
      .rejects.toMatchObject({ status: 404, code: "LOCK_ENTITY_NOT_FOUND" });
    expect(mocks.repoGetActiveLock).not.toHaveBeenCalled();
  });

  it("rejects unknown entity types before resolving an owner or touching lock storage", async () => {
    await expect(svcAcquireLock({ entity_type: "SECRET_TABLE", entity_id: "42", user_id: 7 }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_LOCK_ENTITY" });
    expect(mocks.resolveAccessProfile).not.toHaveBeenCalled();
    expect(mocks.repoAcquireLock).not.toHaveBeenCalled();
  });
});
