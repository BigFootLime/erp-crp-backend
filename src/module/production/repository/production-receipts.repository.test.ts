import { describe, expect, it, vi } from "vitest";

import { reserveProducedQtyForCommandeLine } from "./production-receipts.repository";

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
  });

  it("SHIP_ALL_TOGETHER: keeps the stock reservation and reserves only the production remainder", async () => {
    const client = transactionClient({ activeCommandeReservation: 5, plannedBlQty: 0 });

    await expect(reserve(client, 7)).resolves.toMatchObject({ qty_reserved: 5 });

    const levelUpdate = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE public.stock_levels"));
    expect(levelUpdate?.[1]).toEqual([ids.level, 5, 7]);
  });
});
