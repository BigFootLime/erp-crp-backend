import { describe, expect, it } from "vitest";
import { createFinanceOpeningBalanceTx, createUnbilledLegacyDocumentStateTx, createWipOpeningStateTx, listCutoverOpeningStatesTx } from "./openings.repository";
import type { CutoverRow } from "../../types/data-cutover.types";

const row = (domain: CutoverRow["domain"], values: CutoverRow["values"]): CutoverRow => ({
  id: "11111111-1111-4111-8111-111111111111", batch_id: "22222222-2222-4222-8222-222222222222", domain, legacy_key: `legacy:${domain}`,
  source_id: "source", sheet: "Sheet", row_number: 4, source_values: values, values, source_issues: [], source_notes: [],
  decision: "INCLUDE", review_note: "verified", version: 1, status: "READY", issues: [],
});
const target = { id: "target-1", reference: "REF-1", type: "ARTICLE" };
function tx(rows: unknown[][]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return { calls, query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return { rows: rows.shift() ?? [] }; } };
}

describe("cutover opening-state writers", () => {
  it("stores a WIP opening without creating a pointage or an OF", async () => {
    const client = tx([[{ id: "row" }], [], [{ id: "opening", opening_kind: "WIP", domain: "WIP", created_at: "2026-10-20" }]]);
    const result = await createWipOpeningStateTx(client as never, { row: row("WIP", { quantityRemaining: "4", quantityCompleted: "2", currentPhase: "Fraisage", phaseState: "IN_PROGRESS", workshopValidator: "atelier", evidence: "fiche" }), article: target, affair: { ...target, type: "SALES_ORDER" }, actorId: 7 });
    expect(result).toEqual({ id: "opening", reference: "OPEN-WIP-opening" });
    expect(client.calls.map((call) => call.sql).join("\n")).not.toMatch(/ordres_fabrication|of_time_logs|production_pointages/i);
    expect(JSON.parse(String(client.calls[2].values?.[4]))).toMatchObject({ status: "OPENING_REVIEW_REQUIRED", native_of_created: false, historical_timesheets_created: false });
  });

  it("keeps finance and unbilled history as review states without issuance or stock movement", async () => {
    const financeClient = tx([[{ id: "row" }], [], [{ id: "finance", opening_kind: "FINANCE_BALANCE", domain: "OPENING_RECEIVABLE", created_at: "2026-10-20" }]]);
    await createFinanceOpeningBalanceTx(financeClient as never, { row: row("OPENING_RECEIVABLE", { documentNumber: "F-1", openBalance: "12.30" }), partner: { ...target, type: "CUSTOMER" }, actorId: 7 });
    const unbilledClient = tx([[{ id: "row" }], [], [{ id: "unbilled", opening_kind: "UNBILLED_LEGACY_DOCUMENT", domain: "LEGACY_DELIVERY", created_at: "2026-10-20" }]]);
    await createUnbilledLegacyDocumentStateTx(unbilledClient as never, { row: row("LEGACY_DELIVERY", { deliveryNumber: "BL-1", quantity: "1", unit: "u", deliveryDate: "2026-10-20", billingStatus: "UNBILLED", unbilledAmount: "10", evidence: "BL" }), partner: { ...target, type: "CUSTOMER" }, article: target, actorId: 7 });
    const sql = [...financeClient.calls, ...unbilledClient.calls].map((call) => call.sql).join("\n");
    expect(sql).not.toMatch(/INSERT INTO public\.(facture|stock_movements|bon_livraison)/i);
  });

  it("marks an unlinked opening state for review when it is read", async () => {
    const client = tx([[{ id: "opening", row_id: "row", opening_kind: "WIP", domain: "WIP", state: {}, provenance: {}, created_at: "2026-10-20", links: [] }]]);
    await expect(listCutoverOpeningStatesTx(client as never, "22222222-2222-4222-8222-222222222222")).resolves.toEqual([expect.objectContaining({ status: "OPENING_REVIEW_REQUIRED" })]);
  });
});
