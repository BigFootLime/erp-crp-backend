// Repository du suivi et pointage de production (#274).
//
// Règles structurantes appliquées ici et nulle part ailleurs :
//   * TOUTE commande à effet s'exécute dans UNE transaction, avec verrouillage
//     explicite des ressources concernées (OF, opération, segments de
//     l'opérateur, machine). Aucun état partiel n'est possible.
//   * Le TEMPS est posé par la base (`now()`), jamais par le navigateur.
//   * `of_operations.temps_total_real` est recalculé par la fonction SQL unique
//     `fn_production_recompute_operation_real_time`, jamais incrémenté à la
//     main : une minute ne peut donc pas être comptée deux fois.
//   * Le pointage n'écrit JAMAIS dans le stock, les lots, les BL ou les
//     factures. La chaîne autoritaire reste déclaration → qualité → réception
//     de production (#223) → lot → mouvement.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";

import {
  assertActivityUsable,
  assertExecutionTransition,
  assertFiniteQuantities,
  assertIdempotencyMatch,
  assertMutable,
  assertOwnershipOrSupervision,
  assertPlausibleDuration,
  assertReasonProvided,
  assertRetroactiveAllowed,
  assertSeparationOfDuties,
  assertWithinRemaining,
  computeDurationMinutes,
  fingerprintPayload,
  LONG_RUNNING_ALERT_MINUTES,
  type ActivityCategory,
  type ExecutionEventType,
} from "../domain/production-execution";
import type { AuditContext } from "./production.repository";
import type {
  ChangeExecutionBodyDTO,
  DeclareQuantityBodyDTO,
  FinishOperationBodyDTO,
  FinishOperationPreviewBodyDTO,
  IncidentExecutionBodyDTO,
  ListExecutionsQueryDTO,
  OperatorBoardQueryDTO,
  PauseExecutionBodyDTO,
  ResumeExecutionBodyDTO,
  StartExecutionBodyDTO,
  StopExecutionBodyDTO,
} from "../validators/production-execution.validators";

type DbQueryer = Pick<PoolClient, "query">;

export type ProductionExecutionTransactionHooks<T extends { id: string }> = {
  beforeEffect: (tx: PoolClient) => Promise<void>;
  beforeCommit: (tx: PoolClient, result: T) => Promise<void>;
};

/** Contexte fiable ajouté par la reprise offline, jamais lu dans le payload client. */
export type ProductionQuantitySourceContext = {
  operatorUserId: number;
  machineId: string | null;
  executionSessionId: string | null;
};

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

async function insertAuditLog(
  tx: DbQueryer,
  audit: AuditContext,
  entry: {
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    details?: Record<string, unknown> | null;
  }
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

/** Journal append-only propre au pointage, en plus de l'audit transverse. */
async function insertExecutionEvent(
  tx: DbQueryer,
  params: {
    pointage_id: string;
    event_type: ExecutionEventType;
    user_id: number;
    old_values?: Record<string, unknown> | null;
    new_values?: Record<string, unknown> | null;
    note?: string | null;
  }
) {
  await tx.query(
    `
      INSERT INTO public.production_pointage_events
        (pointage_id, event_type, old_values, new_values, user_id, note)
      VALUES ($1::uuid, $2::text, $3::jsonb, $4::jsonb, $5::int, $6)
    `,
    [
      params.pointage_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.user_id,
      params.note ?? null,
    ]
  );
}

function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

function isPgExclusionViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23P01";
}

/**
 * Traduit les violations de contrainte en erreurs métier lisibles. Sans cela,
 * une course entre deux onglets remonterait une erreur SQL brute à l'atelier.
 */
function translateConcurrencyError(err: unknown): never {
  if (isPgUniqueViolation(err)) {
    const constraint = String((err as { constraint?: unknown }).constraint ?? "");
    if (constraint.includes("running_operator")) {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_OPERATOR_BUSY",
        "Cet opérateur a déjà un pointage en cours. Arrêtez-le avant d'en démarrer un autre."
      );
    }
    if (constraint.includes("running_machine")) {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_MACHINE_BUSY",
        "Cette machine est déjà occupée par un pointage en cours."
      );
    }
    if (constraint.includes("idempotency")) {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_IDEMPOTENCY_CONFLICT",
        "Cette clé d'idempotence a déjà été utilisée avec une charge utile différente."
      );
    }
  }
  if (isPgExclusionViolation(err)) {
    throw new HttpError(
      409,
      "PRODUCTION_EXECUTION_OVERLAP",
      "Ce pointage chevauche une période déjà déclarée pour cet opérateur ou cette machine."
    );
  }
  throw err as Error;
}

/* -------------------------------------------------------------------------- */
/* Idempotence                                                                */
/* -------------------------------------------------------------------------- */

type IdempotentReplay<T> = { replayed: true; body: T } | { replayed: false };

/**
 * Réservation de la clé AVANT l'effet, dans la même transaction. Si l'effet
 * échoue, la réservation disparaît avec le ROLLBACK et un retry est possible.
 */
async function reserveIdempotencyKey<T>(
  tx: DbQueryer,
  params: { key: string; scope: string; payload: unknown; user_id: number }
): Promise<IdempotentReplay<T>> {
  const fingerprint = fingerprintPayload(params.scope, params.payload);

  const existing = await tx.query<{
    request_fingerprint: string;
    response_body: T | null;
    user_id: number;
  }>(
    `
      SELECT request_fingerprint, response_body, user_id
      FROM public.production_execution_idempotency
      WHERE idempotency_key = $1
      FOR UPDATE
    `,
    [params.key]
  );

  const row = existing.rows[0];
  if (row) {
    if (row.user_id !== params.user_id) {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_IDEMPOTENCY_ACTOR_CONFLICT",
        "Cette clé d'idempotence appartient à un autre utilisateur."
      );
    }
    assertIdempotencyMatch({
      key: params.key,
      storedFingerprint: row.request_fingerprint,
      incomingFingerprint: fingerprint,
    });
    return { replayed: true, body: row.response_body as T };
  }

  await tx.query(
    `
      INSERT INTO public.production_execution_idempotency
        (idempotency_key, scope, request_fingerprint, response_status, response_body, user_id)
      VALUES ($1, $2, $3, 200, NULL, $4)
    `,
    [params.key, params.scope, fingerprint, params.user_id]
  );

  return { replayed: false };
}

async function storeIdempotentResponse(tx: DbQueryer, key: string, body: unknown) {
  await tx.query(
    `UPDATE public.production_execution_idempotency SET response_body = $2::jsonb WHERE idempotency_key = $1`,
    [key, JSON.stringify(body ?? null)]
  );
}

/* -------------------------------------------------------------------------- */
/* Référentiel d'activités                                                    */
/* -------------------------------------------------------------------------- */

const ACTIVITY_COLUMNS = `
  code, label, description,
  counts_operator_time, counts_machine_time, is_productive,
  requires_reason, criticality,
  signals_planning, signals_maintenance, signals_quality,
  legacy_time_type::text AS legacy_time_type,
  legacy_of_time_log_type::text AS legacy_of_time_log_type,
  required_capability, sort_order,
  effective_from::text AS effective_from,
  disabled_at
`;

export async function repoListActivityCategories(params: {
  include_disabled?: boolean;
}): Promise<ActivityCategory[]> {
  const res = await pool.query<ActivityCategory>(
    `
      SELECT ${ACTIVITY_COLUMNS}
      FROM public.production_activity_categories
      WHERE ($1::boolean IS TRUE OR disabled_at IS NULL)
        AND effective_from <= CURRENT_DATE
      ORDER BY sort_order, code
    `,
    [Boolean(params.include_disabled)]
  );
  return res.rows;
}

