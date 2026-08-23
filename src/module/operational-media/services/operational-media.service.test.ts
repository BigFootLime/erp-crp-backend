import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), profile: vi.fn(), ownerExists: vi.fn(), storage: vi.fn() }));

vi.mock("../repository/operational-media.repository", () => ({
  findOperationalMediaAssets: mocks.find,
  operationalMediaOwnerExists: mocks.ownerExists,
}));
vi.mock("../../access-control/services/access-control.service", () => ({ resolveAccessProfile: mocks.profile }));
vi.mock("./operational-media-health.service", () => ({ checkOperationalMediaStorage: mocks.storage }));

import { authorizeOperationalMediaRead } from "./operational-media.service";

const assetId = "4a99e772-4496-4c0d-a5a2-2b82c1f8c5c1";

afterEach(() => {
  vi.resetAllMocks();
  mocks.storage.mockResolvedValue({ ready: true, readable: true, writable: true, reason: null });
});

const activeMachine = (overrides: Record<string, unknown> = {}) => ({
  id: assetId,
  storage_key: "machines/a.png",
  mime_type: "image/png",
  sha256: "a".repeat(64),
  status: "ACTIVE" as const,
  owner_type: "machine",
  owner_id: "m-1",
  module_key: "production",
  ...overrides,
});

function allow(module_key = "production") {
  return { is_superadmin: false, modules: [{ module_key, allowed: true }] };
}

describe("operational media authorization", () => {
  it("does not query storage for a malformed opaque id", async () => {
    await expect(authorizeOperationalMediaRead({ assetId: "../images/secret.png", userId: 7 }))
      .rejects.toMatchObject({ status: 404, code: "MEDIA_NOT_FOUND" });
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("returns the same non-disclosing response for an out-of-scope asset", async () => {
    mocks.find.mockResolvedValue([activeMachine()]);
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: "production", allowed: false }] });
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 }))
      .rejects.toMatchObject({ status: 404, code: "MEDIA_NOT_FOUND" });
  });

  it("rechecks current module access and never exposes the storage key in its public identity", async () => {
    mocks.find.mockResolvedValue([activeMachine()]);
    mocks.profile.mockResolvedValue(allow());
    mocks.ownerExists.mockResolvedValue(true);
    const result = await authorizeOperationalMediaRead({ assetId, userId: 7 });
    expect(result.asset.id).toBe(assetId);
    expect(result.filePath).toMatch(/[\\/]generated[\\/]images[\\/]machines[\\/]a\.png$/);
  });

  it("rejects stale revoked and quarantined assets after authorization", async () => {
    mocks.profile.mockResolvedValue({ is_superadmin: true, modules: [] });
    mocks.find.mockResolvedValue([activeMachine({ status: "REVOKED", mime_type: null, sha256: null })]);
    mocks.ownerExists.mockResolvedValue(true);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).rejects.toMatchObject({ status: 410, code: "MEDIA_REVOKED" });
    mocks.find.mockResolvedValue([activeMachine({ status: "QUARANTINED", mime_type: null, sha256: null })]);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).rejects.toMatchObject({ status: 423, code: "MEDIA_QUARANTINED" });
  });

  it("fails closed when access infrastructure is unavailable, even if shared request context is granted", async () => {
    mocks.find.mockResolvedValue([activeMachine()]);
    mocks.profile.mockResolvedValue(null);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 }))
      .rejects.toMatchObject({ status: 404, code: "MEDIA_NOT_FOUND" });
    expect(mocks.ownerExists).not.toHaveBeenCalled();
  });

  it("allows a different owner in the same allowed module by the existing module-wide policy", async () => {
    mocks.find.mockResolvedValue([activeMachine({ owner_id: "another-machine" })]);
    mocks.profile.mockResolvedValue(allow("production"));
    mocks.ownerExists.mockResolvedValue(true);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).resolves.toMatchObject({ asset: { owner_id: "another-machine" } });
  });

  it("authorizes a supplier logo only through the fournisseurs module and a live supplier owner", async () => {
    mocks.find.mockResolvedValue([activeMachine({ owner_type: "fournisseur", owner_id: "11111111-1111-4111-8111-111111111111", module_key: "fournisseurs" })]);
    mocks.profile.mockResolvedValue(allow("fournisseurs"));
    mocks.ownerExists.mockResolvedValue(true);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).resolves.toMatchObject({ asset: { owner_type: "fournisseur", module_key: "fournisseurs" } });
    expect(mocks.ownerExists).toHaveBeenCalledWith("fournisseur", "11111111-1111-4111-8111-111111111111");
  });

  it("denies a cross-module asset despite another allowed module", async () => {
    mocks.find.mockResolvedValue([activeMachine({ module_key: "outillage", owner_type: "outil", owner_id: "41" })]);
    mocks.profile.mockResolvedValue(allow("production"));
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 }))
      .rejects.toMatchObject({ status: 404, code: "MEDIA_NOT_FOUND" });
    expect(mocks.ownerExists).not.toHaveBeenCalled();
  });

  it("fails closed for unknown owner types, binding-module mismatches, and orphaned parents", async () => {
    mocks.profile.mockResolvedValue(allow());
    mocks.find.mockResolvedValue([activeMachine({ owner_type: "unknown" })]);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).rejects.toMatchObject({ status: 404 });
    mocks.find.mockResolvedValue([activeMachine({ module_key: "outillage" })]);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).rejects.toMatchObject({ status: 404 });
    mocks.find.mockResolvedValue([activeMachine()]);
    mocks.ownerExists.mockResolvedValue(false);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).rejects.toMatchObject({ status: 404 });
  });

  it("checks every reused binding independently and audits/returns the passing binding", async () => {
    const client = activeMachine({ owner_type: "client", owner_id: "client-1", module_key: "clients" });
    const tool = activeMachine({ owner_type: "outil", owner_id: "24", module_key: "outillage" });
    mocks.find.mockResolvedValue([client, tool]);
    mocks.profile.mockResolvedValue(allow("outillage"));
    mocks.ownerExists.mockResolvedValue(true);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).resolves.toMatchObject({ asset: { owner_type: "outil", owner_id: "24" } });
    expect(mocks.ownerExists).toHaveBeenCalledTimes(1);
    expect(mocks.ownerExists).toHaveBeenCalledWith("outil", "24");
  });

  it("permits a superadmin only after the parent binding itself exists", async () => {
    mocks.find.mockResolvedValue([activeMachine({ owner_type: "outil_fabricant", owner_id: "3", module_key: "outillage" })]);
    mocks.profile.mockResolvedValue({ is_superadmin: true, modules: [] });
    mocks.ownerExists.mockResolvedValue(true);
    await expect(authorizeOperationalMediaRead({ assetId, userId: 7 })).resolves.toMatchObject({ asset: { owner_type: "outil_fabricant" } });
  });
});
