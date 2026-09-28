import { HttpError } from "../../../utils/httpError";
import { repoCreateClient } from "../../client/repository/client.repository";
import { svcCreateDevis, svcConvertDevisToCommande, svcGetDevis, svcUpdateDevis } from "../../devis/services/devis.service";
import { generateAffairesFromOrderSVC, runCommandeWorkflowActionSVC } from "../../commande-client/services/commande-client.service";
import { svcAutoPlanPlanning } from "../../planning/services/planning.service";
import { svcGetOfReadiness, svcReleaseOrdreFabrication } from "../../production/services/production.service";
import { svcDeclareQuantity, svcPauseExecution, svcResumeExecution, svcStartExecution, svcStopExecution } from "../../production/services/production-execution.service";
import { isDemoMode } from "../../../config/demo-mode";
import type { PresentationAction, PresentationActor, PresentationScenario, PresentationStatus } from "../types/demo-presentation.types";
import { createOrResumePresentation, findExistingPresentationProduction, findFixtureArticleId, findScenarioOfAffaire, findScenarioOfStatus, findScenarioOperation, getPresentationScenario, hasPresentationReceipt, recordPresentationReceipt, updatePresentationScenario, withPresentationLock } from "../repository/demo-presentation.repository";

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
    case "QUOTE_DRAFT": return "convert_quote";
    case "COMMANDE_CREATED": return "generate_affaires";
    case "AFFAIRE_CREATED": return "generate_ofs";
    case "PRODUCTION_READY": return "plan";
    case "PLANNED": return "start_operator";
    case "RUNNING": return "declare_quantity";
    case "PAUSED": return "resume_operator";
    case "QUANTITY_DECLARED": return "stop_operator";
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
    INITIALIZING: "started", QUOTE_DRAFT: "started", COMMANDE_CREATED: "quote_converted",
    AFFAIRE_CREATED: "affaires_generated", PRODUCTION_READY: "ofs_generated", PLANNED: "planned",
    RUNNING: "operator_started", PAUSED: "operator_paused", QUANTITY_DECLARED: "quantity_declared", COMPLETED: "operator_stopped",
  };
  return {
    scenario: { id: scenario.id, status: scenario.status === "COMPLETED" ? "COMPLETED" : "ACTIVE", step: steps[scenario.status] },
    entities: {
      client: scenario.client_id ? { id: scenario.client_id } : null,
      devis: scenario.devis_id ? { id: scenario.devis_id } : null,
      commande: scenario.commande_id ? { id: scenario.commande_id } : null,
      affaire: scenario.affaire_id ? { id: scenario.affaire_id } : null,
      of: scenario.of_id ? { id: scenario.of_id } : null,
      operation: scenario.operation_id ? { id: scenario.operation_id } : null,
      execution: scenario.execution_id ? { id: scenario.execution_id } : null,
    },
    next_action: nextPresentationAction(scenario.status),
    capabilities: {
      documents: false, uploads: false, external_integrations: false, destructive_actions: false,
      quality_validation: false, controlled_release_override: true,
    },
  };
}

async function startScenario(actor: PresentationActor, context: RequestContext, startKey: string): Promise<PresentationScenario> {
  let scenario = await createOrResumePresentation(actor.id, startKey);
  if (scenario.status !== "INITIALIZING") return scenario;
  const today = new Date().toISOString().slice(0, 10);
  const suffix = scenario.id.slice(0, 8).toUpperCase();
  const client = await repoCreateClient({
    company_name: `Atelier Horizon ${suffix}`,
    email: `demo-${scenario.id.slice(0, 8)}@example.invalid`,
    status: "prospect", blocked: false, creation_date: today, payment_mode_ids: [], contacts: [], quality_levels: [],
    bill_address: { name: "Atelier Horizon", street: "Rue de la Démonstration", postal_code: "69001", city: "Lyon", country: "France" },
    delivery_address: { name: "Atelier Horizon", street: "Rue de la Démonstration", postal_code: "69001", city: "Lyon", country: "France" },
  }, audit(actor, context), scenario.id);
  scenario = await updatePresentationScenario(scenario.id, actor.id, { client_id: client.client_id });
  const fixtureArticleId = await findFixtureArticleId(scenario.piece_technique_id);
  const devis = await svcCreateDevis({
    client_id: client.client_id, user_id: actor.id, statut: "BROUILLON", remise_globale: 0, total_ht: 0, total_ttc: 0,
    lignes: [{ article_id: fixtureArticleId, piece_technique_id: scenario.piece_technique_id, code_piece: "DEMO-PT-001", description: "Support de guidage — démonstration", quantite: 3, unite: "U", prix_unitaire_ht: 240, remise_ligne: 0, taux_tva: 20 }],
  }, actor.id, [], { idempotency_key: key(scenario, "quote"), audit: audit(actor, context) });
  return updatePresentationScenario(scenario.id, actor.id, { devis_id: devis.id, status: "QUOTE_DRAFT" });
}

