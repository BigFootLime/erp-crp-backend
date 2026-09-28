import { HttpError } from "../../../utils/httpError";
import { repoCreateClient } from "../../client/repository/client.repository";
import { svcCreateDevis, svcConvertDevisToCommande, svcGetDevis, svcUpdateDevis } from "../../devis/services/devis.service";
import { generateAffairesFromOrderSVC, runCommandeWorkflowActionSVC } from "../../commande-client/services/commande-client.service";
import { svcAutoPlanPlanning } from "../../planning/services/planning.service";
import { svcGetOfReadiness, svcGetOfReceiptContext, svcReleaseOrdreFabrication } from "../../production/services/production.service";
import { svcFinishOperation, svcPauseExecution, svcPreviewFinishOperation, svcResumeExecution, svcStartExecution, svcStopExecution } from "../../production/services/production-execution.service";
import { isDemoMode } from "../../../config/demo-mode";
import type { PresentationAction, PresentationActor, PresentationScenario, PresentationStatus } from "../types/demo-presentation.types";
import { adoptNativeArticle, adoptNativeDelivery, adoptNativeGamme, adoptNativePiece, adoptNativeQualityPlan, adoptNativeQualityRelease, adoptNativeReceipt, assertNativeDeliveryShipped, assertNativeProductionFinished, assertPresentationFixture, createOrResumePresentation, findExistingPresentationProduction, findFixtureArticleId, findPresentationGammePreset, findPreparedClient, findPreparedQuote, findScenarioOfAffaire, findScenarioOfStatus, findScenarioOperation, getPresentationScenario, hasPresentationReceipt, recordPresentationReceipt, updatePresentationScenario, withPresentationLock } from "../repository/demo-presentation.repository";

type RequestContext = { ip: string | null; user_agent: string | null; path: string | null; page_key: string | null; client_session_id: string | null };

function audit(actor: PresentationActor, context: RequestContext) {
  return {
    user_id: actor.id, user_role: actor.role ?? null, role: actor.role ?? null,
    ip: context.ip, user_agent: context.user_agent, device_type: null, os: null, browser: null,
    path: context.path, page_key: context.page_key, client_session_id: context.client_session_id,
  };
}

function key(scenario: PresentationScenario, action: string): string {
  return `demo-presentation:${scenario.id}:${action}`;
}

function requireState(scenario: PresentationScenario, states: readonly PresentationStatus[]): void {
  if (!states.includes(scenario.status)) {
    throw new HttpError(409, "DEMO_SCENARIO_STEP_INVALID", "Cette étape ne correspond pas à l'état courant de la démonstration.", {
      status: scenario.status,
    });
  }
}

export function nextPresentationAction(status: PresentationStatus): PresentationAction | null {
  switch (status) {
    case "INITIALIZING":
    case "CLIENT_PREPARED": return "adopt_client";
    case "CLIENT_CREATED": return "prepare_piece";
    case "PIECE_PREPARED": return "adopt_piece";
    case "PIECE_CREATED": return "prepare_gamme";
    case "GAMME_PREPARED": return "adopt_gamme";
    case "GAMME_APPLICABLE": return "prepare_article";
    case "ARTICLE_PREPARED": return "adopt_article";
    case "ARTICLE_CREATED": return "prepare_devis";
    case "QUOTE_PREPARED": return "adopt_devis";
    case "QUOTE_DRAFT": return "convert_quote";
    case "COMMANDE_CREATED": return "generate_affaires";
    case "AFFAIRE_CREATED": return "generate_ofs";
    case "PRODUCTION_READY": return "plan";
    case "PLANNED": return "release_operator";
    case "OPERATOR_READY": return "start_operator";
    case "RUNNING": return "declare_quantity";
    case "PAUSED": return "resume_operator";
    case "QUANTITY_DECLARED": return "finish_operation";
    case "OPERATION_FINISHED": return "finish_of";
    case "OF_FINISHED": return "prepare_receipt";
    case "COMPLETED": return "prepare_receipt";
    case "RECEIPT_PREPARED": return "adopt_receipt";
    case "RECEIPTED": return "prepare_delivery";
    case "DELIVERY_PREPARED": return "adopt_delivery";
    case "DELIVERY_CREATED": return "prepare_quality_plan";
    case "QUALITY_PLAN_PREPARED": return "adopt_quality_plan";
    case "QUALITY_PLAN_PUBLISHED": return "prepare_quality_release";
    case "QUALITY_RELEASE_PREPARED": return "adopt_quality_release";
    case "QUALITY_RELEASED": return "ship_delivery";
    default: return null;
  }
}

const presentationReleaseOverrideBlockers = ["PROGRAM_OR_INSTRUCTION_MISSING", "QUALITY_PLAN_MISSING"] as const;

/** The demo has no document/upload or quality-control surface. It may record a
 * controlled release only for a non-empty subset of those two evidences. */
export function isPermittedPresentationReleaseOverride(blockers: readonly string[]): boolean {
  return blockers.length > 0 && blockers.every((blocker) =>
    presentationReleaseOverrideBlockers.includes(blocker as typeof presentationReleaseOverrideBlockers[number])
  );
}

