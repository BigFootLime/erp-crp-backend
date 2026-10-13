import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  read: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../../config/database", () => ({
  default: { query: mocks.read, connect: mocks.connect },
}));
vi.mock("../../../shared/realtime/realtime-outbox-transaction", () => ({
  withRealtimeOutboxTransaction: async (
    tx: unknown,
    run: (client: unknown) => unknown,
  ) => run(tx),
}));
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({
  enqueueEntityChanged: vi.fn(),
}));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: vi.fn(),
}));
vi.mock("../../stock/repository/stock-lane-routing.repository", () => ({
  lockStockLaneTopology: vi.fn(),
}));
vi.mock("../../stock/repository/material-bar-posting.repository", () => ({
  lockMaterialBarPostingScopeTx: vi.fn().mockResolvedValue(null),
  prepareMaterialBarPostingTx: vi.fn().mockResolvedValue(null),
  applyMaterialBarPostingTx: vi.fn(),
}));
vi.mock("../../receptions/repository/receipt-disposition.repository", () => ({
  recordPreStockReceiptDisposition: vi.fn().mockResolvedValue(false),
}));
import { repoCreateNonConformityDisposition } from "./qualite.repository";

describe("quantity-scoped quality decisions on stock", () => {
  let physical: number, depreciated: number, verdict: string;
  beforeEach(() => {
    physical = 100;
    depreciated = 0;
    verdict = "LIBERE";
    mocks.connect.mockResolvedValue({ query: mocks.query });
    mocks.read.mockResolvedValue({
      rows: [
        {
          id: "disposition",
          non_conformity_id: "nc",
          decided_by_id: null,
          created_by_id: null,
          updated_by_id: null,
        },
      ],
    });
    mocks.query.mockImplementation(
      async (sql: string, args: unknown[] = []) => {
        if (sql.includes("FROM public.non_conformity WHERE"))
          return { rows: [{ id: "nc", reference: "NC-TEST", lot_id: "lot" }] };
        if (sql.includes("INSERT INTO public.non_conformity_dispositions"))
          return { rows: [{ id: "disposition" }] };
        if (sql.includes("FROM public.stock_batches sb"))
          return {
            rows: [
              {
                magasin_id: "warehouse",
                emplacement_id: 1,
                qty_available: 100,
              },
            ],
          };
        if (sql.includes("SELECT article_id::text"))
          return { rows: [{ article_id: "article" }] };
        if (sql.includes("FROM public.units"))
          return { rows: [{ id: "unit" }] };
        if (sql.includes("FROM public.emplacements"))
          return {
            rows: [
              {
                magasin_id: "warehouse",
                is_active: true,
                location_id: "location",
                warehouse_id: "warehouse",
              },
            ],
          };
        if (sql.includes("FROM public.stock_levels"))
          return {
            rows: [{ id: "level", unit_id: "unit", warehouse_id: "warehouse" }],
          };
        if (sql.includes("SELECT lot_code"))
          return { rows: [{ lot_code: "LOT-TEST" }] };
        if (sql.includes("SELECT id::text AS id FROM public.stock_batches"))
          return { rows: [{ id: "batch" }] };
        if (sql.includes("nextval")) return { rows: [{ n: "1" }] };
        if (sql.includes("INSERT INTO public.stock_movements")) {
          if (args[1] === "SCRAP") depreciated += Number(args[5]);
          else physical -= Number(args[5]);
          return { rows: [{ id: "movement" }] };
        }
        if (sql.includes("UPDATE public.lots")) {
          verdict = sql.includes("'LIBERE'")
            ? "LIBERE"
            : sql.includes("'EN_ATTENTE'")
              ? "EN_ATTENTE"
              : "BLOQUE";
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO quality_event_log"))
          return {
            rows: [{ id: "event", created_at: "2026-10-12T00:00:00Z" }],
          };
        if (
          /INSERT INTO public.stock_batches|INSERT INTO public.stock_movement_lines|UPDATE public.stock_movements|UPDATE public.non_conformity_dispositions/.test(
            sql,
          )
        )
          return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    );
  });

  it.each(["SCRAP", "RETURN_SUPPLIER"] as const)(
    "%s removes only the decided quantity from availability",
    async (disposition_type) => {
      await repoCreateNonConformityDisposition({
        id: "nc",
        body: { disposition_type, qty: 3, unite: "u" },
        audit: { user_id: 1 } as never,
      });
      expect(physical - depreciated).toBe(97);
      expect(verdict).toBe("LIBERE");
    },
  );

  it("does not release a previously blocked lot while disposing part of it", async () => {
    verdict = "BLOQUE";
    await repoCreateNonConformityDisposition({
      id: "nc",
      body: { disposition_type: "SCRAP", qty: 3, unite: "u" },
      audit: { user_id: 1 } as never,
    });
    expect(verdict).toBe("BLOQUE");
  });

  it("keeps an explicit quarantine decision effective", async () => {
    await repoCreateNonConformityDisposition({
      id: "nc",
      body: { disposition_type: "HOLD" },
      audit: { user_id: 1 } as never,
    });
    expect(verdict).toBe("EN_ATTENTE");
    expect(physical - depreciated).toBe(100);
  });
});