async function loadActivity(tx: DbQueryer, code: string): Promise<ActivityCategory> {
  const res = await tx.query<ActivityCategory>(
    `SELECT ${ACTIVITY_COLUMNS} FROM public.production_activity_categories WHERE code = $1`,
    [code]
  );
  const row = res.rows[0];
  assertActivityUsable(row, code);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Lecture des exécutions                                                     */
/* -------------------------------------------------------------------------- */

const EXECUTION_SELECT = `
  SELECT
    p.id::text                        AS id,
    p.status::text                    AS status,
    p.time_type::text                 AS time_type,
    p.activity_code,
    COALESCE(c.label, p.time_type::text) AS activity_label,
    COALESCE(c.is_productive, false)  AS activity_is_productive,
    COALESCE(c.criticality, 'NORMAL') AS activity_criticality,
    p.session_id::text                AS session_id,
    p.segment_index,
    p.source,
    p.start_ts,
    p.end_ts,
    p.duration_minutes,
    CASE
      WHEN p.status = 'RUNNING'
      THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - p.start_ts)) / 60.0)::int)
      ELSE p.duration_minutes
    END                               AS elapsed_minutes,
    p.comment,
    p.correction_reason,
    p.is_retroactive,
    p.submitted_at,
    p.validated_at,
    p.rejected_at,
    p.rejection_reason,
    p.created_at,
    p.updated_at,
    p.of_id,
    o.numero                          AS of_numero,
    o.statut::text                    AS of_statut,
    p.operation_id::text              AS operation_id,
    op.phase                          AS operation_phase,
    op.designation                    AS operation_designation,
    op.status::text                   AS operation_status,
    op.temps_total_planned::float8    AS operation_temps_planned,
    op.temps_total_real::float8       AS operation_temps_real,
    p.affaire_id,
    a.reference                       AS affaire_reference,
    p.piece_technique_id::text        AS piece_technique_id,
    pt.code_piece                     AS piece_code,
    pt.designation                    AS piece_designation,
    p.machine_id::text                AS machine_id,
    m.code                            AS machine_code,
    m.name                            AS machine_name,
    p.poste_id::text                  AS poste_id,
    po.code                           AS poste_code,
    po.label                          AS poste_label,
    p.operator_user_id,
    u.username                        AS operator_username,
    u.name                            AS operator_name,
    u.surname                         AS operator_surname
  FROM public.production_pointages p
  JOIN public.ordres_fabrication o ON o.id = p.of_id
  LEFT JOIN public.of_operations op ON op.id = p.operation_id
  LEFT JOIN public.affaire a ON a.id = p.affaire_id
  LEFT JOIN public.pieces_techniques pt ON pt.id = p.piece_technique_id
  LEFT JOIN public.machines m ON m.id = p.machine_id
  LEFT JOIN public.postes po ON po.id = p.poste_id
  LEFT JOIN public.production_activity_categories c ON c.code = p.activity_code
  JOIN public.users u ON u.id = p.operator_user_id
`;

function operatorLabel(row: {
  operator_username: string;
  operator_name: string | null;
  operator_surname: string | null;
}): string {
  const full = [row.operator_name, row.operator_surname]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join(" ");
  return full ? `${full} (${row.operator_username})` : row.operator_username;
}

function mapExecutionRow(row: Record<string, any>) {
  return {
    id: row.id as string,
    status: row.status as string,
    time_type: row.time_type as string,
    activity: {
      code: (row.activity_code as string | null) ?? null,
      label: row.activity_label as string,
      is_productive: Boolean(row.activity_is_productive),
      criticality: row.activity_criticality as string,
    },
    session_id: (row.session_id as string | null) ?? null,
    segment_index: Number(row.segment_index ?? 1),
    source: row.source as string,
    start_ts: row.start_ts as string,
    end_ts: (row.end_ts as string | null) ?? null,
    duration_minutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    elapsed_minutes: row.elapsed_minutes === null ? null : Number(row.elapsed_minutes),
    comment: (row.comment as string | null) ?? null,
    correction_reason: (row.correction_reason as string | null) ?? null,
    is_retroactive: Boolean(row.is_retroactive),
    submitted_at: (row.submitted_at as string | null) ?? null,
    validated_at: (row.validated_at as string | null) ?? null,
    rejected_at: (row.rejected_at as string | null) ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    of: {
      id: Number(row.of_id),
      numero: row.of_numero as string,
      statut: row.of_statut as string,
    },
    operation: row.operation_id
      ? {
          id: row.operation_id as string,
          phase: Number(row.operation_phase),
          designation: row.operation_designation as string,
          status: row.operation_status as string,
          temps_total_planned: Number(row.operation_temps_planned ?? 0),
          temps_total_real: Number(row.operation_temps_real ?? 0),
        }
      : null,
    affaire: row.affaire_id
      ? { id: Number(row.affaire_id), reference: row.affaire_reference as string }
      : null,
    piece_technique: row.piece_technique_id
      ? {
          id: row.piece_technique_id as string,
          code_piece: row.piece_code as string,
          designation: row.piece_designation as string,
        }
      : null,
    machine: row.machine_id
      ? { id: row.machine_id as string, code: row.machine_code as string, name: row.machine_name as string }
      : null,
    poste: row.poste_id
      ? { id: row.poste_id as string, code: row.poste_code as string, label: row.poste_label as string }
      : null,
    operator: {
      id: Number(row.operator_user_id),
      username: row.operator_username as string,
      name: (row.operator_name as string | null) ?? null,
      surname: (row.operator_surname as string | null) ?? null,
      label: operatorLabel(row as any),
    },
  };
}

export type ExecutionListItem = ReturnType<typeof mapExecutionRow>;

/**
 * Files opérationnelles : ce sont des filtres SERVEUR. Un KPI ou un segment
 * calculé sur la page courante mentirait dès la deuxième page.
 */
function segmentClause(segment: string, values: unknown[]): string {
  switch (segment) {
    case "running":
      return `AND p.status = 'RUNNING'`;
    case "long_running":
      values.push(LONG_RUNNING_ALERT_MINUTES);
      return `AND p.status = 'RUNNING' AND EXTRACT(EPOCH FROM (now() - p.start_ts)) / 60.0 > $${values.length}`;
    case "to_validate":
      return `AND p.status = 'DONE' AND p.validated_at IS NULL AND p.rejected_at IS NULL`;
    case "rejected":
      return `AND p.rejected_at IS NOT NULL`;
    case "incidents":
      return `AND c.criticality IN ('HIGH','CRITICAL')`;
    case "scrap":
      return `AND EXISTS (
                SELECT 1 FROM public.production_quantity_declarations d
                WHERE d.pointage_id = p.id AND d.qty_scrap > 0
              )`;
    case "overrun":
      return `AND op.temps_total_planned > 0 AND op.temps_total_real > op.temps_total_planned`;
    default:
      return "";
  }
}

export async function repoListExecutions(params: {
  query: ListExecutionsQueryDTO;
  scopeOperatorUserId: number | null;
}): Promise<{ items: ExecutionListItem[]; total: number }> {
  const values: unknown[] = [];
  const where: string[] = [];

  // Anti-IDOR : quand l'appelant n'a pas de droit de supervision, le service
  // impose ici son propre identifiant. Le filtre n'est pas contournable par un
  // paramètre de requête.
  if (params.scopeOperatorUserId !== null) {
    values.push(params.scopeOperatorUserId);
    where.push(`p.operator_user_id = $${values.length}`);
  } else if (params.query.operator_user_id) {
    values.push(params.query.operator_user_id);
    where.push(`p.operator_user_id = $${values.length}`);
  }

  if (params.query.date_from) {
    values.push(params.query.date_from);
    where.push(`p.start_ts >= $${values.length}::date`);
  }
  if (params.query.date_to) {
    values.push(params.query.date_to);
    where.push(`p.start_ts < ($${values.length}::date + INTERVAL '1 day')`);
  }
  if (params.query.of_id) {
    values.push(params.query.of_id);
    where.push(`p.of_id = $${values.length}::bigint`);
  }
  if (params.query.operation_id) {
    values.push(params.query.operation_id);
    where.push(`p.operation_id = $${values.length}::uuid`);
  }
  if (params.query.machine_id) {
    values.push(params.query.machine_id);
    where.push(`p.machine_id = $${values.length}::uuid`);
  }
  if (params.query.poste_id) {
    values.push(params.query.poste_id);
    where.push(`p.poste_id = $${values.length}::uuid`);
  }
  if (params.query.activity_code) {
    values.push(params.query.activity_code);
    where.push(`p.activity_code = $${values.length}`);
  }
  if (params.query.status) {
    values.push(params.query.status);
    where.push(`p.status = $${values.length}::production_pointage_status`);
  }
  if (params.query.q) {
    values.push(`%${params.query.q}%`);
    const i = values.length;
    where.push(
      `(o.numero ILIKE $${i} OR op.designation ILIKE $${i} OR m.code ILIKE $${i} OR m.name ILIKE $${i} OR u.username ILIKE $${i})`
    );
  }

  const segment = segmentClause(params.query.segment ?? "all", values);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "WHERE TRUE";

  const sortColumn =
    { start_ts: "p.start_ts", end_ts: "p.end_ts", duration_minutes: "p.duration_minutes", updated_at: "p.updated_at" }[
      params.query.sortBy ?? "start_ts"
    ] ?? "p.start_ts";
  const sortDir = params.query.sortDir === "asc" ? "ASC" : "DESC";

  const countRes = await pool.query<{ total: string }>(
    `
      SELECT count(*)::text AS total
      FROM public.production_pointages p
      JOIN public.ordres_fabrication o ON o.id = p.of_id
      LEFT JOIN public.of_operations op ON op.id = p.operation_id
      LEFT JOIN public.machines m ON m.id = p.machine_id
      LEFT JOIN public.production_activity_categories c ON c.code = p.activity_code
      JOIN public.users u ON u.id = p.operator_user_id
      ${whereSql} ${segment}
    `,
    values
  );

  const page = params.query.page ?? 1;
  const pageSize = params.query.pageSize ?? 50;
  values.push(pageSize, (page - 1) * pageSize);

  const res = await pool.query(
    `
      ${EXECUTION_SELECT}
      ${whereSql} ${segment}
      ORDER BY ${sortColumn} ${sortDir} NULLS LAST, p.id
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values
  );

  return {
    items: res.rows.map(mapExecutionRow),
    total: Number(countRes.rows[0]?.total ?? 0),
  };
}

export async function repoGetExecution(params: {
  id: string;
}): Promise<(ExecutionListItem & { events: unknown[]; declarations: unknown[] }) | null> {
  const res = await pool.query(`${EXECUTION_SELECT} WHERE p.id = $1::uuid`, [params.id]);
  const row = res.rows[0];
  if (!row) return null;

  const events = await pool.query(
    `
      SELECT e.id, e.event_type, e.old_values, e.new_values, e.created_at, e.note,
             u.id AS user_id, u.username, u.name, u.surname
      FROM public.production_pointage_events e
      JOIN public.users u ON u.id = e.user_id
      WHERE e.pointage_id = $1::uuid
      ORDER BY e.created_at, e.id
    `,
    [params.id]
  );

  const declarations = await pool.query(
    `
      SELECT d.id::text AS id, d.qty_good::float8 AS qty_good, d.qty_scrap::float8 AS qty_scrap,
             d.qty_rework::float8 AS qty_rework, d.qty_pending_control::float8 AS qty_pending_control,
             d.unite, d.scrap_reason_code, d.rework_reason_code, d.note,
             d.non_conformity_id::text AS non_conformity_id,
             d.compensates_id::text AS compensates_id, d.compensation_reason,
             d.declared_at, u.username AS declared_by_username
      FROM public.production_quantity_declarations d
      JOIN public.users u ON u.id = d.declared_by
      WHERE d.pointage_id = $1::uuid
      ORDER BY d.declared_at, d.id
    `,
    [params.id]
  );

  return {
    ...mapExecutionRow(row),
    events: events.rows.map((e) => ({
      id: Number(e.id),
      event_type: e.event_type as string,
      old_values: e.old_values ?? null,
      new_values: e.new_values ?? null,
      created_at: e.created_at as string,
      note: (e.note as string | null) ?? null,
      user: {
        id: Number(e.user_id),
        username: e.username as string,
        name: e.name ?? null,
        surname: e.surname ?? null,
        label: operatorLabel({
          operator_username: e.username,
          operator_name: e.name,
          operator_surname: e.surname,
        }),
      },
    })),
    declarations: declarations.rows,
  };
}

/* -------------------------------------------------------------------------- */
/* Command center — KPI calculés par le serveur                               */
/* -------------------------------------------------------------------------- */

export async function repoExecutionCenter(params: {
  date_from: string;
  date_to: string;
  scopeOperatorUserId: number | null;
}) {
  const scope = params.scopeOperatorUserId;
  const res = await pool.query(
    `
      WITH scoped AS (
        SELECT p.*, c.criticality, c.is_productive, op.temps_total_planned, op.temps_total_real
        FROM public.production_pointages p
        LEFT JOIN public.production_activity_categories c ON c.code = p.activity_code
        LEFT JOIN public.of_operations op ON op.id = p.operation_id
        WHERE p.start_ts >= $1::date
          AND p.start_ts < ($2::date + INTERVAL '1 day')
          AND ($3::int IS NULL OR p.operator_user_id = $3::int)
      )
      SELECT
        count(*) FILTER (WHERE status = 'RUNNING')                               AS running,
        count(*) FILTER (
          WHERE status = 'RUNNING'
            AND EXTRACT(EPOCH FROM (now() - start_ts)) / 60.0 > $4::int
        )                                                                         AS long_running,
        count(*) FILTER (WHERE status = 'DONE' AND validated_at IS NULL AND rejected_at IS NULL) AS to_validate,
        count(*) FILTER (WHERE rejected_at IS NOT NULL)                           AS rejected,
        count(*) FILTER (WHERE criticality IN ('HIGH','CRITICAL'))                AS incidents,
        COALESCE(SUM(duration_minutes) FILTER (WHERE status = 'DONE'), 0)::int    AS total_minutes,
        COALESCE(SUM(duration_minutes) FILTER (WHERE status = 'DONE' AND is_productive), 0)::int AS productive_minutes
      FROM scoped
    `,
    [params.date_from, params.date_to, scope, LONG_RUNNING_ALERT_MINUTES]
  );

  const byActivity = await pool.query(
    `
      SELECT COALESCE(p.activity_code, 'NON_CATEGORISE') AS activity_code,
             COALESCE(c.label, 'Non catégorisé')          AS label,
             COALESCE(SUM(p.duration_minutes), 0)::int     AS minutes,
             count(*)::int                                 AS segments
      FROM public.production_pointages p
      LEFT JOIN public.production_activity_categories c ON c.code = p.activity_code
      WHERE p.status = 'DONE'
        AND p.start_ts >= $1::date
        AND p.start_ts < ($2::date + INTERVAL '1 day')
        AND ($3::int IS NULL OR p.operator_user_id = $3::int)
      GROUP BY 1, 2
      ORDER BY minutes DESC
    `,
    [params.date_from, params.date_to, scope]
  );

  const quantities = await pool.query(
    `
      SELECT
        COALESCE(SUM(d.qty_good), 0)::float8            AS qty_good,
        COALESCE(SUM(d.qty_scrap), 0)::float8           AS qty_scrap,
        COALESCE(SUM(d.qty_rework), 0)::float8          AS qty_rework,
        COALESCE(SUM(d.qty_pending_control), 0)::float8 AS qty_pending_control
      FROM public.production_quantity_declarations d
      WHERE d.declared_at >= $1::date
        AND d.declared_at < ($2::date + INTERVAL '1 day')
        AND ($3::int IS NULL OR d.declared_by = $3::int)
    `,
    [params.date_from, params.date_to, scope]
  );

  const k = res.rows[0] ?? {};
  return {
    range: { from: params.date_from, to: params.date_to },
    kpis: {
      running: Number(k.running ?? 0),
      long_running: Number(k.long_running ?? 0),
      to_validate: Number(k.to_validate ?? 0),
      rejected: Number(k.rejected ?? 0),
      incidents: Number(k.incidents ?? 0),
      total_minutes: Number(k.total_minutes ?? 0),
      productive_minutes: Number(k.productive_minutes ?? 0),
    },
    by_activity: byActivity.rows.map((r) => ({
      activity_code: r.activity_code as string,
      label: r.label as string,
      minutes: Number(r.minutes),
      segments: Number(r.segments),
    })),
    quantities: {
      qty_good: Number(quantities.rows[0]?.qty_good ?? 0),
      qty_scrap: Number(quantities.rows[0]?.qty_scrap ?? 0),
      qty_rework: Number(quantities.rows[0]?.qty_rework ?? 0),
      qty_pending_control: Number(quantities.rows[0]?.qty_pending_control ?? 0),
    },
    // Coûts et TRS/OEE : voir `repoExecutionIndicators`. Ils ne sont JAMAIS
    // remplacés par zéro quand la donnée manque.
  };
}

/**
 * Indicateurs dérivés. Rien n'est inventé : chaque indicateur non calculable
 * dit précisément ce qui manque, plutôt que d'afficher un zéro trompeur.
 */
export async function repoExecutionIndicators(params: { date_from: string; date_to: string }) {
  const res = await pool.query(
    `
      SELECT
        count(*)                                                     AS operations,
        count(*) FILTER (WHERE op.temps_total_planned > 0)           AS with_planned,
        COALESCE(SUM(op.temps_total_planned), 0)::float8             AS planned_hours,
        COALESCE(SUM(op.temps_total_real), 0)::float8                AS real_hours,
        count(*) FILTER (WHERE op.hourly_rate_applied > 0)           AS with_rate
      FROM public.of_operations op
      WHERE op.updated_at >= $1::date AND op.updated_at < ($2::date + INTERVAL '1 day')
    `,
    [params.date_from, params.date_to]
  );

  const row = res.rows[0] ?? {};
  const operations = Number(row.operations ?? 0);
  const withPlanned = Number(row.with_planned ?? 0);
  const plannedHours = Number(row.planned_hours ?? 0);
  const realHours = Number(row.real_hours ?? 0);
  const withRate = Number(row.with_rate ?? 0);

  const missingForCost: string[] = [];
  if (withRate === 0) missingForCost.push("taux horaire machine/main-d'œuvre renseigné");
  missingForCost.push("règles de temps indirect et de multi-opérateur validées");
  missingForCost.push("période de validité des taux");

  // Le TRS exige un calendrier de capacité théorique et une cadence nominale
  // versionnée : aucun des deux n'existe aujourd'hui dans le modèle.
  const missingForOee = [
    "calendrier / capacité théorique par machine",
    "temps planifié d'ouverture",
    "cadence nominale versionnée par opération",
  ];

  return {
    range: { from: params.date_from, to: params.date_to },
    time: {
      operations,
      operations_with_planned: withPlanned,
      planned_hours: Number(plannedHours.toFixed(3)),
      real_hours: Number(realHours.toFixed(3)),
      variance_hours: Number((realHours - plannedHours).toFixed(3)),
      computable: withPlanned > 0,
      missing: withPlanned > 0 ? [] : ["temps prévu renseigné sur les opérations"],
    },
    cost: { computable: false, value: null, missing: missingForCost },
    oee: { computable: false, value: null, missing: missingForOee },
  };
}

/* -------------------------------------------------------------------------- */
/* Poste opérateur                                                            */
/* -------------------------------------------------------------------------- */

export async function repoOperatorBoard(params: {
  operatorUserId: number;
  query: OperatorBoardQueryDTO;
}) {
  const active = await pool.query(`${EXECUTION_SELECT} WHERE p.operator_user_id = $1::int AND p.status = 'RUNNING'`, [
    params.operatorUserId,
  ]);

  // Opérations réellement pointables : OF exécutable, opération non terminée
  // ni bloquée. La liste est bornée côté serveur, jamais filtrée côté page.
  const values: unknown[] = [params.operatorUserId];
  let filter = "";
  if (params.query.of_id) {
    values.push(params.query.of_id);
    filter += ` AND o.id = $${values.length}::bigint`;
  }
  if (params.query.q) {
    values.push(`%${params.query.q}%`);
    filter += ` AND (o.numero ILIKE $${values.length} OR op.designation ILIKE $${values.length})`;
  }
  values.push(params.query.limit ?? 25);

  const candidates = await pool.query(
    `
      SELECT
        op.id::text                     AS operation_id,
        op.phase,
        op.designation,
        op.status::text                 AS status,
        op.temps_total_planned::float8  AS temps_total_planned,
        op.temps_total_real::float8     AS temps_total_real,
        o.id                            AS of_id,
        o.numero                        AS of_numero,
        o.statut::text                  AS of_statut,
        o.quantite_lancee::float8       AS quantite_lancee,
        o.quantite_bonne::float8        AS quantite_bonne,
        o.quantite_rebut::float8        AS quantite_rebut,
        m.id::text                      AS machine_id,
        m.code                          AS machine_code,
        m.name                          AS machine_name,
        -- Une opération dont une phase antérieure n'est pas terminée est
        -- signalée, mais le blocage effectif est décidé par le service.
        EXISTS (
          SELECT 1 FROM public.of_operations prev
          WHERE prev.of_id = op.of_id AND prev.phase < op.phase AND prev.status <> 'DONE'
        )                               AS has_pending_predecessor,
        EXISTS (
          SELECT 1 FROM public.production_pointages act
          WHERE act.operation_id = op.id AND act.status = 'RUNNING'
        )                               AS has_active_execution
      FROM public.of_operations op
      JOIN public.ordres_fabrication o ON o.id = op.of_id
      LEFT JOIN public.machines m ON m.id = op.machine_id
      WHERE o.statut IN ('PLANIFIE', 'EN_COURS', 'EN_PAUSE')
        AND op.status <> 'DONE'
        AND $1::int IS NOT NULL
        ${filter}
      ORDER BY o.numero, op.phase
      LIMIT $${values.length}
    `,
    values
  );

  return {
    operator_user_id: params.operatorUserId,
    active: active.rows.map(mapExecutionRow),
    candidates: candidates.rows.map((r) => ({
      operation_id: r.operation_id as string,
      phase: Number(r.phase),
      designation: r.designation as string,
      status: r.status as string,
      temps_total_planned: Number(r.temps_total_planned ?? 0),
      temps_total_real: Number(r.temps_total_real ?? 0),
      of: {
        id: Number(r.of_id),
        numero: r.of_numero as string,
        statut: r.of_statut as string,
        quantite_lancee: Number(r.quantite_lancee ?? 0),
        quantite_bonne: Number(r.quantite_bonne ?? 0),
        quantite_rebut: Number(r.quantite_rebut ?? 0),
      },
      machine: r.machine_id
        ? { id: r.machine_id as string, code: r.machine_code as string, name: r.machine_name as string }
        : null,
      has_pending_predecessor: Boolean(r.has_pending_predecessor),
      has_active_execution: Boolean(r.has_active_execution),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Verrouillage — ordre stable pour éviter les interblocages                   */
/* -------------------------------------------------------------------------- */

/**
 * Verrouille toujours dans le même ordre : OF, puis opération, puis segments de
 * l'opérateur, puis machine. Deux requêtes concurrentes prennent donc les
 * verrous dans la même séquence et ne peuvent pas s'interbloquer.
 */
async function lockExecutionContext(
  tx: DbQueryer,
  params: { of_id: number; operation_id?: string | null; operator_user_id: number; machine_id?: string | null }
) {
  const ofRes = await tx.query<{ id: string; statut: string; quantite_lancee: number }>(
    `SELECT id::text AS id, statut::text AS statut, quantite_lancee::float8 AS quantite_lancee
       FROM public.ordres_fabrication WHERE id = $1::bigint FOR UPDATE`,
    [params.of_id]
  );
  const of = ofRes.rows[0];
  if (!of) {
    throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable.", { of_id: params.of_id });
  }

  let operation: { id: string; status: string; phase: number; of_id: string } | null = null;
  if (params.operation_id) {
    const opRes = await tx.query<{ id: string; status: string; phase: number; of_id: string }>(
      `
        SELECT id::text AS id, status::text AS status, phase, of_id::text AS of_id
        FROM public.of_operations
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [params.operation_id]
    );
    operation = opRes.rows[0] ?? null;
    if (!operation) {
      throw new HttpError(404, "OF_OPERATION_NOT_FOUND", "Opération introuvable.", {
        operation_id: params.operation_id,
      });
    }
    // Cohérence opération/OF : refuse un rattachement croisé.
    if (Number(operation.of_id) !== Number(params.of_id)) {
      throw new HttpError(
        422,
        "PRODUCTION_EXECUTION_OPERATION_MISMATCH",
        "Cette opération n'appartient pas à l'ordre de fabrication indiqué."
      );
    }
  }

  // Verrou sur les segments actifs de l'opérateur : deux onglets ne peuvent pas
  // démarrer simultanément.
  await tx.query(
    `SELECT id FROM public.production_pointages WHERE operator_user_id = $1::int AND status = 'RUNNING' FOR UPDATE`,
    [params.operator_user_id]
  );

  if (params.machine_id) {
    await tx.query(
      `SELECT id FROM public.production_pointages WHERE machine_id = $1::uuid AND status = 'RUNNING' FOR UPDATE`,
      [params.machine_id]
    );
  }

  return { of, operation };
}

