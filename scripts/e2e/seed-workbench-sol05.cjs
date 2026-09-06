// Completes the existing workbench fixture in the managed, disposable SOL-05 DB.
const url = new URL(process.env.DATABASE_URL || "http://invalid");
if (process.env.CERP_E2E_ISOLATED !== "1" || process.env.CERP_E2E_MANAGED_STACK !== "1"
  || url.hostname !== "127.0.0.1" || url.port !== "55432"
  || url.pathname !== "/cerp_test" || url.username !== "cerp_e2e") {
  throw Error("Managed disposable SOL-05 database required");
}
require(require.resolve("ts-node/register/transpile-only", {
  paths: [require("node:path").dirname(require.resolve("ts-node-dev/package.json"))],
}));
const database = require("../../src/config/database.ts").default;
async function main() {
  try {
    const identity = (await database.query("SELECT current_database() AS db, current_user AS role")).rows[0];
    if (identity.db !== "cerp_test" || identity.role !== "cerp_e2e") throw Error("Unexpected fixture database identity");
    if (process.argv[2] === "restore") {
      const previous = JSON.parse(process.argv[3]);
      for (const flag of previous) {
        if (!["PRODUCTION_WORKBENCH", "PRODUCTION_CONSOLIDATION"].includes(flag.key)
          || typeof flag.enabled !== "boolean") throw Error("Unexpected fixture flag");
        await database.query("UPDATE public.app_feature_flags SET enabled=$2 WHERE key=$1", [flag.key, flag.enabled]);
      }
      return;
    }
    const previous = (await database.query("SELECT key,enabled FROM public.app_feature_flags WHERE key IN ('PRODUCTION_WORKBENCH','PRODUCTION_CONSOLIDATION') ORDER BY key")).rows;
    const { seedProductionWorkbenchFixture } = require("../../src/__tests__/fixtures/production-workbench.fixture.ts");
    const { evaluateOfPreparation, repoSavePreparationDecisions } = require("../../src/module/production/repository/production-preparation.repository.ts");
    const fixture = await seedProductionWorkbenchFixture();
    const id = fixture.ids[2];
    const preparation = await evaluateOfPreparation(database, id);
    await repoSavePreparationDecisions(id, {
      expected_updated_at: preparation.of.updated_at,
      version_id: fixture.version,
      expected_version: preparation.profile_version,
      decisions: {
        material: { mode: "NOT_REQUIRED", reason: "Matière fournie dans cet essai" },
        treatment: { mode: "NOT_REQUIRED", reason: "Aucun traitement demandé" },
        subcontract: { mode: "NOT_REQUIRED", reason: "Fabrication entièrement interne" },
        programming: { mode: "NONE", reason: "Opérations manuelles de démonstration" },
      },
    }, fixture.audit);
    process.stdout.write(JSON.stringify({ id, numero: `${fixture.code}-8`, previous }) + "\n");
  } finally { await database.end(); }
}
main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