async function convertQuote(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
  requireState(scenario, ["QUOTE_DRAFT"]);
  if (!scenario.devis_id) throw new HttpError(409, "DEMO_SCENARIO_INCOMPLETE", "Le devis de démonstration est absent.");
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
  const commande = await svcConvertDevisToCommande(scenario.devis_id, { idempotency_key: key(scenario, "convert"), audit: audit(actor, context) });
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

async function startOperator(scenario: PresentationScenario, actor: PresentationActor, context: RequestContext): Promise<PresentationScenario> {
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
  const operationId = scenario.operation_id ?? await findScenarioOperation(scenario);
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
    await svcDeclareQuantity({ actor, body: { of_id: scenario.of_id, operation_id: scenario.operation_id, pointage_id: scenario.execution_id, qty_good: 1, qty_scrap: 0, qty_rework: 0, qty_pending_control: 0, unite: "U", note: "Quantité déclarée pendant la démonstration" }, idempotencyKey: key(scenario, action), audit: audit(actor, context) });
    return updatePresentationScenario(scenario.id, actor.id, { status: "QUANTITY_DECLARED" });
  }
  requireState(scenario, ["RUNNING", "PAUSED", "QUANTITY_DECLARED"]);
  await svcStopExecution({ ...args, body: { comment: "Fin de démonstration" } });
  return updatePresentationScenario(scenario.id, actor.id, { status: "COMPLETED" });
}

const completedActionStates: Partial<Record<PresentationAction, PresentationStatus>> = {
  convert_quote: "COMMANDE_CREATED", generate_affaires: "AFFAIRE_CREATED", generate_ofs: "PRODUCTION_READY",
  plan: "PLANNED", start_operator: "RUNNING", pause_operator: "PAUSED", resume_operator: "RUNNING",
  declare_quantity: "QUANTITY_DECLARED", stop_operator: "COMPLETED",
};

export function actionHasCompleted(scenario: PresentationScenario, action: Exclude<PresentationAction, "start">): boolean {
  return scenario.status === completedActionStates[action];
}

async function runScenarioAction(params: { action: Exclude<PresentationAction, "start">; scenarioId: string; requestKey: string; actor: PresentationActor; context: RequestContext }) {
  return withPresentationLock(`scenario:${params.scenarioId}`, async () => {
    let scenario = await getPresentationScenario(params.scenarioId, params.actor.id);
    if (await hasPresentationReceipt(scenario.id, params.action, params.requestKey)) return presentationResponse(scenario);
    // A process can fail after the domain action and registry state update but before
    // its receipt write. The persisted target state makes that retry read-only.
    if (actionHasCompleted(scenario, params.action)) {
      await recordPresentationReceipt(scenario.id, params.action, params.requestKey);
      return presentationResponse(scenario);
    }
    if (params.action === "convert_quote") scenario = await convertQuote(scenario, params.actor, params.context);
    if (params.action === "generate_affaires") scenario = await generateProduction(scenario, params.actor, params.context);
    if (params.action === "generate_ofs") {
      requireState(scenario, ["AFFAIRE_CREATED"]);
      scenario = await updatePresentationScenario(scenario.id, params.actor.id, { status: "PRODUCTION_READY" });
    }
    if (params.action === "plan") scenario = await plan(scenario, params.actor, params.context);
    if (params.action === "start_operator") scenario = await startOperator(scenario, params.actor, params.context);
    if (["pause_operator", "resume_operator", "declare_quantity", "stop_operator"].includes(params.action)) {
      scenario = await operatorAction(scenario, params.action, params.actor, params.context);
    }
    await recordPresentationReceipt(scenario.id, params.action, params.requestKey);
    return presentationResponse(scenario);
  });
}

export async function runPresentation(params: { action: PresentationAction; scenarioId?: string; requestKey: string; actor: PresentationActor; context: RequestContext }) {
  if (!isDemoMode()) throw new HttpError(404, "NOT_FOUND", "Not found");
  if (params.action === "start") {
    return withPresentationLock(`start:${params.actor.id}`, async () =>
      presentationResponse(await startScenario(params.actor, params.context, params.requestKey))
    );
  }
  return runScenarioAction({ ...params, action: params.action, scenarioId: params.scenarioId! });
}
