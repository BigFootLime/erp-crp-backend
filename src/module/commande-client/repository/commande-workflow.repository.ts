import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { HttpError } from "../../../utils/httpError";
import { enqueueAppNotificationCreated, enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoCreateAppNotifications, repoListUsersForCommandePlanningNotification } from "../../notifications/repository/notifications.repository";
import type { AppNotification } from "../../notifications/types/notifications.types";
import type { RunCommandeWorkflowActionBodyDTO, UpdateCommandeWorkflowCheckpointBodyDTO } from "../validators/commande-client.validators";
import {
  COMMANDE_CHECKPOINT_STATUSES,
  COMMANDE_WORKFLOW_CHECKPOINTS,
  COMMANDE_WORKFLOW_STATUS_ORDER,
  canCommandeWorkflowTransition,
  getCommandeWorkflowAction,
  getCommandeWorkflowCheckpointDefinition,
  isCanonicalCommandeWorkflowStatus,
  normalizeCommandeWorkflowStatus,
  type CommandeCheckpointStatus,
  type CommandeWorkflowStatus,
  type CommandeWorkflowTransitionCause,
} from "../workflow/commande-client-workflow.definition";
import { canActOnCommandeWorkflowCheckpoint } from "../domain/commande-client-rbac";
import { resolveCustomerOrderLaunchMode } from "../domain/commande-client-launch";
import {
  assertCommandeFullyInvoiced,
  assertCommandeFullyShipped,
  assertCommandeProductionCompleted,
  assertCommandeProductionStarted,
  assertCommandeQualityReleased,
} from "./commande-fulfillment-guards.repository";
import { assertOrderManufacturingPlanned } from "./commande-ar-readiness.repository";

type Queryable = Pick<PoolClient, "query">;

