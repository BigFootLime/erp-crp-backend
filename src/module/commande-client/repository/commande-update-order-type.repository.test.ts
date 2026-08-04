import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));

import { repoUpdateCommande } from "./commande-client.repository";

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.query.mockReset();
  mocks.release.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
});

describe("commande order type invariant", () => {
  it("refuse le passage INTERNE vers FERME sous verrou, même sans AR", async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM commande_client") && query.includes("FOR UPDATE")) {
        return {
          rows: [{
            numero: "CI-123",
            client_id: null,
            devis_id: null,
            order_type: "INTERNE",
            adresse_facturation_id: null,
            cadre_start_date: null,
            cadre_end_date: null,
            dest_stock_magasin_id: null,
            dest_stock_emplacement_id: null,
            ar_sent_at: null,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(repoUpdateCommande("123", { order_type: "FERME" } as never, []))
      .rejects.toMatchObject({ status: 409, code: "COMMANDE_ORDER_TYPE_IMMUTABLE" });

    expect(mocks.query.mock.calls.some(([sql]) => /^\s*UPDATE commande_client/i.test(String(sql)))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => /^\s*DELETE FROM commande_ligne/i.test(String(sql)))).toBe(false);
  });
});
