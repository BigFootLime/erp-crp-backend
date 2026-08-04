import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  assertCommandeFullyInvoiced,
  assertCommandeFullyShipped,
  assertCommandeHasActiveOf,
  assertCommandeProductionCompleted,
  assertCommandeProductionStarted,
  assertCommandeQualityReleased,
  syncCommandeAfterInvoiceIssue,
  syncCommandeAfterShipment,
} from "./commande-fulfillment.repository";

function queryable(
  implementation: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
) {
  const query = vi.fn((sql: string, values?: unknown[]) => implementation(sql, values));
  return { query } as { query: typeof query } & Pick<PoolClient, "query">;
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
      if (sql.includes("SELECT id::int AS id, numero, client_id")) {
        return { rows: [{ id: 12, numero: "CC-12", client_id: "001" }] };
      }
      if (sql.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: "PRET_LIVRAISON" }] };
      if (sql.includes("INSERT INTO commande_historique")) return { rows: [{ id: "1" }] };
      if (sql.includes("SELECT order_type")) return { rows: [{ order_type: "STANDARD" }] };
      return { rows: [] };
    });

    await expect(syncCommandeAfterShipment(tx, 12, 7)).resolves.toEqual({
      advanced: true,
      status: "LIVRE",
    });
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE commande_client"),
      [12, false, 7, false]
    );
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO commande_historique"),
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
      if (sql.includes("SELECT id::int AS id, numero, client_id")) {
        return { rows: [{ id: 12, numero: "CC-12", client_id: "001" }] };
      }
      if (sql.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: "ATTENTE_PLANNING" }] };
      return { rows: [] };
    });

    await expect(syncCommandeAfterShipment(tx, 12, 7)).rejects.toMatchObject({
      code: "ILLEGAL_COMMAND_STATUS_TRANSITION",
    });
    expect(tx.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET statut = 'LIVRE'"),
      expect.anything()
    );
  });

  it("advances invoicing only after the delivered command is fully covered", async () => {
    const tx = queryable(async (sql) => {
      if (sql.includes("WITH shipped_by_line AS")) return { rows: [completeState] };
      if (sql.includes("SELECT id::int AS id, numero, client_id")) {
        return { rows: [{ id: 12, numero: "CC-12", client_id: "001" }] };
      }
      if (sql.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: "LIVRE" }] };
      if (sql.includes("INSERT INTO commande_historique")) return { rows: [{ id: "2" }] };
      return { rows: [] };
    });

    await expect(syncCommandeAfterInvoiceIssue(tx, 12, 9)).resolves.toEqual({
      advanced: true,
      status: "FACTURE",
    });
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE commande_client"),
      [12, false, 9, false]
    );
  });

  it("refuse toute synchronisation de facture pour une commande interne sans écrire l'historique", async () => {
    const tx = queryable(async (sql) => {
      if (sql.includes("SELECT order_type") && sql.includes("FOR UPDATE")) {
        return { rows: [{ order_type: "INTERNE" }] };
      }
      return { rows: [] };
    });

    await expect(syncCommandeAfterInvoiceIssue(tx, 12, 9)).rejects.toMatchObject({
      status: 409,
      code: "INTERNAL_ORDER_NOT_BILLABLE",
    });
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO commande_historique"))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("commande_client_event_log"))).toBe(false);
  });

  it("requires real multi-OF production state, while excluding cancelled OF", async () => {
    const notStarted = queryable(async (sql) => {
      expect(sql).toContain("statut::text NOT IN ('EN_COURS','TERMINE','CLOTURE')");
      return { rows: [{ total: 2, not_started: 1 }] };
    });
    await expect(assertCommandeProductionStarted(notStarted, 12)).rejects.toMatchObject({
      code: "PRODUCTION_START_REQUIRED",
    });

    const complete = queryable(async (sql) => {
      expect(sql).toContain("statut::text <> 'ANNULE'");
      return { rows: [{ total: 3, incomplete: 0 }] };
    });
    await expect(assertCommandeProductionCompleted(complete, 12)).resolves.toBeUndefined();

    const childOpen = queryable(async () => ({ rows: [{ total: 3, incomplete: 1 }] }));
    await expect(assertCommandeProductionCompleted(childOpen, 12)).rejects.toMatchObject({
      code: "PRODUCTION_NOT_COMPLETE",
    });
  });

  it("requires release-decision coverage and no open NC before quality completion", async () => {
    const missingDecision = queryable(async (sql) => {
      expect(sql).toContain("quality_release_decision");
      expect(sql).toContain("public.non_conformity");
      return { rows: [{ total: 2, unreleased: 1, open_nc: 0 }] };
    });
    await expect(assertCommandeQualityReleased(missingDecision, 12)).rejects.toMatchObject({
      code: "QUALITY_RELEASE_REQUIRED",
    });

    const released = queryable(async () => ({ rows: [{ total: 2, unreleased: 0, open_nc: 0 }] }));
    await expect(assertCommandeQualityReleased(released, 12)).resolves.toBeUndefined();
  });

  it("keeps append-only history authoritative through delivery, invoice and their replays", async () => {
    let historyStatus = "PRET_LIVRAISON";
    let historyWrites = 0;
    let statusEvents = 0;
    const tx = queryable(async (sql, values) => {
      if (sql.includes("WITH shipped_by_line AS")) return { rows: [completeState] };
      if (sql.includes("SELECT id::int AS id, numero, client_id")) {
        return { rows: [{ id: 12, numero: "CC-12", client_id: "001" }] };
      }
      if (sql.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: historyStatus }] };
      if (sql.includes("INSERT INTO commande_historique")) {
        historyWrites += 1;
        historyStatus = String(values?.[3]);
        return { rows: [{ id: String(historyWrites) }] };
      }
      if (sql.includes("INSERT INTO public.commande_client_event_log")) {
        statusEvents += 1;
        return { rows: [] };
      }
      if (sql.includes("SELECT order_type")) return { rows: [{ order_type: "STANDARD" }] };
      return { rows: [] };
    });

    await expect(syncCommandeAfterShipment(tx, 12, 7)).resolves.toEqual({ advanced: true, status: "LIVRE" });
    expect(historyStatus).toBe("LIVRE");
    await expect(syncCommandeAfterShipment(tx, 12, 7)).resolves.toEqual({ advanced: false, status: "LIVRE" });

    await expect(syncCommandeAfterInvoiceIssue(tx, 12, 9)).resolves.toEqual({ advanced: true, status: "FACTURE" });
    expect(historyStatus).toBe("FACTURE");
    await expect(syncCommandeAfterInvoiceIssue(tx, 12, 9)).resolves.toEqual({ advanced: false, status: "FACTURE" });

    expect(historyWrites).toBe(2);
    expect(statusEvents).toBe(2);
    expect(tx.query.mock.calls.some(([sql]) => /commande_client[\s\S]*statut/i.test(String(sql)))).toBe(false);
  });

  it.each([
    ["shipment", "FACTURE"],
    ["shipment", "ARCHIVE"],
    ["invoice", "ARCHIVE"],
  ])("treats downstream %s replay at %s as a side-effect-free success", async (kind, currentStatus) => {
    const tx = queryable(async (sql) => {
      if (sql.includes("WITH shipped_by_line AS")) return { rows: [completeState] };
      if (sql.includes("SELECT id::int AS id, numero, client_id")) {
        return { rows: [{ id: 12, numero: "CC-12", client_id: "001" }] };
      }
      if (sql.includes("SELECT nouveau_statut")) return { rows: [{ nouveau_statut: currentStatus }] };
      return { rows: [] };
    });

    const result = kind === "shipment"
      ? await syncCommandeAfterShipment(tx, 12, 7)
      : await syncCommandeAfterInvoiceIssue(tx, 12, 9);
    expect(result).toEqual({ advanced: false, status: currentStatus });
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO commande_historique"))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("commande_client_event_log"))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.commande_client_workflow_checkpoint"))).toBe(false);
  });
});
