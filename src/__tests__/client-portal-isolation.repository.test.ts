import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { query: mocked.query, connect: mocked.connect },
}));

import {
  repoCreatePortalAccount,
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
  beforeEach(() => {
    mocked.query.mockReset();
    mocked.connect.mockReset();
  });

  it("keeps a missing client as a 404 under the insert-only receipt grant", async () => {
    const transaction = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [] }) // receipt lookup
        .mockResolvedValueOnce({ rows: [] }) // client lookup
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    mocked.connect.mockResolvedValueOnce(transaction);

    await expect(repoCreatePortalAccount({
      actorId: 1,
      idempotencyKey: "d5ec6d7e-f2f9-42aa-b766-bf98147f42b3",
      requestHash: "a".repeat(64),
      clientId: "997",
      email: "portal@example.test",
      emailNormalized: "portal@example.test",
      displayName: "Portail test",
      passwordHash: "x".repeat(60),
      meta: { requestId: "request-1", ipHash: null, userAgentFamily: null },
    })).rejects.toMatchObject({
      status: 404,
      code: "CLIENT_PORTAL_CLIENT_NOT_FOUND",
    });

    const queries = transaction.query.mock.calls.map(([sql]) => String(sql));
    expect(queries[1]).toContain("pg_advisory_xact_lock");
    expect(queries[2]).not.toContain("FOR SHARE");
    expect(queries[2]).toContain("client_portal_command_receipts");
  });

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

