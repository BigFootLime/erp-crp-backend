import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: vi.fn() },
}));

import { repoCreateFacture, repoUpdateFacture } from "./factures.repository";

beforeEach(() => {
  mocks.connect.mockReset();
  mocks.query.mockReset();
  mocks.release.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
});

describe("legacy invoices cannot target internal orders", () => {
  it("refuse la création avant séquence et INSERT", async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM public.commande_client")) return { rows: [{ order_type: "INTERNE" }] };
      return { rows: [] };
    });

    await expect(repoCreateFacture({
      client_id: "C01",
      commande_id: 123,
      statut: "DRAFT",
      remise_globale: 0,
      lignes: [{ designation: "Pièce", quantite: 1, prix_unitaire_ht: 10, remise_ligne: 0, taux_tva: 20 }],
    })).rejects.toMatchObject({ status: 409, code: "INTERNAL_ORDER_NOT_BILLABLE" });

    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("nextval('public.facture_id_seq')"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO facture"))).toBe(false);
  });

  it("verrouille d'abord la facture puis refuse le PATCH vers une commande interne avant toute modification", async () => {
    mocks.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM facture") && String(sql).includes("FOR UPDATE")) {
        return { rows: [{ id: "41", remise_globale: 0, statut: "DRAFT", commande_id: null }] };
      }
      if (String(sql).includes("FROM public.commande_client")) return { rows: [{ order_type: "INTERNE" }] };
      return { rows: [] };
    });

    await expect(repoUpdateFacture(41, { commande_id: 123 }))
      .rejects.toMatchObject({ status: 409, code: "INTERNAL_ORDER_NOT_BILLABLE" });

    const invoiceLockIndex = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("FROM facture") && String(sql).includes("FOR UPDATE")
    );
    const commandLockIndex = mocks.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("FROM public.commande_client") && String(sql).includes("FOR SHARE")
    );
    expect(invoiceLockIndex).toBeGreaterThanOrEqual(0);
    expect(commandLockIndex).toBeGreaterThan(invoiceLockIndex);
    expect(mocks.query.mock.calls.some(([sql]) => /^\s*UPDATE facture/i.test(String(sql)))).toBe(false);
  });
});