/** L'OF doit être dans un état exécutable — on ne pointe pas sur un OF clos. */
function assertOfExecutable(statut: string) {
  const executable = ["BROUILLON", "PLANIFIE", "EN_COURS", "EN_PAUSE"];
  if (!executable.includes(statut)) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_OF_NOT_EXECUTABLE",
      `Cet ordre de fabrication est en statut ${statut} : il n'accepte plus de pointage.`
    );
  }
}

function assertOperationExecutable(operation: { status: string } | null) {
  if (!operation) return;
  if (operation.status === "DONE") {
    throw new HttpError(
      409,
      "OF_OPERATION_ALREADY_DONE",
      "Cette opération est déclarée terminée : rouvrez-la avant de pointer."
    );
  }
  if (operation.status === "BLOCKED") {
    throw new HttpError(
      409,
      "OF_OPERATION_BLOCKED",
      "Cette opération est suspendue : débloquez-la avant de pointer."
    );
  }
}

/** Une maintenance bloquante interdit le démarrage : elle n'est pas contournable. */
async function assertMachineAvailable(tx: DbQueryer, machineId: string | null | undefined) {
  if (!machineId) return;
  const res = await tx.query<{ statut: string | null }>(
    `SELECT statut::text AS statut FROM public.machines WHERE id = $1::uuid`,
    [machineId]
  );
  const row = res.rows[0];
  if (!row) {
    throw new HttpError(404, "MACHINE_NOT_FOUND", "Machine introuvable.", { machine_id: machineId });
  }
  const blocking = ["HORS_SERVICE", "MAINTENANCE", "EN_MAINTENANCE", "INDISPONIBLE"];
  if (row.statut && blocking.includes(row.statut)) {
    throw new HttpError(
      409,
      "PRODUCTION_EXECUTION_MACHINE_UNAVAILABLE",
      `Cette machine est en statut ${row.statut} : le pointage est refusé.`,
      { machine_id: machineId, statut: row.statut }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Démarrage d'un segment                                                     */
/* -------------------------------------------------------------------------- */

export async function repoStartExecution(params: {
  body: StartExecutionBodyDTO;
  operatorUserId: number;
  idempotencyKey: string;
  audit: AuditContext;
  sessionId?: string | null;
  previousSegmentId?: string | null;
  segmentIndex?: number;
  source?: string;
  transactionHooks?: ProductionExecutionTransactionHooks<{ id: string }>;
}): Promise<ExecutionListItem> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await params.transactionHooks?.beforeEffect(client);

    const replay = await reserveIdempotencyKey<{ id: string }>(client, {
      key: params.idempotencyKey,
      scope: "production.execution.start",
      payload: { ...params.body, operator_user_id: params.operatorUserId },
      user_id: params.audit.user_id,
    });
    if (replay.replayed) {
      await params.transactionHooks?.beforeCommit(client, replay.body);
      await client.query("COMMIT");
      const existing = await repoGetExecution({ id: replay.body.id });
      if (!existing) throw new HttpError(409, "PRODUCTION_EXECUTION_REPLAY_LOST", "Rejeu impossible.");
      return existing;
    }

    const { of, operation } = await lockExecutionContext(client, {
      of_id: params.body.of_id,
      operation_id: params.body.operation_id ?? null,
      operator_user_id: params.operatorUserId,
      machine_id: params.body.machine_id ?? null,
    });

    assertOfExecutable(of.statut);
    assertOperationExecutable(operation);
    await assertMachineAvailable(client, params.body.machine_id);

    const activity = await loadActivity(client, params.body.activity_code);
    assertReasonProvided(activity, params.body.comment ?? params.body.retroactive_reason ?? null);

    // Saisie rétroactive : bornée et motivée. Sans motif, on refuse plutôt que
    // d'accepter silencieusement un horodatage fourni par le client.
    const isRetroactive = Boolean(params.body.start_ts);
    if (isRetroactive) {
      if (!params.body.retroactive_reason) {
        throw new HttpError(
          422,
          "PRODUCTION_EXECUTION_RETROACTIVE_REASON_REQUIRED",
          "Une saisie rétroactive doit être motivée."
        );
      }
      assertRetroactiveAllowed(params.body.start_ts as string, new Date().toISOString());
    }

    // Le type de ressource suit la catégorie si l'appelant ne l'impose pas :
    // le référentiel gouverne, le client ne devine pas.
    const timeType =
      params.body.time_type ?? activity.legacy_time_type ?? ("OPERATEUR" as const);

    // Contexte technique figé : la gamme peut être révisée pendant l'exécution,
    // la déclaration doit rester lisible telle qu'elle a été faite.
    const snapshot = {
      captured_at: new Date().toISOString(),
      of_numero: null as string | null,
      operation_phase: operation?.phase ?? null,
      activity_code: activity.code,
      activity_label: activity.label,
    };

    const sessionId = params.sessionId ?? null;

    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO public.production_pointages (
          of_id, operation_id, affaire_id, piece_technique_id,
          machine_id, poste_id, operator_user_id,
          time_type, activity_code,
          start_ts, status,
          comment, session_id, previous_segment_id, segment_index,
          source, idempotency_key, context_snapshot, is_retroactive,
          created_for_other_reason,
          created_by, updated_by
        )
        SELECT
          $1::bigint,
          $2::uuid,
          o.affaire_id,
          o.piece_technique_id,
          $3::uuid, $4::uuid, $5::int,
          $6::production_pointage_time_type, $7::text,
          COALESCE($8::timestamptz, now()), 'RUNNING'::production_pointage_status,
          $9, COALESCE($10::uuid, gen_random_uuid()), $11::uuid, $12::int,
          $13::text, $14::text, $15::jsonb, $16::boolean,
          $17,
          $18::int, $18::int
        FROM public.ordres_fabrication o
        WHERE o.id = $1::bigint
        RETURNING id::text AS id
      `,
      [
        params.body.of_id,
        params.body.operation_id ?? null,
        params.body.machine_id ?? null,
        params.body.poste_id ?? null,
        params.operatorUserId,
        timeType,
        activity.code,
        params.body.start_ts ?? null,
        params.body.comment ?? null,
        sessionId,
        params.previousSegmentId ?? null,
        params.segmentIndex ?? 1,
        params.source ?? (isRetroactive ? "RETROACTIVE" : "CANONICAL"),
        params.idempotencyKey,
        JSON.stringify(snapshot),
        isRetroactive,
        params.body.for_other_reason ?? null,
        params.audit.user_id,
      ]
    );

    const id = inserted.rows[0]?.id;
    if (!id) {
      throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable.");
    }

    await insertExecutionEvent(client, {
      pointage_id: id,
      event_type: "START",
      user_id: params.audit.user_id,
      new_values: {
        of_id: params.body.of_id,
        operation_id: params.body.operation_id ?? null,
        machine_id: params.body.machine_id ?? null,
        activity_code: activity.code,
        operator_user_id: params.operatorUserId,
        is_retroactive: isRetroactive,
      },
      note: params.body.retroactive_reason ?? params.body.for_other_reason ?? null,
    });

    // L'OF passe EN_COURS au premier pointage : c'est le seul effet de bord
    // toléré, il est explicite et audité.
    if (["BROUILLON", "PLANIFIE", "EN_PAUSE"].includes(of.statut)) {
      await client.query(
        `
          UPDATE public.ordres_fabrication
          SET statut = 'EN_COURS'::of_status,
              date_lancement_reelle = COALESCE(date_lancement_reelle, CURRENT_DATE),
              updated_at = now(), updated_by = $2
          WHERE id = $1::bigint
        `,
        [params.body.of_id, params.audit.user_id]
      );
    }

    if (operation && operation.status !== "RUNNING") {
      await client.query(
        `
          UPDATE public.of_operations
          SET status = 'RUNNING'::of_operation_status,
              started_at = COALESCE(started_at, now()),
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [operation.id]
      );
    }

    await insertAuditLog(client, params.audit, {
      action: "production.execution.start",
      entity_type: "production_pointages",
      entity_id: id,
      details: {
        of_id: params.body.of_id,
        operation_id: params.body.operation_id ?? null,
        machine_id: params.body.machine_id ?? null,
        activity_code: activity.code,
        operator_user_id: params.operatorUserId,
        on_behalf: params.operatorUserId !== params.audit.user_id,
      },
    });

    await storeIdempotentResponse(client, params.idempotencyKey, { id });
    await params.transactionHooks?.beforeCommit(client, { id });
    await client.query("COMMIT");

    const created = await repoGetExecution({ id });
    if (!created) throw new HttpError(500, "PRODUCTION_EXECUTION_READ_BACK_FAILED", "Relecture impossible.");
    return created;
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Arrêt d'un segment                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Arrête le segment actif. NE TERMINE PAS l'opération et NE DÉCLARE AUCUNE
 * quantité : ces deux effets relèvent de la commande atomique de fin
 * d'opération, jamais d'un simple arrêt de timer.
 */
export async function repoStopExecution(params: {
  id: string;
  body: StopExecutionBodyDTO;
  idempotencyKey: string;
  actorRole: string | null | undefined;
  audit: AuditContext;
  eventType?: ExecutionEventType;
  transactionHooks?: ProductionExecutionTransactionHooks<{ id: string }>;
}): Promise<ExecutionListItem> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await params.transactionHooks?.beforeEffect(client);

    const replay = await reserveIdempotencyKey<{ id: string }>(client, {
      key: params.idempotencyKey,
      scope: "production.execution.stop",
      payload: { id: params.id, ...params.body },
      user_id: params.audit.user_id,
    });
    if (replay.replayed) {
      await params.transactionHooks?.beforeCommit(client, replay.body);
      await client.query("COMMIT");
      const existing = await repoGetExecution({ id: params.id });
      if (!existing) throw new HttpError(409, "PRODUCTION_EXECUTION_REPLAY_LOST", "Rejeu impossible.");
      return existing;
    }

    const current = await lockPointage(client, params.id);
    assertOwnershipOrSupervision({
      actorUserId: params.audit.user_id,
      actorRole: params.actorRole,
      ownerUserId: current.operator_user_id,
      action: "arrêt",
    });
    assertMutable(current);

    if (current.status !== "RUNNING") {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_NOT_RUNNING",
        "Ce pointage n'est pas en cours : il a déjà été arrêté."
      );
    }
    assertExecutionTransition("RUNNING", "DONE");

    if (params.body.end_ts && !params.body.retroactive_reason) {
      throw new HttpError(
        422,
        "PRODUCTION_EXECUTION_RETROACTIVE_REASON_REQUIRED",
        "Un horodatage d'arrêt imposé doit être motivé."
      );
    }
    if (params.body.end_ts) {
      const minutes = computeDurationMinutes(current.start_ts, params.body.end_ts);
      assertPlausibleDuration(minutes);
    }

    const stopped = await client.query<{ duration_minutes: number | null }>(
      `
        UPDATE public.production_pointages
        SET status = 'DONE'::production_pointage_status,
            end_ts = COALESCE($2::timestamptz, now()),
            comment = COALESCE($3, comment),
            updated_at = now(),
            updated_by = $4::int
        WHERE id = $1::uuid AND status = 'RUNNING'
        RETURNING duration_minutes
      `,
      [params.id, params.body.end_ts ?? null, params.body.comment ?? null, params.audit.user_id]
    );

    if (!stopped.rows[0]) {
      // Une autre requête a arrêté le pointage entre le verrou et l'UPDATE.
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_ALREADY_STOPPED",
        "Ce pointage vient d'être arrêté par une autre action."
      );
    }

    await insertExecutionEvent(client, {
      pointage_id: params.id,
      event_type: params.eventType ?? "STOP",
      user_id: params.audit.user_id,
      old_values: { status: "RUNNING" },
      new_values: { status: "DONE", duration_minutes: stopped.rows[0].duration_minutes },
      note: params.body.retroactive_reason ?? null,
    });

    // Source unique du temps réel : recalcul complet, jamais incrémental.
    if (current.operation_id) {
      await client.query(`SELECT public.fn_production_recompute_operation_real_time($1::uuid)`, [
        current.operation_id,
      ]);
    }

    await insertAuditLog(client, params.audit, {
      action: "production.execution.stop",
      entity_type: "production_pointages",
      entity_id: params.id,
      details: {
        of_id: current.of_id,
        operation_id: current.operation_id,
        duration_minutes: stopped.rows[0].duration_minutes,
      },
    });

    await storeIdempotentResponse(client, params.idempotencyKey, { id: params.id });
    await params.transactionHooks?.beforeCommit(client, { id: params.id });
    await client.query("COMMIT");

    const updated = await repoGetExecution({ id: params.id });
    if (!updated) throw new HttpError(500, "PRODUCTION_EXECUTION_READ_BACK_FAILED", "Relecture impossible.");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}

