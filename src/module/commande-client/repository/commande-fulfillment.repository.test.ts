import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  assertCommandeFullyInvoiced,
  assertCommandeFullyShipped,
  assertCommandeHasActiveOf,
  syncCommandeAfterInvoiceIssue,
  syncCommandeAfterShipment,
} from "./commande-fulfillment.repository";

function queryable(
  implementation: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
) {
  return {
    query: vi.fn((sql: string, values?: unknown[]) => implementation(sql, values)),
  } as unknown as Pick<PoolClient, "query">;
}

const completeState = {
  has_lines: true,
  has_ready_delivery: true,
  fully_shipped: true,
  fully_invoiced: true,
};

describe("commande fulfillment invariants", () => {
  it("ignores cancelled OF when validating planning", async () => {
    const tx = queryable(async (sql) => {
      expect(sql).toContain("statut::text <> 'ANNULE'");
      return { rows: [{ exists: false }] };
    });

    await expect(assertCommandeHasActiveOf(tx, 12)).rejects.toMatchObject({
      code: "PLANNING_REQUIRES_OF",
    });
  });

  it("requires every ordered quantity to be shipped and invoiced", async () => {
    const tx = queryable(async () => ({
      rows: [{
        has_lines: true,
        has_ready_delivery: true,
        fully_shipped: false,
        fully_invoiced: false,
      }],
    }));

    await expect(assertCommandeFullyShipped(tx, 12)).rejects.toMatchObject({
      code: "DELIVERY_NOT_COMPLETE",
    });
    await expect(assertCommandeFullyInvoiced(tx, 12)).rejects.toMatchObject({
      code: "INVOICE_NOT_COMPLETE",
    });
  });

  it("advances delivery only from PRET_LIVRAISON", async () => {
    const tx = queryable(async (sql) => {
      if (sql.includes("WITH shipped_by_line AS")) return { rows: [completeState] };
      if (sql.includes("SELECT statut, order_type")) {
        return { rows: [{ statut: "PRET_LIVRAISON", order_type: "STANDARD" }] };
      }
      return { rows: [] };
    });

    await expect(syncCommandeAfterShipment(tx, 12, 7)).resolves.toEqual({
      advanced: true,
      status: "LIVRE",
    });
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("SET statut = 'LIVRE'"),
      [12]
    );
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO public.commande_historique"),
      [
        12,
        7,
        "PRET_LIVRAISON",
        "LIVRE",
        expect.stringContaining("sortie de stock complète"),
      ]
    );
  });

  it("rolls back the semantic shortcut when a complete shipment happens too early", async () => {
    const tx = queryable(async (sql) => {
      if (sql.includes("WITH shipped_by_line AS")) return { rows: [completeState] };
      if (sql.includes("SELECT statut, order_type")) {
        return { rows: [{ statut: "ATTENTE_PLANNING", order_type: "STANDARD" }] };
      }
      return { rows: [] };
    });

    await expect(syncCommandeAfterShipment(tx, 12, 7)).rejects.toMatchObject({
      code: "COMMAND_NOT_READY_FOR_DELIVERY",
    });
    expect(tx.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET statut = 'LIVRE'"),
      expect.anything()
    );
  });

  it("advances invoicing only after the delivered command is fully covered", async () => {
    const tx = queryable(async (sql) => {
      if (sql.includes("WITH shipped_by_line AS")) return { rows: [completeState] };
      if (sql.includes("SELECT statut FROM public.commande_client")) {
        return { rows: [{ statut: "LIVRE" }] };
      }
      return { rows: [] };
    });

    await expect(syncCommandeAfterInvoiceIssue(tx, 12, 9)).resolves.toEqual({
      advanced: true,
      status: "FACTURE",
    });
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("SET statut = 'FACTURE'"),
      [12]
    );
  });
});
