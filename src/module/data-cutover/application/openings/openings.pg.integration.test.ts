import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoPath } from "../../../../__tests__/helpers/repo-paths";
import { createFinanceOpeningBalanceTx, createUnbilledLegacyDocumentStateTx, createWipOpeningStateTx, listCutoverOpeningStatesTx } from "./openings.repository";
import type { CutoverRow } from "../../types/data-cutover.types";

const url = process.env.CERP_CUTOVER_INTEGRATION_URL;
const describePg = url ? describe : describe.skip;
let db: Pool;
const id = "11111111-1111-4111-8111-111111111111";
const batch = "22222222-2222-4222-8222-222222222222";
const rowId = "33333333-3333-4333-8333-333333333333";
const row = (domain: CutoverRow["domain"], values: CutoverRow["values"], idValue = rowId): CutoverRow => ({ id: idValue, batch_id: batch, domain, legacy_key: `legacy:${domain}:${idValue}`, source_id: "frozen", sheet: "S", row_number: 2, source_values: values, values, source_issues: [], source_notes: [], decision: "INCLUDE", review_note: "verified", version: 1, status: "READY", issues: [] });

describePg("cutover opening states PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Cutover integration URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== "/cerp_cutover_1710" || parsed.port !== "55471") throw new Error("Refusing non-disposable cutover test database");
    db = new Pool({ connectionString: url });
    await db.query("CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY,username text NOT NULL); INSERT INTO public.users(id,username) VALUES(1,'fixture') ON CONFLICT DO NOTHING;");
    await db.query(readFileSync(repoPath("db", "patches", "20261020_01_data_cutover_preparation_1710.sql"), "utf8"));
    await db.query(readFileSync(repoPath("db", "patches", "20261020_03_cutover_opening_states_1710.sql"), "utf8"));
  });
  beforeEach(async () => {
    await db.query("TRUNCATE public.data_cutover_opening_links,public.data_cutover_opening_states,public.data_cutover_rows,public.data_cutover_batches CASCADE");
    await db.query("INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by) VALUES($1::uuid,'fixture','CLIPPER_EXCEL',$2,'[]'::jsonb,1)", [batch, "a".repeat(64)]);
  });
  afterAll(async () => { await db?.end(); });
  async function persist(input: CutoverRow) {
    await db.query(`INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,"values",source_issues,source_notes,decision,review_note,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$8::jsonb,'[]'::jsonb,'[]'::jsonb,'INCLUDE','verified',1)`, [input.id, input.batch_id, input.domain, input.legacy_key, input.source_id, input.sheet, input.row_number, JSON.stringify(input.values)]);
  }
  it("stores WIP and finance openings as review states and rejects mutation", async () => {
    const wip = row("WIP", { quantityRemaining: "4", quantityCompleted: "1", currentPhase: "Fraisage", phaseState: "IN_PROGRESS", workshopValidator: "atelier", evidence: "fiche" });
    await persist(wip);
    const wipClient = await db.connect();
    try { await wipClient.query("BEGIN"); await createWipOpeningStateTx(wipClient, { row: wip, article: { id: "article", reference: "ART", type: "ARTICLE" }, affair: { id: "order", reference: "CMD", type: "SALES_ORDER" }, actorId: 1 }); await wipClient.query("COMMIT"); } finally { wipClient.release(); }
    const finance = row("OPENING_RECEIVABLE", { documentNumber: "F-1", documentKind: "INVOICE", openBalance: "12.00", accountingEvidence: "balance", documentEvidence: "facture" }, "33333333-3333-4333-8333-333333333334");
    await persist(finance);
    const client = await db.connect();
    try { await client.query("BEGIN"); await createFinanceOpeningBalanceTx(client, { row: finance, partner: { id: "client", reference: "CLI", type: "CUSTOMER" }, actorId: 1 }); await client.query("COMMIT"); } finally { client.release(); }
    const states = await listCutoverOpeningStatesTx(db as never, batch);
    expect(states).toEqual(expect.arrayContaining([expect.objectContaining({ status: "OPENING_REVIEW_REQUIRED", opening_kind: "WIP" }), expect.objectContaining({ status: "OPENING_REVIEW_REQUIRED", opening_kind: "FINANCE_BALANCE" })]));
    await expect(db.query("UPDATE public.data_cutover_opening_states SET state='{}'::jsonb")).rejects.toMatchObject({ code: "23514" });
  });
});