type LockedPointage = {
  id: string;
  of_id: number;
  operation_id: string | null;
  machine_id: string | null;
  poste_id: string | null;
  operator_user_id: number;
  activity_code: string | null;
  time_type: string;
  status: "RUNNING" | "DONE" | "CANCELLED" | "CORRECTED";
  start_ts: string;
  end_ts: string | null;
  session_id: string | null;
  segment_index: number;
  validated_at: string | null;
  submitted_at: string | null;
};

async function lockPointage(tx: DbQueryer, id: string): Promise<LockedPointage> {
  const res = await tx.query<LockedPointage>(
    `
      SELECT id::text AS id, of_id::int AS of_id, operation_id::text AS operation_id,
             machine_id::text AS machine_id, poste_id::text AS poste_id,
             operator_user_id, activity_code, time_type::text AS time_type,
             status::text AS status, start_ts, end_ts,
             session_id::text AS session_id, segment_index,
             validated_at, submitted_at
      FROM public.production_pointages
      WHERE id = $1::uuid
      FOR UPDATE
    `,
    [id]
  );
  const row = res.rows[0];
  if (!row) {
    throw new HttpError(404, "PRODUCTION_EXECUTION_NOT_FOUND", "Pointage introuvable.", { id });
  }
  return row;
}

/* -------------------------------------------------------------------------- */
/* Pause / reprise / changement — segments immuables                          */
/* -------------------------------------------------------------------------- */

