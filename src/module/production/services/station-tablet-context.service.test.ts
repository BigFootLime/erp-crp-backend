import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  directory: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock("../../../shared-directory/site-runtime", () => ({ sharedDirectoryClient: mocks.directory, validateSiteDirectoryToken: mocks.validate }));
vi.mock("../../../config/database", () => ({ default: {} }));
vi.mock("../repository/station.repository", () => ({
  repoEnsureDirectoryTabletDevice: mocks.ensure,
}));
vi.mock("../../operational-media/repository/operational-media.repository", () => ({
  findAssetIdsByStorageKeys: vi.fn(),
}));
vi.mock("../../access-control/services/access-control.service", () => ({
  isSuperadmin: vi.fn(), resolveAccessProfile: vi.fn(),
}));

import { svcTabletContext } from "./station.service";

const claims = { id: 17, directory_session: "dir_" + "a".repeat(64) };
const tabletId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Directory tablet station context", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.directory.mockReturnValue({}); });

  it("keeps local installations available without calling Directory", async () => {
    mocks.directory.mockReturnValue(null);
    await expect(svcTabletContext({ claims })).resolves.toEqual({ available: false });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("keeps the normal ERP fallback available without a tablet proof", async () => {
    mocks.validate.mockResolvedValue({ tablet_device_id: undefined });
    await expect(svcTabletContext({ claims })).resolves.toEqual({ available: false });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("materialises only the Directory-proven tablet and returns its public code", async () => {
    mocks.validate.mockResolvedValue({ tablet_device_id: tabletId });
    mocks.ensure.mockResolvedValue({ public_code: "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    await expect(svcTabletContext({ claims })).resolves.toEqual({
      available: true,
      deviceCode: "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(mocks.ensure).toHaveBeenCalledWith({ directoryTabletDeviceId: tabletId, actorUserId: 17 });
  });

  it("treats Directory validation failure as unavailable and never materialises a device", async () => {
    mocks.validate.mockRejectedValue(new Error("DIRECTORY_SESSION_REJECTED"));
    await expect(svcTabletContext({ claims })).rejects.toMatchObject({ status: 503, code: "DIRECTORY_UNAVAILABLE" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
