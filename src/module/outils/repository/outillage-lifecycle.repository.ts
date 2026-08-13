import crypto from "node:crypto";
import type { PoolClient } from "pg";

import db from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import { nextAllocationState, type LifecycleEventType } from "../domain/outillage-lifecycle";
import type {
  CreateToolParameterVersionInput,
  LifecycleTransitionInput,
  ReplaceToolRequirementsInput,
  ReserveToolInput,
} from "../validators/outillage-lifecycle.validators";

export type OutillageAuditContext = {
  user_id: number;
  username: string;
  ip: string | null;
  user_agent: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
  correlation_id: string | null;
};

type AllocationRow = {
  id: string;
  id_outil: number;
  piece_technique_id: string;
  piece_technique_version_id: string;
  of_id: string | null;
  reserved_quantity: number;
  issued_quantity: number;
  returned_quantity: number;
  broken_quantity: number;
  worn_quantity: number;
  status: string;
  unit_cost_snapshot: number | null;
  currency: string | null;
  cost_source: string | null;
  cost_source_observed_at: string | null;
  cost_reliability: string;
  expected_life_pieces_snapshot: number | null;
  reason: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

const ALLOCATION_COLUMNS = `
  id::text AS id, id_outil, piece_technique_id::text AS piece_technique_id,
  piece_technique_version_id::text AS piece_technique_version_id, of_id::text AS of_id,
  reserved_quantity, issued_quantity, returned_quantity, broken_quantity, worn_quantity,
  status, unit_cost_snapshot::float8 AS unit_cost_snapshot, currency, cost_source,
  cost_source_observed_at::text AS cost_source_observed_at, cost_reliability,
  expected_life_pieces_snapshot::float8 AS expected_life_pieces_snapshot,
  reason, notes, created_at::text AS created_at, updated_at::text AS updated_at,
  closed_at::text AS closed_at`;

function requestHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function audit(
  tx: Pick<PoolClient, "query">,
  context: OutillageAuditContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action,
    page_key: context.page_key,
    entity_type: entityType,
    entity_id: entityId,
    path: context.path,
    client_session_id: context.client_session_id,
    details,
  };
  await repoInsertAuditLog({
    user_id: context.user_id,
    body,
    ip: context.ip,
    user_agent: context.user_agent,
    device_type: null,
    os: null,
    browser: null,
    tx,
  });
}