export function presentationResponse(scenario: PresentationScenario) {
  const steps: Record<PresentationStatus, string> = {
    INITIALIZING: "client_prepared", CLIENT_PREPARED: "client_prepared", CLIENT_CREATED: "client_created", PIECE_PREPARED: "piece_prepared", PIECE_CREATED: "piece_created", GAMME_PREPARED: "gamme_prepared", GAMME_APPLICABLE: "gamme_applicable", ARTICLE_PREPARED: "article_prepared", ARTICLE_CREATED: "article_created", QUOTE_PREPARED: "quote_prepared", QUOTE_DRAFT: "quote_created", COMMANDE_CREATED: "quote_converted",
    AFFAIRE_CREATED: "affaires_generated", PRODUCTION_READY: "ofs_generated", PLANNED: "planned", OPERATOR_READY: "operator_released",
    RUNNING: "operator_started", PAUSED: "operator_paused", QUANTITY_DECLARED: "quantity_declared", OPERATION_FINISHED:"operation_finished", OF_FINISHED:"of_finished", COMPLETED: "operator_stopped", RECEIPT_PREPARED:"receipt_prepared", RECEIPTED:"receipted", DELIVERY_PREPARED:"delivery_prepared", DELIVERY_CREATED:"delivery_created", QUALITY_PLAN_PREPARED:"quality_plan_prepared", QUALITY_PLAN_PUBLISHED:"quality_plan_published", QUALITY_RELEASE_PREPARED:"quality_release_prepared", QUALITY_RELEASED:"quality_released", SHIPPED:"shipped",
  };
  return {
    scenario: { id: scenario.id, status: scenario.status === "COMPLETED" ? "COMPLETED" : "ACTIVE", step: steps[scenario.status] },
    entities: {
      client: scenario.client_id ? { id: scenario.client_id } : null,
      piece: scenario.piece_technique_id ? { id: scenario.piece_technique_id, version_id: scenario.piece_technique_version_id } : null,
      gamme: scenario.gamme_id ? { id: scenario.gamme_id } : null,
      article: scenario.article_id ? { id: scenario.article_id } : null,
      devis: scenario.devis_id ? { id: scenario.devis_id } : null,
      commande: scenario.commande_id ? { id: scenario.commande_id } : null,
      affaire: scenario.affaire_id ? { id: scenario.affaire_id } : null,
      of: scenario.of_id ? { id: scenario.of_id } : null,
      operation: scenario.operation_id ? { id: scenario.operation_id } : null,
      execution: scenario.execution_id ? { id: scenario.execution_id } : null,
      receipt: scenario.receipt_id ? { id: scenario.receipt_id } : null,
      lot: scenario.lot_id ? { id: scenario.lot_id } : null,
      livraison: scenario.livraison_id ? { id: scenario.livraison_id } : null,
      qualityPlan: scenario.quality_plan_id ? { id: scenario.quality_plan_id } : null,
      quality: scenario.quality_control_id ? { id: scenario.quality_control_id, decision_id: scenario.quality_release_decision_id } : null,
    },
    next_action: nextPresentationAction(scenario.status),
    ...(scenario.status === "INITIALIZING" || scenario.status === "CLIENT_PREPARED" ? { prepared: { client: preparedClient(scenario) } } : {}),
    capabilities: {
      documents: false, uploads: false, external_integrations: false, destructive_actions: false,
      quality_validation: false, controlled_release_override: true,
    },
  };
}

