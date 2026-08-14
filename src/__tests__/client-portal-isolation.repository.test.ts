import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { query: mocked.query, connect: mocked.connect },
}));

import {
  repoGetPortalDocumentDownload,
  repoListPortalInvoices,
  repoListPortalOrders,
} from "../module/client-portal/repository/client-portal.repository";

const identity = {
  accountId: "3f31d6d6-c0d4-4c90-8fc3-5057a4e10370",
  clientId: "042",
  sessionEpoch: 2,
};

describe("client portal repository tenant isolation", () => {
  beforeEach(() => mocked.query.mockReset());

  it.each([
    ["orders", repoListPortalOrders],
    ["invoices", repoListPortalInvoices],
  ] as const)("always binds the authenticated client for %s", async (_label, loader) => {
    mocked.query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    await loader(identity, 1, 20);
    expect(mocked.query).toHaveBeenCalledTimes(2);
    for (const [sql, values] of mocked.query.mock.calls) {
      expect(String(sql)).toContain("WHERE client_id=$1");
      expect(values[0]).toBe("042");
    }
  });

  it("binds both the portal account and client when resolving a download", async () => {
    mocked.query.mockResolvedValueOnce({ rows: [] });
    await expect(repoGetPortalDocumentDownload(
      identity,
      "d5ec6d7e-f2f9-42aa-b766-bf98147f42b3",
    )).resolves.toBeNull();
    const [sql, values] = mocked.query.mock.calls[0];
    expect(String(sql)).toContain("publication.client_id=$3");
    expect(values).toEqual([
      identity.accountId,
      "d5ec6d7e-f2f9-42aa-b766-bf98147f42b3",
      identity.clientId,
    ]);
  });
});

