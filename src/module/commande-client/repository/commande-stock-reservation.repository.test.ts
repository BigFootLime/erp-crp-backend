import { describe, expect, it, vi } from "vitest";

import {
  reserveCommandeStockForLaterDelivery,
  reuseRecoveredCommandeStockReservations,
  type CommandeStockAnalysisLine,
} from "./commande-client.repository";

const ids = {
  article: "11111111-1111-1111-1111-111111111111",
  location: "22222222-2222-2222-2222-222222222222",
  level: "33333333-3333-3333-3333-333333333333",
  lot: "44444444-4444-4444-8444-444444444444",
  magasin: "55555555-5555-5555-8555-555555555555",
};

const line: CommandeStockAnalysisLine = {
  commande_ligne_id: 1,
  code_piece: "P-1",
  article_id: ids.article,
  article_code: "ART-1",
  article_designation: "Article test",
  piece_technique_id: null,
  piece_code: null,
  piece_designation: null,
  requested_qty: 10,
  old_available_qty: 4,
  old_used_qty: 4,
  new_available_qty: 0,
  new_used_qty: 0,
  available_qty: 4,
  available_used_qty: 4,
  shortage_qty: 6,
  proposed_production_qty: 6,
  status: "PARTIAL",
};

describe("reserveCommandeStockForLaterDelivery", () => {
  it("reserves exactly the four OLD/NEW units for SHIP_ALL_TOGETHER without creating a BL", async () => {
    const query = vi.fn(async (sql: unknown, _params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("FROM public.v_stock_availability_225 availability")) {
        return {
          rows: [{
            article_id: ids.article,
            stock_scope: "OLD",
            stock_level_id: ids.level,
            stock_batch_id: null,
            location_id: ids.location,
            lot_id: ids.lot,
            magasin_id: ids.magasin,
            emplacement_id: 1,
            qty_available: 4,
          }],
        };
      }
      if (text.includes("FROM public.stock_levels") && text.includes("FOR UPDATE")) {
        return { rows: [{ qty_total: 4, qty_reserved: 0, qty_depreciated: 0 }] };
      }
      if (text.includes("FROM public.lots")) return { rows: [{ lot_code: "LOT-OLD", lot_status: "LIBERE", article_unit: "U" }] };
      if (text.includes("FROM public.quality_control qc")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999999", qty_released: "4", qty_held: "0", qty_consumed: "0", unite: "U", pending: false }] };
      }
      if (text.includes("FROM public.stock_reservations") && text.includes("FOR SHARE")) return { rows: [] };
      if (text.includes("FROM public.non_conformity nc")) return { rows: [{ total: 0 }] };
      if (text.includes("FROM public.quality_release_decision")) return { rows: [] };
      if (text.includes("INSERT INTO public.stock_reservations")) {
        return { rows: [{ id: "66666666-6666-6666-8666-666666666666" }] };
      }
      return { rows: [] };
    });

    await expect(
      reserveCommandeStockForLaterDelivery({ query } as never, {
        commande_id: 123,
        livraison_affaire_id: 7,
        user_id: 9,
        analysis_lines: [line],
        quantities_by_line: new Map([[1, 4]]),
      })
    ).resolves.toEqual(["66666666-6666-6666-8666-666666666666"]);

    const levelUpdate = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_levels"));
    const reservationInsert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"));
    expect(levelUpdate?.[1]).toEqual([ids.level, 4, 9]);
    expect(reservationInsert?.[1]).toEqual(expect.arrayContaining([ids.article, ids.location, 4, "1", 7, ids.lot]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM public.quality_control qc"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO bon_livraison"))).toBe(false);
  });

  it("keeps the Quality gate mandatory for Base NEW allocations", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("FROM public.v_stock_availability_225 availability")) {
        return {
          rows: [{
            article_id: ids.article,
            stock_scope: "NEW",
            stock_level_id: ids.level,
            stock_batch_id: null,
            location_id: ids.location,
            lot_id: ids.lot,
            magasin_id: ids.magasin,
            emplacement_id: 1,
            qty_available: 4,
          }],
        };
      }
      if (text.includes("FROM public.lots")) {
        return { rows: [{ lot_code: "LOT-NEW", lot_status: "LIBERE", article_unit: "U" }] };
      }
      if (text.includes("FROM public.quality_control qc")) return { rows: [] };
      if (text.includes("FROM public.stock_reservations") && text.includes("FOR SHARE")) return { rows: [] };
      if (text.includes("FROM public.non_conformity nc")) return { rows: [{ total: 0 }] };
      if (text.includes("FROM public.quality_release_decision")) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      reserveCommandeStockForLaterDelivery({ query } as never, {
        commande_id: 123,
        livraison_affaire_id: 7,
        user_id: 9,
        analysis_lines: [{ ...line, old_used_qty: 0, new_available_qty: 4, new_used_qty: 4 }],
        quantities_by_line: new Map([[1, 4]]),
      })
    ).rejects.toMatchObject({ code: "QUALITY_NOT_ELIGIBLE", status: 409 });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.stock_levels"))).toBe(false);
  });
});

describe("reuseRecoveredCommandeStockReservations", () => {
  it("reuses an exact locked coverage for the whole command", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { id: "77777777-7777-4777-8777-777777777777", commande_ligne_id: 1, qty_reserved: 4 },
      ],
    });

    await expect(
      reuseRecoveredCommandeStockReservations({ query } as never, {
        commande_id: 123,
        quantities_by_line: new Map([[1, 4]]),
      })
    ).resolves.toEqual(["77777777-7777-4777-8777-777777777777"]);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("JOIN public.commande_ligne line"),
      [123]
    );
    expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE");
  });

  it("rejects an unexpected reservation instead of silently keeping excess stock reserved", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { id: "77777777-7777-4777-8777-777777777777", commande_ligne_id: 1, qty_reserved: 4 },
        { id: "88888888-8888-4888-8888-888888888888", commande_ligne_id: 2, qty_reserved: 1 },
      ],
    });

    await expect(
      reuseRecoveredCommandeStockReservations({ query } as never, {
        commande_id: 123,
        quantities_by_line: new Map([[1, 4]]),
      })
    ).rejects.toMatchObject({ code: "RECOVERED_RESERVATION_COVERAGE_MISMATCH", status: 409 });
  });

  it("accepts an empty expected coverage only when the command has no active reservation", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      reuseRecoveredCommandeStockReservations({ query } as never, {
        commande_id: 123,
        quantities_by_line: new Map(),
      })
    ).resolves.toEqual([]);
  });
});