async function replayAllocation(
  tx: Pick<PoolClient, "query">,
  userId: number,
  idempotencyKey: string,
  hash: string
): Promise<AllocationRow | null> {
  const replay = await tx.query<{ request_hash: string; allocation_id: string }>(
    `SELECT request_hash, allocation_id::text AS allocation_id
       FROM public.outillage_lifecycle_events
      WHERE actor_user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );
  const event = replay.rows[0];
  if (!event) return null;
  if (event.request_hash !== hash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence correspond à une autre action");
  }
  const allocation = await tx.query<AllocationRow>(
    `SELECT ${ALLOCATION_COLUMNS} FROM public.outillage_allocations WHERE id = $1::uuid`,
    [event.allocation_id]
  );
  return allocation.rows[0] ?? null;
}

async function assertUsableVersion(
  tx: Pick<PoolClient, "query">,
  pieceId: string,
  versionId: string,
  ofId: number | null
) {
  const version = await tx.query<{ statut: string; is_current: boolean; date_effet: string | null }>(
    `SELECT statut, is_current, date_effet::text AS date_effet
       FROM public.piece_technique_versions
      WHERE id = $1::uuid AND piece_technique_id = $2::uuid`,
    [versionId, pieceId]
  );
  const row = version.rows[0];
  if (!row) throw new HttpError(404, "PIECE_VERSION_NOT_FOUND", "Indice technique introuvable pour cette pièce");
  if (row.statut !== "APPLICABLE" || !row.is_current) {
    throw new HttpError(
      409,
      "PIECE_VERSION_NOT_APPLICABLE",
      "La sortie est bloquée : sélectionnez l'indice technique applicable courant"
    );
  }
  if (row.date_effet && new Date(row.date_effet).getTime() > Date.now()) {
    throw new HttpError(409, "PIECE_VERSION_NOT_EFFECTIVE", "La sortie est bloquée jusqu'à la date d'effet de cet indice");
  }
  if (ofId !== null) {
    const of = await tx.query(
      `SELECT 1 FROM public.ordres_fabrication
        WHERE id = $1 AND piece_technique_id = $2::uuid
          AND piece_technique_version_id = $3::uuid`,
      [ofId, pieceId, versionId]
    );
    if (!of.rows[0]) {
      throw new HttpError(409, "OF_TECHNICAL_VERSION_MISMATCH", "L'OF ne référence pas cette pièce et cet indice");
    }
  }
}

async function insertEvent(
  tx: Pick<PoolClient, "query">,
  allocationId: string,
  eventType: "RESERVE" | LifecycleEventType,
  quantity: number,
  body: { reason: string; notes: string | null },
  idempotencyKey: string,
  hash: string,
  context: OutillageAuditContext,
  before: Record<string, unknown>,
  after: Record<string, unknown>
) {
  await tx.query(
    `INSERT INTO public.outillage_lifecycle_events
       (allocation_id, event_type, quantity, reason, notes, idempotency_key, request_hash,
        actor_user_id, actor_username, source, correlation_id, before_state, after_state)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,'application',$10,$11::jsonb,$12::jsonb)`,
    [
      allocationId, eventType, quantity, body.reason, body.notes, idempotencyKey, hash,
      context.user_id, context.username, context.correlation_id,
      JSON.stringify(before), JSON.stringify(after),
    ]
  );
}

export async function repoReserveTool(
  body: ReserveToolInput,
  idempotencyKey: string,
  context: OutillageAuditContext
): Promise<{ allocation: AllocationRow; replayed: boolean }> {
  const hash = requestHash({ action: "RESERVE", body });
  const client = await db.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const replayed = await replayAllocation(tx, context.user_id, idempotencyKey, hash);
    if (replayed) return { allocation: replayed, replayed: true };

    await assertUsableVersion(tx, body.piece_technique_id, body.piece_technique_version_id, body.of_id);
    const requirement = await tx.query<{ required_quantity: number }>(
      `SELECT required_quantity
         FROM public.piece_version_tool_requirements
        WHERE piece_technique_version_id = $1::uuid AND id_outil = $2`,
      [body.piece_technique_version_id, body.id_outil]
    );
    if (!requirement.rows[0]) {
      throw new HttpError(409, "TOOL_NOT_IN_TECHNICAL_DEFINITION", "Cet outil n'est pas sélectionné dans l'indice technique");
    }
    if (body.quantity > Number(requirement.rows[0].required_quantity)) {
      throw new HttpError(409, "TOOL_REQUIREMENT_EXCEEDED", "La quantité dépasse le besoin défini par les Méthodes");
    }

    const stock = await tx.query<{ stock: number }>(
      `SELECT COALESCE(quantite, 0)::int AS stock
         FROM public.gestion_outils_stock WHERE id_outil = $1 FOR UPDATE`,
      [body.id_outil]
    );
    if (!stock.rows[0]) throw new HttpError(409, "TOOL_STOCK_NOT_CONFIGURED", "Le stock de cet outil n'est pas configuré");
    const pending = await tx.query<{ reserved: number }>(
      `SELECT COALESCE(sum(reserved_quantity - issued_quantity), 0)::int AS reserved
         FROM public.outillage_allocations
        WHERE id_outil = $1 AND status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED')`,
      [body.id_outil]
    );
    const available = Number(stock.rows[0].stock) - Number(pending.rows[0]?.reserved ?? 0);
    if (available < body.quantity) {
      throw new HttpError(409, "TOOL_NOT_AVAILABLE", `Quantité disponible ${Math.max(0, available)}, demandée ${body.quantity}`);
    }

    const params = await tx.query<{
      unit_cost: number | null; currency: string; source: string; source_observed_at: string;
      reliability: string; expected_life_pieces: number | null;
    }>(
      `SELECT unit_cost::float8 AS unit_cost, currency, source,
              source_observed_at::text AS source_observed_at, reliability,
              expected_life_pieces::float8 AS expected_life_pieces
         FROM public.outillage_tool_parameter_versions
        WHERE id_outil = $1 AND effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())
        ORDER BY effective_from DESC LIMIT 1`,
      [body.id_outil]
    );
    const p = params.rows[0];
    const inserted = await tx.query<AllocationRow>(
      `INSERT INTO public.outillage_allocations
         (id_outil, piece_technique_id, piece_technique_version_id, of_id, reserved_quantity,
          unit_cost_snapshot, currency, cost_source, cost_source_observed_at, cost_reliability,
          expected_life_pieces_snapshot, reason, notes, created_by, updated_by)
       VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       RETURNING ${ALLOCATION_COLUMNS}`,
      [
        body.id_outil, body.piece_technique_id, body.piece_technique_version_id, body.of_id,
        body.quantity, p?.unit_cost ?? null, p?.currency ?? null, p?.source ?? null,
        p?.source_observed_at ?? null, p?.reliability ?? "UNAVAILABLE",
        p?.expected_life_pieces ?? null, body.reason, body.notes, context.user_id,
      ]
    );
    const allocation = inserted.rows[0];
    await insertEvent(tx, allocation.id, "RESERVE", body.quantity, body, idempotencyKey, hash, context, {}, allocation);
    await audit(tx, context, "OUTILLAGE_RESERVE", "OUTILLAGE_ALLOCATION", allocation.id, {
      id_outil: body.id_outil,
      piece_technique_version_id: body.piece_technique_version_id,
      of_id: body.of_id,
      quantity: body.quantity,
      cost_reliability: allocation.cost_reliability,
    });
    await enqueueEntityChanged(tx, {
      entityType: "OUTIL", entityId: String(body.id_outil), action: "updated", module: "outillage",
      at: allocation.created_at, invalidateKeys: ["outils", "outils-summary", "outillage-allocations"],
    }, { deduplicationKey: `outillage:allocation:${allocation.id}:reserved` });
    return { allocation, replayed: false };
  });
}

