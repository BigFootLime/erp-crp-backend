import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { createPilotFixtureArticle } from "../../../__tests__/fixtures/demand-pilot.fixture";
import { seedWorkbenchStock } from "../../../__tests__/fixtures/production-workbench.fixture";
import { reservePilotOfMaterial } from "../../../__tests__/fixtures/industrial-pilot-material.fixture";
import { releasePilotOf } from "../../../__tests__/fixtures/industrial-pilot-release.fixture";
import { importDemand } from "../../demand-pilot/repository/demand-ingest.repository";
import { saveArticleMapping } from "../../demand-pilot/repository/demand-mapping.repository";
import { prepareFirmDraft } from "../../demand-pilot/services/demand-pilot-firm-draft.service";
import { enqueueIndustrialRun, industrialRunById, industrialTx, processIndustrialRun, validateIndustrialRun } from "../services/industrial-runs.service";
import { executeIndustrialProposals } from "../services/industrial-proposal-execution.service";
import { evaluateOfPreparation, repoReviewPreparationStock, repoSavePreparationDecisions } from "../../production/repository/production-preparation.repository";
import { repoGenerateSelfInspection } from "../../production/repository/self-inspection.repository";
import { repoGetOrdreFabrication, repoUpdateOrdreFabrication, repoSubmitOfTechnicalPreparation, repoValidateOfTechnicalPreparation } from "../../production/repository/production.repository";
import { configureStockLane } from "../../stock/repository/stock-lanes.repository";
import type { AuditContext } from "../repository/planning.repository";
import type { IndustrialProposal } from "../types/industrial-plan.types";
import { updateIndustrialSettings } from "../repository/industrial-settings.repository";
import { repoAnalyzeCommandeStock, repoRunCommandeWorkflowAction } from "../../commande-client/repository/commande-client.repository";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const isolated = process.env.CERP_E2E_ISOLATED === "1" && process.env.CERP_DEMAND_POSTGRES_TEST === "1" && ["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname) && databaseUrl.pathname === "/cerp_test";
const externalCode = process.env.CERP_VISION_PILOT_ARTICLE_CODE ?? "VISION-MAKE-SYNTHETIC";
const quantity = Number(process.env.CERP_VISION_PILOT_QUANTITY ?? "1");
const launchQuantity = Math.ceil(quantity * 100 / 90);
const client = "V" + randomUUID().replace(/-/g, "").slice(0, 2);
const suffix = randomUUID().slice(0, 8);
const article = randomUUID();
const materialArticle = randomUUID();
let actor = 0, secretaryActor = 0, technicalActor = 0, due = "";
let materialStock: Awaited<ReturnType<typeof seedWorkbenchStock>>;
let productTechnical!: { piece: string; version: string };
let beforePlanning: { activation: string; workshop_calendar_id: string | null };
let beforeMaterialWorkflow = false;
let beforeProductionWorkbench = false;
const audit = (): AuditContext => ({ user_id: actor, role: "Directeur", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/planning/industrial", page_key: "planning.industrial", client_session_id: null });
const technicalAudit = (): AuditContext => ({ ...audit(), user_id: technicalActor, role: "Method | Responsable Programmation" });
async function waitRun(id: string) {
  for (let index = 0; index < 12; index++) {
    const run = await industrialRunById(id);
    if (run.status !== "QUEUED") return run;
    await processIndustrialRun();
  }
  return industrialRunById(id);
}

describe.skipIf(!isolated)("firm demand to technically validated OF", () => {
  beforeAll(async () => {
    if (!(quantity > 0) || !Number.isSafeInteger(quantity)) throw new Error("CERP_VISION_PILOT_QUANTITY must be a positive whole number of pieces.");
    actor = Number((await pool.query("SELECT id FROM public.users WHERE is_superadmin LIMIT 1")).rows[0].id);
    secretaryActor = Number((await pool.query<{ id: number }>(
      "INSERT INTO public.users(username,password,role,status,email) VALUES($1,'DISABLED_TEST_CREDENTIAL','Secretaire','Active',$2) RETURNING id",
      ["SEC-" + suffix, "sec-" + suffix + "@example.invalid"],
    )).rows[0].id);
    technicalActor = Number((await pool.query<{ id: number }>(
      "INSERT INTO public.users(username,password,role,status,email) VALUES($1,'DISABLED_TEST_CREDENTIAL','Employee','Active',$2) RETURNING id",
      ["TECH-" + suffix, "tech-" + suffix + "@example.invalid"],
    )).rows[0].id);
    await pool.query(
      "INSERT INTO public.user_role_assignments(user_id,role_key,assigned_by) VALUES($1,'Secretaire',$3),($2,'Employee',$3),($2,'Études-Méthodes',$3)",
      [secretaryActor, technicalActor, actor],
    );
    due = (await pool.query<{ due: string }>("SELECT (CURRENT_DATE + 28)::text AS due")).rows[0].due;
    beforePlanning = (await pool.query("SELECT activation,workshop_calendar_id::text FROM public.planning_central_settings WHERE singleton")).rows[0];
    beforeMaterialWorkflow = (await pool.query<{ enabled: boolean }>("SELECT enabled FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW'")).rows[0].enabled;
    beforeProductionWorkbench = (await pool.query<{ enabled: boolean }>("SELECT enabled FROM public.app_feature_flags WHERE key='PRODUCTION_WORKBENCH'")).rows[0].enabled;
    await industrialTx(async (tx) => {
      await tx.query("UPDATE public.app_feature_flags SET enabled=true WHERE key='PRODUCTION_MATERIAL_WORKFLOW'");
      await tx.query("UPDATE public.app_feature_flags SET enabled=true WHERE key='PRODUCTION_WORKBENCH'");
      // The isolated validation database starts without the commercial unit used by
      // this Vision fixture.  Seed the reference data before creating its lot.
      await tx.query("INSERT INTO public.units(code,label) VALUES('PCE','Pièce') ON CONFLICT(code) DO NOTHING");
      await tx.query("INSERT INTO public.clients(client_id,client_code,company_name) VALUES($1,$2,'Vision isolate') ON CONFLICT(client_id) DO NOTHING", [client, client]);
      const technical = await createPilotFixtureArticle(tx, client, actor, article, "SYN-" + suffix, { publish: false });
      productTechnical = technical;
      await saveArticleMapping(tx, { client_id: client, article_id: article, external_code: externalCode, external_unit: "PCE", units_per_external: 1 }, actor);
      await tx.query("UPDATE public.pieces_techniques SET article_id=$2::uuid WHERE id=$1::uuid", [technical.piece, article]);
      await tx.query("INSERT INTO public.articles(id,root_article_id,version_number,plan_index,code,designation,article_type,unite,article_category,status,commercial_scope,internal_reference,is_sold,stock_managed,family_code) VALUES($1,$1,1,1,$2,'Matière Vision isolée','PURCHASED','PCE','matiere','VALIDE','CRP',$2,false,true,$2)", [materialArticle, "MAT-" + suffix]);
      const calendar = randomUUID(), machine = randomUUID(), gamme = randomUUID(), qualityPlan = randomUUID(), centre = randomUUID();
      await tx.query("INSERT INTO public.programmation_calendars(id,code,label,timezone,working_days,day_start,day_end,active) VALUES($1,$2,'Vision isolé','Europe/Paris',ARRAY[1,2,3,4,5],'06:00','22:00',true)", [calendar, "VSC-" + suffix]);
      await tx.query("UPDATE public.planning_central_settings SET activation='COMMIT',workshop_calendar_id=$1 WHERE singleton", [calendar]);
      await tx.query("INSERT INTO public.production_machine_families(code,libelle) VALUES('VSM','Vision isolé') ON CONFLICT(code) DO NOTHING");
      await tx.query("INSERT INTO public.centres_frais(id,code,name,designation,machine_family_code) VALUES($1,$2,'Centre Vision isolé','Centre Vision isolé','VSM')", [centre, "VSCF-" + suffix]);
      await tx.query("INSERT INTO public.production_cost_center_rates(cf_id,taux_horaire,devise,date_effet,source,created_by) VALUES($1,50,'EUR',CURRENT_DATE,'Recette locale',$2)", [centre, actor]);
      await tx.query("INSERT INTO public.machines(id,code,name,type,status,is_available,machine_family_code,created_by,updated_by) VALUES($1,$2,'Vision isolé','MILLING','ACTIVE',true,'VSM',$3,$3)", [machine, "VSM-" + suffix, actor]);
      await tx.query("INSERT INTO public.planning_resource_calendars(resource_id,machine_id,calendar_id) VALUES($1,$2,$3)", ["machine:" + machine, machine, calendar]);
      await tx.query("INSERT INTO public.gammes(id,piece_technique_version_id,code,designation,statut,is_current,created_by,updated_by) VALUES($1,$2,$3,'Vision isolé','APPLICABLE',true,$4,$4)", [gamme, technical.version, "VSG-" + suffix, actor]);
      await tx.query("INSERT INTO public.pieces_techniques_operations(piece_technique_id,gamme_id,phase,ordre,designation,type_operation,cf_id,machine_id,machine_family_code,coef,tp,tf_unit,qte,temps_fabrication,temps_total) VALUES($1,$2,10,10,'Usinage','FRAISAGE',$3,$4,'VSM',1,0.01,0.001,1,0.001,0.011)", [technical.piece, gamme, centre, machine]);
      await tx.query("INSERT INTO public.pieces_techniques_achats(piece_technique_id,piece_technique_version_id,phase,nom,designation,type_achat,article_id,quantite,unite_prix) VALUES($1,$2,10,'Brut Vision','Brut Vision','MATIERE',$3,1,'PCE')", [technical.piece, technical.version, materialArticle]);
      await tx.query("INSERT INTO public.ged_document_links(document_id,entity_type,entity_id,link_role,created_by) VALUES('92000000-0000-4000-8000-000000000005','PIECE_TECHNIQUE_VERSION',$1,'PLAN_CLIENT',$2)", [technical.version, actor]);
      await tx.query("INSERT INTO public.quality_control_plan(id,code,label,status,trigger_type,piece_version_id,sampling_rule,created_by,updated_by) VALUES($1,$2,'Contrôle Vision isolé','DRAFT','FINAL',$3,'ALL',$4,$4)", [qualityPlan, "VQP-" + suffix, technical.version, actor]);
      await tx.query("INSERT INTO public.quality_control_plan_characteristic(plan_id,characteristic_key,position,label,value_kind,unit,tolerance_min,tolerance_max) VALUES($1,'DIM',1,'Dimension de recette','NUMERIC','mm',0,100)", [qualityPlan]);
      await tx.query("UPDATE public.quality_control_plan SET status='PUBLISHED',published_at=now(),published_by=$2 WHERE id=$1", [qualityPlan, actor]);
      await tx.query("UPDATE public.piece_technique_versions SET statut='APPLICABLE' WHERE id=$1::uuid", [technical.version]);
    });
    materialStock = await seedWorkbenchStock({
      article: materialArticle,
      version: null,
      // The lot remains a material lot; the published technical piece supplies
      // the mandatory quality-control context for the isolated stock fixture.
      piece: productTechnical.piece,
      audit: audit(),
      code: "MAT-" + suffix,
    }, launchQuantity, "LIBERE", {
      articleId: materialArticle,
      stockUnit: "PCE",
      technicalVersionId: null,
    });
    await configureStockLane(materialStock.location, {
      lane: "FREE",
      expected_version: 0,
      default_destination: false,
      request_id: randomUUID(),
      reason: "Zone libre de la matière de recette Vision",
    }, actor);
    const imported = await importDemand({ clientId: client, completeSnapshot: false, idempotencyKey: randomUUID(), actor: { userId: actor }, rows: [{ external_site: "SITE-" + suffix, external_order_key: "OF-" + suffix, external_line_key: "10", external_schedule_key: "S1", source_version: "W44", source_as_of: new Date().toISOString(), kind: "FIRM", quantity, unit: "PCE", quantity_basis: "REMAINING", need_date: due, article_code: externalCode }] });
    const revision = (await pool.query<{ id: string }>("SELECT id::text FROM public.demand_pilot_revisions WHERE import_id=$1::uuid", [imported.import_id])).rows[0];
    await prepareFirmDraft({ client_id: client, revision_ids: [revision.id], lines: [{ revision_id: revision.id, designation: externalCode, prix_unitaire_ht: 1, taux_tva: 20, remise_ligne: 0 }] }, secretaryActor, randomUUID());
    const order = (await pool.query<{ id: string }>(
      "SELECT id::text FROM public.commande_client WHERE client_id=$1 ORDER BY id DESC LIMIT 1",
      [client],
    )).rows[0];
    if (!order) throw new Error("The pilot firm order was not materialized.");
    await repoRunCommandeWorkflowAction(order.id, { action: "start_analysis", commentaire: "Recette secrétaire" }, secretaryActor, "Secretaire");
    await repoRunCommandeWorkflowAction(order.id, { action: "request_stock_check", commentaire: "Contrôle OLD/NEW demandé" }, secretaryActor, "Secretaire");
    const stock = await repoAnalyzeCommandeStock(order.id, {
      user_id: technicalActor, user_role: "Method | Responsable Programmation", ip: null, user_agent: null,
      device_type: null, os: null, browser: null, path: "/commandes/stock", page_key: "commandes.stock", client_session_id: null,
    });
    expect(stock?.suggested_scenario).toBe("LIVRAISON_AND_OF");
    await repoRunCommandeWorkflowAction(order.id, { action: "check_stock", commentaire: "Contrôle stock technique validé" }, technicalActor, "Method | Responsable Programmation");
    await industrialTx(tx => updateIndustrialSettings(tx, actor, {
      client_id: client, contracts: [], articles: [{
        article_id: article, family: "Vision", lead_days: 2, unit_cost_eur: 1, lot_size: 1, yield_percent: 90,
      }],
    }));
  });
  afterAll(async () => {
    if (beforePlanning) {
      await pool.query("UPDATE public.app_feature_flags SET enabled=$1 WHERE key='PRODUCTION_MATERIAL_WORKFLOW'", [beforeMaterialWorkflow]);
      await pool.query("UPDATE public.app_feature_flags SET enabled=$1 WHERE key='PRODUCTION_WORKBENCH'", [beforeProductionWorkbench]);
      await pool.query("UPDATE public.planning_central_settings SET activation=$1,workshop_calendar_id=$2::uuid WHERE singleton", [beforePlanning.activation, beforePlanning.workshop_calendar_id]);
    }
    await pool.end();
  });
  it("creates, prepares and releases an OF from the validated capacity proposal", async () => {
    const start = (await pool.query<{ day: string }>("SELECT CURRENT_DATE::text AS day")).rows[0].day;
    const queued = await enqueueIndustrialRun({ client_id: client, start, label: "Vision firm MAKE", capacity_percent: 100, months: 18, weeks: 26 }, actor);
    const ready = await waitRun(queued.id);
    expect(ready.status).toBe("READY");
    const index = ready.result.proposals.findIndex((proposal: IndustrialProposal) => proposal.kind === "MAKE" && proposal.article_id === article && proposal.due === due);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(ready.result.proposals[index]).toMatchObject({
      quantity: launchQuantity, required_good_quantity: quantity, expected_good_quantity: quantity, yield_percent: 90,
    });
    expect(ready.result.placements).toEqual(expect.arrayContaining([expect.objectContaining({ article_id: article, requested: due, status: "CAPACITY_SIMULATED" })]));
    await validateIndustrialRun(queued.id, actor);
    const executionKey = randomUUID();
    const execution = await executeIndustrialProposals(queued.id, { proposal_indexes: [index], request_key: executionKey }, technicalAudit());
    expect(execution).toMatchObject({ outcomes: [expect.objectContaining({ status: "EXECUTED", target_type: "OF" })] });
    const ofId = Number((execution.outcomes[0] as { target_id: string }).target_id);
    const sizes = await pool.query<{ launched: number; ordered: number }>(
      `SELECT of.quantite_lancee::float8 AS launched, line.quantite::float8 AS ordered
       FROM public.ordres_fabrication of JOIN public.commande_ligne line ON line.id=of.commande_ligne_id
       WHERE of.id=$1`, [ofId],
    );
    expect(sizes.rows).toEqual([{ launched: launchQuantity, ordered: quantity }]);
    const replay = await executeIndustrialProposals(queued.id, { proposal_indexes: [index], request_key: executionKey }, technicalAudit());
    expect(replay.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ status: "EXECUTED", target_type: "OF", target_id: String(ofId) })]));
    // The native OF editor can change a draft without overwriting the customer demand.
    const draft = await repoGetOrdreFabrication({ id: ofId, user_id: actor });
    const editAudit = { ...audit(), user_role: "Production" };
    const adjusted = await repoUpdateOrdreFabrication({ id: ofId, audit: editAudit,
      patch: { quantite_lancee: launchQuantity + 8, expected_updated_at: draft!.updated_at } });
    expect(adjusted?.quantite_lancee).toBe(launchQuantity + 8);
    const orderLine = await pool.query("SELECT quantite::float8 AS ordered FROM public.commande_ligne WHERE commande_id=$1 AND article_id=$2", [draft!.commande_id, article]);
    expect(orderLine.rows).toEqual([{ ordered: quantity }]);
    await repoUpdateOrdreFabrication({ id: ofId, audit: editAudit,
      patch: { quantite_lancee: launchQuantity, expected_updated_at: adjusted!.updated_at } });
    let preparation = await evaluateOfPreparation(pool, ofId);
    preparation = await repoSavePreparationDecisions(ofId, { expected_updated_at: preparation.of.updated_at, version_id: productTechnical.version, expected_version: preparation.profile_version, decisions: { material: { mode: "REQUIRED" }, treatment: { mode: "NOT_REQUIRED", reason: "Aucun traitement" }, subcontract: { mode: "NOT_REQUIRED", reason: "Interne" }, programming: { mode: "NONE", reason: "Non requis" } } }, technicalAudit());
    preparation = await repoReviewPreparationStock(ofId, { expected_updated_at: preparation.of.updated_at, source_hash: preparation.stock_hash, reason: "Stock de recette contrôlé avant gel technique" }, technicalAudit());
    preparation = await repoGenerateSelfInspection(ofId, preparation.of.updated_at, technicalAudit());
    expect(preparation.ready, JSON.stringify(preparation)).toBe(true);
    await repoSubmitOfTechnicalPreparation({ id: ofId, body: { expected_updated_at: preparation.of.updated_at }, audit: technicalAudit() });
    preparation = await evaluateOfPreparation(pool, ofId);
    await repoValidateOfTechnicalPreparation({ id: ofId, body: { expected_updated_at: preparation.of.updated_at }, audit: technicalAudit() });
    const validated = await evaluateOfPreparation(pool, ofId);
    expect(validated.of.technical_readiness).toBe("VALIDATED");
    const operation = (await pool.query<{ id: string }>("SELECT id::text FROM public.of_operations WHERE of_id=$1 ORDER BY phase,id LIMIT 1", [ofId])).rows[0];
    expect(operation).toBeDefined();
    const reserved = await reservePilotOfMaterial(ofId, technicalAudit(), {
      batchId: materialStock.batch,
      quantity: launchQuantity,
      configuration: { operationId: operation.id, requirements: { grade: null, condition: null, ownerClientId: null, dimensions: {}, certificates: [], manualChecks: [] }, supplyMode: "PURCHASE", supplierId: null, destinationId: null, allowPartial: false, debitRule: { form: "UNIT", stockUnit: "PCE", unitsPerBlank: 1, kerfPerBlank: 0, yieldValidated: true } },
    });
    expect(reserved.material_required).toBe(true);
    const placement = ready.result.placements.find((item: { article_id: string; requested: string; operations: unknown[] }) => item.article_id === article && item.requested === due)!;
    await expect(releasePilotOf(ofId, actor, placement.operations)).resolves.toMatchObject({ statut: "EN_COURS", releases: 1 });
    const queuedAgain = await enqueueIndustrialRun({ client_id: client, start, label: "Vision firm MAKE replay", capacity_percent: 100, months: 18, weeks: 26 }, actor);
    const recalculated = await waitRun(queuedAgain.id);
    expect(recalculated.status).toBe("READY");
    await validateIndustrialRun(queuedAgain.id, actor);
    const repeatedEntries: Array<{ proposal: IndustrialProposal; proposalIndex: number }> = recalculated.result.proposals
      .map((proposal: IndustrialProposal, proposalIndex: number) => ({ proposal, proposalIndex }))
      .filter((entry: { proposal: IndustrialProposal }) => entry.proposal.kind === "MAKE" && entry.proposal.article_id === article && entry.proposal.due === due);
    const repeatedMakeIndexes = repeatedEntries.map((entry: { proposal: IndustrialProposal; proposalIndex: number }) => entry.proposalIndex);
    if (repeatedMakeIndexes.length) {
      const repeated = await executeIndustrialProposals(queuedAgain.id, { proposal_indexes: repeatedMakeIndexes, request_key: randomUUID() }, technicalAudit());
      const repeatedOutcomes = repeated.outcomes as Array<{ status: string; target_id?: string | null }>;
      expect(repeatedOutcomes).toHaveLength(repeatedMakeIndexes.length);
      for (const outcome of repeatedOutcomes) {
        expect(outcome.status).toBe("REVIEW");
        expect(outcome.target_id ?? null).toBeNull();
      }
    }
    const roots = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM public.ordres_fabrication WHERE client_id=$1 AND article_id=$2", [client, article]);
    expect(roots.rows[0].count).toBe("1");
  });
});