/**
 * Un changement (activité, machine, opérateur) ou une pause CLÔTURE le segment
 * courant et en OUVRE un nouveau. Aucun segment passé n'est réécrit : c'est ce
 * qui rend l'historique opposable.
 */
export async function repoTransitionSegment(params: {
  id: string;
  kind: "PAUSE" | "RESUME" | "CHANGE" | "INCIDENT";
  body: PauseExecutionBodyDTO | ResumeExecutionBodyDTO | ChangeExecutionBodyDTO | IncidentExecutionBodyDTO;
  idempotencyKey: string;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<ExecutionListItem> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const replay = await reserveIdempotencyKey<{ id: string }>(client, {
      key: params.idempotencyKey,
      scope: `production.execution.${params.kind.toLowerCase()}`,
      payload: { id: params.id, ...params.body },
      user_id: params.audit.user_id,
    });
    if (replay.replayed) {
      await client.query("COMMIT");
      const existing = await repoGetExecution({ id: replay.body.id });
      if (!existing) throw new HttpError(409, "PRODUCTION_EXECUTION_REPLAY_LOST", "Rejeu impossible.");
      return existing;
    }

    const current = await lockPointage(client, params.id);
    assertOwnershipOrSupervision({
      actorUserId: params.audit.user_id,
      actorRole: params.actorRole,
      ownerUserId: current.operator_user_id,
      action: params.kind.toLowerCase(),
    });
    assertMutable(current);

    if (current.status !== "RUNNING") {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_NOT_RUNNING",
        "Ce pointage n'est pas en cours : aucune transition possible."
      );
    }

    const body = params.body as ChangeExecutionBodyDTO & IncidentExecutionBodyDTO;

    // 1) Clôture du segment courant. La convention [début, fin) garantit que la
    // minute de bascule n'est comptée qu'une fois.
    const closed = await client.query<{ duration_minutes: number | null; end_ts: string }>(
      `
        UPDATE public.production_pointages
        SET status = 'DONE'::production_pointage_status,
            end_ts = now(),
            updated_at = now(),
            updated_by = $2::int
        WHERE id = $1::uuid AND status = 'RUNNING'
        RETURNING duration_minutes, end_ts
      `,
      [params.id, params.audit.user_id]
    );
    if (!closed.rows[0]) {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_ALREADY_STOPPED",
        "Ce pointage vient d'être arrêté par une autre action."
      );
    }

    const eventType: ExecutionEventType =
      params.kind === "PAUSE"
        ? "PAUSE"
        : params.kind === "RESUME"
          ? "RESUME"
          : params.kind === "INCIDENT"
            ? "INCIDENT"
            : body.operator_user_id !== undefined
              ? "CHANGE_OPERATOR"
              : body.machine_id !== undefined
                ? "CHANGE_MACHINE"
                : "CHANGE_ACTIVITY";

    await insertExecutionEvent(client, {
      pointage_id: params.id,
      event_type: eventType,
      user_id: params.audit.user_id,
      old_values: {
        activity_code: current.activity_code,
        machine_id: current.machine_id,
        operator_user_id: current.operator_user_id,
      },
      new_values: {
        activity_code: body.activity_code ?? current.activity_code,
        machine_id: body.machine_id === undefined ? current.machine_id : body.machine_id,
        operator_user_id: body.operator_user_id ?? current.operator_user_id,
        closed_duration_minutes: closed.rows[0].duration_minutes,
      },
      note: body.reason ?? body.comment ?? null,
    });

    if (current.operation_id) {
      await client.query(`SELECT public.fn_production_recompute_operation_real_time($1::uuid)`, [
        current.operation_id,
      ]);
    }

    // 2) Une PAUSE n'ouvre pas de nouveau segment de travail : le temps
    // s'arrête. La reprise en ouvrira un.
    let nextId: string | null = null;
    if (params.kind !== "PAUSE") {
      const nextActivityCode = body.activity_code ?? current.activity_code ?? "PRODUCTION";
      const activity = await loadActivity(client, nextActivityCode);
      if (params.kind === "INCIDENT") {
        assertReasonProvided(activity, body.reason ?? null);
      }

      const nextOperator = body.operator_user_id ?? current.operator_user_id;
      const nextMachine = body.machine_id === undefined ? current.machine_id : body.machine_id;
      await assertMachineAvailable(client, nextMachine);

      // Verrou sur le nouvel opérateur/nouvelle machine avant insertion.
      await client.query(
        `SELECT id FROM public.production_pointages WHERE operator_user_id = $1::int AND status = 'RUNNING' FOR UPDATE`,
        [nextOperator]
      );

      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.production_pointages (
            of_id, operation_id, affaire_id, piece_technique_id,
            machine_id, poste_id, operator_user_id,
            time_type, activity_code, start_ts, status, comment,
            session_id, previous_segment_id, segment_index, source,
            context_snapshot, created_by, updated_by
          )
          SELECT
            p.of_id, p.operation_id, p.affaire_id, p.piece_technique_id,
            $2::uuid, COALESCE($3::uuid, p.poste_id), $4::int,
            COALESCE($5::production_pointage_time_type, p.time_type),
            $6::text,
            p.end_ts,
            'RUNNING'::production_pointage_status,
            $7,
            COALESCE(p.session_id, p.id),
            p.id,
            p.segment_index + 1,
            'CANONICAL',
            p.context_snapshot,
            $8::int, $8::int
          FROM public.production_pointages p
          WHERE p.id = $1::uuid
          RETURNING id::text AS id
        `,
        [
          params.id,
          nextMachine,
          body.poste_id === undefined ? null : body.poste_id,
          nextOperator,
          activity.legacy_time_type,
          activity.code,
          body.comment ?? null,
          params.audit.user_id,
        ]
      );
      nextId = ins.rows[0]?.id ?? null;

      if (nextId) {
        await insertExecutionEvent(client, {
          pointage_id: nextId,
          event_type: params.kind === "RESUME" ? "RESUME" : "START",
          user_id: params.audit.user_id,
          new_values: {
            activity_code: activity.code,
            machine_id: nextMachine,
            operator_user_id: nextOperator,
            previous_segment_id: params.id,
          },
          note: body.reason ?? null,
        });
      }
    }

    // 3) Un aléa qui arrête la machine la signale, sans jamais contourner une
    // maintenance ni écrire dans le parc machine.
    await insertAuditLog(client, params.audit, {
      action: `production.execution.${params.kind.toLowerCase()}`,
      entity_type: "production_pointages",
      entity_id: params.id,
      details: {
        of_id: current.of_id,
        operation_id: current.operation_id,
        next_pointage_id: nextId,
        activity_code: body.activity_code ?? current.activity_code,
        stops_machine: Boolean(body.stops_machine),
        reason: body.reason ?? null,
      },
    });

    const responseId = nextId ?? params.id;
    await storeIdempotentResponse(client, params.idempotencyKey, { id: responseId });
    await client.query("COMMIT");

    const result = await repoGetExecution({ id: responseId });
    if (!result) throw new HttpError(500, "PRODUCTION_EXECUTION_READ_BACK_FAILED", "Relecture impossible.");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Fin d'opération — commande métier atomique                                 */
/* -------------------------------------------------------------------------- */

export type FinishOperationPreview = {
  of: { id: number; numero: string; quantite_lancee: number; quantite_bonne: number; quantite_rebut: number };
  operation: { id: string; phase: number; designation: string; status: string; temps_total_real: number };
  active_segment: { id: string; elapsed_minutes: number } | null;
  declared: { qty_good: number; qty_scrap: number; qty_rework: number; qty_pending_control: number };
  already_declared: { qty_good: number; qty_scrap: number; qty_rework: number };
  remaining_before: number;
  remaining_after: number;
  will_stop_segment: boolean;
  will_complete_operation: boolean;
  requires_quality_decision: boolean;
  warnings: string[];
  /** Empreinte de l'aperçu : la confirmation doit la présenter à l'identique. */
  preview_hash: string;
};

async function buildFinishPreview(
  tx: DbQueryer,
  params: { body: FinishOperationPreviewBodyDTO; operatorUserId: number }
): Promise<FinishOperationPreview> {
  const ofRes = await tx.query(
    `
      SELECT o.id, o.numero, o.quantite_lancee::float8 AS quantite_lancee,
             o.quantite_bonne::float8 AS quantite_bonne, o.quantite_rebut::float8 AS quantite_rebut
      FROM public.ordres_fabrication o WHERE o.id = $1::bigint
    `,
    [params.body.of_id]
  );
  const of = ofRes.rows[0];
  if (!of) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable.");

  const opRes = await tx.query(
    `
      SELECT op.id::text AS id, op.phase, op.designation, op.status::text AS status,
             op.temps_total_real::float8 AS temps_total_real, op.of_id::int AS of_id
      FROM public.of_operations op WHERE op.id = $1::uuid
    `,
    [params.body.operation_id]
  );
  const operation = opRes.rows[0];
  if (!operation) throw new HttpError(404, "OF_OPERATION_NOT_FOUND", "Opération introuvable.");
  if (Number(operation.of_id) !== Number(params.body.of_id)) {
    throw new HttpError(
      422,
      "PRODUCTION_EXECUTION_OPERATION_MISMATCH",
      "Cette opération n'appartient pas à l'ordre de fabrication indiqué."
    );
  }

  const activeRes = await tx.query(
    `
      SELECT id::text AS id,
             GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - start_ts)) / 60.0)::int) AS elapsed_minutes
      FROM public.production_pointages
      WHERE operation_id = $1::uuid AND operator_user_id = $2::int AND status = 'RUNNING'
      ORDER BY start_ts DESC LIMIT 1
    `,
    [params.body.operation_id, params.operatorUserId]
  );

  const declaredRes = await tx.query(
    `
      SELECT COALESCE(SUM(qty_good), 0)::float8 AS qty_good,
             COALESCE(SUM(qty_scrap), 0)::float8 AS qty_scrap,
             COALESCE(SUM(qty_rework), 0)::float8 AS qty_rework
      FROM public.production_quantity_declarations
      WHERE operation_id = $1::uuid
    `,
    [params.body.operation_id]
  );

  const declared = {
    qty_good: params.body.qty_good ?? 0,
    qty_scrap: params.body.qty_scrap ?? 0,
    qty_rework: params.body.qty_rework ?? 0,
    qty_pending_control: params.body.qty_pending_control ?? 0,
  };
  const already = {
    qty_good: Number(declaredRes.rows[0]?.qty_good ?? 0),
    qty_scrap: Number(declaredRes.rows[0]?.qty_scrap ?? 0),
    qty_rework: Number(declaredRes.rows[0]?.qty_rework ?? 0),
  };

  const remainingBefore = Number(of.quantite_lancee) - already.qty_good - already.qty_scrap;
  const remainingAfter = remainingBefore - declared.qty_good - declared.qty_scrap;

  const warnings: string[] = [];
  if (declared.qty_scrap > 0) {
    warnings.push(
      "Le rebut déclaré sera transmis à la Qualité pour décision. Aucune non-conformité n'est créée automatiquement ici."
    );
  }
  if (declared.qty_pending_control > 0) {
    warnings.push("Les quantités en attente de contrôle ne sont pas disponibles en stock.");
  }
  if (remainingAfter < 0) {
    warnings.push("Cette déclaration dépasse le restant de l'ordre de fabrication.");
  }
  warnings.push(
    "Aucune entrée en stock n'est créée : la mise en stock passe par la réception de production."
  );

  const preview = {
    of: {
      id: Number(of.id),
      numero: of.numero as string,
      quantite_lancee: Number(of.quantite_lancee),
      quantite_bonne: Number(of.quantite_bonne),
      quantite_rebut: Number(of.quantite_rebut),
    },
    operation: {
      id: operation.id as string,
      phase: Number(operation.phase),
      designation: operation.designation as string,
      status: operation.status as string,
      temps_total_real: Number(operation.temps_total_real),
    },
    active_segment: activeRes.rows[0]
      ? { id: activeRes.rows[0].id as string, elapsed_minutes: Number(activeRes.rows[0].elapsed_minutes) }
      : null,
    declared,
    already_declared: already,
    remaining_before: remainingBefore,
    remaining_after: remainingAfter,
    will_stop_segment: Boolean(params.body.stop_active_segment) && Boolean(activeRes.rows[0]),
    will_complete_operation: Boolean(params.body.complete_operation),
    requires_quality_decision: declared.qty_scrap > 0 || declared.qty_pending_control > 0,
    warnings,
  };

  // L'empreinte couvre l'état serveur ET l'intention : si l'un des deux bouge,
  // la confirmation est refusée plutôt qu'appliquée sur des données périmées.
  const preview_hash = fingerprintPayload("production.execution.finish", {
    of: preview.of,
    operation: preview.operation,
    declared: preview.declared,
    already_declared: preview.already_declared,
    active_segment_id: preview.active_segment?.id ?? null,
    will_complete_operation: preview.will_complete_operation,
  });

  return { ...preview, preview_hash };
}

export async function repoPreviewFinishOperation(params: {
  body: FinishOperationPreviewBodyDTO;
  operatorUserId: number;
}): Promise<FinishOperationPreview> {
  return buildFinishPreview(pool, params);
}

/**
 * Fin d'opération en UNE transaction : verrous, arrêt du segment, validation
 * des quantités, déclaration immuable, progression, transition d'état, recalcul
 * du temps, audit. L'échec d'une étape n'en laisse aucune appliquée.
 */
export async function repoFinishOperation(params: {
  body: FinishOperationBodyDTO;
  operatorUserId: number;
  idempotencyKey: string;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<{ preview: FinishOperationPreview; declaration_id: string | null; operation_status: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const replay = await reserveIdempotencyKey<{
      preview: FinishOperationPreview;
      declaration_id: string | null;
      operation_status: string;
    }>(client, {
      key: params.idempotencyKey,
      scope: "production.execution.finish",
      payload: params.body,
      user_id: params.audit.user_id,
    });
    if (replay.replayed) {
      await client.query("COMMIT");
      return replay.body;
    }

    await lockExecutionContext(client, {
      of_id: params.body.of_id,
      operation_id: params.body.operation_id,
      operator_user_id: params.operatorUserId,
    });

    // Aperçu recalculé SOUS VERROU : c'est lui qui fait foi, pas celui affiché.
    const preview = await buildFinishPreview(client, {
      body: params.body,
      operatorUserId: params.operatorUserId,
    });

    if (preview.preview_hash !== params.body.preview_hash) {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_PREVIEW_STALE",
        "L'état a changé depuis l'aperçu : rechargez et vérifiez avant de confirmer.",
        { expected: preview.preview_hash }
      );
    }

    const delta = preview.declared;
    assertFiniteQuantities(delta);

    if (delta.qty_scrap > 0 && !params.body.scrap_reason_code) {
      throw new HttpError(
        422,
        "PRODUCTION_QUANTITY_SCRAP_REASON_REQUIRED",
        "Une cause de rebut est obligatoire.",
        { details: { fields: { scrap_reason_code: ["Sélectionnez une cause de rebut."] } } }
      );
    }
    if (delta.qty_rework > 0 && !params.body.rework_reason_code) {
      throw new HttpError(
        422,
        "PRODUCTION_QUANTITY_REWORK_REASON_REQUIRED",
        "Une cause de reprise est obligatoire.",
        { details: { fields: { rework_reason_code: ["Sélectionnez une cause de reprise."] } } }
      );
    }

    // Surproduction : interdite sauf tolérance explicite ET motif.
    assertWithinRemaining({
      declared: delta.qty_good + delta.qty_scrap,
      alreadyDeclared: preview.already_declared.qty_good + preview.already_declared.qty_scrap,
      quantityTarget: preview.of.quantite_lancee,
      overproductionTolerance: 0,
      reason: params.body.overproduction_reason ?? null,
    });

    // 1) Arrêt du segment actif, dans la même transaction.
    if (preview.will_stop_segment && preview.active_segment) {
      const stopped = await client.query(
        `
          UPDATE public.production_pointages
          SET status = 'DONE'::production_pointage_status, end_ts = now(),
              updated_at = now(), updated_by = $2::int
          WHERE id = $1::uuid AND status = 'RUNNING'
          RETURNING duration_minutes
        `,
        [preview.active_segment.id, params.audit.user_id]
      );
      if (!stopped.rows[0]) {
        throw new HttpError(
          409,
          "PRODUCTION_EXECUTION_ALREADY_STOPPED",
          "Le pointage vient d'être arrêté par une autre action : rechargez."
        );
      }
      await insertExecutionEvent(client, {
        pointage_id: preview.active_segment.id,
        event_type: "STOP",
        user_id: params.audit.user_id,
        new_values: { status: "DONE", via: "finish_operation" },
      });
    }

    // 2) Déclaration immuable en deltas.
    let declarationId: string | null = null;
    const hasQuantities =
      delta.qty_good > 0 || delta.qty_scrap > 0 || delta.qty_rework > 0 || delta.qty_pending_control > 0;

    if (hasQuantities) {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.production_quantity_declarations (
            pointage_id, of_id, operation_id,
            qty_good, qty_scrap, qty_rework, qty_pending_control,
            unite, scrap_reason_code, rework_reason_code, note,
            idempotency_key, declared_by
          )
          VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::int)
          RETURNING id::text AS id
        `,
        [
          preview.active_segment?.id ?? null,
          params.body.of_id,
          params.body.operation_id,
          delta.qty_good,
          delta.qty_scrap,
          delta.qty_rework,
          delta.qty_pending_control,
          params.body.unite ?? null,
          params.body.scrap_reason_code ?? null,
          params.body.rework_reason_code ?? null,
          params.body.note ?? null,
          `${params.idempotencyKey}:declaration`,
          params.audit.user_id,
        ]
      );
      declarationId = ins.rows[0]?.id ?? null;

      if (preview.active_segment?.id && declarationId) {
        await insertExecutionEvent(client, {
          pointage_id: preview.active_segment.id,
          event_type: "DECLARE_QUANTITY",
          user_id: params.audit.user_id,
          new_values: { declaration_id: declarationId, ...delta },
          note: params.body.note ?? null,
        });
      }

      // 3) Progression cumulée de l'OF. Les quantités en attente de contrôle
      // n'y entrent PAS : elles ne sont ni bonnes ni rebutées tant que la
      // Qualité n'a pas décidé.
      await client.query(
        `
          UPDATE public.ordres_fabrication
          SET quantite_bonne = quantite_bonne + $2,
              quantite_rebut = quantite_rebut + $3,
              updated_at = now(), updated_by = $4::int
          WHERE id = $1::bigint
        `,
        [params.body.of_id, delta.qty_good, delta.qty_scrap, params.audit.user_id]
      );
    }

    // 4) Recalcul du temps réel depuis la source unique.
    await client.query(`SELECT public.fn_production_recompute_operation_real_time($1::uuid)`, [
      params.body.operation_id,
    ]);

    // 5) Transition d'état de l'opération, seulement si demandée.
    let operationStatus = preview.operation.status;
    if (params.body.complete_operation) {
      if (preview.operation.status === "DONE") {
        throw new HttpError(
          409,
          "OF_OPERATION_ALREADY_DONE",
          "Cette opération est déjà déclarée terminée."
        );
      }
      const stillRunning = await client.query<{ n: string }>(
        `
          SELECT count(*)::text AS n FROM public.production_pointages
          WHERE operation_id = $1::uuid AND status = 'RUNNING'
        `,
        [params.body.operation_id]
      );
      if (Number(stillRunning.rows[0]?.n ?? 0) > 0) {
        throw new HttpError(
          409,
          "PRODUCTION_EXECUTION_STILL_RUNNING",
          "Des pointages sont encore en cours sur cette opération : arrêtez-les avant de la terminer."
        );
      }
      await client.query(
        `
          UPDATE public.of_operations
          SET status = 'DONE'::of_operation_status, ended_at = now(), updated_at = now()
          WHERE id = $1::uuid
        `,
        [params.body.operation_id]
      );
      operationStatus = "DONE";
    }

    await insertAuditLog(client, params.audit, {
      action: "production.execution.finish-operation",
      entity_type: "of_operations",
      entity_id: params.body.operation_id,
      details: {
        of_id: params.body.of_id,
        declaration_id: declarationId,
        ...delta,
        completed: params.body.complete_operation ?? false,
        requires_quality_decision: preview.requires_quality_decision,
        // Traçabilité explicite de ce qui N'A PAS été fait : aucune entrée en
        // stock, aucun lot, aucune NC créés par cette commande.
        no_stock_movement: true,
        no_lot_created: true,
        no_non_conformity_created: true,
      },
    });

    const result = { preview, declaration_id: declarationId, operation_status: operationStatus };
    await storeIdempotentResponse(client, params.idempotencyKey, result);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Déclaration de quantité isolée                                             */
