#!/usr/bin/env node

const { Client } = require("pg");

function assertIsolated() {
  if (process.env.CERP_E2E_ISOLATED !== "1") {
    throw new Error("CERP_E2E_ISOLATED=1 is required for the SOL-29 fixture");
  }
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || url.pathname !== "/cerp_test") {
    throw new Error("SOL-29 fixture refuses non-loopback or non-cerp_test databases");
  }
}

async function main() {
  assertIsolated();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.clients (client_id,client_code,company_name,status,document_policy)
       VALUES ('902','E2E-CLIENT-902','Client isolation SOL-29','client','NONE')
       ON CONFLICT (client_id) DO UPDATE SET
         client_code=EXCLUDED.client_code,
         company_name=EXCLUDED.company_name,
         status='client'`
    );
    await client.query(
      `INSERT INTO public.commande_client (
         id,numero,client_id,date_commande,order_type,total_ht,total_ttc
       ) VALUES
         (9290001,'SOL29-ORDER-A','901',DATE '2026-08-14','FERME',100,120),
         (9290002,'SOL29-ORDER-B','902',DATE '2026-08-14','FERME',200,240)
       ON CONFLICT (id) DO UPDATE SET
         numero=EXCLUDED.numero,
         client_id=EXCLUDED.client_id,
         date_commande=EXCLUDED.date_commande,
         order_type=EXCLUDED.order_type,
         total_ht=EXCLUDED.total_ht,
         total_ttc=EXCLUDED.total_ttc`
    );
    await client.query(
      `INSERT INTO public.commande_historique (
         commande_id,user_id,ancien_statut,nouveau_statut,commentaire
       )
       SELECT fixture.commande_id, actor.id, 'BROUILLON', 'ENREGISTREE', 'Fixture isolée SOL-29'
         FROM (VALUES (9290001::bigint),(9290002::bigint)) AS fixture(commande_id)
         CROSS JOIN LATERAL (
           SELECT id FROM public.users WHERE username='KEENAN' LIMIT 1
         ) actor
        WHERE NOT EXISTS (
          SELECT 1 FROM public.commande_historique existing
           WHERE existing.commande_id=fixture.commande_id
             AND existing.commentaire='Fixture isolée SOL-29'
        )`
    );
    await client.query(
      `INSERT INTO public.ged_document_links (
         id,document_id,entity_type,entity_id,link_role,created_by
       ) VALUES (
         '92900000-0000-4000-8000-000000000001',
         '92000000-0000-4000-8000-000000000005',
         'CLIENT','901','PORTAL_SOL29',
         (SELECT id FROM public.users WHERE username='KEENAN')
       ) ON CONFLICT (document_id,entity_type,entity_id,link_role) DO NOTHING`
    );
    await client.query("COMMIT");
    process.stdout.write("SOL-29 isolated fixture ready: clients=901/902 orders=SOL29-ORDER-A/B document=GED-E2E-SOL20-PLAN\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