type WorkflowAuditContext = {
  user_id: number;
  user_role: string | null;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type CommandeEventInput = {
  commande_id: number;
  event_type: string;
  old_values?: unknown | null;
  new_values?: unknown | null;
  user_id?: number | null;
};

export type CommandeWorkflowRepositoryDependencies = {
  toInt: (value: unknown, label?: string) => number;
  toNullableInt: (value: unknown, label?: string) => number | null;
  insertCommandeEvent: (db: Queryable, params: CommandeEventInput) => Promise<string | null>;
  analyzeCommandeStockTx: (client: PoolClient, commandeId: number, audit: WorkflowAuditContext) => Promise<unknown | null>;
};

export function createCommandeWorkflowRepository(dependencies: CommandeWorkflowRepositoryDependencies) {
  const { analyzeCommandeStockTx, insertCommandeEvent, toInt, toNullableInt } = dependencies;

  async function loadCommandeWorkflowHeader(tx: Queryable, commandeId: number): Promise<{
    id: number;
    numero: string;
    client_id: string | null;
    order_type: string | null;
  } | null> {
    const res = await tx.query<{ id: number; numero: string; client_id: string | null; order_type: string | null }>(
      `
        SELECT id::int AS id, numero, client_id, order_type
        FROM commande_client
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [commandeId]
    );

    return res.rows[0] ?? null;
  }

  async function repoEnsureCommandeWorkflowStatus(params: {
    tx: Queryable;
    commande_id: number;
    nouveau_statut: CommandeWorkflowStatus;
    cause: CommandeWorkflowTransitionCause;
    resume_status?: CommandeWorkflowStatus | null;
    commentaire: string | null;
    user_id: number | null;
  }): Promise<{
    changed: boolean;
    ancien_statut: string | null;
    nouveau_statut: string;
    history_id: number | null;
    notifications: AppNotification[];
  }> {
    const commande = await loadCommandeWorkflowHeader(params.tx, params.commande_id);
    if (!commande) {
      throw new HttpError(404, "COMMANDE_NOT_FOUND", "Commande introuvable");
    }

    if (!isCanonicalCommandeWorkflowStatus(params.nouveau_statut)) {
      throw new HttpError(
        400,
        "INVALID_COMMAND_STATUS",
        `Statut commande non canonique: ${String(params.nouveau_statut)}.`
      );
    }
    const nextStatus = params.nouveau_statut;
    if (params.cause.startsWith("internal_") && String(commande.order_type ?? "").toUpperCase() !== "INTERNE") {
      throw new HttpError(
        409,
        "INTERNAL_COMMAND_TRANSITION_REQUIRED",
        `La cause ${params.cause} est réservée aux commandes internes.`
      );
    }

    const last = await params.tx.query<{ nouveau_statut: string }>(
      `
        SELECT nouveau_statut
        FROM commande_historique
        WHERE commande_id = $1
        ORDER BY date_action DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `,
      [params.commande_id]
    );

    const ancienStatut = last.rows[0]?.nouveau_statut ?? null;
    // Legacy rows without history have always been exposed as BROUILLON by the
    // workflow reader. Keep that safe repair path, then apply the exact same
    // transition rules as a newly-created command instead of accepting a jump.
    const inferredFromMissingHistory = ancienStatut === null;
    // commande_historique is the only persisted command-status authority; the
    // base commande_client table intentionally has no workflow-status column.
    const currentNormalized = inferredFromMissingHistory ? "BROUILLON" : normalizeCommandeWorkflowStatus(ancienStatut);
    if (!currentNormalized) {
      throw new HttpError(
        409,
        "COMMAND_STATUS_HISTORY_INVALID",
        `Le dernier statut enregistré (${ancienStatut}) est inconnu. Réparez l'historique avant de poursuivre.`
      );
    }

    const isDownstreamSystemReplay =
      (params.cause === "shipment_sync" && ["FACTURE", "ARCHIVE"].includes(currentNormalized)) ||
      (params.cause === "invoice_sync" && currentNormalized === "ARCHIVE") ||
      (params.cause === "planning_sync" && [
        "AR_PRET",
        "AR_ENVOYE",
        "EN_PRODUCTION",
        "PRODUCTION_TERMINEE",
        "CONTROLE_QUALITE",
        "PRET_LIVRAISON",
        "LIVRE",
        "FACTURE",
        "ARCHIVE",
      ].includes(currentNormalized));
    if (isDownstreamSystemReplay) {
      return {
        changed: false,
        ancien_statut: ancienStatut,
        nouveau_statut: currentNormalized,
        history_id: null,
        notifications: [],
      };
    }

    if (currentNormalized === nextStatus) {
      return {
        changed: false,
        ancien_statut: ancienStatut,
        nouveau_statut: currentNormalized,
        history_id: null,
        notifications: [],
      };
    }

    if (!canCommandeWorkflowTransition(currentNormalized, nextStatus, params.cause, {
      resume_status: params.resume_status,
    })) {
      throw new HttpError(
        409,
        "ILLEGAL_COMMAND_STATUS_TRANSITION",
        `Transition commande interdite: ${currentNormalized} → ${nextStatus} (${params.cause}). Utilisez le checkpoint métier actif.`
      );
    }

    const ins = await params.tx.query<{ id: string }>(
      `
        INSERT INTO commande_historique (commande_id, user_id, ancien_statut, nouveau_statut, commentaire)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id::text AS id
      `,
      [params.commande_id, params.user_id, ancienStatut, nextStatus, params.commentaire]
    );

    // AR_PRET peut maintenant être atteint sans planning pour une commande
    // entièrement couverte par le stock. Ne jamais inventer une validation
    // planning dans ce cas ; les flux avec OF l'ont déjà persistée au jalon dédié.
    const marksPlanningValidated = nextStatus === "PLANNING_VALIDE";
    const marksArSent = nextStatus === "AR_ENVOYE";
    await params.tx.query(
      `
        UPDATE commande_client
        SET
          updated_at = now(),
          planning_validated_at = CASE
            WHEN $2::boolean THEN COALESCE(planning_validated_at, now())
            ELSE planning_validated_at
          END,
          planning_validated_by = CASE
            WHEN $2::boolean THEN COALESCE(planning_validated_by, $3::int)
            ELSE planning_validated_by
          END,
          ar_sent_at = CASE
            WHEN $4::boolean THEN COALESCE(ar_sent_at, now())
            ELSE ar_sent_at
          END,
          ar_sent_by = CASE
            WHEN $4::boolean THEN COALESCE(ar_sent_by, $3::int)
            ELSE ar_sent_by
          END,
          arc_date_envoi = CASE
            WHEN $4::boolean THEN COALESCE(arc_date_envoi, now())
            ELSE arc_date_envoi
          END
        WHERE id = $1
      `,
      [params.commande_id, marksPlanningValidated, params.user_id ?? null, marksArSent]
    );

    await insertCommandeEvent(params.tx, {
      commande_id: params.commande_id,
      event_type: "STATUS_CHANGED",
      old_values: {
        ancien_statut: ancienStatut,
        inferred_from_missing_history: inferredFromMissingHistory,
      },
      new_values: { nouveau_statut: nextStatus, cause: params.cause },
      user_id: params.user_id ?? null,
    });

    let notifications: AppNotification[] = [];
    if (nextStatus === "PLANNING_VALIDE") {
      const internalOrder = String(commande.order_type ?? "").toUpperCase() === "INTERNE";
      const recipientIds = internalOrder
        ? await listUsersForCommandeWorkflowRole(params.tx, "production")
        : await repoListUsersForCommandePlanningNotification(params.tx);
      notifications = await repoCreateAppNotifications({
        tx: params.tx,
        user_ids: recipientIds,
        kind: internalOrder ? "commande.workflow.handoff" : "commande.planning_valide",
        title: internalOrder
          ? `Production à lancer pour ${commande.numero}`
          : `Commande ${commande.numero} planifiée`,
        message: internalOrder
          ? `Le planning interne de la commande ${commande.numero} est validé. La production peut être lancée.`
          : `La commande ${commande.numero} est maintenant planifiée. Un AR peut être préparé.`,
        severity: "success",
        action_url: `/commandes/${params.commande_id}`,
        action_label: "Ouvrir",
        action_key: internalOrder ? "LAUNCH_PRODUCTION" : "PREPARE_AR",
        entity_type: "COMMANDE_CLIENT",
        entity_id: params.commande_id,
        module_key: "commandes-clients",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        payload: {
          commande_id: params.commande_id,
          numero: commande.numero,
          client_id: commande.client_id,
          checkpoint_code: internalOrder ? "production_launch" : "ar_preparation",
          role: internalOrder ? "production" : "secretariat",
        },
        dedupe_key: internalOrder
          ? `commande:${params.commande_id}:checkpoint:production_launch:active`
          : `commande:${params.commande_id}:planning_valide`,
      });
    }

    if (nextStatus === "AR_PRET") {
      const recipientIds = await repoListUsersForCommandePlanningNotification(params.tx);
      notifications = await repoCreateAppNotifications({
        tx: params.tx,
        user_ids: recipientIds,
        kind: "commande.ar_pret",
        title: `AR pret pour ${commande.numero}`,
        message: `La commande ${commande.numero} a un planning valide. L'AR peut etre prepare et envoye manuellement.`,
        severity: "success",
        action_url: `/commandes/${params.commande_id}`,
        action_label: "Preparer l'AR",
        action_key: "PREPARE_AR",
        entity_type: "COMMANDE_CLIENT",
        entity_id: params.commande_id,
        module_key: "commandes-clients",
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        payload: {
          commande_id: params.commande_id,
          numero: commande.numero,
          client_id: commande.client_id,
        },
        dedupe_key: `commande:${params.commande_id}:ar_pret`,
      });
    }

    return {
      changed: true,
      ancien_statut: ancienStatut,
      nouveau_statut: nextStatus,
      history_id: ins.rows[0]?.id ? toInt(ins.rows[0].id, "commande_historique.id") : null,
      notifications,
    };
  }

  async function repoApplyCommandeWorkflowMilestone(params: {
    tx: Queryable;
    commande_id: number;
    nouveau_statut: CommandeWorkflowStatus;
    cause: CommandeWorkflowTransitionCause;
    commentaire: string | null;
    user_id: number | null;
    completed_checkpoint_codes: readonly string[];
    active_checkpoint_code: string | null;
  }) {
    const transition = await repoEnsureCommandeWorkflowStatus({
      tx: params.tx,
      commande_id: params.commande_id,
      nouveau_statut: params.nouveau_statut,
      cause: params.cause,
      commentaire: params.commentaire,
      user_id: params.user_id,
    });
    if (!transition.changed) return transition;

    await params.tx.query(
      `
        UPDATE public.commande_client_workflow_checkpoint
        SET
          status = CASE
            WHEN checkpoint_code = ANY($2::text[]) THEN 'done'
            WHEN checkpoint_code = $3::text AND status NOT IN ('done', 'skipped') THEN 'active'
            ELSE status
          END,
          completed_at = CASE
            WHEN checkpoint_code = ANY($2::text[]) THEN COALESCE(completed_at, now())
            ELSE completed_at
          END,
          completed_by = CASE
            WHEN checkpoint_code = ANY($2::text[]) THEN COALESCE(completed_by, $4::int)
            ELSE completed_by
          END,
          blocked_reason = CASE WHEN checkpoint_code = $3::text THEN NULL ELSE blocked_reason END,
          notes = CASE
            WHEN checkpoint_code = ANY($2::text[]) THEN COALESCE($5, notes)
            ELSE notes
          END,
          updated_at = now()
        WHERE commande_id = $1
          AND (checkpoint_code = ANY($2::text[]) OR checkpoint_code = $3::text)
          AND (
            (checkpoint_code = ANY($2::text[]) AND status <> 'done')
            OR (checkpoint_code = $3::text AND status NOT IN ('active', 'done', 'skipped'))
          )
      `,
      [
        params.commande_id,
        [...params.completed_checkpoint_codes],
        params.active_checkpoint_code,
        params.user_id,
        params.commentaire,
      ]
    );

    return transition;
  }

  async function advanceInternalOrderWorkflowAfterGeneration(params: {
    tx: Queryable;
    commande_id: number;
    user_id: number;
    of_ids: number[];
  }) {
    const transition = await repoEnsureCommandeWorkflowStatus({
      tx: params.tx,
      commande_id: params.commande_id,
      nouveau_statut: "ATTENTE_PLANNING",
      cause: "internal_order_launch",
      commentaire: "Commande interne validee et lancee",
      user_id: params.user_id,
    });

    await repoEnsureCommandeWorkflowCheckpoints(params.tx, params.commande_id, "ATTENTE_PLANNING");
    await params.tx.query(
      `
        UPDATE public.commande_client_workflow_checkpoint
        SET
          status = CASE
            WHEN checkpoint_code IN ('commercial_review','stock_check','ar_preparation','ar_sent','invoicing') THEN 'skipped'
            WHEN checkpoint_code IN ('order_intake','of_generation') THEN 'done'
            WHEN checkpoint_code = 'planning_validation' THEN 'active'
            ELSE status
          END,
          completed_at = CASE
            WHEN checkpoint_code IN (
              'order_intake','commercial_review','stock_check','of_generation',
              'ar_preparation','ar_sent','invoicing'
            ) THEN COALESCE(completed_at, now())
            ELSE completed_at
          END,
          completed_by = CASE
            WHEN checkpoint_code IN (
              'order_intake','commercial_review','stock_check','of_generation',
              'ar_preparation','ar_sent','invoicing'
            ) THEN COALESCE(completed_by, $2::int)
            ELSE completed_by
          END,
          metadata = COALESCE(metadata, '{}'::jsonb) || CASE
            WHEN checkpoint_code = 'of_generation' THEN $3::jsonb
            WHEN checkpoint_code IN ('commercial_review','stock_check','ar_preparation','ar_sent','invoicing')
              THEN '{"skip_reason":"internal_order_flow"}'::jsonb
            ELSE '{"internal_order_flow":true}'::jsonb
          END,
          updated_at = now()
        WHERE commande_id = $1
      `,
      [
        params.commande_id,
        params.user_id,
        JSON.stringify({
          internal_order_flow: true,
          of_ids: params.of_ids,
        }),
      ]
    );

    return transition;
  }

  async function repairLegacyNoOperationPlanningBypass(params: {
    tx: Queryable;
    commande_id: number;
    user_id: number;
    ar_sent_at: string | null;
    of_ids: number[];
  }): Promise<boolean> {
    if (params.ar_sent_at || params.of_ids.length === 0) return false;

    const header = await loadCommandeWorkflowHeaderWithStatus(params.tx, params.commande_id);
    if (!header || header.statut !== "AR_PRET") return false;

    const planning = await params.tx.query<{ status: string; metadata: Record<string, unknown> | null }>(
      `
        SELECT status, metadata
        FROM public.commande_client_workflow_checkpoint
        WHERE commande_id = $1
          AND checkpoint_code = 'planning_validation'
        LIMIT 1
        FOR UPDATE
      `,
      [params.commande_id]
    );
    const row = planning.rows[0] ?? null;
    if (
      !row ||
      row.status !== "skipped" ||
      row.metadata?.skip_reason !== "no_plannable_operations" ||
      row.metadata?.no_operation_flow !== true
    ) {
      return false;
    }

    await params.tx.query(
      `
        UPDATE public.commande_client_workflow_checkpoint
        SET
          status = CASE
            WHEN checkpoint_code = 'of_generation' THEN 'done'
            WHEN checkpoint_code = 'planning_validation' THEN 'active'
            ELSE 'pending'
          END,
          completed_at = CASE WHEN checkpoint_code = 'of_generation' THEN completed_at ELSE NULL END,
          completed_by = CASE WHEN checkpoint_code = 'of_generation' THEN completed_by ELSE NULL END,
          metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
          updated_at = now()
        WHERE commande_id = $1
          AND checkpoint_code IN ('of_generation', 'planning_validation', 'ar_preparation', 'ar_sent')
      `,
      [
        params.commande_id,
        JSON.stringify({
          repair_reason: "planning_required_for_of_without_operations",
          repaired_of_ids: params.of_ids,
        }),
      ]
    );
    await repoEnsureCommandeWorkflowStatus({
      tx: params.tx,
      commande_id: params.commande_id,
      nouveau_statut: "ATTENTE_PLANNING",
      cause: "planning_repair",
      commentaire: "Correction automatique : tout OF, même sans opération, doit être validé au planning",
      user_id: params.user_id,
    });
    return true;
  }

  async function advanceCustomerOrderWorkflowAfterLaunch(params: {
    tx: Queryable;
    commande_id: number;
    user_id: number;
    needs_production: boolean;
    of_ids: number[];
  }) {
    const launchMode = resolveCustomerOrderLaunchMode({
      needsProduction: params.needs_production,
      generatedOperationsCount: 0,
    });

    if (launchMode === "PRODUCTION_WITH_PLANNING") {
      await params.tx.query(
        `
          UPDATE public.commande_client_workflow_checkpoint
          SET status = 'done',
              completed_at = COALESCE(completed_at, now()),
              completed_by = COALESCE(completed_by, $2::int),
              metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
          WHERE commande_id = $1
            AND checkpoint_code = 'of_generation'
            AND status = 'active'
        `,
        [params.commande_id, params.user_id, JSON.stringify({ of_ids: params.of_ids })]
      );
      await activateNextCheckpoint(params.tx, params.commande_id, "planning_validation");
      return repoEnsureCommandeWorkflowStatus({
        tx: params.tx,
        commande_id: params.commande_id,
        nouveau_statut: "ATTENTE_PLANNING",
        cause: "customer_order_launch",
        commentaire: "Stock réservé et OF du manquant générés",
        user_id: params.user_id,
      });
    }

    await prepareStockOnlyCustomerOrderCheckpoints(params);
    return repoEnsureCommandeWorkflowStatus({
      tx: params.tx,
      commande_id: params.commande_id,
      nouveau_statut: "AR_PRET",
      cause: "customer_order_launch",
      commentaire: "Commande entièrement réservée sans OF, AR prêt à envoyer avant livraison",
      user_id: params.user_id,
    });
  }

  async function prepareStockOnlyCustomerOrderCheckpoints(params: { tx: Queryable; commande_id: number; user_id: number }) {
    await params.tx.query(
      `
        UPDATE public.commande_client_workflow_checkpoint
        SET status = CASE
              WHEN checkpoint_code IN ('of_generation', 'ar_preparation') THEN 'done'
              WHEN checkpoint_code = 'ar_sent' THEN 'active'
              WHEN checkpoint_code = 'delivery' THEN 'pending'
              ELSE 'skipped'
            END,
            completed_at = CASE
              WHEN checkpoint_code IN ('ar_sent', 'delivery') THEN NULL
              ELSE COALESCE(completed_at, now())
            END,
            completed_by = CASE
              WHEN checkpoint_code IN ('ar_sent', 'delivery') THEN NULL
              ELSE COALESCE(completed_by, $2::int)
            END,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = now()
        WHERE commande_id = $1
          AND checkpoint_code IN (
            'of_generation', 'planning_validation', 'ar_preparation', 'ar_sent',
            'production_launch', 'production_completion', 'quality_control', 'delivery'
          )
      `,
      [
        params.commande_id,
        params.user_id,
        JSON.stringify({
          skip_reason: "commande_fully_reserved_from_stock_awaiting_ar",
          stock_only_flow: true,
          delivery_preparation: "ATELIER_BL",
          bon_livraison_id: null,
        }),
      ]
    );
  }

  type CommandeWorkflowHeader = {
    id: number;
    numero: string;
    client_id: string | null;
    order_type: string | null;
    fulfilment_mode?: string | null;
    statut: CommandeWorkflowStatus;
    raw_statut: string | null;
  };

  function isSupplierDropship(fulfilmentMode: unknown): boolean {
    return String(fulfilmentMode ?? "").trim().toUpperCase() === "SUPPLIER_DROPSHIP";
  }

  function assertCommercialOnlyDropship(fulfilmentMode: unknown): void {
    if (isSupplierDropship(fulfilmentMode)) {
      throw new HttpError(
        409,
        "SUPPLIER_DROPSHIP_INDUSTRIAL_FLOW_FORBIDDEN",
        "Une commande en dropship fournisseur ne peut pas créer d'affaire, d'OF, de réservation ou d'étape stock locale."
      );
    }
  }

  type WorkflowCheckpointRow = {
    id: string;
    commande_id: string;
    checkpoint_code: string;
    label: string;
    sort_order: number;
    status: CommandeCheckpointStatus;
    responsible_role: string;
    assigned_user_id: number | null;
    due_at: string | null;
    completed_at: string | null;
    completed_by: number | null;
    blocked_reason: string | null;
    notes: string | null;
    action_key: string | null;
    action_label: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };

  const checkpointStatusSet = new Set<string>(COMMANDE_CHECKPOINT_STATUSES);

  function normalizeCheckpointStatus(value: unknown): CommandeCheckpointStatus {
    const status = typeof value === "string" ? value.trim().toLowerCase() : "";
    return checkpointStatusSet.has(status) ? (status as CommandeCheckpointStatus) : "pending";
  }

  function mapWorkflowCheckpoint(row: WorkflowCheckpointRow) {
    return {
      ...row,
      id: toInt(row.id, "workflow_checkpoint.id"),
      commande_id: toInt(row.commande_id, "workflow_checkpoint.commande_id"),
      status: normalizeCheckpointStatus(row.status),
      assigned_user_id: toNullableInt(row.assigned_user_id, "workflow_checkpoint.assigned_user_id"),
      completed_by: toNullableInt(row.completed_by, "workflow_checkpoint.completed_by"),
      metadata: row.metadata ?? {},
    };
  }

  function checkpointSeedStatus(definitionStatus: CommandeWorkflowStatus, currentStatus: CommandeWorkflowStatus, activeAssigned: { value: boolean }) {
    if (currentStatus === "ANNULE") return "skipped" as const;
    if (currentStatus !== "BLOQUE" && COMMANDE_WORKFLOW_STATUS_ORDER[definitionStatus] <= COMMANDE_WORKFLOW_STATUS_ORDER[currentStatus]) {
      return "done" as CommandeCheckpointStatus;
    }
    if (!activeAssigned.value) {
      activeAssigned.value = true;
      return currentStatus === "BLOQUE" ? "blocked" as CommandeCheckpointStatus : "active" as CommandeCheckpointStatus;
    }
    return "pending" as CommandeCheckpointStatus;
  }

  async function loadCommandeWorkflowHeaderWithStatus(
    tx: Queryable,
    commandeId: number,
    options: { forUpdate?: boolean } = {}
  ): Promise<CommandeWorkflowHeader | null> {
    if (options.forUpdate) {
      const locked = await tx.query<{ id: string }>(
        `
          SELECT id::text AS id
          FROM commande_client cc
          WHERE cc.id = $1
          FOR UPDATE
        `,
        [commandeId]
      );
      if (!locked.rows[0]) return null;
    }

    // When mutation was requested, this second statement runs only after the
    // aggregate lock and therefore reads a fresh history snapshot.
    const res = await tx.query<{
      id: string;
      numero: string;
      client_id: string | null;
      order_type: string | null;
      fulfilment_mode: string | null;
      raw_statut: string | null;
    }>(
      `
        SELECT
          cc.id::text AS id,
          cc.numero,
          cc.client_id,
          cc.order_type,
          cc.fulfilment_mode,
          st.nouveau_statut AS raw_statut
        FROM commande_client cc
        LEFT JOIN LATERAL (
          SELECT ch.nouveau_statut
          FROM commande_historique ch
          WHERE ch.commande_id = cc.id
          ORDER BY ch.date_action DESC, ch.id DESC
          LIMIT 1
        ) st ON TRUE
        WHERE cc.id = $1
        LIMIT 1
      `,
      [commandeId]
    );

    const row = res.rows[0] ?? null;
    if (!row) return null;
    const statut = normalizeCommandeWorkflowStatus(row.raw_statut) ?? "BROUILLON";
    const header = {
      id: toInt(row.id, "commande.id"),
      numero: row.numero,
      client_id: row.client_id,
      order_type: row.order_type,
      fulfilment_mode: row.fulfilment_mode,
      raw_statut: row.raw_statut,
      statut,
    };
    return options.forUpdate ? repoRetireCommandeTechnicalReview(tx, header) : header;
  }

  /** Caller holds the command lock. Retiring a UI milestone never validates an OF. */
  async function repoRetireCommandeTechnicalReview(tx: Queryable, header: CommandeWorkflowHeader): Promise<CommandeWorkflowHeader> {
    if (header.statut !== "ATTENTE_TECHNIQUE" && header.statut !== "BLOQUE") return header;
    const legacy = await tx.query<{
      status: string; assigned_user_id: number | null; due_at: string | null;
      blocked_reason: string | null; notes: string | null; metadata: Record<string, unknown>;
      has_of: boolean; stock_done: boolean;
    }>(`SELECT cp.status, cp.assigned_user_id, cp.due_at::text, cp.blocked_reason, cp.notes, cp.metadata,
        EXISTS (SELECT 1 FROM public.ordres_fabrication o WHERE o.commande_id=$1 AND o.statut::text<>'ANNULE') AS has_of,
        EXISTS (SELECT 1 FROM public.commande_client_workflow_checkpoint s
          WHERE s.commande_id=$1 AND s.checkpoint_code='stock_check' AND s.status='done') AS stock_done
      FROM public.commande_client_workflow_checkpoint cp
      WHERE cp.commande_id=$1 AND cp.checkpoint_code='technical_analysis'
        AND cp.status IN ('active','pending','blocked') FOR UPDATE OF cp`, [header.id]);
    const old = legacy.rows[0];
    if (!old || (header.statut === "BLOQUE" && old.status !== "blocked")) return header;
    const target = old.has_of ? "planning_validation"
      : header.order_type === "INTERNE" || old.stock_done ? "of_generation" : "stock_check";
    const status: CommandeWorkflowStatus = target === "planning_validation" ? "ATTENTE_PLANNING"
      : target === "of_generation" ? "ATTENTE_OF" : "ATTENTE_STOCK";
    await repoEnsureCommandeWorkflowCheckpoints(tx, header.id, status);
    await tx.query(`UPDATE public.commande_client_workflow_checkpoint
      SET status=$3, assigned_user_id=COALESCE(assigned_user_id,$4::int), due_at=COALESCE(due_at,$5::timestamptz),
        blocked_reason=CASE WHEN $3='blocked' THEN $6 ELSE blocked_reason END,
        notes=COALESCE(notes,$7), metadata=COALESCE(metadata,'{}'::jsonb)||$8::jsonb, updated_at=now()
      WHERE commande_id=$1 AND checkpoint_code=$2 AND status NOT IN ('done','skipped')`,
      [header.id,target,old.status === "blocked" ? "blocked" : "active",old.assigned_user_id,old.due_at,old.blocked_reason,old.notes,
        JSON.stringify({ retired_technical_checkpoint: true, ...(old.status === "blocked" ? { previous_status_before_block: status } : {}) })]);
    await tx.query(`UPDATE public.commande_client_workflow_checkpoint SET status='skipped',
        metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb, updated_at=now()
      WHERE commande_id=$1 AND checkpoint_code='technical_analysis' AND status IN ('active','pending','blocked')`,
      [header.id,JSON.stringify({ skip_reason: "technical_review_moved_to_of", successor_checkpoint: target, former_status: old.status })]);
    if (header.statut !== "BLOQUE") {
      await repoEnsureCommandeWorkflowStatus({ tx,commande_id:header.id,nouveau_statut:status,
        cause:"technical_review_retired",user_id:null,
        commentaire:"Étape technique de commande retirée ; contrôles conservés dans la préparation des OF." });
    }
    await insertCommandeEvent(tx, { commande_id:header.id,event_type:"TECHNICAL_REVIEW_RETIRED",user_id:null,
      old_values:{ checkpoint_code:"technical_analysis",status:old.status },
      new_values:{ checkpoint_code:target,policy:"command-technical-review-retired-20261023",of_validation_unchanged:true } });
    return { ...header, statut:header.statut === "BLOQUE" ? "BLOQUE" : status,
      raw_statut:header.statut === "BLOQUE" ? header.raw_statut : status };
  }

  async function repoEnsureCommandeWorkflowCheckpoints(
    tx: Queryable,
    commandeId: number,
    currentStatus: CommandeWorkflowStatus
  ) {
    const fulfilment = await tx.query<{ fulfilment_mode: string | null }>(
      "SELECT fulfilment_mode FROM public.commande_client WHERE id = $1",
      [commandeId]
    );
    // Supplier dropship commands are commercial-only on the buyer. Shipment and
    // invoice synchronisation advance their status, but they never receive the
    // local stock/OF checkpoint template as a side effect of a workflow read.
    if (isSupplierDropship(fulfilment.rows[0]?.fulfilment_mode)) return;
    const activeAssigned = { value: false };
    for (const checkpoint of COMMANDE_WORKFLOW_CHECKPOINTS) {
      const status = checkpointSeedStatus(checkpoint.status_when_done, currentStatus, activeAssigned);
      await tx.query(
        `
          INSERT INTO public.commande_client_workflow_checkpoint (
            commande_id,
            checkpoint_code,
            label,
            sort_order,
            status,
            responsible_role,
            completed_at,
            action_key,
            action_label,
            metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5 = 'done' THEN now() ELSE NULL END,$7,$8,$9::jsonb)
          ON CONFLICT (commande_id, checkpoint_code) DO UPDATE
          SET label = EXCLUDED.label,
              sort_order = EXCLUDED.sort_order,
              responsible_role = EXCLUDED.responsible_role,
              action_key = EXCLUDED.action_key,
              action_label = EXCLUDED.action_label,
              updated_at = now()
        `,
        [
          commandeId,
          checkpoint.code,
          checkpoint.label,
          checkpoint.sort_order,
          status,
          checkpoint.responsible_role,
          checkpoint.action_key,
          checkpoint.action_label,
          JSON.stringify({ description: checkpoint.description, status_when_done: checkpoint.status_when_done }),
        ]
      );
    }
  }

  async function loadCommandeWorkflowCheckpoints(tx: Queryable, commandeId: number) {
    const rows = await tx.query<WorkflowCheckpointRow>(
      `
        SELECT
          id::text AS id,
          commande_id::text AS commande_id,
          checkpoint_code,
          label,
          sort_order::int AS sort_order,
          status,
          responsible_role,
          assigned_user_id::int AS assigned_user_id,
          due_at::text AS due_at,
          completed_at::text AS completed_at,
          completed_by::int AS completed_by,
          blocked_reason,
          notes,
          action_key,
          action_label,
          metadata,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM public.commande_client_workflow_checkpoint
        WHERE commande_id = $1
        ORDER BY sort_order ASC, id ASC
      `,
      [commandeId]
    );
    return rows.rows.filter(row => row.checkpoint_code !== "technical_analysis").map(mapWorkflowCheckpoint);
  }

  function buildWorkflowView(
    header: CommandeWorkflowHeader,
    checkpoints: ReturnType<typeof mapWorkflowCheckpoint>[],
    viewer?: { user_id: number; user_role: string | null | undefined }
  ) {
    const activeCheckpoint =
      checkpoints.find((checkpoint) => checkpoint.status === "active" || checkpoint.status === "blocked") ??
      checkpoints.find((checkpoint) => checkpoint.status === "pending") ??
      null;
    const action = activeCheckpoint?.action_key ? getCommandeWorkflowAction(activeCheckpoint.action_key) : null;
    const canAct = Boolean(activeCheckpoint && viewer && canActOnCommandeWorkflowCheckpoint({
      user_id: viewer.user_id,
      user_role: viewer.user_role,
      responsible_role: activeCheckpoint.responsible_role,
      assigned_user_id: activeCheckpoint.assigned_user_id,
    }));
    const actionForbiddenReason = !activeCheckpoint || canAct
      ? null
      : activeCheckpoint.assigned_user_id !== null && activeCheckpoint.assigned_user_id !== viewer?.user_id
        ? "Ce checkpoint est attribué à un autre utilisateur."
        : `Action réservée au rôle ${activeCheckpoint.responsible_role}.`;

    return {
      commande_id: header.id,
      numero: header.numero,
      client_id: header.client_id,
      statut: header.statut,
      raw_statut: header.raw_statut,
      current_checkpoint: activeCheckpoint,
      checkpoints,
      can_act: canAct,
      action_forbidden_reason: actionForbiddenReason,
      available_actions: action && action.key !== "prepare_ar" && action.key !== "mark_ar_sent" && activeCheckpoint?.status === "active" && canAct
        ? [{
            key: action.key,
            label: action.label,
            checkpoint_code: action.checkpoint_code,
            target_status: action.target_status,
            next_checkpoint_code: action.next_checkpoint_code,
            responsible_role: activeCheckpoint.responsible_role,
          }]
        : [],
    };
  }

  async function listUsersForCommandeWorkflowRole(tx: Queryable, role: string): Promise<number[]> {
    const r = role.trim().toLowerCase();
    const patternsByRole: Record<string, string[]> = {
      secretariat: ["%secr%", "%secret%", "%assist%", "%admin%"],
      technique: ["%method%", "%methode%", "%tech%", "%bureau%"],
      planning: ["%planning%", "%atelier%", "%production%", "%admin%"],
      production: ["%production%", "%atelier%", "%operateur%", "%admin%"],
      qualite: ["%qual%", "%controle%", "%admin%"],
      logistique: ["%livraison%", "%logist%", "%expedition%", "%admin%"],
      comptabilite: ["%compt%", "%factur%", "%admin%"],
      direction: ["%direct%", "%admin%", "%administrateur%"],
    };
    const patterns = patternsByRole[r] ?? ["%admin%", "%administrateur%"];
    const values: unknown[] = [];
    const clauses = patterns.map((pattern) => {
      values.push(pattern);
      const p = `$${values.length}`;
      return `(lower(COALESCE(u.role, '')) LIKE ${p}
        OR lower(COALESCE(u.username, '')) LIKE ${p}
        OR lower(COALESCE(u.email, '')) LIKE ${p}
        OR lower(COALESCE(u.name, '')) LIKE ${p}
        OR lower(COALESCE(u.surname, '')) LIKE ${p})`;
    });

    const res = await tx.query<{ id: number }>(
      `
        SELECT DISTINCT u.id::int AS id
        FROM public.users u
        WHERE COALESCE(NULLIF(lower(trim(u.status)), ''), 'active') NOT IN ('inactive', 'blocked', 'suspended')
          AND (${clauses.join(" OR ")})
        ORDER BY u.id ASC
      `,
      values
    );
    return res.rows.map((row) => row.id).filter((id) => Number.isInteger(id) && id > 0);
  }

  async function notifyWorkflowRole(tx: Queryable, params: {
    commande: CommandeWorkflowHeader;
    role: string;
    kind: string;
    title: string;
    message: string;
    severity?: "info" | "success" | "warning" | "error";
    checkpoint_code: string | null;
    dedupe_key: string;
  }) {
    const recipientIds = await listUsersForCommandeWorkflowRole(tx, params.role);
    return repoCreateAppNotifications({
      tx,
      user_ids: recipientIds,
      kind: params.kind,
      title: params.title,
      message: params.message,
      severity: params.severity ?? "info",
      action_url: `/commandes/${params.commande.id}`,
      action_label: "Ouvrir",
      action_key: params.checkpoint_code ? `CHECKPOINT_${params.checkpoint_code.toUpperCase()}` : "OPEN_COMMANDE",
      entity_type: "COMMANDE_CLIENT",
      entity_id: params.commande.id,
      module_key: "commandes-clients",
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      payload: {
        commande_id: params.commande.id,
        numero: params.commande.numero,
        client_id: params.commande.client_id,
        checkpoint_code: params.checkpoint_code,
        role: params.role,
      },
      dedupe_key: params.dedupe_key,
    });
  }

  async function activateNextCheckpoint(tx: Queryable, commandeId: number, nextCheckpointCode: string | null) {
    if (!nextCheckpointCode) return;
    await tx.query(
      `
        WITH requested AS (
          SELECT sort_order
          FROM public.commande_client_workflow_checkpoint
          WHERE commande_id = $1 AND checkpoint_code = $2
        ), next_eligible AS (
          SELECT cp.id
          FROM public.commande_client_workflow_checkpoint cp
          CROSS JOIN requested r
          WHERE cp.commande_id = $1
            AND cp.sort_order >= r.sort_order
            AND cp.status NOT IN ('done','skipped')
          ORDER BY cp.sort_order ASC, cp.id ASC
          LIMIT 1
        )
        UPDATE public.commande_client_workflow_checkpoint cp
        SET status = 'active',
            blocked_reason = NULL,
            updated_at = now()
        FROM next_eligible next
        WHERE cp.id = next.id
      `,
      [commandeId, nextCheckpointCode]
    );
  }

  async function repoGetCommandeWorkflow(
    id: string,
    userId: number,
    userRole: string | null | undefined
  ) {
    const commandeId = toInt(id, "commande_id");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const header = await loadCommandeWorkflowHeaderWithStatus(client, commandeId, { forUpdate: true });
      if (!header) {
        await client.query("ROLLBACK");
        return null;
      }
      await repoEnsureCommandeWorkflowCheckpoints(client, commandeId, header.statut);
      const checkpoints = await loadCommandeWorkflowCheckpoints(client, commandeId);
      await client.query("COMMIT");
      return buildWorkflowView(header, checkpoints, { user_id: userId, user_role: userRole });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async function repoUpdateCommandeWorkflowCheckpoint(
    id: string,
    checkpointCode: string,
    body: UpdateCommandeWorkflowCheckpointBodyDTO,
    userId: number | null,
    userRole: string | null
  ) {
    const commandeId = toInt(id, "commande_id");
    if (userId === null) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
    const definition = getCommandeWorkflowCheckpointDefinition(checkpointCode);
    if (!definition) throw new HttpError(400, "UNKNOWN_CHECKPOINT", "Unknown workflow checkpoint");

    const client = await pool.connect();
    let notifications: AppNotification[] = [];
    return withRealtimeOutboxTransaction(client, async () => {
      const header = await loadCommandeWorkflowHeaderWithStatus(client, commandeId, { forUpdate: true });
      if (!header) {
        return null;
      }
      assertCommercialOnlyDropship(header.fulfilment_mode);
      await repoEnsureCommandeWorkflowCheckpoints(client, commandeId, header.statut);

      const existing = await client.query<WorkflowCheckpointRow>(
        `
          SELECT
            id::text AS id,
            commande_id::text AS commande_id,
            checkpoint_code,
            label,
            sort_order::int AS sort_order,
            status,
            responsible_role,
            assigned_user_id::int AS assigned_user_id,
            due_at::text AS due_at,
            completed_at::text AS completed_at,
            completed_by::int AS completed_by,
            blocked_reason,
            notes,
            action_key,
            action_label,
            metadata,
            created_at::text AS created_at,
            updated_at::text AS updated_at
          FROM public.commande_client_workflow_checkpoint
          WHERE commande_id = $1 AND checkpoint_code = $2
          FOR UPDATE
        `,
        [commandeId, definition.code]
      );
      const before = existing.rows[0] ?? null;
      if (!before) throw new HttpError(404, "CHECKPOINT_NOT_FOUND", "Workflow checkpoint not found");
      if (!canActOnCommandeWorkflowCheckpoint({
        user_id: userId,
        user_role: userRole,
        responsible_role: before.responsible_role,
        assigned_user_id: before.assigned_user_id,
      })) {
        throw new HttpError(403, "WORKFLOW_CHECKPOINT_FORBIDDEN", "This checkpoint is assigned to another role or user.");
      }

      if (body.metadata && ["previous_status_before_block", "stock_only_flow", "flow_version", "commercial_validation"]
        .some(key => Object.prototype.hasOwnProperty.call(body.metadata, key))) {
        throw new HttpError(
          400,
          "RESERVED_CHECKPOINT_METADATA",
          "Les preuves de progression et de couverture sont gérées par CERP."
        );
      }

      const beforeStatus = normalizeCheckpointStatus(before.status);
      const nextStatus = body.status ?? beforeStatus;
      const changesStatus = nextStatus !== beforeStatus;
      const entersBlocked = beforeStatus === "active" && nextStatus === "blocked";
      const resumesBlocked = beforeStatus === "blocked" && nextStatus === "active";
      if (changesStatus && !entersBlocked && !resumesBlocked) {
        throw new HttpError(
          409,
          "ILLEGAL_CHECKPOINT_STATUS_TRANSITION",
          `Checkpoint transition forbidden: ${beforeStatus} -> ${nextStatus}. Run the active workflow action to advance.`
        );
      }
      if (entersBlocked && !body.blocked_reason?.trim() && !body.notes?.trim()) {
        throw new HttpError(400, "BLOCK_REASON_REQUIRED", "A reason is required to block the active checkpoint.");
      }
      if (entersBlocked && header.statut === "BLOQUE") {
        throw new HttpError(409, "COMMAND_ALREADY_BLOCKED", "The command is already blocked by another checkpoint.");
      }
      if (resumesBlocked && header.statut !== "BLOQUE") {
        throw new HttpError(409, "COMMAND_NOT_BLOCKED", "The command status is inconsistent with the blocked checkpoint.");
      }

      const metadata = { ...(before.metadata ?? {}), ...(body.metadata ?? {}) };
      const hasAssignedUser = Object.prototype.hasOwnProperty.call(body, "assigned_user_id");
      const hasDueAt = Object.prototype.hasOwnProperty.call(body, "due_at");
      const hasNotes = Object.prototype.hasOwnProperty.call(body, "notes");

      if (entersBlocked) {
        metadata.previous_status_before_block = header.statut;
      }

      const resumeStatus = resumesBlocked
        ? normalizeCommandeWorkflowStatus(before.metadata?.previous_status_before_block)
        : null;

      if (resumesBlocked && (!resumeStatus || resumeStatus === "BLOQUE" || resumeStatus === "ARCHIVE")) {
        throw new HttpError(
          409,
          "BLOCK_RESUME_STATUS_MISSING",
          "The exact pre-block command status is missing from checkpoint metadata; repair it before resuming."
        );
      }

      if (resumeStatus) {
        delete metadata.previous_status_before_block;
      }

      const nextAssignedUser = hasAssignedUser ? body.assigned_user_id ?? null : before.assigned_user_id;
      const nextDueAt = hasDueAt ? body.due_at ?? null : before.due_at;
      const nextNotes = hasNotes ? body.notes ?? null : before.notes;
      const nextBlockedReason = nextStatus === "blocked"
        ? (Object.prototype.hasOwnProperty.call(body, "blocked_reason")
            ? body.blocked_reason?.trim() || null
            : before.blocked_reason)
        : null;
      const sameDueAt = nextDueAt === before.due_at || (
        nextDueAt !== null && before.due_at !== null && Date.parse(nextDueAt) === Date.parse(before.due_at)
      );
      const isIdempotentReplay =
        nextStatus === beforeStatus &&
        nextAssignedUser === before.assigned_user_id &&
        sameDueAt &&
        nextNotes === before.notes &&
        nextBlockedReason === before.blocked_reason &&
        isDeepStrictEqual(metadata, before.metadata ?? {});

      if (isIdempotentReplay) {
        return { checkpoint: mapWorkflowCheckpoint(before), idempotent_replay: true };
      }

      const updated = await client.query<WorkflowCheckpointRow>(
        `
          UPDATE public.commande_client_workflow_checkpoint
          SET status = $3,
              assigned_user_id = CASE WHEN $10::boolean THEN $4::int ELSE assigned_user_id END,
              due_at = CASE WHEN $11::boolean THEN $5::timestamptz ELSE due_at END,
              completed_at = CASE WHEN $3 = 'done' THEN COALESCE(completed_at, now()) ELSE completed_at END,
              completed_by = CASE WHEN $3 = 'done' THEN COALESCE($6::int, completed_by) ELSE completed_by END,
              blocked_reason = CASE WHEN $3 = 'blocked' THEN $7 ELSE NULL END,
              notes = CASE WHEN $12::boolean THEN $8 ELSE notes END,
              metadata = $9::jsonb,
              updated_at = now()
          WHERE commande_id = $1 AND checkpoint_code = $2
          RETURNING
            id::text AS id,
            commande_id::text AS commande_id,
            checkpoint_code,
            label,
            sort_order::int AS sort_order,
            status,
            responsible_role,
            assigned_user_id::int AS assigned_user_id,
            due_at::text AS due_at,
            completed_at::text AS completed_at,
            completed_by::int AS completed_by,
            blocked_reason,
            notes,
            action_key,
            action_label,
            metadata,
            created_at::text AS created_at,
            updated_at::text AS updated_at
        `,
        [
          commandeId,
          definition.code,
          nextStatus,
          body.assigned_user_id ?? null,
          body.due_at ?? null,
          userId,
          nextBlockedReason,
          nextNotes,
          JSON.stringify(metadata),
          hasAssignedUser,
          hasDueAt,
          hasNotes,
        ]
      );

      if (entersBlocked) {
        const blockTransition = await repoEnsureCommandeWorkflowStatus({
          tx: client,
          commande_id: commandeId,
          nouveau_statut: "BLOQUE",
          cause: "block",
          commentaire: body.blocked_reason ?? body.notes ?? `Checkpoint ${definition.code} blocked`,
          user_id: userId,
        });
        notifications = await notifyWorkflowRole(client, {
          commande: header,
          role: "direction",
          kind: "commande.workflow.blocked",
          title: `Commande ${header.numero} bloquee`,
          message: `Le checkpoint ${definition.label} est bloque.`,
          severity: "warning",
          checkpoint_code: definition.code,
          dedupe_key: `commande:${commandeId}:checkpoint:${definition.code}:blocked:${blockTransition.history_id ?? "unknown"}`,
        });
      } else if (resumeStatus) {
        await repoEnsureCommandeWorkflowStatus({
          tx: client,
          commande_id: commandeId,
          nouveau_statut: resumeStatus,
          cause: "resume",
          resume_status: resumeStatus,
          commentaire: body.notes ?? `Checkpoint ${definition.code} resumed`,
          user_id: userId,
        });
      }

      const realtimeMutationId = await insertCommandeEvent(client, {
        commande_id: commandeId,
        event_type: "CHECKPOINT_UPDATED",
        old_values: {
          checkpoint_code: definition.code,
          status: before.status,
          assigned_user_id: before.assigned_user_id,
          due_at: before.due_at,
        },
        new_values: {
          checkpoint_code: definition.code,
          status: nextStatus,
          assigned_user_id: hasAssignedUser ? body.assigned_user_id ?? null : before.assigned_user_id,
          due_at: hasDueAt ? body.due_at ?? null : before.due_at,
          resumed_status: resumeStatus,
        },
        user_id: userId,
      });
      if (!realtimeMutationId) throw new Error("COMMANDE_EVENT_INSERT_FAILED");

      for (const notification of notifications) {
        await enqueueAppNotificationCreated(client, notification.user_id, notification, {
          deduplicationKey: `notification:${notification.id}`,
        });
      }
      await enqueueEntityChanged(client, {
        entityType: "COMMANDE_CLIENT",
        entityId: String(commandeId),
        action: "updated",
        module: "commandes-clients",
        at: new Date().toISOString(),
        invalidateKeys: ["commandes:list", `commandes:detail:${commandeId}`, `commandes:workflow:${commandeId}`],
      }, {
        deduplicationKey: `commande-event:${realtimeMutationId}`,
      });
      return { checkpoint: mapWorkflowCheckpoint(updated.rows[0]), idempotent_replay: false };
    });
  }

  async function repoRunCommandeWorkflowAction(
    id: string,
    body: RunCommandeWorkflowActionBodyDTO,
    userId: number | null,
    userRole: string | null
  ) {
    const commandeId = toInt(id, "commande_id");
    if (userId === null) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
    const action = getCommandeWorkflowAction(body.action);
    if (!action) throw new HttpError(400, "UNKNOWN_WORKFLOW_ACTION", "Unknown workflow action");
    if (action.key === "mark_of_ready") {
      throw new HttpError(
        409,
        "COMMAND_LAUNCH_REQUIRED",
        "Utilisez Vérifier le stock et lancer : cette étape doit réserver OLD/NEW, préparer le BL ou créer les OF du manquant."
      );
    }
    if (action.key === "prepare_ar") {
      throw new HttpError(
        409,
        "COMMAND_AR_DOCUMENT_REQUIRED",
        "Générez l’AR depuis le dossier de commande. Sa préparation et son planning seront vérifiés avant édition.",
      );
    }
    if (action.key === "mark_ar_sent") {
      throw new HttpError(
        409,
        "COMMAND_AR_SEND_REQUIRED",
        "Utilisez Envoyer l'AR : seul l'envoi client tracé peut valider ce checkpoint."
      );
    }

    const runsStockAnalysis = action.key === "check_stock";

    const client = await pool.connect();
    let notifications: AppNotification[] = [];
    return withRealtimeOutboxTransaction(client, async () => {
      const header = await loadCommandeWorkflowHeaderWithStatus(client, commandeId, { forUpdate: true });
      if (!header) {
        return null;
      }
      assertCommercialOnlyDropship(header.fulfilment_mode);
      await repoEnsureCommandeWorkflowCheckpoints(client, commandeId, header.statut);

      const checkpointRes = await client.query<{ status: string; responsible_role: string; assigned_user_id: number | null }>(
        `
          SELECT status, responsible_role, assigned_user_id::int AS assigned_user_id
          FROM public.commande_client_workflow_checkpoint
          WHERE commande_id = $1 AND checkpoint_code = $2
          FOR UPDATE
        `,
        [commandeId, action.checkpoint_code]
      );
      const checkpoint = checkpointRes.rows[0] ?? null;
      if (!checkpoint) throw new HttpError(404, "CHECKPOINT_NOT_FOUND", "Workflow checkpoint not found");
      if (!canActOnCommandeWorkflowCheckpoint({
        user_id: userId,
        user_role: userRole,
        responsible_role: checkpoint.responsible_role,
        assigned_user_id: checkpoint.assigned_user_id,
      })) {
        throw new HttpError(403, "WORKFLOW_CHECKPOINT_FORBIDDEN", "This checkpoint is assigned to another role or user.");
      }
      if (checkpoint.status === "blocked") {
        throw new HttpError(409, "CHECKPOINT_BLOCKED", "Resolve the blocker before running this workflow action");
      }
      if (checkpoint.status === "done") {
        const checkpoints = await loadCommandeWorkflowCheckpoints(client, commandeId);
        return {
          workflow: buildWorkflowView(header, checkpoints, { user_id: userId, user_role: userRole }),
          idempotent_replay: true,
        };
      }
      if (checkpoint.status !== "active") {
        throw new HttpError(
          409,
          "CHECKPOINT_NOT_ACTIVE",
          `L'étape ${action.checkpoint_code} n'est pas l'étape active de la commande.`
        );
      }

      // Expensive/domain assertions are intentionally after the locked replay
      // check: the second identical request must be a read-only success even if
      // downstream state has already moved on.
      // These milestones cannot be completed by the role panel alone. The
      // readiness proof is recomputed under the command lock, so a direct API
      // call has exactly the same gates as the official planning/AR flows.
      if (action.key === "validate_planning") await assertOrderManufacturingPlanned(client, commandeId);
      if (action.key === "start_production") await assertCommandeProductionStarted(client, commandeId);
      if (action.key === "complete_production") await assertCommandeProductionCompleted(client, commandeId);
      if (action.key === "validate_quality") await assertCommandeQualityReleased(client, commandeId);
      if (action.key === "mark_delivered") await assertCommandeFullyShipped(client, commandeId);
      if (action.key === "mark_invoiced") await assertCommandeFullyInvoiced(client, commandeId);

      const stockAnalysisResult = runsStockAnalysis
        ? await analyzeCommandeStockTx(client, commandeId, {
            user_id: userId,
            user_role: userRole,
            ip: null,
            user_agent: null,
            device_type: null,
            os: null,
            browser: null,
            path: null,
            page_key: "commande.workflow",
            client_session_id: null,
          })
        : null;

      const internalOrder = String(header.order_type ?? "").toUpperCase() === "INTERNE";
      const nextCheckpointCode = internalOrder && action.key === "validate_planning"
        ? "production_launch"
        : action.next_checkpoint_code;
      let transitionCause: CommandeWorkflowTransitionCause = "checkpoint";
      if (internalOrder && action.key === "validate_planning") transitionCause = "internal_planning_validation";
      if (internalOrder && action.key === "start_production") transitionCause = "internal_production_launch";
      if (internalOrder && action.key === "archive") transitionCause = "internal_archive";

      await client.query(
        `
          UPDATE public.commande_client_workflow_checkpoint
          SET status = 'done',
              completed_at = COALESCE(completed_at, now()),
              completed_by = COALESCE(completed_by, $3::int),
              notes = COALESCE($4, notes),
              updated_at = now()
          WHERE commande_id = $1 AND checkpoint_code = $2
        `,
        [commandeId, action.checkpoint_code, userId, body.commentaire ?? null]
      );
      if (runsStockAnalysis) {
        await client.query(
          `
            UPDATE public.commande_client_workflow_checkpoint
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                updated_at = now()
            WHERE commande_id = $1
              AND checkpoint_code = $2
          `,
          [
            commandeId,
            action.checkpoint_code,
            JSON.stringify({
              stock_scope_order: ["OLD", "NEW"],
              analysis: stockAnalysisResult,
            }),
          ]
        );
      }
      await activateNextCheckpoint(client, commandeId, nextCheckpointCode);

      const transition = await repoEnsureCommandeWorkflowStatus({
        tx: client,
        commande_id: commandeId,
        nouveau_statut: action.target_status,
        cause: transitionCause,
        commentaire: body.commentaire ?? action.label,
        user_id: userId,
      });
      notifications = [...transition.notifications];

      // A milestone notification already carries the handoff semantics for
      // planning/AR transitions. Do not send a second differently-keyed handoff
      // to overlapping recipients for the same state change.
      if (nextCheckpointCode && transition.notifications.length === 0) {
        const nextDef = getCommandeWorkflowCheckpointDefinition(nextCheckpointCode);
        if (nextDef) {
          const roleNotifications = await notifyWorkflowRole(client, {
            commande: header,
            role: nextDef.responsible_role,
            kind: "commande.workflow.handoff",
            title: `Commande ${header.numero}: ${nextDef.label}`,
            message: `Le checkpoint ${nextDef.label} est maintenant actif.`,
            severity: "info",
            checkpoint_code: nextDef.code,
            dedupe_key: `commande:${commandeId}:checkpoint:${nextDef.code}:active`,
          });
          notifications = [...notifications, ...roleNotifications];
        }
      }

      const realtimeMutationId = await insertCommandeEvent(client, {
        commande_id: commandeId,
        event_type: "WORKFLOW_ACTION",
        old_values: { statut: header.statut, checkpoint_code: action.checkpoint_code },
        new_values: {
          statut: action.target_status,
          action: action.key,
          next_checkpoint_code: nextCheckpointCode,
          stock_analysis: stockAnalysisResult,
        },
        user_id: userId,
      });
      if (!realtimeMutationId) throw new Error("COMMANDE_EVENT_INSERT_FAILED");

      const checkpoints = await loadCommandeWorkflowCheckpoints(client, commandeId);
      const workflow = buildWorkflowView(
        { ...header, statut: action.target_status, raw_statut: action.target_status },
        checkpoints,
        { user_id: userId, user_role: userRole }
      );

      for (const notification of notifications) {
        await enqueueAppNotificationCreated(client, notification.user_id, notification, {
          deduplicationKey: `notification:${notification.id}`,
        });
      }
      await enqueueEntityChanged(client, {
        entityType: "COMMANDE_CLIENT",
        entityId: String(commandeId),
        action: "updated",
        module: "commandes-clients",
        at: new Date().toISOString(),
        invalidateKeys: ["commandes:list", `commandes:detail:${commandeId}`, `commandes:workflow:${commandeId}`],
      }, {
        deduplicationKey: `commande-event:${realtimeMutationId}`,
      });
      return { workflow, idempotent_replay: false };
    });
  }

  return {
    repoEnsureCommandeWorkflowStatus,
    repoApplyCommandeWorkflowMilestone,
    advanceInternalOrderWorkflowAfterGeneration,
    repairLegacyNoOperationPlanningBypass,
    advanceCustomerOrderWorkflowAfterLaunch,
    prepareStockOnlyCustomerOrderCheckpoints,
    isSupplierDropship,
    assertCommercialOnlyDropship,
    loadCommandeWorkflowHeaderWithStatus,
    notifyWorkflowRole,
    repoRetireCommandeTechnicalReview,
    repoEnsureCommandeWorkflowCheckpoints,
    repoGetCommandeWorkflow,
    repoUpdateCommandeWorkflowCheckpoint,
    repoRunCommandeWorkflowAction,
  };
}

