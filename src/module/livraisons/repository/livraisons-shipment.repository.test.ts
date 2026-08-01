import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { prepareLivraisonInTransaction } from "./livraisons-shipment.repository";
import { attachActiveCommandeReservationsToLivraison } from "./livraisons.repository";

describe("prepareLivraisonInTransaction", () => {
  it("reuses an active production reservation without reserving stock twice", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.bon_livraison\n")) {
        return {
          rows: [{
            id: "44444444-4444-4444-8444-444444444444",
            numero: "BL-00000001",
            statut: "DRAFT",
            row_version: 1,
            commande_id: "12",
            affaire_id: "7",
          }],
        };
      }
      if (sql.includes("remainder.quantite_commandee::float8")) {
        return {
          rows: [{
            id: "55555555-5555-4555-8555-555555555555",
            ordre: 1,
            quantite: 2,
            commande_ligne_id: 91,
            quantite_commandee: 2,
            quantite_expediee: 0,
            quantite_restante: 2,
          }],
        };
      }
      if (sql.includes("FROM public.bon_livraison_ligne_allocations allocation")) {
        return {
          rows: [{
            id: "66666666-6666-4666-8666-666666666666",
            bon_livraison_ligne_id: "55555555-5555-4555-8555-555555555555",
            line_order: 1,
            line_quantity: 2,
            article_id: "11111111-1111-4111-8111-111111111111",
            lot_id: "22222222-2222-4222-8222-222222222222",
            lot_article_id: "11111111-1111-4111-8111-111111111111",
            lot_status: "LIBERE",
            magasin_id: "33333333-3333-4333-8333-333333333333",
            emplacement_id: 4,
            location_id: "77777777-7777-4777-8777-777777777777",
            stock_level_id: "88888888-8888-4888-8888-888888888888",
            stock_batch_id: "99999999-9999-4999-8999-999999999999",
            reservation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            reservation_status: "ACTIVE",
            reservation_quantity: 2,
            stock_movement_line_id: null,
            quantite: 2,
            unite: "u",
            qty_on_hand: 2,
            qty_reserved: 2,
            qty_depreciated: 0,
          }],
        };
      }
      if (sql.includes("FROM public.bon_livraison_pack_versions")) return { rows: [] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;

    await expect(
      prepareLivraisonInTransaction(
        client,
        "44444444-4444-4444-8444-444444444444",
        7
      )
    ).resolves.toBeUndefined();

    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"))
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("SET qty_reserved = qty_reserved +"))
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("source_type = 'BON_LIVRAISON_LIGNE'"))
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("SET statut = 'READY'"))
    ).toBe(true);
  });
});

describe("attachActiveCommandeReservationsToLivraison", () => {
  it("transfers a produced order-line reservation to the delivery allocation", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("reservation.source_type = 'COMMANDE_LIGNE'")) {
        return {
          rows: [{
            line_id: "55555555-5555-4555-8555-555555555555",
            commande_ligne_id: 91,
            line_quantity: 2,
            affaire_id: 7,
            reservation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            reservation_quantity: 2,
            article_id: "11111111-1111-4111-8111-111111111111",
            lot_id: "22222222-2222-4222-8222-222222222222",
            location_id: "77777777-7777-4777-8777-777777777777",
            stock_level_id: "88888888-8888-4888-8888-888888888888",
            stock_batch_id: "99999999-9999-4999-8999-999999999999",
            magasin_id: "33333333-3333-4333-8333-333333333333",
            emplacement_id: 4,
            unite: "u",
          }],
        };
      }
      if (sql.includes("SELECT NOT EXISTS(")) return { rows: [{ complete: true }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;

    await expect(
      attachActiveCommandeReservationsToLivraison(
        client,
        "44444444-4444-4444-8444-444444444444",
        7
      )
    ).resolves.toEqual({ attached: 1, fullyAllocated: true });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("source_type = 'BON_LIVRAISON_LIGNE'"),
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "55555555-5555-4555-8555-555555555555",
        7,
        "44444444-4444-4444-8444-444444444444",
        7,
      ]
    );
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations"))
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE public.stock_levels"))
    ).toBe(false);
  });

  it("never allocates the same order reservation to duplicate delivery lines", async () => {
    const sharedReservation = {
      commande_ligne_id: 91,
      line_quantity: 2,
      affaire_id: 7,
      reservation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      reservation_quantity: 2,
      article_id: "11111111-1111-4111-8111-111111111111",
      lot_id: "22222222-2222-4222-8222-222222222222",
      location_id: "77777777-7777-4777-8777-777777777777",
      stock_level_id: "88888888-8888-4888-8888-888888888888",
      stock_batch_id: "99999999-9999-4999-8999-999999999999",
      magasin_id: "33333333-3333-4333-8333-333333333333",
      emplacement_id: 4,
      unite: "u",
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("reservation.source_type = 'COMMANDE_LIGNE'")) {
        return {
          rows: [
            { ...sharedReservation, line_id: "55555555-5555-4555-8555-555555555555" },
            { ...sharedReservation, line_id: "66666666-6666-4666-8666-666666666666" },
          ],
        };
      }
      if (sql.includes("SELECT NOT EXISTS(")) return { rows: [{ complete: false }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;

    await expect(
      attachActiveCommandeReservationsToLivraison(
        client,
        "44444444-4444-4444-8444-444444444444",
        7
      )
    ).resolves.toEqual({ attached: 1, fullyAllocated: false });

    const allocationInserts = query.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO public.bon_livraison_ligne_allocations")
    );
    expect(allocationInserts).toHaveLength(1);
  });
});
