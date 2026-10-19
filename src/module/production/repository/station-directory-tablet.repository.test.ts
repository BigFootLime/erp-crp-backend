import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect, query: mocks.query } }));

import { repoEnsureDirectoryTabletDevice } from "./station.repository";

const tabletId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const publicCode = `T${tabletId.replace(/-/g, "").slice(0, 31).toUpperCase()}`;

describe("Directory tablet station registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it("refuses a pre-existing local row whose deterministic code does not match the Directory UUID", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: tabletId, status: "ACTIVE", public_code: "TAB-LEGACY" }] })
      .mockResolvedValue({ rows: [] });

    await expect(repoEnsureDirectoryTabletDevice({ directoryTabletDeviceId: tabletId, actorUserId: 7 }))
      .rejects.toMatchObject({ status: 409, code: "STATION_DEVICE_MAPPING_CONFLICT" });
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("returns a service-unavailable error when the station database cannot be reached", async () => {
    mocks.connect.mockRejectedValue(new Error("connection refused"));
    await expect(repoEnsureDirectoryTabletDevice({ directoryTabletDeviceId: tabletId, actorUserId: 7 }))
      .rejects.toMatchObject({ status: 503, code: "STATION_DEVICE_UNAVAILABLE" });
  });

  it("uses a neutral shared-tablet label and never writes a secret", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: tabletId }] })
      .mockResolvedValueOnce({ rows: [{ id: tabletId, status: "ACTIVE", public_code: publicCode }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repoEnsureDirectoryTabletDevice({ directoryTabletDeviceId: tabletId, actorUserId: 7 })).rejects.toMatchObject({ status: 503 });
    const insert = mocks.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO public.production_devices"));
    expect(insert?.[1]).toEqual([tabletId, publicCode, "Tablette partagée AAAAAA", 7]);
    expect(String(insert?.[0])).not.toContain("secret");
  });
});
