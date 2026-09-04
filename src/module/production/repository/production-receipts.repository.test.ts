import { describe, expect, it, vi } from "vitest";

import {
  reserveProducedComponentForParentOf,
  reserveProducedQtyForCommandeLine,
} from "./production-receipts.repository";

const ids = {
  article: "11111111-1111-1111-1111-111111111111",
  location: "22222222-2222-2222-2222-222222222222",
  level: "33333333-3333-3333-3333-333333333333",
  batch: "44444444-4444-4444-4444-444444444444",
  lot: "55555555-5555-5555-5555-555555555555",
};

function transactionClient(params: { activeCommandeReservation: number; plannedBlQty: number }) {
  const query = vi.fn(async (sql: unknown, _queryParams?: unknown[]) => {
    const text = String(sql);
    if (text.includes("FROM public.commande_ligne") && text.includes("FOR UPDATE")) {
      return { rows: [{ quantite: 10, article_id: ids.article }] };
    }
    if (text.includes("source_type = 'COMMANDE_LIGNE'") && text.includes("SUM(qty_reserved)")) {
      return { rows: [{ qty_reserved: params.activeCommandeReservation }] };
    }
    if (text.includes("FROM public.bon_livraison_ligne line") && text.includes("delivery.statut <> 'CANCELLED'")) {
      return { rows: [{ qty_planned: params.plannedBlQty }] };
    }
    if (text.includes("FROM public.stock_levels") && text.includes("FOR UPDATE")) {
      return { rows: [{ qty_total: 20, qty_reserved: 0 }] };
    }
    if (text.includes("FROM public.stock_batches") && text.includes("FOR UPDATE")) {
      return { rows: [{ qty_total: 20, qty_reserved: 0 }] };
    }
    if (text.includes("FROM public.lots")) return { rows: [{ lot_code: "LOT-616", lot_status: "LIBERE", article_unit: "U" }] };
    if (text.includes("FROM public.quality_control qc")) {
      return { rows: [{ id: "99999999-9999-4999-8999-999999999999", qty_released: "20", qty_held: "0", qty_consumed: "0", unite: "U", pending: false }] };
    }
    if (text.includes("FROM public.stock_reservations") && text.includes("FOR SHARE")) return { rows: [] };
    if (text.includes("FROM public.non_conformity nc")) return { rows: [{ total: 0 }] };
    if (text.includes("FROM public.quality_release_decision")) return { rows: [] };
    if (text.includes("SELECT id::text AS id") && text.includes("stock_batch_id")) return { rows: [] };
    if (text.includes("INSERT INTO public.stock_reservations")) return { rows: [{ id: "66666666-6666-6666-6666-666666666666" }] };
    return { rows: [] };
  });
  return { query };
}

async function reserve(client: { query: ReturnType<typeof vi.fn> }, qty_ok: number) {
  return reserveProducedQtyForCommandeLine(client as never, {
    commande_ligne_id: 10,
    article_id: ids.article,
    location_id: ids.location,
    stock_level_id: ids.level,
    stock_batch_id: ids.batch,
    lot_id: ids.lot,
    qty_ok,
    actor_user_id: 7,
  });
}

describe("reserveProducedQtyForCommandeLine", () => {
  it("SHIP_AVAILABLE_NOW: excludes both the prepared BL quantity and active command reservations", async () => {
    const client = transactionClient({ activeCommandeReservation: 0, plannedBlQty: 5 });

    await expect(reserve(client, 7)).resolves.toMatchObject({ qty_reserved: 5 });

    const levelUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_levels"));
    const reservationInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"));
    expect(levelUpdate?.[1]).toEqual([ids.level, 5, 7]);
    expect(reservationInsert?.[1]).toEqual(expect.arrayContaining([5, "10"]));
    expect(String(reservationInsert?.[0])).toContain("$4::text,$4::bigint");
  });

  it("SHIP_ALL_TOGETHER: keeps the stock reservation and reserves only the production remainder", async () => {
    const client = transactionClient({ activeCommandeReservation: 5, plannedBlQty: 0 });

    await expect(reserve(client, 7)).resolves.toMatchObject({ qty_reserved: 5 });

    const levelUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_levels"));
    expect(levelUpdate?.[1]).toEqual([ids.level, 5, 7]);
  });
});

describe("reserveProducedComponentForParentOf", () => {
  it("reserves only the missing component quantity for the consuming OF", async () => {
    const requirementId = "77777777-7777-4777-8777-777777777777";
    const reservationId = "88888888-8888-4888-8888-888888888888";
    const client = {
      query: vi.fn(async (sql: unknown, _params?: unknown[]) => {
        const text = String(sql);
        if (text.includes("FROM public.of_component_requirements requirement") && text.includes("FOR UPDATE")) {
          return { rows: [{ id: requirementId, consuming_of_id: 42, component_article_id: ids.article, required_qty: 10 }] };
        }
        if (text.includes("FROM public.stock_levels") && text.includes("available_qty")) {
          return { rows: [{ available_qty: 20 }] };
        }
        if (text.includes("FROM public.stock_batches") && text.includes("available_qty")) {
          return { rows: [{ available_qty: 20 }] };
        }
        if (text.includes("sum(reservation.qty_reserved)") && !text.includes("UPDATE public.of_component_requirements")) {
          return { rows: [{ reserved_qty: 4 }] };
        }
        if (text.includes("INSERT INTO public.stock_reservations")) return { rows: [{ id: reservationId }] };
        return { rows: [] };
      }),
    };

    await expect(reserveProducedComponentForParentOf(client as never, {
      component_of_id: 84,
      article_id: ids.article,
      location_id: ids.location,
      stock_level_id: ids.level,
      stock_batch_id: ids.batch,
      lot_id: ids.lot,
      qty_ok: 8,
      actor_user_id: 7,
      quality_gate_already_held: true,
    })).resolves.toEqual({
      matched: true,
      reservation_id: reservationId,
      qty_reserved: 6,
      reservation_ids: [reservationId],
    });

    const reservationInsert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.stock_reservations"));
    const levelUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_levels"));
    const batchUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_batches"));
    expect(reservationInsert?.[1]).toEqual(expect.arrayContaining([6, requirementId, 42]));
    expect(levelUpdate?.[1]).toEqual([ids.level, 6, 7]);
    expect(batchUpdate?.[1]).toEqual([ids.batch, 6]);
  });

  it("does not turn an unrelated production receipt into a component reservation", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };

    await expect(reserveProducedComponentForParentOf(client as never, {
      component_of_id: 84,
      article_id: ids.article,
      location_id: ids.location,
      stock_level_id: ids.level,
      stock_batch_id: ids.batch,
      lot_id: ids.lot,
      qty_ok: 8,
      actor_user_id: 7,
    })).resolves.toEqual({ matched: false, reservation_id: null, qty_reserved: 0, reservation_ids: [] });
  });
});
