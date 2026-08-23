import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { repoRoot } from "../../../__tests__/helpers/repo-paths";

vi.mock("../../../shared/realtime/realtime.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../shared/realtime/realtime.service")>(),
  enqueueEntityChanged: vi.fn().mockResolvedValue("event-livraison"),
}));
vi.mock("../../../shared/authoritative-documents/authoritative-document.service", () => ({
  queueCreationPdfArchive: vi.fn().mockResolvedValue({ id: "archive-624" }),
}));
vi.mock("../services/delivery-authoritative-document", () => ({
  buildDeliveryCreationSnapshotInput: vi.fn().mockResolvedValue({}),
  buildShippedDeliveryArtifactInput: vi.fn().mockResolvedValue({}),
}));

import {
  prepareLivraisonInTransaction,
  releaseLivraisonReservationsInTransaction,
} from "./livraisons-shipment.repository";
import {
  attachActiveCommandeReservationsToLivraison,
  repoCreateLivraisonFromCommande,
} from "./livraisons.repository";
import { withRealtimeOutboxDbMock } from "../../../__tests__/helpers/realtime-outbox-db-mock";

const shipmentRepositorySource = readFileSync(
  resolve(repoRoot, "src/module/livraisons/repository/livraisons-shipment.repository.ts"),
  "utf8"
);

