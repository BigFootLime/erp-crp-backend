// Service du suivi et pointage de production (#274).
//
// Rôle : appliquer les règles qui dépendent de l'IDENTITÉ de l'appelant avant
// de déléguer au repository. C'est ici que se joue la différence entre
// « pointer pour soi » et « pointer pour un autre », et le périmètre de lecture
// d'un opérateur.

import { HttpError } from "../../../utils/httpError";
import {
  assertProductionExecutionCapability,
  PRODUCTION_EXECUTION_CAPABILITIES,
  roleHasProductionExecutionCapability,
  type ProductionExecutionCapability,
} from "../domain/production-execution";
import type { AuditContext } from "../repository/production.repository";
import {
  repoCancelExecution,
  repoCorrectExecution,
  repoDeclareQuantity,
  repoExecutionCenter,
  repoExecutionIndicators,
  repoFinishOperation,
  repoGetExecution,
  repoListActivityCategories,
  repoListExecutions,
  repoOperatorBoard,
  repoPreviewFinishOperation,
  repoRejectExecution,
  repoStartExecution,
  repoStopExecution,
  repoSubmitExecution,
  repoTransitionSegment,
  repoValidateExecution,
  type ProductionQuantitySourceContext,
  type ProductionExecutionTransactionHooks,
} from "../repository/production-execution.repository";
import type {
  CancelExecutionBodyDTO,
  ChangeExecutionBodyDTO,
  CorrectExecutionBodyDTO,
  DeclareQuantityBodyDTO,
  ExecutionCenterQueryDTO,
  FinishOperationBodyDTO,
  FinishOperationPreviewBodyDTO,
  IncidentExecutionBodyDTO,
  ListActivityCategoriesQueryDTO,
  ListExecutionsQueryDTO,
  OperatorBoardQueryDTO,
  PauseExecutionBodyDTO,
  RejectExecutionBodyDTO,
  ResumeExecutionBodyDTO,
  StartExecutionBodyDTO,
  StopExecutionBodyDTO,
  SubmitExecutionBodyDTO,
  ValidateExecutionBodyDTO,
} from "../validators/production-execution.validators";

export type Actor = { id: number; role: string | null | undefined };

/**
 * Périmètre de lecture. Un opérateur ne voit que SES pointages ; un superviseur
 * voit tout. Le retour `null` signifie « aucune restriction », il n'est jamais
 * déductible d'un paramètre de requête.
 */
function readScope(actor: Actor): number | null {
  if (roleHasProductionExecutionCapability(actor.role, "validate")) return null;
  if (roleHasProductionExecutionCapability(actor.role, "create_for_other")) return null;
  return actor.id;
}

/**
 * Identité de l'opérateur d'un pointage. Elle vient du JWT ; le corps de
 * requête ne peut la surcharger qu'avec la capacité `create_for_other` ET un
 * motif. Sans les deux, la valeur envoyée est ignorée plutôt que refusée
 * silencieusement — mais l'écart est signalé.
 */
function resolveOperator(actor: Actor, body: { operator_user_id?: number; for_other_reason?: string }): number {
  const requested = body.operator_user_id;
  if (!requested || requested === actor.id) return actor.id;

  assertProductionExecutionCapability(actor.role, "create_for_other");
  if (!body.for_other_reason || body.for_other_reason.trim().length < 3) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_FOR_OTHER_REASON_REQUIRED",
      "Pointer pour un autre opérateur exige un motif.",
      { details: { fields: { for_other_reason: ["Indiquez pourquoi vous pointez pour cet opérateur."] } } }
    );
  }
  return requested;
}

/* ------------------------------- Lecture --------------------------------- */

export async function svcListActivityCategories(query: ListActivityCategoriesQueryDTO) {
  return repoListActivityCategories({ include_disabled: query.include_disabled });
}

export async function svcCapabilities(actor: Actor) {
  const capabilities = PRODUCTION_EXECUTION_CAPABILITIES.filter((c) =>
    roleHasProductionExecutionCapability(actor.role, c as ProductionExecutionCapability)
  );
  return { capabilities };
}

