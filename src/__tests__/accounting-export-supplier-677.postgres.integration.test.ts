import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationUrl = process.env.ACCOUNTING_EXPORT_SUPPLIER_677_TEST_DATABASE_URL;
const suite = integrationUrl ? describe : describe.skip;
const root = process.cwd();
const verifyPath = path.join(root, "db/patches/support/20260827_z_accounting_export_supplier_677.verify.sql");

suite("ACCOUNTING-EXPORT-677 successor verifier: PostgreSQL", () => {
  let client: import("pg").Client;
  let verify: string;

  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.Client({ connectionString: integrationUrl });
    await client.connect();
    const database = await client.query<{ current_database: string }>("SELECT current_database()");
    if (!/test|sandbox|local/i.test(database.rows[0]?.current_database ?? "")) {
      throw new Error("ACCOUNTING_EXPORT_SUPPLIER_677_TEST_DATABASE_URL must target a test/local/sandbox database");
    }
    verify = await fs.readFile(verifyPath, "utf8");
  });

  afterAll(async () => { await client?.end(); });

  async function createFinalFinance1268Profile() {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.query(`
      CREATE TABLE public.accounting_export_batches (source_types text[] NOT NULL);
      CREATE TABLE public.accounting_export_batch_sources (source_type text NOT NULL);
      CREATE TABLE public.accounting_export_entries (source_type text NOT NULL);
      CREATE TABLE public.accounting_export_source_claims (source_type text NOT NULL);
      ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK (
        cardinality(source_types) BETWEEN 1 AND 8 AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL']::text[]);
      ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'));
      ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'));
      ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'));
    `);
  }

  it("accepts the active Finance #1268 successor profile", async () => {
    await createFinalFinance1268Profile();
    await expect(client.query(verify)).resolves.toBeDefined();
  });

  it("refuses a missing successor constraint", async () => {
    await createFinalFinance1268Profile();
    await client.query("ALTER TABLE public.accounting_export_entries DROP CONSTRAINT accounting_entry_source_type_1268_ck");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("ACCOUNTING-EXPORT-677 source constraints are incomplete"),
    });
    await client.query("ROLLBACK");
  });

  it("refuses an unvalidated or weakened successor source contract", async () => {
    await createFinalFinance1268Profile();
    await client.query("ALTER TABLE public.accounting_export_entries DROP CONSTRAINT accounting_entry_source_type_1268_ck");
    await client.query("ALTER TABLE public.accounting_export_entries ADD CONSTRAINT accounting_entry_source_type_1268_ck CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT')) NOT VALID");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("ACCOUNTING-EXPORT-677 source constraints are incomplete"),
    });
    await client.query("ROLLBACK");

    await createFinalFinance1268Profile();
    await client.query("ALTER TABLE public.accounting_export_source_claims DROP CONSTRAINT accounting_claim_source_type_1268_ck");
    await client.query("ALTER TABLE public.accounting_export_source_claims ADD CONSTRAINT accounting_claim_source_type_1268_ck CHECK (source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','ADVANCE_VAT'))");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("ACCOUNTING-EXPORT-677 source constraints are incomplete"),
    });
    await client.query("ROLLBACK");

    await createFinalFinance1268Profile();
    await client.query("ALTER TABLE public.accounting_export_batches DROP CONSTRAINT accounting_batch_sources_1268_ck");
    await client.query("ALTER TABLE public.accounting_export_batches ADD CONSTRAINT accounting_batch_sources_1268_ck CHECK (cardinality(source_types) BETWEEN 1 AND 7 AND source_types <@ ARRAY['INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND']::text[])");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("ACCOUNTING-EXPORT-677 source constraints are incomplete"),
    });
    await client.query("ROLLBACK");

    await createFinalFinance1268Profile();
    await client.query("ALTER TABLE public.accounting_export_batch_sources DROP CONSTRAINT accounting_batch_source_type_1268_ck");
    await client.query("ALTER TABLE public.accounting_export_batch_sources ADD CONSTRAINT accounting_batch_source_type_1268_ck CHECK (true OR source_type IN ('INVOICE','CREDIT_NOTE','PAYMENT','SUPPLIER_INVOICE','SUPPLIER_CREDIT_NOTE','ADVANCE_VAT','CUSTOMER_REFUND','CUSTOMER_REFUND_REVERSAL'))");
    await expect(client.query(verify)).rejects.toMatchObject({
      message: expect.stringContaining("ACCOUNTING-EXPORT-677 source constraints are incomplete"),
    });
    await client.query("ROLLBACK");
  });
});