function lifecycleError(error: unknown): never {
  const code = error instanceof Error ? error.message : "INVALID_LIFECYCLE_TRANSITION";
  const messages: Record<string, string> = {
    INVALID_QUANTITY: "Quantité invalide",
    ALLOCATION_CLOSED: "Cette réservation est déjà clôturée",
    ISSUED_ALLOCATION_CANNOT_BE_CANCELLED: "Une sortie effectuée doit être retournée, cassée ou déclarée usée",
    CANCEL_QUANTITY_MUST_MATCH_RESERVATION: "L'annulation doit libérer toute la réservation",
    ISSUE_EXCEEDS_RESERVATION: "La sortie dépasse la quantité réservée",
    DISPOSITION_EXCEEDS_ISSUED: "La quantité dépasse le solde réellement sorti",
  };
  throw new HttpError(409, code, messages[code] ?? "Transition d'outil invalide");
}

export async function repoTransitionAllocation(
  allocationId: string,
  eventType: LifecycleEventType,
  body: LifecycleTransitionInput,
  idempotencyKey: string,
  context: OutillageAuditContext
): Promise<{ allocation: AllocationRow; replayed: boolean }> {
  const hash = requestHash({ action: eventType, allocationId, body });
  const client = await db.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const replayed = await replayAllocation(tx, context.user_id, idempotencyKey, hash);
    if (replayed) return { allocation: replayed, replayed: true };
    const locked = await tx.query<AllocationRow>(
      `SELECT ${ALLOCATION_COLUMNS} FROM public.outillage_allocations WHERE id = $1::uuid FOR UPDATE`,
      [allocationId]
    );
    const current = locked.rows[0];
    if (!current) throw new HttpError(404, "TOOL_ALLOCATION_NOT_FOUND", "Réservation d'outil introuvable");
    // Une version devenue obsolète bloque toute NOUVELLE sortie. Le retour, la
    // casse, l'usure et l'annulation doivent rester possibles afin de fermer
    // proprement une allocation historique déjà engagée.
    if (eventType === "ISSUE") {
      await assertUsableVersion(tx, current.piece_technique_id, current.piece_technique_version_id, current.of_id ? Number(current.of_id) : null);
    }
    let next;
    try {
      next = nextAllocationState(current, eventType, body.quantity);
    } catch (error) {
      lifecycleError(error);
    }

    if (eventType === "ISSUE") {
      const stock = await tx.query<{ stock: number }>(
        `SELECT COALESCE(quantite,0)::int AS stock FROM public.gestion_outils_stock
          WHERE id_outil = $1 FOR UPDATE`, [current.id_outil]
      );
      if (!stock.rows[0] || Number(stock.rows[0].stock) < body.quantity) {
        throw new HttpError(409, "TOOL_PHYSICAL_STOCK_INSUFFICIENT", "Le stock physique ne permet plus cette sortie");
      }
      await tx.query(`UPDATE public.gestion_outils_stock SET quantite = quantite - $2 WHERE id_outil = $1`, [current.id_outil, body.quantity]);
      await tx.query(
        `INSERT INTO public.gestion_outils_mouvement_stock
           (id_outil, quantite, type_mouvement, utilisateur, user_id, reason, source, note)
         VALUES ($1,$2,'sortie',$3,$4,$5,'allocation',$6)`,
        [current.id_outil, body.quantity, context.username, context.user_id, body.reason, body.notes]
      );
    } else if (eventType === "RETURN") {
      await tx.query(`UPDATE public.gestion_outils_stock SET quantite = quantite + $2 WHERE id_outil = $1`, [current.id_outil, body.quantity]);
      await tx.query(
        `INSERT INTO public.gestion_outils_mouvement_stock
           (id_outil, quantite, type_mouvement, utilisateur, user_id, reason, source, note)
         VALUES ($1,$2,'entrée',$3,$4,$5,'allocation_return',$6)`,
        [current.id_outil, body.quantity, context.username, context.user_id, body.reason, body.notes]
      );
    }

    const updated = await tx.query<AllocationRow>(
      `UPDATE public.outillage_allocations
          SET reserved_quantity=$2, issued_quantity=$3, returned_quantity=$4,
              broken_quantity=$5, worn_quantity=$6, status=$7,
              updated_at=now(), updated_by=$8,
              closed_at=CASE WHEN $7 IN ('CLOSED','CANCELLED') THEN now() ELSE NULL END
        WHERE id=$1::uuid RETURNING ${ALLOCATION_COLUMNS}`,
      [allocationId, next.reserved_quantity, next.issued_quantity, next.returned_quantity,
       next.broken_quantity, next.worn_quantity, next.status, context.user_id]
    );
    const allocation = updated.rows[0];
    await insertEvent(tx, allocationId, eventType, body.quantity, body, idempotencyKey, hash, context, current, allocation);
    await audit(tx, context, `OUTILLAGE_${eventType}`, "OUTILLAGE_ALLOCATION", allocationId, {
      id_outil: current.id_outil, quantity: body.quantity, before_status: current.status, after_status: allocation.status,
    });
    await enqueueEntityChanged(tx, {
      entityType: "OUTIL", entityId: String(current.id_outil), action: "updated", module: "outillage",
      at: allocation.updated_at, invalidateKeys: ["outils", "outils-summary", "outils-recent-movements", "outillage-allocations"],
    }, { deduplicationKey: `outillage:allocation:${allocationId}:${eventType.toLowerCase()}:${idempotencyKey}` });
    return { allocation, replayed: false };
  });
}