function luhnCheckDigit(value: string): string {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    let digit = Number(value[value.length - 1 - index]);
    if (index % 2 === 0) digit *= 2;
    sum += digit > 9 ? digit - 9 : digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function preparedClient(scenario: PresentationScenario) {
  const digits = scenario.id.replace(/-/g, "").split("").map((char) => (parseInt(char, 16) % 10).toString()).join("");
  const siretBase = `9${digits.slice(0, 12)}`;
  const suffix = scenario.id.slice(0, 8).toUpperCase();
  return {
    company_name: `Atelier Présentation ${suffix}`,
    email: `contact+${scenario.id.slice(0, 8)}@demo.cerp.invalid`,
    siret: `${siretBase}${luhnCheckDigit(siretBase)}`,
    siren: siretBase.slice(0, 9), vat_number: "FR12123456789", phone: "0478000000", devise: "EUR",
    primary_contact: { first_name: "Camille", last_name: "Martin", email: `camille+${scenario.id.slice(0, 8)}@demo.cerp.invalid`, phone_direct: "0478000000", role: "Achats", civility: "Madame" },
    bill_address: { name: "Facturation", house_number: "12", street: "Rue de la Démonstration", postal_code: "69007", city: "Lyon", country: "France" },
    delivery_address: { name: "Livraison", house_number: "12", street: "Rue de la Démonstration", postal_code: "69007", city: "Lyon", country: "France" },
  };
}

async function preparedQuote(scenario: PresentationScenario) {
  if (!scenario.client_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "Le client de démonstration est absent.");
  const articleId = scenario.article_id ?? await findFixtureArticleId(scenario.piece_technique_id);
  return { client_id: scenario.client_id, statut: "BROUILLON" as const, remise_globale: 0, total_ht: 0, total_ttc: 0,
    lignes: [{ article_id: articleId, piece_technique_id: scenario.piece_technique_id, code_piece: "DEMO-PT-001", description: "Support de guidage — démonstration", quantite: 3, unite: "U", prix_unitaire_ht: 240, remise_ligne: 0, taux_tva: 20 }] };
}

async function prepareClient(actor: PresentationActor, startKey: string) {
  const scenario = await createOrResumePresentation(actor.id, startKey);
  return scenario;
}

/** Compatibility only for an already loaded v2 frontend. New presentation UI
 * uses prepare/adopt and native forms; this path is not advertised to it. */
async function legacyStartScenario(actor: PresentationActor, context: RequestContext, startKey: string) {
  let scenario = await createOrResumePresentation(actor.id, startKey);
  if (scenario.status !== "INITIALIZING") return scenario;
  const clientPreset = preparedClient(scenario);
  const client = await repoCreateClient({
    ...clientPreset, status: "prospect", blocked: false, creation_date: new Date().toISOString().slice(0, 10), payment_mode_ids: [], contacts: [], quality_levels: [],
  }, audit(actor, context), scenario.id);
  scenario = await updatePresentationScenario(scenario.id, actor.id, { client_id: client.client_id });
  const quotePreset = await preparedQuote(scenario);
  const devis = await svcCreateDevis(quotePreset, actor.id, [], { idempotency_key: key(scenario, "quote"), audit: audit(actor, context) });
  return updatePresentationScenario(scenario.id, actor.id, { devis_id: devis.id, status: "QUOTE_DRAFT" });
}

async function adoptClient(scenario: PresentationScenario, actor: PresentationActor, clientId?: string) {
  requireState(scenario, ["INITIALIZING", "CLIENT_PREPARED"]);
  const preset = preparedClient(scenario);
  const adoptedId = await findPreparedClient({ scenario, userId: actor.id, companyName: preset.company_name, siret: preset.siret, email: preset.email, clientId });
  return updatePresentationScenario(scenario.id, actor.id, { client_id: adoptedId, status: "CLIENT_CREATED" });
}

async function prepareQuote(scenario: PresentationScenario, actor: PresentationActor): Promise<PresentationScenario> {
  requireState(scenario, ["ARTICLE_CREATED"]);
  return updatePresentationScenario(scenario.id, actor.id, { status: "QUOTE_PREPARED" });
}

async function preparePiece(s: PresentationScenario, actor: PresentationActor) { requireState(s,["CLIENT_CREATED"]); return updatePresentationScenario(s.id,actor.id,{status:"PIECE_PREPARED"}); }
async function adoptPiece(s: PresentationScenario, actor: PresentationActor, id?: string) { requireState(s,["PIECE_PREPARED"]); const p=await adoptNativePiece({scenario:s,userId:actor.id,pieceId:id}); return updatePresentationScenario(s.id,actor.id,{piece_technique_id:p.piece_id,piece_technique_version_id:p.version_id,status:"PIECE_CREATED"}); }
async function prepareGamme(s: PresentationScenario, actor: PresentationActor) { requireState(s,["PIECE_CREATED"]); return updatePresentationScenario(s.id,actor.id,{status:"GAMME_PREPARED"}); }
async function adoptGamme(s: PresentationScenario, actor: PresentationActor, id?: string) { requireState(s,["GAMME_PREPARED"]); const g=await adoptNativeGamme({scenario:s,userId:actor.id,gammeId:id}); return updatePresentationScenario(s.id,actor.id,{gamme_id:id,machine_id:g.machine_id,status:"GAMME_APPLICABLE"}); }
async function prepareArticle(s: PresentationScenario, actor: PresentationActor) { requireState(s,["GAMME_APPLICABLE"]); return updatePresentationScenario(s.id,actor.id,{status:"ARTICLE_PREPARED"}); }
async function adoptArticle(s: PresentationScenario, actor: PresentationActor, id?: string) { requireState(s,["ARTICLE_PREPARED"]); const a=await adoptNativeArticle({scenario:s,userId:actor.id,articleId:id}); return updatePresentationScenario(s.id,actor.id,{article_id:a.article_id,status:"ARTICLE_CREATED"}); }
async function prepareReceipt(s: PresentationScenario, actor: PresentationActor) { requireState(s,["COMPLETED"]); if(!s.of_id) throw new HttpError(409,"DEMO_SCENARIO_INCOMPLETE","OF absent."); const c=await svcGetOfReceiptContext({of_id:s.of_id}); if(c.qty_ok_receivable<3 || !c.default_location_id) throw new HttpError(409,"DEMO_RECEIPT_NOT_READY","La réception native n'est pas prête."); return updatePresentationScenario(s.id,actor.id,{status:"RECEIPT_PREPARED"}); }
async function adoptReceipt(s: PresentationScenario, actor: PresentationActor, id?: string) { requireState(s,["RECEIPT_PREPARED"]); const r=await adoptNativeReceipt({scenario:s,receiptId:id}); return updatePresentationScenario(s.id,actor.id,{receipt_id:r.receipt_id,lot_id:r.lot_id,stock_movement_id:r.stock_movement_id,reservation_id:r.reservation_id,status:"RECEIPTED"}); }
async function prepareDelivery(s: PresentationScenario, actor: PresentationActor) { requireState(s,["RECEIPTED"]); if(!s.lot_id || !s.commande_id) throw new HttpError(409,"DEMO_SCENARIO_INCOMPLETE","Lot ou commande absent."); return updatePresentationScenario(s.id,actor.id,{status:"DELIVERY_PREPARED"}); }
async function adoptDelivery(s: PresentationScenario, actor: PresentationActor, id?: string) { requireState(s,["DELIVERY_PREPARED"]); const d=await adoptNativeDelivery({scenario:s,livraisonId:id}); return updatePresentationScenario(s.id,actor.id,{livraison_id:d.livraison_id,status:"DELIVERY_CREATED"}); }
async function prepareQualityPlan(s: PresentationScenario, actor: PresentationActor) { requireState(s,["DELIVERY_CREATED"]); if(!s.article_id) throw new HttpError(409,"DEMO_SCENARIO_INCOMPLETE","Article absent."); return updatePresentationScenario(s.id,actor.id,{status:"QUALITY_PLAN_PREPARED"}); }
async function adoptQualityPlan(s: PresentationScenario, actor: PresentationActor, id?: string) { requireState(s,["QUALITY_PLAN_PREPARED"]); const q=await adoptNativeQualityPlan({scenario:s,userId:actor.id,qualityPlanId:id}); return updatePresentationScenario(s.id,actor.id,{quality_plan_id:q.quality_plan_id,status:"QUALITY_PLAN_PUBLISHED"}); }
async function prepareQualityRelease(s: PresentationScenario, actor: PresentationActor) { requireState(s,["QUALITY_PLAN_PUBLISHED"]); if(!s.livraison_id || !s.lot_id) throw new HttpError(409,"DEMO_SCENARIO_INCOMPLETE","Bon de livraison ou lot absent."); return updatePresentationScenario(s.id,actor.id,{status:"QUALITY_RELEASE_PREPARED"}); }
async function adoptQualityRelease(s: PresentationScenario, actor: PresentationActor, qualityControlId?: string, decisionId?: string) { requireState(s,["QUALITY_RELEASE_PREPARED"]); const q=await adoptNativeQualityRelease({scenario:s,qualityControlId,decisionId}); return updatePresentationScenario(s.id,actor.id,{quality_control_id:q.quality_control_id,quality_release_decision_id:q.decision_id,status:"QUALITY_RELEASED"}); }
async function shipDelivery(s: PresentationScenario, actor: PresentationActor) { requireState(s,["QUALITY_RELEASED"]); await assertNativeDeliveryShipped({scenario:s}); return updatePresentationScenario(s.id,actor.id,{status:"SHIPPED"}); }
async function finishOperation(s: PresentationScenario, actor: PresentationActor) { requireState(s,["QUANTITY_DECLARED"]); await assertNativeProductionFinished(s,false); return updatePresentationScenario(s.id,actor.id,{status:"OPERATION_FINISHED"}); }
async function finishOf(s: PresentationScenario, actor: PresentationActor) { requireState(s,["OPERATION_FINISHED"]); await assertNativeProductionFinished(s,true); return updatePresentationScenario(s.id,actor.id,{status:"OF_FINISHED"}); }

async function adoptQuote(scenario: PresentationScenario, actor: PresentationActor, devisId?: number): Promise<PresentationScenario> {
  requireState(scenario, ["QUOTE_PREPARED"]);
  const preset = await preparedQuote(scenario);
  const adoptedId = await findPreparedQuote({ scenario, userId: actor.id, articleId: preset.lignes[0].article_id, devisId });
  return updatePresentationScenario(scenario.id, actor.id, { devis_id: adoptedId, status: "QUOTE_DRAFT" });
}

async function convertQuote(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  requireState(scenario, ["QUOTE_DRAFT"]);
  if (!scenario.devis_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "Le devis de démonstration est absent.");
  await assertPresentationFixture(scenario);
  const ctx = { audit: audit(actor, context) };
  // Recover a timeout after either durable commercial transition without trying
  // to move an accepted quote backwards to ENVOYE.
  const current = await svcGetDevis(scenario.devis_id, "");
  const statut = current?.devis.statut;
  if (statut === "BROUILLON") await svcUpdateDevis(scenario.devis_id, { statut: "ENVOYE" }, actor.id, [], ctx);
  const afterSend = statut === "BROUILLON" ? "ENVOYE" : statut;
  if (afterSend === "ENVOYE") await svcUpdateDevis(scenario.devis_id, { statut: "ACCEPTE" }, actor.id, [], ctx);
  if (afterSend !== "ENVOYE" && afterSend !== "ACCEPTE") {
    throw new HttpError(409, "DEMO_QUOTE_STATE_INVALID", "Le devis de démonstration ne peut pas être converti dans son état actuel.", { statut });
  }
  const commande = await svcConvertDevisToCommande(scenario.devis_id, {
    idempotency_key: key(scenario, "convert"),
    audit: audit(actor, context),
    presentation_fixture: {
      piece_technique_id: scenario.piece_technique_id,
      piece_technique_version_id: scenario.piece_technique_version_id,
    },
  });
  if (!commande) throw new HttpError(409, "DEMO_COMMANDE_NOT_CREATED", "La commande de démonstration n'a pas pu être créée.");
  return updatePresentationScenario(scenario.id, actor.id, { commande_id: commande.id, status: "COMMANDE_CREATED" });
}

async function completeCommercialLaunchChecks(scenario: PresentationScenario, actor: PresentationActor): Promise<void> {
  if (!scenario.commande_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "La commande de démonstration est absente.");
  // A quote conversion starts a v1 customer order at ATTENTE_TECHNIQUE. Advance
  // its active technical and stock checkpoints instead of bypassing either check.
  for (const action of ["complete_technical_analysis", "check_stock"] as const) {
    await runCommandeWorkflowActionSVC(
      String(scenario.commande_id),
      { action, commentaire: "Étape automatique de la présentation CERP+" },
      actor.id,
      actor.role ?? null,
    );
  }
}

async function generateProduction(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  requireState(scenario, ["COMMANDE_CREATED"]);
  if (!scenario.commande_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "La commande de démonstration est absente.");
  // Recover a committed generator before replaying workflow actions after a timeout.
  const persisted = await findExistingPresentationProduction(scenario.commande_id);
  if (persisted) return updatePresentationScenario(scenario.id, actor.id, { ...persisted, status: "AFFAIRE_CREATED" });
  // This is the existing commercial-to-production generator. It creates the
  // delivery affaire and recursively creates the OF from the applicable gamme.
  await completeCommercialLaunchChecks(scenario, actor);
  const out = await generateAffairesFromOrderSVC(String(scenario.commande_id), { decision: "SHIP_ALL_TOGETHER", livraison_count: 1, lines: [] }, audit(actor, context));
  if (!out) throw new HttpError(404, "DEMO_COMMANDE_NOT_FOUND", "La commande de démonstration est introuvable.");
  // The generator creates a principal commercial affaire and a delivery affaire.
  // The root OF belongs to the delivery affaire, which is the association the
  // presentation exposes for the production part of the journey.
  const affaireId = out.livraison_affaire_id ?? out.principal_affaire_id ?? out.affaire_ids?.[0] ?? null;
  const ofId = out.root_of_ids?.[0] ?? out.of_ids?.[0] ?? null;
  if (!affaireId || !ofId) throw new HttpError(409, "DEMO_PRODUCTION_NOT_READY", "La génération métier n'a pas produit l'affaire et l'OF attendus.");
  return updatePresentationScenario(scenario.id, actor.id, { affaire_id: affaireId, of_id: ofId, status: "AFFAIRE_CREATED" });
}

async function plan(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  requireState(scenario, ["PRODUCTION_READY"]);
  if (!scenario.of_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "L'ordre de fabrication est absent.");
  const operationId = await findScenarioOperation(scenario);
  const result = await svcAutoPlanPlanning({
    body: { of_ids: [scenario.of_id], step_minutes: 15, skip_planned: true, include_done: false, fallback_resource: { resource_type: "MACHINE", resource_id: scenario.machine_id } },
    audit: audit(actor, context),
  });
  const alreadyPlanned = result.skipped_operations.some((entry) =>
    entry.of_operation_id === operationId && entry.reason === "ALREADY_PLANNED" && Boolean(entry.existing_event_id)
  );
  if (result.summary.created < 1 && !alreadyPlanned) {
    throw new HttpError(409, "DEMO_PLANNING_NOT_READY", "L'OF de démonstration ne peut pas être planifié.", { skipped: result.skipped_operations });
  }
  return updatePresentationScenario(scenario.id, actor.id, { operation_id: operationId, status: "PLANNED" });
}

async function releaseOperator(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  requireState(scenario, ["PLANNED"]);
  if (!scenario.of_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "L'ordre de fabrication est absent.");
  const ofId = scenario.of_id;
  // Repair a scenario created by an earlier presentation build that stored the
  // principal affaire although the OF is attached to the delivery affaire.
  const ofAffaireId = await findScenarioOfAffaire(ofId);
  if (scenario.affaire_id !== ofAffaireId) {
    scenario = await updatePresentationScenario(scenario.id, actor.id, { affaire_id: ofAffaireId });
  }
  const ofStatus = await findScenarioOfStatus(ofId);
  if (["BROUILLON", "PLANIFIE"].includes(ofStatus ?? "")) {
    // Starting a real operation never silently promotes a planned OF. The
    // canonical release service checks readiness, records the decision/audit,
    // then performs the EN_COURS transition.
    const readiness = await svcGetOfReadiness({ id: ofId });
    const blockers = readiness?.blockers ?? [];
    const onlySyntheticPresentationEvidenceMissing = isPermittedPresentationReleaseOverride(blockers);
    await svcReleaseOrdreFabrication({
      id: ofId,
      // The demo deliberately exposes neither uploads nor quality controls.
      // A release remains explicit, audited and bounded to those two missing
      // synthetic evidences; every operational/material blocker still fails.
      body: onlySyntheticPresentationEvidenceMissing
        ? {
            override: true,
            override_blocker_codes: blockers as Array<"PROGRAM_OR_INSTRUCTION_MISSING" | "QUALITY_PLAN_MISSING">,
            override_reason: "Présentation CERP+ : documents et plan de contrôle non inclus.",
          }
        : { override: false },
      audit: audit(actor, context),
    });
  } else if (!["EN_COURS", "EN_PAUSE"].includes(ofStatus ?? "")) {
    throw new HttpError(409, "DEMO_OF_RELEASE_STATE_INVALID", "L'ordre de fabrication de démonstration ne peut pas être lancé dans son état actuel.", { statut: ofStatus });
  }
  return updatePresentationScenario(scenario.id, actor.id, { status: "OPERATOR_READY" });
}

async function startOperator(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  // v2 callers may still send start directly; the v3 UI makes the audited
  // release visible as its own native button first.
  if (scenario.status === "PLANNED") scenario = await releaseOperator(scenario, actor, context);
  requireState(scenario, ["OPERATOR_READY"]);
  if (!scenario.of_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "L'ordre de fabrication est absent.");
  const operationId = scenario.operation_id ?? await findScenarioOperation(scenario);
  const ofId = scenario.of_id;
  const execution = await svcStartExecution({ actor, body: { of_id: ofId, operation_id: operationId, machine_id: scenario.machine_id, activity_code: "USINAGE" }, idempotencyKey: key(scenario, "start"), audit: audit(actor, context), source: "CANONICAL" });
  return updatePresentationScenario(scenario.id, actor.id, { operation_id: operationId, execution_id: execution.id, status: "RUNNING" });
}

async function operatorAction(scenario: PresentationScenario, action: PresentationAction, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  if (!scenario.execution_id || !scenario.of_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "Le pointage de démonstration est absent.");
  const args = { actor, id: scenario.execution_id, idempotencyKey: key(scenario, action), audit: audit(actor, context) };
  if (action === "pause_operator") {
    requireState(scenario, ["RUNNING"]);
    await svcPauseExecution({ ...args, body: { activity_code: "USINAGE", reason: "Pause démonstration" } });
    return updatePresentationScenario(scenario.id, actor.id, { status: "PAUSED" });
  }
  if (action === "resume_operator") {
    requireState(scenario, ["PAUSED"]);
    const resumed = await svcResumeExecution({ ...args, body: { activity_code: "USINAGE", machine_id: scenario.machine_id } });
    return updatePresentationScenario(scenario.id, actor.id, { execution_id: resumed.id, status: "RUNNING" });
  }
  if (action === "declare_quantity") {
    requireState(scenario, ["RUNNING"]);
    if (!scenario.operation_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "L'opération de démonstration est absente.");
    // Keep this payload identical to the guided native operator dialog: it
    // previews, then confirms the same one-good-unit declaration.
    const nativeJourney = Boolean(scenario.article_id);
    const body = { of_id: scenario.of_id, operation_id: scenario.operation_id, qty_good: nativeJourney ? 3 : 1, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0, unite: "U", note: null, stop_active_segment: true, complete_operation: nativeJourney };
    const preview = await svcPreviewFinishOperation({ actor, body });
    await svcFinishOperation({ actor, body: { ...body, preview_hash: preview.preview_hash }, idempotencyKey: key(scenario, action), audit: audit(actor, context) });
    return updatePresentationScenario(scenario.id, actor.id, { status: "QUANTITY_DECLARED" });
  }
  if (action === "stop_operator" && scenario.status === "QUANTITY_DECLARED") {
    // The canonical finish command above already stopped the active segment;
    // this final button records the confirmed, read-back presentation outcome.
    return updatePresentationScenario(scenario.id, actor.id, { status: "COMPLETED" });
  }
  requireState(scenario, ["RUNNING", "PAUSED", "QUANTITY_DECLARED"]);
  await svcStopExecution({ ...args, body: { comment: "Fin de démonstration" } });
  return updatePresentationScenario(scenario.id, actor.id, { status: "COMPLETED" });
}

const completedActionStates: Partial<Record<PresentationAction, PresentationStatus>> = {
  adopt_client: "CLIENT_CREATED", prepare_piece: "PIECE_PREPARED", adopt_piece: "PIECE_CREATED", prepare_gamme: "GAMME_PREPARED", adopt_gamme: "GAMME_APPLICABLE", prepare_article: "ARTICLE_PREPARED", adopt_article: "ARTICLE_CREATED", prepare_devis: "QUOTE_PREPARED", adopt_devis: "QUOTE_DRAFT",
  convert_quote: "COMMANDE_CREATED", generate_affaires: "AFFAIRE_CREATED", generate_ofs: "PRODUCTION_READY",
  plan: "PLANNED", release_operator: "OPERATOR_READY", start_operator: "RUNNING", pause_operator: "PAUSED", resume_operator: "RUNNING",
  declare_quantity: "QUANTITY_DECLARED", stop_operator: "COMPLETED", finish_operation:"OPERATION_FINISHED", finish_of:"OF_FINISHED", prepare_receipt:"RECEIPT_PREPARED", adopt_receipt:"RECEIPTED", prepare_delivery:"DELIVERY_PREPARED", adopt_delivery:"DELIVERY_CREATED", prepare_quality_plan:"QUALITY_PLAN_PREPARED", adopt_quality_plan:"QUALITY_PLAN_PUBLISHED", prepare_quality_release:"QUALITY_RELEASE_PREPARED", adopt_quality_release:"QUALITY_RELEASED", ship_delivery:"SHIPPED",
};

export function actionHasCompleted(scenario: PresentationScenario, action: Exclude<PresentationAction, "prepare_client">): boolean {
  return scenario.status === completedActionStates[action];
}

export function shouldIncludePreparedQuote(action: PresentationAction, status: PresentationStatus): boolean {
  return action === "prepare_devis" && status === "QUOTE_PREPARED";
}

async function responseForAction(action: PresentationAction, scenario: PresentationScenario) {
  const response = presentationResponse(scenario);
  if (action === "prepare_piece" && scenario.status === "PIECE_PREPARED") return { ...response, prepared: { piece: { client_id: scenario.client_id, name_piece: `Pièce présentation ${scenario.id.slice(0,8)}`, designation: `Pièce présentation ${scenario.id.slice(0,8)}`, plan_reference: `DEMO-${scenario.id.slice(0,8)}`, indice_externe: "A", statut: "DRAFT" } } };
  if (action === "prepare_gamme" && scenario.status === "GAMME_PREPARED") { const resource = await findPresentationGammePreset(scenario.machine_id); return { ...response, prepared: { gamme: { piece_technique_version_id: scenario.piece_technique_version_id, machine_id: resource.machine_id, cf_id: resource.cf_id, machine_family_code: resource.machine_family_code, type_operation: "FRAISAGE", designation: "Fraisage démonstration", qte: 3, coef: 1, temps_preparation_minutes: 5, temps_unitaire_minutes: 3, numero_programme: `DEMO-${scenario.id.slice(0,8).toUpperCase()}` } } }; }
  if (action === "prepare_article" && scenario.status === "ARTICLE_PREPARED") return { ...response, prepared: { article: { piece_technique_id: scenario.piece_technique_id, article_category: "fabrique", unite: "U", commercial_scope: "CLIENTS", client_ids: scenario.client_id ? [scenario.client_id] : [] } } };
  if (action === "prepare_receipt" && scenario.status === "RECEIPT_PREPARED") {
    const c=await svcGetOfReceiptContext({of_id:scenario.of_id!});
    return {...response,prepared:{receipt:{article_id:c.article_id,qty_ok:3,qty_scrap:0,qty_rework:0,unite:c.unite,location_id:c.default_location_id,lot_mode:"NEW",lot_id:null,lot_number:null,quality_status:"QUARANTAINE",quality_reason:"Présentation CERP+",expected_of_updated_at:c.of.updated_at,commentaire:null}}};
  }
  if (action === "prepare_delivery" && scenario.status === "DELIVERY_PREPARED") {
    return { ...response, prepared: { delivery: { commande_id: scenario.commande_id, lot_id: scenario.lot_id, article_id: scenario.article_id, quantite: 3, unite: "U" } } }
  }
  if (action === "prepare_quality_plan" && scenario.status === "QUALITY_PLAN_PREPARED") { return { ...response, prepared: { plan: { article_id: scenario.article_id, trigger_type: "LOT_RELEASE", label: "Libération lot présentation", sampling: { rule: "ALL", value: null, justification: null }, characteristic: { characteristic_key: "CONFORMITE", label: "Conformité visuelle", characteristic_type: "VISUAL", value_kind: "BOOLEAN", criticality: "MAJOR", mandatory: true } } } }; }
  if (action === "prepare_quality_release" && scenario.status === "QUALITY_RELEASE_PREPARED") {
    return { ...response, prepared: { quality: { lot_id: scenario.lot_id, of_id: scenario.of_id, livraison_id: scenario.livraison_id, quantite: 3, unite: "U", decision: "FULL" } } }
  }
  return shouldIncludePreparedQuote(action, scenario.status)
    ? { ...response, prepared: { devis: await preparedQuote(scenario) } }
    : response;
}

async function runScenarioAction(params: { action: Exclude<PresentationAction, "prepare_client">; scenarioId: string; requestKey: string; actor: PresentationActor; context: RequestContext; clientId?: string; pieceTechniqueId?: string; gammeId?: string; articleId?: string; receiptId?: string; livraisonId?: string; qualityPlanId?: string; qualityControlId?: string; qualityReleaseDecisionId?: string; devisId?: number }) {
  return withPresentationLock(`scenario:${params.scenarioId}`, async () => {
    let scenario = await getPresentationScenario(params.scenarioId, params.actor.id);
    if (await hasPresentationReceipt(scenario.id, params.action, params.requestKey)) return responseForAction(params.action, scenario);
    // A process can fail after the domain action and registry state update but before
    // its receipt write. The persisted target state makes that retry read-only.
    if (actionHasCompleted(scenario, params.action)) {
      await recordPresentationReceipt(scenario.id, params.action, params.requestKey);
      return responseForAction(params.action, scenario);
    }
    if (params.action === "adopt_client") scenario = await adoptClient(scenario, params.actor, params.clientId);
    if (params.action === "prepare_piece") scenario = await preparePiece(scenario, params.actor);
    if (params.action === "adopt_piece") scenario = await adoptPiece(scenario, params.actor, params.pieceTechniqueId);
    if (params.action === "prepare_gamme") scenario = await prepareGamme(scenario, params.actor);
    if (params.action === "adopt_gamme") scenario = await adoptGamme(scenario, params.actor, params.gammeId);
    if (params.action === "prepare_article") scenario = await prepareArticle(scenario, params.actor);
    if (params.action === "adopt_article") scenario = await adoptArticle(scenario, params.actor, params.articleId);
    if (params.action === "prepare_receipt") scenario = await prepareReceipt(scenario, params.actor);
    if (params.action === "adopt_receipt") scenario = await adoptReceipt(scenario, params.actor, params.receiptId);
    if (params.action === "prepare_delivery") scenario = await prepareDelivery(scenario, params.actor);
    if (params.action === "adopt_delivery") scenario = await adoptDelivery(scenario, params.actor, params.livraisonId);
    if (params.action === "prepare_quality_plan") scenario = await prepareQualityPlan(scenario, params.actor);
    if (params.action === "adopt_quality_plan") scenario = await adoptQualityPlan(scenario, params.actor, params.qualityPlanId);
    if (params.action === "prepare_quality_release") scenario = await prepareQualityRelease(scenario, params.actor);
    if (params.action === "adopt_quality_release") scenario = await adoptQualityRelease(scenario, params.actor, params.qualityControlId, params.qualityReleaseDecisionId);
    if (params.action === "ship_delivery") scenario = await shipDelivery(scenario, params.actor);
    if (params.action === "finish_operation") scenario = await finishOperation(scenario, params.actor);
    if (params.action === "finish_of") scenario = await finishOf(scenario, params.actor);
    if (params.action === "prepare_devis") scenario = await prepareQuote(scenario, params.actor);
    if (params.action === "adopt_devis") scenario = await adoptQuote(scenario, params.actor, params.devisId);
    if (params.action === "convert_quote") scenario = await convertQuote(scenario, params.actor, params.context);
    if (params.action === "generate_affaires") scenario = await generateProduction(scenario, params.actor, params.context);
    if (params.action === "generate_ofs") {
      requireState(scenario, ["AFFAIRE_CREATED"]);
      scenario = await updatePresentationScenario(scenario.id, params.actor.id, { status: "PRODUCTION_READY" });
    }
    if (params.action === "plan") scenario = await plan(scenario, params.actor, params.context);
    if (params.action === "release_operator") scenario = await releaseOperator(scenario, params.actor, params.context);
    if (params.action === "start_operator") scenario = await startOperator(scenario, params.actor, params.context);
    if (["pause_operator", "resume_operator", "declare_quantity", "stop_operator"].includes(params.action)) {
      scenario = await operatorAction(scenario, params.action, params.actor, params.context);
    }
    await recordPresentationReceipt(scenario.id, params.action, params.requestKey);
    return responseForAction(params.action, scenario);
  });
}

export async function runPresentation(params: { action: PresentationAction; scenarioId?: string; clientId?: string; pieceTechniqueId?: string; gammeId?: string; articleId?: string; receiptId?: string; livraisonId?: string; qualityPlanId?: string; qualityControlId?: string; qualityReleaseDecisionId?: string; devisId?: number; requestKey: string; actor: PresentationActor; context: RequestContext }) {
  if (!isDemoMode()) throw new HttpError(404, "NOT_FOUND", "Not found");
  if (params.action === "start") {
    return withPresentationLock(`start:${params.actor.id}`, async () =>
      presentationResponse(await legacyStartScenario(params.actor, params.context, params.requestKey))
    );
  }
  if (params.action === "prepare_client") {
    return withPresentationLock(`start:${params.actor.id}`, async () =>
      presentationResponse(await prepareClient(params.actor, params.requestKey))
    );
  }
  return runScenarioAction({ ...params, action: params.action, scenarioId: params.scenarioId! });
}
