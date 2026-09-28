#!/usr/bin/env node
/* eslint-disable no-console */

// Seeds only the public-demo navigation catalogue. It contains no customer,
// employee, or production data and refuses every database except cerp_demo.
const { Client } = require("pg");

const MODULES = [
  ["clients", "Clients", "Commerce", ["/clients", "/payment-modes", "/billers", "/banking-info"], ["clients"], 10],
  ["devis", "Devis", "Commerce", ["/devis"], ["devis"], 20],
  ["commandes-clients", "Commandes clients", "Commerce", ["/commandes"], ["commandes"], 30],
  ["livraisons", "Livraisons", "Commerce", ["/livraisons"], ["livraisons"], 40],
  ["affaires", "Affaires", "Commerce", ["/affaires"], ["affaires"], 50],
  ["fournisseurs", "Fournisseurs", "Achats", ["/fournisseurs"], ["fournisseurs"], 80],
  ["pieces-techniques", "Données techniques", "Production", ["/pieces-techniques", "/piece-technique-versions", "/gammes", "/dossiers"], ["pieces-techniques"], 100],
  ["production", "Production", "Production", ["/production", "/planning", "/programmations"], ["production-dashboard", "machines-postes", "production-planning", "production-execution", "atelier-station", "production-pointages", "ordres-fabrication"], 110],
  ["qualite", "Qualité", "Qualité", ["/qualite", "/receptions"], ["qualite-center", "qualite-controls", "qualite-non-conformities", "receptions"], 120],
  ["metrologie", "Métrologie", "Qualité", ["/metrologie"], ["metrologie"], 130],
  ["stock", "Stock", "Stock", ["/stock"], ["stock-dashboard", "stock-articles", "stock-mouvements", "stock-inventaires"], 150],
  ["outillage", "Outillage", "Stock", ["/outils"], ["outils", "outils-new", "outils-retirer"], 160],
  ["finitions", "Bibliothèque de finitions", "Production", ["/finitions"], ["finitions"], 101],
  ["methodes-centres-frais", "Méthodes — Centres de frais", "Production", ["/methodes/centres-frais", "/centre-frais"], ["methodes-centres-frais"], 102],
  ["methodes-parc-machines", "Méthodes — Parc machine", "Production", ["/methodes/machines", "/methodes/familles-machine"], ["methodes-parc-machines"], 103],
];

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function assertDemoDatabase(url) {
  if (new URL(url).pathname !== "/cerp_demo") {
    throw new Error("Refusing to seed a database other than cerp_demo");
  }
}

async function main() {
  if (process.env.CERP_DEMO_MODE !== "true") throw new Error("CERP_DEMO_MODE=true is required");
  const databaseUrl = required("DATABASE_URL");
  assertDemoDatabase(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const [moduleKey, label, category, apiPrefixes, navPageKeys, sortOrder] of MODULES) {
      await client.query(
        `INSERT INTO public.app_modules
          (module_key, label, description, category, api_prefixes, nav_page_keys,
           enabled_by_default, is_protected, sort_order, is_active)
         VALUES ($1, $2, $2, $3, $4, $5, true, false, $6, true)
         ON CONFLICT (module_key) DO UPDATE
           SET label = EXCLUDED.label, description = EXCLUDED.description,
               category = EXCLUDED.category, api_prefixes = EXCLUDED.api_prefixes,
               nav_page_keys = EXCLUDED.nav_page_keys, sort_order = EXCLUDED.sort_order,
               enabled_by_default = true, is_active = true, updated_at = now()`,
        [moduleKey, label, category, apiPrefixes, navPageKeys, sortOrder],
      );
    }
    await client.query("COMMIT");
    console.log("Demo module catalogue seeded.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Demo module catalogue seed failed");
  process.exitCode = 1;
});