export async function repoListAllocations(filters: {
  id_outil?: number; piece_technique_version_id?: string; of_id?: number; open_only: boolean;
}) {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (filters.id_outil) where.push(`id_outil = ${push(filters.id_outil)}`);
  if (filters.piece_technique_version_id) where.push(`piece_technique_version_id = ${push(filters.piece_technique_version_id)}::uuid`);
  if (filters.of_id) where.push(`of_id = ${push(filters.of_id)}`);
  if (filters.open_only) where.push(`status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED')`);
  const result = await db.query<AllocationRow>(
    `SELECT ${ALLOCATION_COLUMNS} FROM public.outillage_allocations
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT 500`, values
  );
  return result.rows;
}

export async function repoGetToolLifecycle(idOutil: number) {
  const [metric, events] = await Promise.all([
    db.query(
      `WITH pending AS (
         SELECT COALESCE(sum(reserved_quantity-issued_quantity)
                  FILTER (WHERE status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED')),0)::int AS qty,
                count(*) FILTER (WHERE status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED'))::int AS active
           FROM public.outillage_allocations WHERE id_outil=$1
       ), consumed AS (
         SELECT COALESCE(sum(broken_quantity+worn_quantity),0)::int AS qty,
                sum((broken_quantity+worn_quantity)*unit_cost_snapshot)::float8 AS cost,
                count(*) FILTER (
                  WHERE broken_quantity+worn_quantity>0 AND unit_cost_snapshot IS NULL
                )::int AS missing_cost_count,
                count(DISTINCT currency) FILTER (
                  WHERE broken_quantity+worn_quantity>0 AND unit_cost_snapshot IS NOT NULL
                )::int AS currency_count,
                min(currency) FILTER (
                  WHERE broken_quantity+worn_quantity>0 AND unit_cost_snapshot IS NOT NULL
                ) AS cost_currency,
                string_agg(DISTINCT cost_source, '; ') FILTER (
                  WHERE broken_quantity+worn_quantity>0 AND unit_cost_snapshot IS NOT NULL
                ) AS cost_source,
                (max(cost_source_observed_at) FILTER (
                  WHERE broken_quantity+worn_quantity>0 AND unit_cost_snapshot IS NOT NULL
                ))::text AS cost_source_observed_at,
                bool_or(cost_reliability='DECLARED') FILTER (WHERE broken_quantity+worn_quantity>0) AS has_declared_cost,
                bool_or(cost_reliability='MEASURED') FILTER (WHERE broken_quantity+worn_quantity>0) AS has_measured_cost,
                bool_or(cost_reliability='UNAVAILABLE') FILTER (WHERE broken_quantity+worn_quantity>0) AS has_unavailable_cost
           FROM public.outillage_allocations WHERE id_outil=$1
       ), produced AS (
         SELECT sum(o.quantite_bonne)::float8 AS qty
           FROM public.ordres_fabrication o
           JOIN (SELECT DISTINCT of_id FROM public.outillage_allocations WHERE id_outil=$1 AND of_id IS NOT NULL) a
             ON a.of_id=o.id
       ), params AS (
         SELECT unit_cost::float8, expected_life_pieces::float8, currency, source,
                source_observed_at::text, reliability
           FROM public.outillage_tool_parameter_versions
          WHERE id_outil=$1 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
          ORDER BY effective_from DESC LIMIT 1
       )
       SELECT s.quantite::int AS physical_stock, pending.qty AS reserved_quantity,
              CASE WHEN s.quantite IS NULL THEN NULL
                   ELSE GREATEST(s.quantite::int-pending.qty,0) END AS available_quantity,
              pending.active AS active_allocations, consumed.qty AS consumed_quantity,
              params.unit_cost, params.expected_life_pieces, params.currency, params.source,
              params.source_observed_at, COALESCE(params.reliability,'UNAVAILABLE') AS reliability,
              produced.qty AS produced_pieces, consumed.cost_currency,
              consumed.cost_source AS cost_per_piece_source,
              consumed.cost_source_observed_at AS cost_per_piece_freshness_at,
              CASE WHEN produced.qty>0 AND consumed.cost IS NOT NULL
                         AND consumed.missing_cost_count=0 AND consumed.currency_count<=1
                   THEN consumed.cost/produced.qty ELSE NULL END AS cost_per_piece,
              CASE WHEN produced.qty>0 AND consumed.qty>0
                   THEN produced.qty/consumed.qty ELSE NULL END AS observed_life_pieces,
              CASE WHEN consumed.qty=0 OR consumed.missing_cost_count>0 OR consumed.currency_count>1
                          OR COALESCE(consumed.has_unavailable_cost,false) THEN 'UNAVAILABLE'
                   WHEN COALESCE(consumed.has_declared_cost,false) THEN 'DECLARED'
                   WHEN COALESCE(consumed.has_measured_cost,false) THEN 'MEASURED'
                   ELSE 'VERIFIED' END AS cost_per_piece_reliability,
              consumed.missing_cost_count, consumed.currency_count
         FROM public.gestion_outils_outil o
         LEFT JOIN public.gestion_outils_stock s ON s.id_outil=o.id_outil
         CROSS JOIN pending CROSS JOIN consumed CROSS JOIN produced LEFT JOIN params ON true
        WHERE o.id_outil=$1`, [idOutil]
    ),
    db.query(
      `SELECT e.id::text, e.allocation_id::text, e.event_type, e.quantity, e.reason, e.notes,
              e.actor_user_id, e.actor_username, e.source, e.correlation_id, e.created_at::text,
              e.before_state, e.after_state
         FROM public.outillage_lifecycle_events e
         JOIN public.outillage_allocations a ON a.id=e.allocation_id
        WHERE a.id_outil=$1 ORDER BY e.created_at DESC LIMIT 250`, [idOutil]
    ),
  ]);
  if (!metric.rows[0]) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable");
  return {
    metric: {
      ...metric.rows[0],
      definition: "Disponibilité = stock physique - quantités réservées non encore sorties. Durée observée = pièces bonnes / outils cassés ou usés. Coût/pièce = coût snapshot des outils cassés ou usés / pièces bonnes des OF liés.",
      unit: `outil; coût par pièce en ${metric.rows[0].cost_currency ?? metric.rows[0].currency ?? "devise indisponible"}`,
      period: "cumul des allocations tracées SOL-20",
      source: metric.rows[0].source ?? "Aucun paramètre de coût/durée de vie validé",
      freshness_at: metric.rows[0].source_observed_at ?? null,
      reliability: metric.rows[0].reliability,
      missing: [
        ...(metric.rows[0].physical_stock === null ? ["physical_stock"] : []),
        ...(metric.rows[0].unit_cost === null ? ["unit_cost"] : []),
        ...(metric.rows[0].expected_life_pieces === null ? ["expected_life_pieces"] : []),
        ...(metric.rows[0].produced_pieces === null || Number(metric.rows[0].produced_pieces) <= 0 ? ["produced_pieces"] : []),
        ...(Number(metric.rows[0].missing_cost_count) > 0 ? ["consumed_tool_cost"] : []),
        ...(Number(metric.rows[0].currency_count) > 1 ? ["mixed_currencies"] : []),
      ],
    },
    events: events.rows,
  };
}