export async function svcListExecutions(actor: Actor, query: ListExecutionsQueryDTO) {
  assertProductionExecutionCapability(actor.role, "read");
  return repoListExecutions({ query, scopeOperatorUserId: readScope(actor) });
}

export async function svcGetExecution(actor: Actor, id: string) {
  assertProductionExecutionCapability(actor.role, "read");
  const found = await repoGetExecution({ id });
  if (!found) {
    throw new HttpError(404, "PRODUCTION_EXECUTION_NOT_FOUND", "Pointage introuvable.", { id });
  }
  // Anti-IDOR : un identifiant deviné ne donne pas accès au pointage d'un tiers.
  const scope = readScope(actor);
  if (scope !== null && found.operator.id !== scope) {
    throw new HttpError(
      403,
      "PRODUCTION_EXECUTION_FOREIGN_POINTAGE",
      "Ce pointage appartient à un autre opérateur."
    );
  }
  return found;
}

export async function svcExecutionCenter(actor: Actor, query: ExecutionCenterQueryDTO) {
  assertProductionExecutionCapability(actor.role, "read");
  const today = new Date().toISOString().slice(0, 10);
  return repoExecutionCenter({
    date_from: query.date_from ?? today,
    date_to: query.date_to ?? today,
    scopeOperatorUserId: readScope(actor),
  });
}

/**
 * Indicateurs dérivés. L'accès aux coûts est un périmètre SÉPARÉ : voir du
 * temps n'est pas voir de l'argent.
 */
export async function svcExecutionIndicators(actor: Actor, query: ExecutionCenterQueryDTO) {
  assertProductionExecutionCapability(actor.role, "read");
  const today = new Date().toISOString().slice(0, 10);
  const indicators = await repoExecutionIndicators({
    date_from: query.date_from ?? today,
    date_to: query.date_to ?? today,
  });
  if (!roleHasProductionExecutionCapability(actor.role, "view_costs")) {
    return {
      ...indicators,
      cost: { computable: false, value: null, missing: ["capacité 'view_costs' requise"] },
    };
  }
  return indicators;
}

export async function svcOperatorBoard(actor: Actor, query: OperatorBoardQueryDTO) {
  assertProductionExecutionCapability(actor.role, "read");
  const target = query.operator_user_id ?? actor.id;
  if (target !== actor.id) {
    assertProductionExecutionCapability(actor.role, "create_for_other");
  }
  return repoOperatorBoard({ operatorUserId: target, query });
}

/* ------------------------------ Commandes -------------------------------- */

export async function svcStartExecution(params: {
  actor: Actor;
  body: StartExecutionBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
  executionSessionId?: string | null;
  source?: string;
  transactionHooks?: ProductionExecutionTransactionHooks<{ id: string }>;
}) {
  assertProductionExecutionCapability(params.actor.role, "start_self");
  const operatorUserId = resolveOperator(params.actor, params.body);
  return repoStartExecution({
    body: params.body,
    operatorUserId,
    idempotencyKey: params.idempotencyKey,
    audit: params.audit,
    sessionId: params.executionSessionId,
    source: params.source,
    transactionHooks: params.transactionHooks,
  });
}

export async function svcStopExecution(params: {
  actor: Actor;
  id: string;
  body: StopExecutionBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
  transactionHooks?: ProductionExecutionTransactionHooks<{ id: string }>;
}) {
  assertProductionExecutionCapability(params.actor.role, "stop_self");
  return repoStopExecution({
    id: params.id,
    body: params.body,
    idempotencyKey: params.idempotencyKey,
    actorRole: params.actor.role,
    audit: params.audit,
    transactionHooks: params.transactionHooks,
  });
}

