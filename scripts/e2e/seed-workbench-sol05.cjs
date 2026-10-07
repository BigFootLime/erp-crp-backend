// Completes the existing workbench fixture in the managed, disposable SOL-05 DB.
const url = new URL(process.env.DATABASE_URL || "http://invalid");
const managedPort = process.env.CERP_E2E_DB_PORT || "55432";
if (process.env.CERP_E2E_ISOLATED !== "1" || process.env.CERP_E2E_MANAGED_STACK !== "1"
  || !/^\d+$/.test(managedPort) || Number(managedPort) < 1024 || Number(managedPort) > 65535
  || url.hostname !== "127.0.0.1" || url.port !== String(Number(managedPort))
  || url.pathname !== "/cerp_test" || url.username !== "cerp_e2e") {
  throw Error("Managed disposable SOL-05 database required");
}
require("ts-node/register/transpile-only");
const database = require("../../src/config/database.ts").default;
async function main() {
  try {
    const identity = (await database.query("SELECT current_database() AS db, current_user AS role")).rows[0];
    if (identity.db !== "cerp_test" || identity.role !== "cerp_e2e") throw Error("Unexpected fixture database identity");
    if (process.argv[2] === "restore") {
      const previous = JSON.parse(process.argv[3]);
      for (const flag of previous) {
        if (!["PRODUCTION_WORKBENCH", "PRODUCTION_CONSOLIDATION", "PRODUCTION_MATERIAL_WORKFLOW"].includes(flag.key)
          || typeof flag.enabled !== "boolean") throw Error("Unexpected fixture flag");
        await database.query("UPDATE public.app_feature_flags SET enabled=$2 WHERE key=$1", [flag.key, flag.enabled]);
      }
      if (process.argv[4]) {
        const previousCalendar = JSON.parse(process.argv[4]);
        if (previousCalendar !== null && (typeof previousCalendar !== "string" || !/^[0-9a-f-]{36}$/i.test(previousCalendar))) throw Error("Unexpected fixture calendar");
        await database.query("UPDATE public.planning_central_settings SET workshop_calendar_id=$1 WHERE singleton", [previousCalendar]);
      }
      return;
    }
    const { seedProductionWorkbenchFixture, seedWorkbenchStock } = require("../../src/__tests__/fixtures/production-workbench.fixture.ts");
    if (process.argv[2] === "prepare-material") {
      if (!/^\d+$/.test(process.argv[3] || "")) throw Error("Unexpected fixture OF");
      const source = (await database.query("SELECT id,numero,piece_technique_id,created_by FROM public.ordres_fabrication WHERE id=$1", [process.argv[3]])).rows[0];
      if (!source || !/^E2E712-[0-9a-f]{8}-8$/.test(source.numero)) throw Error("Synthetic workbench OF required");
      source.id = Number(source.id);
      const code = source.numero.slice(0, -2);
      const sources = (await database.query("SELECT id,quantite_lancee AS quantite FROM public.ordres_fabrication WHERE numero=ANY($1::text[]) AND piece_technique_id=$2 ORDER BY quantite_lancee", [[source.numero, `${code}-12`], source.piece_technique_id])).rows;
      if (sources.length !== 2 || Number(sources[0].quantite) !== 8 || Number(sources[1].quantite) !== 12) throw Error("Unexpected synthetic consolidation sources");
      await database.query("UPDATE public.app_feature_flags SET enabled=true WHERE key='PRODUCTION_MATERIAL_WORKFLOW'");
      const { randomUUID } = require("node:crypto");
      const { configureOfMaterial, getOfMaterial } = require("../../src/module/production/repository/of-material.repository.ts");
      const { confirmOfMaterial } = require("../../src/module/production/repository/of-material-confirmation.repository.ts");
      const audit = { user_id: Number(source.created_by), ip_address: "127.0.0.1", user_agent: "Managed workbench fixture", device_id: null, client_session_id: null };
      const initial = await getOfMaterial(source.id);
      if (!initial.enabled || initial.needs.length !== 1 || !initial.needs[0].articleId) throw Error("Synthetic raw material need required");
      const stock = await seedWorkbenchStock({ code: `${code}-MP`, piece: source.piece_technique_id, audit }, 35, "LIBERE", {
        articleId: initial.needs[0].articleId, stockUnit: "kg", warehouseCode: "NEW-MP", technicalVersionId: null,
      });
      // One quality-released physical lot is held in three stock locations:
      // each source has its own hold, and the third location covers the surplus.
      // Same-location reservation merging is tracked separately (backend #937).
      const batches = [stock.batch];
      const tx = await database.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("UPDATE public.stock_levels SET qty_total=8 WHERE id=$1::uuid", [stock.level]);
        await tx.query("UPDATE public.stock_batches SET qty_total=8 WHERE id=$1::uuid", [stock.batch]);
        for (const amount of [12, 15]) {
          const location = randomUUID(), level = randomUUID(), batch = randomUUID();
          const locationCode = `${code}-MP-${amount}`;
          await tx.query("INSERT INTO public.locations(id,warehouse_id,code,description) SELECT $1::uuid,warehouse_id,$2,'Emplacement matière synthétique' FROM public.locations WHERE id=$3::uuid", [location, locationCode, stock.location]);
          await tx.query("INSERT INTO public.emplacements(magasin_id,code,name,location_id) SELECT magasin_id,$2,'Emplacement matière synthétique',$1::uuid FROM public.emplacements WHERE location_id=$3::uuid", [location, locationCode, stock.location]);
          await tx.query("INSERT INTO public.stock_levels(id,article_id,unit_id,warehouse_id,location_id,managed_in_stock,qty_total) SELECT $1::uuid,article_id,unit_id,warehouse_id,$2::uuid,true,$3 FROM public.stock_levels WHERE id=$4::uuid", [level, location, amount, stock.level]);
          await tx.query("INSERT INTO public.stock_batches(id,stock_level_id,batch_code,qty_total,lot_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)", [batch, level, locationCode, amount, stock.lot]);
          batches.push(batch);
        }
        await tx.query("COMMIT");
      } catch (error) { await tx.query("ROLLBACK"); throw error; }
      finally { tx.release(); }
      const reserved = [];
      for (const [index, of] of sources.entries()) {
        of.id = Number(of.id);
        let material = await getOfMaterial(of.id);
        if (!material.enabled || material.needs.length !== 1 || !material.operations[0]) throw Error("Unexpected synthetic material dossier");
        const needKey = material.needs[0].key;
        await configureOfMaterial(of.id, needKey, {
          expectedVersion: material.version, idempotencyKey: randomUUID(),
          configuration: {
            operationId: material.operations[0].id,
            requirements: { grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualChecks: [] },
            supplyMode: "PURCHASE", supplierId: null, destinationId: null, allowPartial: false,
            debitRule: { form: "UNIT", stockUnit: "kg", unitsPerBlank: 1, kerfPerBlank: 0, yieldValidated: true },
          },
        }, audit);
        material = await getOfMaterial(of.id);
        const need = material.needs[0];
        const candidate = need.candidates.find(item => item.lot.batchId === batches[index]);
        if (need.blockers.length || !candidate || candidate.reasons.length || candidate.available < need.required) throw Error("Synthetic material is not physically available");
        const confirmed = await confirmOfMaterial(of.id, {
          expectedVersion: material.version, idempotencyKey: randomUUID(),
          selections: [{ needKey, batchId: batches[index], quantity: need.required }], futureSelections: [],
        }, audit, false);
        const quantity = confirmed.coverage.needs[0].reserved;
        if (quantity !== Number(of.quantite)) throw Error("Synthetic reservation quantity mismatch");
        reserved.push(quantity);
      }
      process.stdout.write(JSON.stringify({ reserved, batchId: stock.batch, quantity: 35 }) + "\n");
      return;
    }
    const previous = (await database.query("SELECT key,enabled FROM public.app_feature_flags WHERE key IN ('PRODUCTION_WORKBENCH','PRODUCTION_CONSOLIDATION','PRODUCTION_MATERIAL_WORKFLOW') ORDER BY key")).rows;
    const { evaluateOfPreparation, repoSavePreparationDecisions } = require("../../src/module/production/repository/production-preparation.repository.ts");
    const fixture = await seedProductionWorkbenchFixture();
    const settings = (await database.query("SELECT workshop_calendar_id FROM public.planning_central_settings WHERE singleton")).rows[0];
    if (!settings) throw Error("Workbench fixture requires isolated planning settings");
    const previousWorkshopCalendarId = settings.workshop_calendar_id;
    const calendar = (await database.query(
      `INSERT INTO public.programmation_calendars(code,label,timezone,working_days,day_start,day_end,created_by,updated_by)
       VALUES($1,'Calendrier atelier synthétique','Europe/Paris',ARRAY[1,2,3,4,5]::smallint[],'08:00','16:00',$2,$2) RETURNING id`,
      [`${fixture.code}-CAL`, fixture.audit.user_id],
    )).rows[0];
    await database.query("UPDATE public.planning_central_settings SET workshop_calendar_id=$1 WHERE singleton", [calendar.id]);
    // Priority now starts from the owning customer's order and counts workshop
    // hours. An OF-only 49-hour timestamp cannot prove that business rule.
    const order = (await database.query(
      `INSERT INTO public.commande_client(numero,client_id,date_commande,created_at,created_by,updated_by)
       VALUES($1,'901',CURRENT_DATE-21,now()-interval '21 days',$2,$2) RETURNING id`,
      [`${fixture.code}-CMD`, fixture.audit.user_id],
    )).rows[0];
    await database.query("UPDATE public.ordres_fabrication SET commande_id=$1 WHERE id=ANY($2::bigint[])", [order.id, fixture.ids]);
    const priority = (await database.query(
      "SELECT public.workshop_working_deadline(created_at,48)<now() AS overdue FROM public.commande_client WHERE id=$1",
      [order.id],
    )).rows[0];
    if (priority?.overdue !== true) throw Error("Workbench priority fixture must exceed 48 workshop hours");
    const id = fixture.ids[2];
    const preparation = await evaluateOfPreparation(database, id);
    await repoSavePreparationDecisions(id, {
      expected_updated_at: preparation.of.updated_at,
      version_id: fixture.version,
      expected_version: preparation.profile_version,
      decisions: {
        material: { mode: "REQUIRED" },
        treatment: { mode: "NOT_REQUIRED", reason: "Aucun traitement demandé" },
        subcontract: { mode: "NOT_REQUIRED", reason: "Fabrication entièrement interne" },
        programming: { mode: "NONE", reason: "Opérations manuelles de démonstration" },
      },
    }, fixture.audit);
    process.stdout.write(JSON.stringify({ id, numero: `${fixture.code}-8`, previous, previousWorkshopCalendarId }) + "\n");
  } finally { await database.end(); }
}
main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