export async function repoCreateToolParameterVersion(
  idOutil: number,
  body: CreateToolParameterVersionInput,
  context: OutillageAuditContext
) {
  const client = await db.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const exists = await tx.query(`SELECT 1 FROM public.gestion_outils_outil WHERE id_outil=$1 FOR UPDATE`, [idOutil]);
    if (!exists.rows[0]) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable");
    const current = await tx.query<{ effective_from: string }>(
      `SELECT effective_from::text AS effective_from
         FROM public.outillage_tool_parameter_versions
        WHERE id_outil=$1 AND effective_to IS NULL FOR UPDATE`, [idOutil]
    );
    if (current.rows[0] && new Date(body.effective_from).getTime() <= new Date(current.rows[0].effective_from).getTime()) {
      throw new HttpError(409, "TOOL_PARAMETER_EFFECTIVE_DATE_CONFLICT", "La nouvelle période doit commencer après la période active");
    }
    await tx.query(
      `UPDATE public.outillage_tool_parameter_versions SET effective_to=$2::timestamptz
        WHERE id_outil=$1 AND effective_to IS NULL AND effective_from<$2::timestamptz`,
      [idOutil, body.effective_from]
    );
    const result = await tx.query(
      `INSERT INTO public.outillage_tool_parameter_versions
         (id_outil,effective_from,unit_cost,expected_life_pieces,currency,source,source_observed_at,reliability,change_reason,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id::text,id_outil,effective_from::text,effective_to::text,unit_cost::float8,
                 expected_life_pieces::float8,currency,source,source_observed_at::text,reliability,change_reason,created_at::text`,
      [idOutil,body.effective_from,body.unit_cost,body.expected_life_pieces,body.currency,body.source,
       body.source_observed_at,body.reliability,body.change_reason,context.user_id]
    );
    await audit(tx, context, "OUTILLAGE_PARAMETER_VERSION_CREATE", "OUTIL", String(idOutil), {
      parameter_version_id: result.rows[0].id, effective_from: body.effective_from,
      reliability: body.reliability, source_observed_at: body.source_observed_at,
    });
    return result.rows[0];
  });
}