/* -------------------------------------------------------------------------- */

export async function repoDeclareQuantity(params: {
  body: DeclareQuantityBodyDTO;
  idempotencyKey: string;
  audit: AuditContext;
  sourceContext?: ProductionQuantitySourceContext;
  transactionHooks?: ProductionExecutionTransactionHooks<{ id: string }>;
}): Promise<{ id: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await params.transactionHooks?.beforeEffect(client);

    const replay = await reserveIdempotencyKey<{ id: string }>(client, {
      key: params.idempotencyKey,
      scope: "production.execution.declare-quantity",
      payload: params.sourceContext
        ? { ...params.body, source_context: params.sourceContext }
        : params.body,
      user_id: params.audit.user_id,
    });
    if (replay.replayed) {
      await params.transactionHooks?.beforeCommit(client, replay.body);
      await client.query("COMMIT");
      return replay.body;
    }

    if (params.sourceContext && !params.body.pointage_id) {
      throw new HttpError(
        409,
        "OFFLINE_POINTAGE_REQUIRED",
        "Une quantité hors ligne doit référencer son pointage de production."
      );
    }

    // Si l'opération n'est pas répétée dans le payload, le pointage fournit un
    // indice non verrouillé. La valeur définitive est relue sous verrou après
    // l'ordre global OF → opération → pointage, afin d'éviter les deadlocks.
    let operationId = params.body.operation_id ?? null;
    if (params.body.pointage_id && !operationId) {
      const hint = await client.query<{ operation_id: string | null }>(
        `SELECT operation_id::text AS operation_id
           FROM public.production_pointages
          WHERE id = $1::uuid`,
        [params.body.pointage_id]
      );
      if (!hint.rows[0]) {
        throw new HttpError(404, "PRODUCTION_EXECUTION_NOT_FOUND", "Pointage introuvable.", {
          id: params.body.pointage_id,
        });
      }
      operationId = hint.rows[0].operation_id;
    }

    const { of, operation } = await lockExecutionContext(client, {
      of_id: params.body.of_id,
      operation_id: operationId,
      operator_user_id: params.audit.user_id,
    });
    assertOfExecutable(of.statut);
    assertOperationExecutable(operation);

    let pointage: LockedPointage | null = null;
    if (params.body.pointage_id) {
      pointage = await lockPointage(client, params.body.pointage_id);
      if (pointage.operator_user_id !== params.audit.user_id) {
        throw new HttpError(
          409,
          "PRODUCTION_QUANTITY_POINTAGE_OPERATOR_CONFLICT",
          "Ce pointage appartient à un autre opérateur."
        );
      }
      if (Number(pointage.of_id) !== Number(params.body.of_id)) {
        throw new HttpError(
          422,
          "PRODUCTION_QUANTITY_POINTAGE_OF_CONFLICT",
          "Le pointage ne concerne pas l'ordre de fabrication indiqué."
        );
      }
      if ((pointage.operation_id ?? null) !== operationId) {
        throw new HttpError(
          422,
          "PRODUCTION_QUANTITY_POINTAGE_OPERATION_CONFLICT",
          "Le pointage ne concerne pas l'opération indiquée."
        );
      }
      if (pointage.status === "CANCELLED" || pointage.status === "CORRECTED") {
        throw new HttpError(
          409,
          "PRODUCTION_QUANTITY_POINTAGE_NOT_ELIGIBLE",
          "Un pointage annulé ou corrigé ne peut pas recevoir de quantité."
        );
      }
      if (params.sourceContext) {
        if (pointage.operator_user_id !== params.sourceContext.operatorUserId) {
          throw new HttpError(
            409,
            "OFFLINE_QUANTITY_POINTAGE_OPERATOR_CONFLICT",
            "Le pointage ne correspond pas à l'opérateur de la capture hors ligne."
          );
        }
        if ((pointage.machine_id ?? null) !== params.sourceContext.machineId) {
          throw new HttpError(
            409,
            "OFFLINE_QUANTITY_POINTAGE_MACHINE_CONFLICT",
            "Le pointage ne correspond pas à la machine de la capture hors ligne."
          );
        }
        // Un pointage direct déjà actif n'a pas de start_event_id dans la file :
        // `executionSessionId` vaut alors null et ne doit pas imposer que la
        // session serveur le soit aussi. Lorsqu'un START offline a été résolu,
        // son identifiant déterministe reste en revanche obligatoire.
        if (
          params.sourceContext.executionSessionId !== null
          && (pointage.session_id ?? null) !== params.sourceContext.executionSessionId
        ) {
          throw new HttpError(
            409,
            "OFFLINE_QUANTITY_POINTAGE_SESSION_CONFLICT",
            "Le pointage ne correspond pas au démarrage de la capture hors ligne."
          );
        }
      }
    }

    const delta = {
      qty_good: params.body.qty_good ?? 0,
      qty_scrap: params.body.qty_scrap ?? 0,
      qty_rework: params.body.qty_rework ?? 0,
      qty_pending_control: params.body.qty_pending_control ?? 0,
    };
    assertFiniteQuantities(delta);

    if (delta.qty_scrap > 0 && !params.body.scrap_reason_code) {
      throw new HttpError(422, "PRODUCTION_QUANTITY_SCRAP_REASON_REQUIRED", "Une cause de rebut est obligatoire.");
    }
    if (delta.qty_rework > 0 && !params.body.rework_reason_code) {
      throw new HttpError(422, "PRODUCTION_QUANTITY_REWORK_REASON_REQUIRED", "Une cause de reprise est obligatoire.");
    }

    // L'OF est encore verrouillé : deux déclarations concurrentes relisent le
    // cumul l'une après l'autre et ne peuvent pas dépasser ensemble le restant.
    const declaredRes = await client.query<{ qty_good: number; qty_scrap: number }>(
      `
        SELECT COALESCE(SUM(qty_good), 0)::float8 AS qty_good,
               COALESCE(SUM(qty_scrap), 0)::float8 AS qty_scrap
          FROM public.production_quantity_declarations
         WHERE of_id = $1::bigint
           AND operation_id IS NOT DISTINCT FROM $2::uuid
      `,
      [params.body.of_id, operationId]
    );
    const alreadyDeclared = Number(declaredRes.rows[0]?.qty_good ?? 0)
      + Number(declaredRes.rows[0]?.qty_scrap ?? 0);
    assertWithinRemaining({
      declared: delta.qty_good + delta.qty_scrap,
      alreadyDeclared,
      quantityTarget: Number(of.quantite_lancee),
      overproductionTolerance: 0,
      reason: params.body.overproduction_reason ?? null,
    });

    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.production_quantity_declarations (
          pointage_id, of_id, operation_id,
          qty_good, qty_scrap, qty_rework, qty_pending_control,
          unite, scrap_reason_code, rework_reason_code, note,
          idempotency_key, declared_by
        )
        VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::int)
        RETURNING id::text AS id
      `,
      [
        params.body.pointage_id ?? null,
        params.body.of_id,
        operationId,
        delta.qty_good,
        delta.qty_scrap,
        delta.qty_rework,
        delta.qty_pending_control,
        params.body.unite ?? null,
        params.body.scrap_reason_code ?? null,
        params.body.rework_reason_code ?? null,
        params.body.note ?? null,
        params.idempotencyKey,
        params.audit.user_id,
      ]
    );
    const id = ins.rows[0]!.id;

    await client.query(
      `
        UPDATE public.ordres_fabrication
        SET quantite_bonne = quantite_bonne + $2, quantite_rebut = quantite_rebut + $3,
            updated_at = now(), updated_by = $4::int
        WHERE id = $1::bigint
      `,
      [params.body.of_id, delta.qty_good, delta.qty_scrap, params.audit.user_id]
    );

    if (params.body.pointage_id) {
      await insertExecutionEvent(client, {
        pointage_id: params.body.pointage_id,
        event_type: "DECLARE_QUANTITY",
        user_id: params.audit.user_id,
        new_values: { declaration_id: id, ...delta },
        note: params.body.note ?? null,
      });
    }

    await insertAuditLog(client, params.audit, {
      action: "production.execution.declare-quantity",
      entity_type: "production_quantity_declarations",
      entity_id: id,
      details: { of_id: params.body.of_id, operation_id: operationId, ...delta, no_stock_movement: true },
    });

    await storeIdempotentResponse(client, params.idempotencyKey, { id });
    await params.transactionHooks?.beforeCommit(client, { id });
    await client.query("COMMIT");
    return { id };
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Cycle de validation                                                        */
/* -------------------------------------------------------------------------- */

export async function repoSubmitExecution(params: {
  id: string;
  note: string | null;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<ExecutionListItem> {
  return simpleTransition({
    ...params,
    action: "submit",
    apply: async (client, current) => {
      if (current.status !== "DONE") {
        throw new HttpError(
          409,
          "PRODUCTION_EXECUTION_NOT_STOPPED",
          "Arrêtez le pointage avant de le soumettre."
        );
      }
      assertOwnershipOrSupervision({
        actorUserId: params.audit.user_id,
        actorRole: params.actorRole,
        ownerUserId: current.operator_user_id,
        action: "soumission",
      });
      await client.query(
        `
          UPDATE public.production_pointages
          SET submitted_at = now(), submitted_by = $2::int,
              rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL,
              updated_at = now(), updated_by = $2::int
          WHERE id = $1::uuid
        `,
        [params.id, params.audit.user_id]
      );
      return { event: "SUBMIT" as const, details: {} };
    },
  });
}

export async function repoValidateExecution(params: {
  id: string;
  note: string | null;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<ExecutionListItem> {
  return simpleTransition({
    ...params,
    action: "validate",
    apply: async (client, current) => {
      if (current.status !== "DONE") {
        throw new HttpError(
          409,
          "PRODUCTION_EXECUTION_NOT_STOPPED",
          "Un pointage en cours ne peut pas être validé."
        );
      }
      // Séparation des tâches : on ne valide pas son propre travail.
      assertSeparationOfDuties({
        actorUserId: params.audit.user_id,
        ownerUserId: current.operator_user_id,
        actorRole: params.actorRole,
      });
      await client.query(
        `
          UPDATE public.production_pointages
          SET validated_at = now(), validated_by = $2::int,
              rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL,
              updated_at = now(), updated_by = $2::int
          WHERE id = $1::uuid AND validated_at IS NULL
        `,
        [params.id, params.audit.user_id]
      );
      if (current.operation_id) {
        await client.query(`SELECT public.fn_production_recompute_operation_real_time($1::uuid)`, [
          current.operation_id,
        ]);
      }
      return { event: "VALIDATE" as const, details: {} };
    },
  });
}

export async function repoRejectExecution(params: {
  id: string;
  reason: string;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<ExecutionListItem> {
  return simpleTransition({
    id: params.id,
    note: params.reason,
    actorRole: params.actorRole,
    audit: params.audit,
    action: "reject",
    apply: async (client, current) => {
      assertSeparationOfDuties({
        actorUserId: params.audit.user_id,
        ownerUserId: current.operator_user_id,
        actorRole: params.actorRole,
      });
      await client.query(
        `
          UPDATE public.production_pointages
          SET rejected_at = now(), rejected_by = $2::int, rejection_reason = $3,
              updated_at = now(), updated_by = $2::int
          WHERE id = $1::uuid
        `,
        [params.id, params.audit.user_id, params.reason]
      );
      return { event: "REJECT" as const, details: { reason: params.reason } };
    },
  });
}

export async function repoCancelExecution(params: {
  id: string;
  reason: string;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<ExecutionListItem> {
  return simpleTransition({
    id: params.id,
    note: params.reason,
    actorRole: params.actorRole,
    audit: params.audit,
    action: "cancel",
    apply: async (client, current) => {
      assertExecutionTransition(current.status, "CANCELLED");
      // Annulation NON destructive : la ligne reste, son statut change et le
      // temps cesse d'être compté.
      await client.query(
        `
          UPDATE public.production_pointages
          SET status = 'CANCELLED'::production_pointage_status,
              end_ts = COALESCE(end_ts, now()),
              correction_reason = $3,
              updated_at = now(), updated_by = $2::int
          WHERE id = $1::uuid
        `,
        [params.id, params.audit.user_id, params.reason]
      );
      if (current.operation_id) {
        await client.query(`SELECT public.fn_production_recompute_operation_real_time($1::uuid)`, [
          current.operation_id,
        ]);
      }
      return { event: "CANCEL" as const, details: { reason: params.reason } };
    },
  });
}

async function simpleTransition(params: {
  id: string;
  note: string | null;
  actorRole: string | null | undefined;
  audit: AuditContext;
  action: string;
  apply: (
    client: PoolClient,
    current: LockedPointage
  ) => Promise<{ event: ExecutionEventType; details: Record<string, unknown> }>;
}): Promise<ExecutionListItem> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await lockPointage(client, params.id);
    assertMutable(current);

    const { event, details } = await params.apply(client, current);

    await insertExecutionEvent(client, {
      pointage_id: params.id,
      event_type: event,
      user_id: params.audit.user_id,
      old_values: { status: current.status, validated_at: current.validated_at },
      new_values: details,
      note: params.note,
    });

    await insertAuditLog(client, params.audit, {
      action: `production.execution.${params.action}`,
      entity_type: "production_pointages",
      entity_id: params.id,
      details: { of_id: current.of_id, operation_id: current.operation_id, ...details },
    });

    await client.query("COMMIT");
    const updated = await repoGetExecution({ id: params.id });
    if (!updated) throw new HttpError(500, "PRODUCTION_EXECUTION_READ_BACK_FAILED", "Relecture impossible.");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------------------------- */
/* Correction — version liée, l'original reste visible                        */
/* -------------------------------------------------------------------------- */

export async function repoCorrectExecution(params: {
  id: string;
  correction_reason: string;
  patch: Record<string, unknown>;
  actorRole: string | null | undefined;
  audit: AuditContext;
}): Promise<ExecutionListItem> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await lockPointage(client, params.id);
    assertMutable(current);
    if (current.status === "RUNNING") {
      throw new HttpError(
        409,
        "PRODUCTION_EXECUTION_RUNNING_NOT_CORRECTABLE",
        "Arrêtez le pointage avant de le corriger."
      );
    }

    const patch = params.patch as {
      start_ts?: string;
      end_ts?: string | null;
      activity_code?: string;
      machine_id?: string | null;
      poste_id?: string | null;
      operation_id?: string | null;
      comment?: string | null;
    };

    if (patch.activity_code) await loadActivity(client, patch.activity_code);
    if (patch.start_ts && patch.end_ts) {
      assertPlausibleDuration(computeDurationMinutes(patch.start_ts, patch.end_ts));
    }

    // L'original bascule en CORRECTED : il reste lisible et traçable.
    assertExecutionTransition(current.status, "CORRECTED");
    await client.query(
      `
        UPDATE public.production_pointages
        SET status = 'CORRECTED'::production_pointage_status,
            correction_reason = $2,
            updated_at = now(), updated_by = $3::int
        WHERE id = $1::uuid
      `,
      [params.id, params.correction_reason, params.audit.user_id]
    );

    // Le remplaçant est une NOUVELLE ligne liée à l'original.
    const ins = await client.query<{ id: string }>(
      `
        INSERT INTO public.production_pointages (
          of_id, operation_id, affaire_id, piece_technique_id,
          machine_id, poste_id, operator_user_id, time_type, activity_code,
          start_ts, end_ts, status, comment, correction_reason,
          session_id, previous_segment_id, segment_index, source,
          context_snapshot, created_by, updated_by
        )
        SELECT
          p.of_id,
          COALESCE($2::uuid, p.operation_id),
          p.affaire_id, p.piece_technique_id,
          CASE WHEN $3::text = 'set' THEN $4::uuid ELSE p.machine_id END,
          CASE WHEN $5::text = 'set' THEN $6::uuid ELSE p.poste_id END,
          p.operator_user_id, p.time_type,
          COALESCE($7::text, p.activity_code),
          COALESCE($8::timestamptz, p.start_ts),
          COALESCE($9::timestamptz, p.end_ts),
          'DONE'::production_pointage_status,
          COALESCE($10, p.comment),
          $11,
          COALESCE(p.session_id, p.id), p.id, p.segment_index + 1, 'CANONICAL',
          p.context_snapshot, $12::int, $12::int
        FROM public.production_pointages p
        WHERE p.id = $1::uuid
        RETURNING id::text AS id
      `,
      [
        params.id,
        patch.operation_id ?? null,
        patch.machine_id !== undefined ? "set" : "keep",
        patch.machine_id ?? null,
        patch.poste_id !== undefined ? "set" : "keep",
        patch.poste_id ?? null,
        patch.activity_code ?? null,
        patch.start_ts ?? null,
        patch.end_ts ?? null,
        patch.comment ?? null,
        params.correction_reason,
        params.audit.user_id,
      ]
    );
    const newId = ins.rows[0]!.id;

    await insertExecutionEvent(client, {
      pointage_id: params.id,
      event_type: "CORRECT",
      user_id: params.audit.user_id,
      old_values: { status: current.status, start_ts: current.start_ts, end_ts: current.end_ts },
      new_values: { replaced_by: newId, ...patch },
      note: params.correction_reason,
    });
    await insertExecutionEvent(client, {
      pointage_id: newId,
      event_type: "CORRECT",
      user_id: params.audit.user_id,
      new_values: { corrects: params.id },
      note: params.correction_reason,
    });

    if (current.operation_id) {
      await client.query(`SELECT public.fn_production_recompute_operation_real_time($1::uuid)`, [
        current.operation_id,
      ]);
    }

    await insertAuditLog(client, params.audit, {
      action: "production.execution.correct",
      entity_type: "production_pointages",
      entity_id: params.id,
      details: { replaced_by: newId, reason: params.correction_reason, patch },
    });

    await client.query("COMMIT");
    const updated = await repoGetExecution({ id: newId });
    if (!updated) throw new HttpError(500, "PRODUCTION_EXECUTION_READ_BACK_FAILED", "Relecture impossible.");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    return translateConcurrencyError(err);
  } finally {
    client.release();
  }
}