describe("shipment stock movement audit contract", () => {
  it("writes the canonical stock_movement_id audit column", () => {
    expect(shipmentRepositorySource).toContain(
      "stock_movement_id, event_type, old_values, new_values, user_id, correlation_id"
    );
    expect(shipmentRepositorySource).not.toMatch(
      /INSERT INTO public\.stock_movement_event_log \(\s*movement_id,/
    );
  });

  it("keeps the delivery-line parameter UUID-typed when creating a reservation (#428)", () => {
    // PostgreSQL assigns one type to each bind parameter. Reusing $6 as both the
    // TEXT source_id and the UUID line filter fails at parse time with 42P08.
    expect(shipmentRepositorySource).toMatch(
      /'BON_LIVRAISON_LIGNE',\s*line\.id::text,\s*line\.commande_ligne_id/
    );
    expect(shipmentRepositorySource).not.toMatch(
      /'BON_LIVRAISON_LIGNE',\s*\$6,\s*line\.commande_ligne_id/
    );
  });
});

describe("internal order delivery gate", () => {
  it("creates no BL artifact before the post-quality PRET_LIVRAISON milestone", async () => {
    const query = vi.fn(withRealtimeOutboxDbMock(async (rawSql: unknown) => {
      const sql = String(rawSql);
      if (sql.includes("FROM public.commande_client cc")) {
        return {
          rows: [{
            id: 12,
            numero: "CI-12",
            client_id: null,
            order_type: "INTERNE",
            raw_statut: "PRODUCTION_TERMINEE",
          }],
        };
      }
      return { rows: [] };
    }));
    const tx = { query } as unknown as PoolClient;

    await expect(repoCreateLivraisonFromCommande(12, 7, tx)).rejects.toMatchObject({
      status: 409,
      code: "INTERNAL_DELIVERY_QUALITY_RELEASE_REQUIRED",
    });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO bon_livraison"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("bon_livraison_no_seq"))).toBe(false);
  });

  it("resolves the configured internal client and records the stock destination after quality", async () => {
    const internalClientId = "CERP-INTERNE";
    const warehouseId = "11111111-1111-4111-8111-111111111111";
    const deliveryId = "22222222-2222-4222-8222-222222222222";
    const query = vi.fn(withRealtimeOutboxDbMock(async (rawSql: unknown) => {
      const sql = String(rawSql);
      if (sql.includes("FROM public.commande_client cc")) {
        return {
          rows: [{
            id: 12,
            numero: "CI-12",
            client_id: null,
            order_type: "INTERNE",
            raw_statut: "PRET_LIVRAISON",
            dest_stock_magasin_id: warehouseId,
            dest_stock_emplacement_id: 42,
          }],
        };
      }
      if (sql.includes("commandes.internal_client_id")) return { rows: [{ value_text: internalClientId }] };
      if (sql.includes("FROM pg_attribute")) return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM commande_to_affaire") || sql.includes("FROM public.commande_to_affaire")) {
        return { rows: [{ affaire_id: 91 }] };
      }
      if (sql.includes("bon_livraison_no_seq")) return { rows: [{ n: "8" }] };
      if (sql.includes("INSERT INTO bon_livraison (")) return { rows: [{ id: deliveryId }] };
      if (sql.includes("v_bon_livraison_reliquats_226")) {
        return {
          rows: [{
            id: 501,
            designation: "Pièce interne",
            code_piece: "INT-01",
            quantite: 2,
            unite: "u",
            delai_client: null,
          }],
        };
      }
      if (sql.includes("FROM public.bon_livraison_ligne delivery_line")) return { rows: [] };
      if (sql.includes("SELECT NOT EXISTS(")) return { rows: [{ complete: false }] };
      if (sql.includes("INSERT INTO bon_livraison_event_log")) {
        return { rows: [{ id: "event-created", created_at: "2026-08-04T12:00:00.000Z" }] };
      }
      return { rows: [] };
    }));
    const tx = { query } as unknown as PoolClient;

    await expect(repoCreateLivraisonFromCommande(12, 7, tx)).resolves.toEqual({ id: deliveryId });

    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO bon_livraison ("));
    expect(insert?.[1]).toEqual([
      "BL-00000008",
      internalClientId,
      12,
      91,
      null,
      `Destination stock interne: magasin ${warehouseId}, emplacement 42`,
      7,
    ]);
    const event = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO bon_livraison_event_log"));
    expect(String(event?.[1]?.[3])).toContain(`\"magasin_id\":\"${warehouseId}\"`);
    expect(String(event?.[1]?.[3])).toContain("\"emplacement_id\":42");
  });
});

describe("prepareLivraisonInTransaction", () => {
  it("reuses an active production reservation without reserving stock twice", async () => {
    const query = vi.fn(withRealtimeOutboxDbMock(async (rawSql: unknown) => {
      const sql = String(rawSql);
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
      if (sql.includes("INSERT INTO public.bon_livraison_event_log")) {
        return { rows: [{ id: "event-ready", created_at: "2026-08-04T12:00:00.000Z" }] };
      }
      return { rows: [] };
    }));
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

describe("releaseLivraisonReservationsInTransaction", () => {
  it("libère toutes les réservations ACTIVE liées au BL et décrémente les quantités agrégées", async () => {
    const stockLevelId = "88888888-8888-4888-8888-888888888888";
    const stockBatchId = "99999999-9999-4999-8999-999999999999";
    const lotId = "22222222-2222-4222-8222-222222222222";
    const reservationIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.bon_livraison_ligne_allocations allocation")) {
        return {
          rows: reservationIds.map((id, index) => ({
            id,
            stock_level_id: stockLevelId,
            stock_batch_id: stockBatchId,
            qty_reserved: index === 0 ? 1.25 : 0.75,
          })),
        };
      }
      if (sql.includes("FROM public.stock_levels")) {
        return { rows: [{ qty_total: 10, qty_reserved: 4, qty_depreciated: 0 }] };
      }
      if (sql.includes("FROM public.stock_batches")) {
        return {
          rows: [{
            stock_level_id: stockLevelId,
            lot_id: lotId,
            qty_total: 10,
            qty_reserved: 4,
            qty_depreciated: 0,
          }],
        };
      }
      if (sql.includes("FROM public.lots")) return { rows: [{ lot_status: "LIBERE" }] };
      return { rows: [], rowCount: 2 };
    });
    const client = { query } as unknown as PoolClient;

    await expect(
      releaseLivraisonReservationsInTransaction(
        client,
        "44444444-4444-4444-8444-444444444444",
        7,
        "BL annulé"
      )
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET qty_reserved = qty_reserved - $2"),
      [stockLevelId, 2, 7]
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE public.stock_batches SET qty_reserved = qty_reserved - $2"),
      [stockBatchId, 2]
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'RELEASED'"),
      [reservationIds, "BL annulé", 7]
    );
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
      query.mock.calls.some(([sql]) => String(sql).includes("source_id = $2::text"))
    ).toBe(true);
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
