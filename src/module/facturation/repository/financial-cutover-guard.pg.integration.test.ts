import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { PoolClient } from "pg";

import {
  activateFinancialCutoverEmissionTx,
  assertFinancialCutoverEmissionAllowedTx,
  getFinancialCutoverStatusTx,
  startFinancialCutoverPreparationTx,
} from "./financial-cutover-guard";

const FIXTURE_DATABASE = "cerp_financial_gate_1710";
const integrationUrl = process.env.CERP_FINANCIAL_CUTOVER_INTEGRATION_URL;
const runIntegration = Boolean(integrationUrl) && integrationUrl === process.env.DATABASE_URL;
let databaseUrl = "";
let actorId = 0;
let batchId = "";

function isolatedUrl(): string {
  if (!integrationUrl) throw new Error("Missing explicit financial cutover integration database URL");
  const url = new URL(integrationUrl);
  if (!/^(localhost|127\.0\.0\.1)$/i.test(url.hostname) || url.port !== "55471" || url.pathname !== `/${FIXTURE_DATABASE}`) {
    throw new Error("Financial cutover integration tests require their dedicated local database");
  }
  return url.toString();
}

async function open() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

// The production helper receives a pooled transaction client. A standalone
// pg Client exposes the same transaction/query surface for this isolated test.
function transactionClient(client: Client): PoolClient {
  return client as unknown as PoolClient;
}

const describePg = runIntegration ? describe : describe.skip;
describePg("financial cutover guard against the isolated native schema", () => {
  beforeAll(async () => {
    databaseUrl = isolatedUrl();
    const client = await open();
    try {
      const identity = await client.query<{ database: string }>("SELECT current_database() AS database");
      if (identity.rows[0]?.database !== FIXTURE_DATABASE) throw new Error("Financial cutover integration database identity mismatch");
      await client.query(readFileSync("db/patches/20261020_cutover_numbering_1710.sql", "utf8"));
      await client.query(readFileSync("db/patches/20261020_05_financial_cutover_gate_1710.sql", "utf8"));
      const user = await client.query<{ id: number }>(
        `INSERT INTO public.users(username,password,name,surname,email,role,lane,house_no,postcode)
         VALUES($1,$2,'Gate','Test',$3,'Administrateur Systeme et Reseau','-', '-', '00000') RETURNING id`,
        [`financial-gate-${Date.now()}`, "not-a-login-secret", `financial-gate-${Date.now()}@invalid.test`],
      );
      actorId = user.rows[0]!.id;
      batchId = randomUUID();
      await client.query(
        `INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by)
         VALUES($1::uuid,'Financial gate qualification','CLIPPER_EXCEL',$2,'[]'::jsonb,$3)`,
        [batchId, randomUUID().replace(/-/g, "").repeat(2), actorId],
      );
    } finally {
      await client.end();
    }
  });

  beforeEach(async () => {
    const client = await open();
    try {
      await client.query("UPDATE public.financial_cutover_gate SET phase='IDLE',started_at=NULL,started_by=NULL,started_batch_id=NULL,activated_at=NULL,activated_by=NULL,activation_evidence_reference=NULL,updated_at=now() WHERE singleton=TRUE");
      await client.query("DELETE FROM public.cutover_finance_shared_sequences WHERE entity_code='CRP' AND period_key='2026'");
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    // The database is an explicitly disposable fixture; the parent release task
    // owns its lifecycle and can preserve it as evidence until its final gate.
  });
  it("serializes an in-flight issuance before starting PREPARING, then blocks the next one", async () => {
    const issuing = await open();
    const preparing = await open();
    try {
      await issuing.query("BEGIN");
      await assertFinancialCutoverEmissionAllowedTx(transactionClient(issuing));

      await preparing.query("BEGIN");
      let started = false;
      const start = startFinancialCutoverPreparationTx(transactionClient(preparing), { actorId, batchId }).then(result => {
        started = true;
        return result;
      });
      await new Promise(resolve => setTimeout(resolve, 75));
      expect(started).toBe(false);

      await issuing.query("COMMIT");
      await expect(start).resolves.toEqual({ phase: "PREPARING" });
      await preparing.query("COMMIT");

      const verification = await open();
      try {
        await verification.query("BEGIN");
        await expect(assertFinancialCutoverEmissionAllowedTx(transactionClient(verification))).rejects.toMatchObject({ status: 409, code: "FINANCIAL_CUTOVER_SUSPENDED" });
        await verification.query("ROLLBACK");
      } finally {
        await verification.end();
      }
    } finally {
      await issuing.query("ROLLBACK").catch(() => undefined);
      await preparing.query("ROLLBACK").catch(() => undefined);
      await issuing.end();
      await preparing.end();
    }
  });

  it("refuses a proforma number that moves the native sequence backward and preserves append-only evidence", async () => {
    const client = await open();
    try {
      await client.query("BEGIN");
      await startFinancialCutoverPreparationTx(transactionClient(client), { actorId, batchId });
      await client.query(`INSERT INTO public.cutover_finance_shared_sequences(entity_code,period_key,next_value,facture_prefix,avoir_prefix,padding,active,activated_at,activated_by,activation_evidence_reference)
        VALUES('CRP','2026',24000,'FAC-26-','AV-26-',5,TRUE,now(),$1,'fixture-proof')`, [actorId]);
      await client.query("SELECT setval('public.proforma_client_reference_seq',100,false)");
      await expect(activateFinancialCutoverEmissionTx(transactionClient(client), {
        actorId, entityCode: "CRP", periodKey: "2026", proformaNextValue: 99, evidenceReference: "fixture-proof",
      })).rejects.toMatchObject({ status: 409, code: "FINANCIAL_CUTOVER_PROFORMA_SEQUENCE_BACKWARD" });
      await client.query("COMMIT");

      await expect(client.query("UPDATE public.financial_cutover_events SET action='ACTIVATED'")).rejects.toThrow(/append-only/i);
      await expect(getFinancialCutoverStatusTx(transactionClient(client))).resolves.toEqual({ phase: "PREPARING" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });
});