export async function svcPauseExecution(params: {
  actor: Actor;
  id: string;
  body: PauseExecutionBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "pause_self");
  return repoTransitionSegment({
    id: params.id,
    kind: "PAUSE",
    body: params.body,
    idempotencyKey: params.idempotencyKey,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcResumeExecution(params: {
  actor: Actor;
  id: string;
  body: ResumeExecutionBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "pause_self");
  return repoTransitionSegment({
    id: params.id,
    kind: "RESUME",
    body: params.body,
    idempotencyKey: params.idempotencyKey,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcChangeExecution(params: {
  actor: Actor;
  id: string;
  body: ChangeExecutionBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "start_self");
  // Transmettre le travail à quelqu'un d'autre engage un tiers : capacité dédiée.
  if (params.body.operator_user_id && params.body.operator_user_id !== params.actor.id) {
    assertProductionExecutionCapability(params.actor.role, "create_for_other");
    if (!params.body.reason) {
      throw new HttpError(
        422,
        "PRODUCTION_EXECUTION_FOR_OTHER_REASON_REQUIRED",
        "Transférer un pointage à un autre opérateur exige un motif."
      );
    }
  }
  return repoTransitionSegment({
    id: params.id,
    kind: "CHANGE",
    body: params.body,
    idempotencyKey: params.idempotencyKey,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcDeclareIncident(params: {
  actor: Actor;
  id: string;
  body: IncidentExecutionBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "declare_incident");
  return repoTransitionSegment({
    id: params.id,
    kind: "INCIDENT",
    body: params.body,
    idempotencyKey: params.idempotencyKey,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcDeclareQuantity(params: {
  actor: Actor;
  body: DeclareQuantityBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
  sourceContext?: ProductionQuantitySourceContext;
  transactionHooks?: ProductionExecutionTransactionHooks<{ id: string }>;
}) {
  assertProductionExecutionCapability(params.actor.role, "declare_quantity");
  return repoDeclareQuantity({
    body: params.body,
    idempotencyKey: params.idempotencyKey,
    audit: params.audit,
    sourceContext: params.sourceContext,
    transactionHooks: params.transactionHooks,
  });
}

export async function svcPreviewFinishOperation(params: {
  actor: Actor;
  body: FinishOperationPreviewBodyDTO;
}) {
  assertProductionExecutionCapability(params.actor.role, "declare_quantity");
  return repoPreviewFinishOperation({ body: params.body, operatorUserId: params.actor.id });
}

export async function svcFinishOperation(params: {
  actor: Actor;
  body: FinishOperationBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "declare_quantity");
  assertProductionExecutionCapability(params.actor.role, "stop_self");
  return repoFinishOperation({
    body: params.body,
    operatorUserId: params.actor.id,
    idempotencyKey: params.idempotencyKey,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

/* ------------------------- Cycle de validation --------------------------- */

export async function svcSubmitExecution(params: {
  actor: Actor;
  id: string;
  body: SubmitExecutionBodyDTO;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "submit");
  return repoSubmitExecution({
    id: params.id,
    note: params.body.note ?? null,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcValidateExecution(params: {
  actor: Actor;
  id: string;
  body: ValidateExecutionBodyDTO;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "validate");
  return repoValidateExecution({
    id: params.id,
    note: params.body.note ?? null,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcRejectExecution(params: {
  actor: Actor;
  id: string;
  body: RejectExecutionBodyDTO;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "reject");
  return repoRejectExecution({
    id: params.id,
    reason: params.body.reason,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcCorrectExecution(params: {
  actor: Actor;
  id: string;
  body: CorrectExecutionBodyDTO;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "correct");
  return repoCorrectExecution({
    id: params.id,
    correction_reason: params.body.correction_reason,
    patch: params.body.patch,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}

export async function svcCancelExecution(params: {
  actor: Actor;
  id: string;
  body: CancelExecutionBodyDTO;
  audit: AuditContext;
}) {
  assertProductionExecutionCapability(params.actor.role, "cancel");
  return repoCancelExecution({
    id: params.id,
    reason: params.body.reason,
    actorRole: params.actor.role,
    audit: params.audit,
  });
}
