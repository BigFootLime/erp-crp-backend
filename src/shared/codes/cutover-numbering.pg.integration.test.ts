import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoPath } from "../../__tests__/helpers/repo-paths";
import {
  activateCutoverBusinessNumberSequenceTx,
  generateAffaireCode,
  generateBlCode,
} from "./code-generator.service";
import {
  activateCutoverFinanceSharedSeriesTx,
  allocateLegalNumber,
} from "../../module/facturation/repository/workflow.repository.shared";
import {
  activateFinancialCutoverEmissionTx,
  startFinancialCutoverPreparationTx,
} from "../../module/facturation/repository/financial-cutover-guard";

// This suite only connects to the explicit disposable loopback database. It
// proves actual PostgreSQL locking/allocation rather than reimplementing it in
// mocks.
const url = process.env.CERP_CUTOVER_INTEGRATION_URL;
const describePg = url ? describe : describe.skip;
const FINANCIAL_GATE_BATCH_ID = "00000000-0000-4000-8000-000000001710";
let db: Pool;

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { return await fn(client); } finally { client.release(); }
}

const applyPatch = async () => {
  await db.query(readFileSync(repoPath("db", "patches", "20261020_cutover_numbering_1710.sql"), "utf8"));
  await db.query(readFileSync(repoPath("db", "patches", "20261020_05_financial_cutover_gate_1710.sql"), "utf8"));
};

