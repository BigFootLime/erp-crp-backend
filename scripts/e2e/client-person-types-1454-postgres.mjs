import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
const isolatedDatabase = /^client_person_types_1454_[a-z0-9_]+$/u.test(
  databaseUrl.pathname.slice(1),
);
if (
  process.env.CERP_E2E_ISOLATED !== "1"
  || !["127.0.0.1", "localhost", "::1"].includes(databaseUrl.hostname)
  || !isolatedDatabase
) {
  throw new Error(
    "CERP_E2E_ISOLATED=1 and a loopback client_person_types_1454_* DATABASE_URL are required",
  );
}

const patch = await readFile(
  new URL("../../db/patches/20261026_client_person_types_1454.sql", import.meta.url),
  "utf8",
);
const db = new Client({ connectionString: databaseUrl.toString() });

async function expectsConstraint(sql, values) {
  await assert.rejects(db.query(sql, values), { code: "23514" });
}

async function runProfile({ name, legacyVat, legacyNaf, canonicalVat, canonicalNaf, expectedVat, expectedNaf }) {
  await db.query("DROP TABLE IF EXISTS public.clients CASCADE");
  const legacyColumns = [
    canonicalVat ? "vat_number text" : null,
    canonicalNaf ? "naf_code text" : null,
    legacyVat ? "tva_intracom text" : null,
    legacyNaf ? "code_naf text" : null,
  ].filter(Boolean).join(", ");
  await db.query(`
    CREATE TABLE public.clients (
      client_id uuid PRIMARY KEY,
      company_name text NOT NULL,
      siret text,
      siren text${legacyColumns ? `, ${legacyColumns}` : ""}
    )
  `);
  const availableColumns = await db.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'clients'
       AND column_name IN ('tva_intracom', 'code_naf')
     ORDER BY column_name
  `);
  assert.deepEqual(
    availableColumns.rows.map(({ column_name }) => column_name),
    [legacyNaf ? "code_naf" : null, legacyVat ? "tva_intracom" : null].filter(Boolean),
  );

  const fiscalColumns = ["client_id", "company_name", "siret", "siren"];
  const fiscalValues = ["00000000-0000-4000-8000-000000000001", `${name} pro`, null, null];
  if (canonicalVat) {
    fiscalColumns.push("vat_number");
    fiscalValues.push("FR canonical");
  }
  if (canonicalNaf) {
    fiscalColumns.push("naf_code");
    fiscalValues.push("62.01Z");
  }
  if (legacyVat) {
    fiscalColumns.push("tva_intracom");
    fiscalValues.push("  FR legacy  ");
  }
  if (legacyNaf) {
    fiscalColumns.push("code_naf");
    fiscalValues.push("  25.62Z  ");
  }
  await db.query(
    `INSERT INTO public.clients (${fiscalColumns.join(", ")}) VALUES (${fiscalValues.map((_, index) => `$${index + 1}`).join(", ")})`,
    fiscalValues,
  );

  await db.query(patch);
  await db.query(patch);

  const identity = await db.query(
    "SELECT customer_type, vat_number, naf_code FROM public.clients WHERE client_id = $1",
    [fiscalValues[0]],
  );
  assert.deepEqual(identity.rows[0], {
    customer_type: "PROFESSIONAL",
    vat_number: expectedVat,
    naf_code: expectedNaf,
  });

  await expectsConstraint(
    "INSERT INTO public.clients (client_id, company_name, customer_type, individual_first_name, individual_last_name, vat_number, naf_code) VALUES ($1, $2, 'INDIVIDUAL', 'Ada', 'Lovelace', 'FR123', '25.62Z')",
    ["00000000-0000-4000-8000-000000000002", `${name} invalid`],
  );
  if (legacyVat || legacyNaf) {
    const columns = ["client_id", "company_name", "customer_type", "individual_first_name", "individual_last_name"];
    const values = ["00000000-0000-4000-8000-000000000003", `${name} legacy invalid`, "INDIVIDUAL", "Ada", "Lovelace"];
    if (legacyVat) { columns.push("tva_intracom"); values.push("FR legacy"); }
    if (legacyNaf) { columns.push("code_naf"); values.push("25.62Z"); }
    await expectsConstraint(
      `INSERT INTO public.clients (${columns.join(", ")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`,
      values,
    );
  }
  await expectsConstraint(
    "INSERT INTO public.clients (client_id, company_name, customer_type, individual_first_name) VALUES ($1, $2, 'INDIVIDUAL', 'Ada')",
    ["00000000-0000-4000-8000-000000000004", `${name} incomplete`],
  );
  await db.query(
    "INSERT INTO public.clients (client_id, company_name, customer_type, individual_first_name, individual_last_name) VALUES ($1, $2, 'INDIVIDUAL', 'Ada', 'Lovelace')",
    ["00000000-0000-4000-8000-000000000005", `${name} valid`],
  );
}

try {
  await db.connect();
  await runProfile({ name: "canonical", legacyVat: false, legacyNaf: false, canonicalVat: true, canonicalNaf: true, expectedVat: "FR canonical", expectedNaf: "62.01Z" });
  await runProfile({ name: "legacy", legacyVat: true, legacyNaf: true, canonicalVat: false, canonicalNaf: false, expectedVat: "FR legacy", expectedNaf: "25.62Z" });
  await runProfile({ name: "both", legacyVat: true, legacyNaf: true, canonicalVat: true, canonicalNaf: true, expectedVat: "FR canonical", expectedNaf: "62.01Z" });
  console.log("client-person-types-1454 PostgreSQL profiles: PASS");
} finally {
  await db.end();
}