export async function repoReplaceToolRequirements(
  pieceId: string,
  versionId: string,
  body: ReplaceToolRequirementsInput,
  context: OutillageAuditContext
) {
  const client = await db.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
    const version = await tx.query<{ statut: string }>(
      `SELECT statut FROM public.piece_technique_versions
        WHERE id=$1::uuid AND piece_technique_id=$2::uuid FOR UPDATE`, [versionId, pieceId]
    );
    if (!version.rows[0]) throw new HttpError(404, "PIECE_VERSION_NOT_FOUND", "Indice technique introuvable");
    if (["APPLICABLE", "OBSOLETE"].includes(version.rows[0].statut)) {
      throw new HttpError(409, "VALIDATED_VERSION_IMMUTABLE", "Créez un nouvel indice pour modifier les exigences d'outillage");
    }
    if (body.requirements.length) {
      const ids = body.requirements.map((item) => item.id_outil);
      const tools = await tx.query<{ id_outil: number }>(
        `SELECT id_outil FROM public.gestion_outils_outil WHERE id_outil=ANY($1::int[])`, [ids]
      );
      if (tools.rows.length !== new Set(ids).size) throw new HttpError(422, "TOOL_REQUIREMENT_UNKNOWN_TOOL", "Un outil sélectionné n'existe pas");
    }
    const before = await tx.query(`SELECT id_outil,required_quantity,usage_notes FROM public.piece_version_tool_requirements WHERE piece_technique_version_id=$1`, [versionId]);
    await tx.query(`DELETE FROM public.piece_version_tool_requirements WHERE piece_technique_version_id=$1`, [versionId]);
    for (const requirement of body.requirements) {
      await tx.query(
        `INSERT INTO public.piece_version_tool_requirements
           (piece_technique_version_id,id_outil,required_quantity,usage_notes,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [versionId, requirement.id_outil, requirement.required_quantity, requirement.usage_notes, context.user_id]
      );
    }
    await audit(tx, context, "PIECE_VERSION_TOOL_REQUIREMENTS_REPLACE", "PIECE_TECHNIQUE_VERSION", versionId, {
      reason: body.reason, before: before.rows, after: body.requirements,
    });
    return repoGetTechnicalCompleteness(pieceId, versionId, tx);
  });
}

export async function repoListToolRequirements(pieceId: string, versionId: string) {
  const version = await db.query(
    `SELECT 1 FROM public.piece_technique_versions
      WHERE id=$1::uuid AND piece_technique_id=$2::uuid`, [versionId, pieceId]
  );
  if (!version.rows[0]) throw new HttpError(404, "PIECE_VERSION_NOT_FOUND", "Indice technique introuvable");
  const result = await db.query(
    `SELECT r.id::text,r.id_outil,r.required_quantity,r.usage_notes,
            o.reference_fabricant,o.codification,o.designation_outil_cnc,
            s.quantite::int AS physical_stock,
            COALESCE(sum(a.reserved_quantity-a.issued_quantity)
              FILTER (WHERE a.status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED')),0)::int AS reserved_quantity,
            CASE WHEN s.quantite IS NULL THEN NULL ELSE
              GREATEST(s.quantite::int-COALESCE(sum(a.reserved_quantity-a.issued_quantity)
                FILTER (WHERE a.status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED')),0)::int,0)
            END AS available_quantity,
            r.created_at::text,r.updated_at::text
       FROM public.piece_version_tool_requirements r
       JOIN public.gestion_outils_outil o ON o.id_outil=r.id_outil
       LEFT JOIN public.gestion_outils_stock s ON s.id_outil=r.id_outil
       LEFT JOIN public.outillage_allocations a ON a.id_outil=r.id_outil
      WHERE r.piece_technique_version_id=$1::uuid
      GROUP BY r.id,o.id_outil,s.quantite
      ORDER BY COALESCE(o.codification,o.reference_fabricant,o.designation_outil_cnc),r.id_outil`,
    [versionId]
  );
  return {
    items: result.rows,
    definition: "Disponible = stock physique - réservations non encore sorties.",
    source: "piece_version_tool_requirements + gestion_outils_stock + outillage_allocations",
    observed_at: new Date().toISOString(),
    freshness: "LIVE",
    reliability: "VERIFIED",
  };
}

type ReadinessStatus = "READY" | "MISSING" | "BLOCKED" | "UNAVAILABLE";

export async function repoGetTechnicalCompleteness(
  pieceId: string,
  versionId: string,
  tx: Pick<PoolClient, "query"> = db
) {
  const result = await tx.query<{
    indice: string; statut: string; is_current: boolean; plan_reference: string | null;
    matiere_prevue: string | null; document_requirements_frozen_at: string | null;
    gamme_count: number; control_count: number; tool_count: number; tool_unavailable_count: number;
    required_document_count: number; clean_document_count: number; plan_document_count: number;
  }>(
    `WITH selected AS (
       SELECT v.* FROM public.piece_technique_versions v
        WHERE v.id=$1::uuid AND v.piece_technique_id=$2::uuid
     ), tool_availability AS (
       SELECT r.id_outil, r.required_quantity,
              CASE WHEN s.quantite IS NULL THEN NULL ELSE
                s.quantite::int - COALESCE(sum(a.reserved_quantity-a.issued_quantity)
                  FILTER (WHERE a.status IN ('RESERVED','ISSUED','PARTIALLY_RETURNED')),0)::int
              END AS available
         FROM public.piece_version_tool_requirements r
         LEFT JOIN public.gestion_outils_stock s ON s.id_outil=r.id_outil
         LEFT JOIN public.outillage_allocations a ON a.id_outil=r.id_outil
        WHERE r.piece_technique_version_id=$1::uuid
        GROUP BY r.id_outil,r.required_quantity,s.quantite
     ), clean_docs AS (
       SELECT DISTINCT l.link_role
         FROM public.ged_document_links l
         JOIN public.ged_documents d ON d.id=l.document_id AND d.archived_at IS NULL
         JOIN public.ged_document_versions dv ON dv.id=d.current_version_id AND dv.status='APPLICABLE'
         JOIN public.ged_upload_sessions us ON us.id=dv.upload_session_id
        WHERE l.entity_type='PIECE_TECHNIQUE_VERSION' AND l.entity_id=$1::text
          AND us.scan_status='clean' AND us.quarantine_status='released'
     )
     SELECT s.indice,s.statut,s.is_current,s.plan_reference,s.matiere_prevue,
            s.document_requirements_frozen_at::text,
            (SELECT count(*)::int FROM public.gammes g WHERE g.piece_technique_version_id=s.id AND g.statut='APPLICABLE' AND g.is_current) AS gamme_count,
            (SELECT count(*)::int FROM public.quality_control_plan q WHERE (q.piece_version_id=s.id OR q.piece_technique_id=s.piece_technique_id) AND q.status='PUBLISHED') AS control_count,
            (SELECT count(*)::int FROM tool_availability) AS tool_count,
            (SELECT count(*)::int FROM tool_availability WHERE available IS NULL OR available<required_quantity) AS tool_unavailable_count,
            (SELECT count(*)::int FROM public.piece_version_document_requirements r WHERE r.piece_technique_version_id=s.id) AS required_document_count,
            (SELECT count(*)::int FROM public.piece_version_document_requirements r JOIN clean_docs d ON d.link_role=r.document_type_code WHERE r.piece_technique_version_id=s.id) AS clean_document_count,
            (SELECT count(*)::int FROM clean_docs WHERE link_role IN ('PLAN','PLAN_CLIENT','TECHNICAL_DRAWING')) AS plan_document_count
       FROM selected s`, [versionId, pieceId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "PIECE_VERSION_NOT_FOUND", "Indice technique introuvable");
  const item = (
    key: string, label: string, status: ReadinessStatus, detail: string, source: string, action_url: string
  ) => ({ key, label, status, detail, source, observed_at: new Date().toISOString(), freshness: "LIVE", reliability: "VERIFIED", action_url });
  const docsReady = row.document_requirements_frozen_at !== null
    && row.clean_document_count >= row.required_document_count;
  const items = [
    item("index", "Indice applicable", row.statut === "APPLICABLE" && row.is_current ? "READY" : row.statut === "OBSOLETE" ? "BLOCKED" : "MISSING",
      `${row.indice} — ${row.statut}${row.is_current ? " (courant)" : ""}`, "piece_technique_versions", `/pieces-techniques/${pieceId}?version=${versionId}`),
    item("plan", "Plan et indice documentaire", row.plan_reference && row.plan_document_count > 0 ? "READY" : "MISSING",
      row.plan_reference ? `${row.plan_reference}; ${row.plan_document_count} plan GED propre applicable` : "Référence de plan absente",
      "piece_technique_versions + GED/antivirus", `/pieces-techniques/${pieceId}?tab=documents&version=${versionId}`),
    item("gamme", "Gamme applicable", row.gamme_count > 0 ? "READY" : "MISSING",
      `${row.gamme_count} gamme applicable courante`, "gammes", `/pieces-techniques/${pieceId}?tab=gammes&version=${versionId}`),
    item("controls", "Contrôles publiés", row.control_count > 0 ? "READY" : "MISSING",
      `${row.control_count} plan de contrôle publié`, "quality_control_plan", `/qualite/plans?piece_version_id=${versionId}`),
    item("material", "Matière définie", row.matiere_prevue?.trim() ? "READY" : "MISSING",
      row.matiere_prevue?.trim() || "Matière prévue absente", "piece_technique_versions.matiere_prevue", `/pieces-techniques/${pieceId}?tab=identite&version=${versionId}`),
    item("tooling", "Outillage sélectionné et disponible", row.tool_count > 0 && row.tool_unavailable_count === 0 ? "READY" : row.tool_count > 0 ? "BLOCKED" : "MISSING",
      `${row.tool_count} exigence(s), ${row.tool_unavailable_count} indisponible(s)`, "piece_version_tool_requirements + stock + réservations", `/pieces-techniques/${pieceId}?tab=resume&version=${versionId}`),
    item("documents", "Documents obligatoires validés", docsReady ? "READY" : "MISSING",
      row.document_requirements_frozen_at === null ? "Politique documentaire non figée" : `${row.clean_document_count}/${row.required_document_count} document(s) GED propre(s) applicable(s)`,
      "piece_version_document_requirements + GED/antivirus", `/pieces-techniques/${pieceId}?tab=documents&version=${versionId}`),
  ];
  return {
    piece_technique_id: pieceId,
    piece_technique_version_id: versionId,
    ready: items.every((entry) => entry.status === "READY"),
    evaluated_at: new Date().toISOString(),
    definition: "Une définition est complète lorsque l'indice, le plan GED propre, la gamme, le contrôle, la matière, l'outillage et les documents obligatoires sont prêts.",
    items,
  };
}
