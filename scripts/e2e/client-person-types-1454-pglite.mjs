import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const moduleRoot = process.env.CERP_PGLITE_NODE_MODULES;
if (!moduleRoot) {
  throw new Error(
    "CERP_PGLITE_NODE_MODULES must point to a temporary @electric-sql/pglite installation",
  );
}

const require = createRequire(new URL("../../package.json", import.meta.url));
const { PGlite } = require(`${moduleRoot}/@electric-sql/pglite`);
const db = new PGlite();

try {
  await db.exec(`
    CREATE TABLE public.clients (
      client_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      client_code text,
      company_name text NOT NULL,
      siret text,
      siren text,
      vat_number text,
      naf_code text,
      contact_id uuid,email text,phone text,website_url text,status text,blocked boolean,reason text,creation_date timestamp,
      biller_id uuid,delivery_address_id uuid,bill_address_id uuid,bank_info_id uuid,observations text,provided_documents_id uuid,
      quality_levels text[],devise text,encours_max numeric,incoterm text,langue text,compte_tiers text,groupe_financier text,
      electronic_address_scheme text,electronic_address_value text,electronic_address_directory_entry_id uuid,electronic_address_verified_at timestamptz,
      created_by integer,updated_by integer
    );
  `);

  await db.exec(
    await readFile(
      new URL(
        "../../db/patches/20261026_client_person_types_1454.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.query(`INSERT INTO public.clients (client_id, company_name)
    VALUES ('00000000-0000-4000-8000-000000000001', 'Historique')`);

  let fiscalIdentityRejected = false;
  try {
    await db.query(`INSERT INTO public.clients
      (client_id, company_name, customer_type, individual_first_name, individual_last_name, siret)
      VALUES ('00000000-0000-4000-8000-000000000002', 'Ana Martin', 'INDIVIDUAL', 'Ana', 'Martin', '12345678901234')`);
  } catch {
    fiscalIdentityRejected = true;
  }
  if (!fiscalIdentityRejected)
    throw new Error("individual fiscal identity unexpectedly accepted");

  await db.query(`INSERT INTO public.clients
    (client_id, company_name, customer_type, individual_first_name, individual_last_name)
    VALUES ('00000000-0000-4000-8000-000000000003', 'Ana Martin', 'INDIVIDUAL', 'Ana', 'Martin')`);

  const result = await db.query(`
    SELECT customer_type, count(*)::int AS count
      FROM public.clients
     GROUP BY customer_type
     ORDER BY customer_type
  `);
  const expected = [
    { customer_type: "INDIVIDUAL", count: 1 },
    { customer_type: "PROFESSIONAL", count: 1 },
  ];
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new Error(
      `unexpected migration rows: ${JSON.stringify(result.rows)}`,
    );
  }

  // Execute the exact INSERT used by the repository, including its placeholders.
  // This catches SQL/argument shifts that a TypeScript or mocked-query test misses.
  const source = await readFile(
    new URL(
      "../../src/module/client/repository/client.repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const insert = /const q = `([\s\S]*?INSERT INTO clients[\s\S]*?)`;/u.exec(
    source,
  )?.[1];
  if (!insert) throw new Error("Could not locate the native client INSERT");
  const inserted = await db.query(insert, [
    "CLI-FIXTURE",
    "Ana Martin",
    "INDIVIDUAL",
    "Ana",
    "Martin",
    null,
    "ana@example.test",
    "",
    "",
    "",
    "",
    "",
    "",
    "client",
    false,
    "",
    "2026-10-26",
    null,
    null,
    null,
    null,
    "Fixture",
    null,
    [],
    "EUR",
    0,
    "",
    "fr",
    "",
    "",
    "",
    "",
    7,
  ]);
  const saved = (
    await db.query(
      "SELECT company_name,customer_type,individual_first_name,individual_last_name,email,status,devise,created_by,updated_by FROM public.clients WHERE client_id=$1",
      [inserted.rows[0].client_id],
    )
  ).rows[0];
  const expectedSaved = {
    company_name: "Ana Martin",
    customer_type: "INDIVIDUAL",
    individual_first_name: "Ana",
    individual_last_name: "Martin",
    email: "ana@example.test",
    status: "client",
    devise: "EUR",
    created_by: 7,
    updated_by: 7,
  };
  if (JSON.stringify(saved) !== JSON.stringify(expectedSaved))
    throw new Error(
      "Native client INSERT did not preserve identity/field bindings",
    );

  console.log("client-person-types-1454 PGlite fixture: PASS");
} finally {
  await db.close();
}