describePg("cutover numbering PostgreSQL allocation", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Numbering integration URL must exactly match DATABASE_URL");
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/cerp_cutover_1710" || parsed.port !== "55471") {
      throw new Error("Refusing non-disposable numbering test database");
    }
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "cerp_cutover_1710") throw new Error("Unexpected database identity");
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY, username text NOT NULL);
      INSERT INTO public.users(id,username) VALUES(1,'numbering-fixture-admin') ON CONFLICT(id) DO NOTHING;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN CREATE ROLE cerp_app; END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS public.finance_legal_sequences(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_type text NOT NULL,
        entity_code text NOT NULL,
        period_key text NOT NULL,
        prefix text NOT NULL,
        next_value bigint NOT NULL,
        padding integer NOT NULL,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.data_cutover_batches(
        id uuid PRIMARY KEY,
        name text NOT NULL,
        source_system text NOT NULL,
        source_hash char(64) NOT NULL UNIQUE,
        sources jsonb NOT NULL,
        created_by integer NOT NULL REFERENCES public.users(id)
      );
      INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by)
      VALUES('${FINANCIAL_GATE_BATCH_ID}'::uuid,'Numbering integration fixture','CLIPPER_EXCEL','1710171017101710171017101710171017101710171017101710171017101710','[]'::jsonb,1)
      ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS public.proforma_client(reference text NOT NULL);
      CREATE SEQUENCE IF NOT EXISTS public.proforma_client_reference_seq;
    `);
    await applyPatch();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE public.cutover_business_number_sequences,public.cutover_finance_shared_sequences,public.financial_cutover_events");
    await db.query("UPDATE public.financial_cutover_gate SET phase='IDLE',started_at=NULL,started_by=NULL,started_batch_id=NULL,activated_at=NULL,activated_by=NULL,activation_evidence_reference=NULL,updated_at=now() WHERE singleton=TRUE");
    await db.query("ALTER SEQUENCE public.proforma_client_reference_seq RESTART WITH 700");
    await applyPatch();
  });

  afterAll(async () => { await db?.end(); });

  it("keeps proposed affair/BL counters inactive until the explicit activation", async () => {
    const rows = await db.query<{ scope: string; next_value: string; active: boolean }>("SELECT scope,next_value::text,active FROM public.cutover_business_number_sequences ORDER BY scope");
    expect(rows.rows).toEqual([
      { scope: "AFFAIRE_LIVRAISON", next_value: "24000", active: false },
      { scope: "BON_LIVRAISON", next_value: "15000", active: false },
    ]);
  });

  it("allocates unique counters concurrently and keeps the raw suffix through the Paris year rollover", async () => {
    await withClient((client) => activateCutoverBusinessNumberSequenceTx(client, { scope: "AFFAIRE_LIVRAISON", nextValue: 24000, actorId: 1 }));
    await withClient((client) => activateCutoverBusinessNumberSequenceTx(client, { scope: "BON_LIVRAISON", nextValue: 15000, actorId: 1 }));

    const decParis = await generateAffaireCode(db as never, { type: "LIV", client_code: "001", date: new Date("2026-12-31T22:59:00.000Z") });
    const janParis = await generateAffaireCode(db as never, { type: "LIV", client_code: "001", date: new Date("2026-12-31T23:30:00.000Z") });
    expect(decParis).toBe("AFF-LIV-26-24000");
    expect(janParis).toBe("AFF-LIV-27-24001");

    const concurrent = await Promise.all(Array.from({ length: 24 }, () => generateAffaireCode(db as never, { type: "LIV", client_code: "001", date: new Date("2027-01-01T10:00:00.000Z") })));
    expect(new Set(concurrent).size).toBe(24);
    expect(concurrent.map((value) => Number(value.slice(-5))).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => 24002 + index));

    const bl = await Promise.all(Array.from({ length: 16 }, () => generateBlCode(db as never, { date: new Date("2027-01-01T10:00:00.000Z") })));
    expect(new Set(bl).size).toBe(16);
    expect(bl.map((value) => Number(value.slice(-5))).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => 15000 + index));
  });

  it("reapplying the additive patch never resets an activated or consumed counter", async () => {
    await withClient((client) => activateCutoverBusinessNumberSequenceTx(client, { scope: "AFFAIRE_LIVRAISON", nextValue: 24000, actorId: 1 }));
    await generateAffaireCode(db as never, { type: "LIV", client_code: "001", date: new Date("2026-10-20T10:00:00.000Z") });
    const before = await db.query<{ next_value: string; active: boolean }>("SELECT next_value::text,active FROM public.cutover_business_number_sequences WHERE scope='AFFAIRE_LIVRAISON'");
    await applyPatch();
    const after = await db.query<{ next_value: string; active: boolean }>("SELECT next_value::text,active FROM public.cutover_business_number_sequences WHERE scope='AFFAIRE_LIVRAISON'");
    expect(after.rows).toEqual(before.rows);
  });

  it("uses one opt-in fiscal allocation for invoices, advances and credits while proformas remain independent", async () => {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await startFinancialCutoverPreparationTx(client, { actorId: 1, batchId: FINANCIAL_GATE_BATCH_ID });
        await activateCutoverFinanceSharedSeriesTx({
          client,
          entityCode: "CRP",
          periodKey: "2026",
          nextValue: 900,
          facturePrefix: "F-26-",
          avoirPrefix: "A-26-",
          padding: 5,
          actorId: 1,
          evidenceReference: "Fixture cutover evidence",
        });
        await activateFinancialCutoverEmissionTx(client, {
          actorId: 1,
          entityCode: "CRP",
          periodKey: "2026",
          proformaNextValue: 700,
          evidenceReference: "Fixture cutover evidence",
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    const [invoice, advance, credit] = await Promise.all([
      withClient((client) => allocateLegalNumber({ client, documentType: "FACTURE", entityCode: "CRP", issueDate: "2026-10-20" })),
      // An advance invoice is issued as the FACTURE document type: there is no
      // separate counter scope.
      withClient((client) => allocateLegalNumber({ client, documentType: "FACTURE", entityCode: "CRP", issueDate: "2026-10-20" })),
      withClient((client) => allocateLegalNumber({ client, documentType: "AVOIR", entityCode: "CRP", issueDate: "2026-10-20" })),
    ]);
    expect([invoice.sequenceValue, advance.sequenceValue, credit.sequenceValue].sort((a, b) => a - b)).toEqual([900, 901, 902]);
    expect(invoice.legalNumber).toMatch(/^F-26-0090[0-2]$/);
    expect(advance.legalNumber).toMatch(/^F-26-0090[0-2]$/);
    expect(credit.legalNumber).toMatch(/^A-26-0090[0-2]$/);
    const firstProforma = await db.query<{ value: string }>("SELECT nextval('public.proforma_client_reference_seq')::text AS value");
    const secondProforma = await db.query<{ value: string }>("SELECT nextval('public.proforma_client_reference_seq')::text AS value");
    expect([firstProforma.rows[0]!.value, secondProforma.rows[0]!.value]).toEqual(["700", "701"]);
  });
});
